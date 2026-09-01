import { explainInjectionFailure } from "./injection-error";
import { captureVisibleTabPaced } from "../chrome/capture";
import { LAST_CAPTURE_BLOB_KEY, extraLastCaptureBlobKey, getBlob, putBlob } from "../chrome/blob-store";
import { ext } from "../platform/webext";
import type { CaptureReport, ContentRequest, PageMetrics, PrepResponse, ScrollToResponse, SelectAreaResponse } from "../types";
import { loadShotCore } from "./wasm-loader";

export interface CaptureOutcome {
  report: CaptureReport;
  images: Uint8Array[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ShotCoreSession = any;

// Everything a later "export as PDF" / "annotate" / "copy to clipboard"
// click needs about the last capture lives in persistent storage, not a
// module-level variable — the background service worker gets evicted
// after ~30s idle (normal MV3 behavior, not an error condition), which
// wipes any in-memory state instantly. The popup's "last capture" UI
// (M13) can stay showing enabled buttons for as long as the user likes
// across that eviction, so those buttons have to keep working too: dpr
// and the image count go in chrome.storage.session (small, and no need to
// survive a full browser restart — same tier openEditorWithBytes already
// uses for editorDpr), the image bytes in blob-store (IndexedDB, no
// realistic size ceiling).
const LAST_CAPTURE_META_KEY = "lastCaptureMeta";

interface LastCaptureMeta {
  dpr: number;
  imageCount: number;
}

async function rememberLastCapture(result: { report: CaptureReport; images: Uint8Array[] }): Promise<void> {
  await putBlob(LAST_CAPTURE_BLOB_KEY, result.images[0]!);
  await Promise.all(result.images.slice(1).map((img, i) => putBlob(extraLastCaptureBlobKey(i + 1), img)));
  const meta: LastCaptureMeta = { dpr: result.report.dpr, imageCount: result.images.length };
  await ext.storage.session.set({ [LAST_CAPTURE_META_KEY]: meta });
}

async function getLastCaptureMeta(): Promise<LastCaptureMeta> {
  const stored = await ext.storage.session.get(LAST_CAPTURE_META_KEY);
  const meta = stored[LAST_CAPTURE_META_KEY] as LastCaptureMeta | undefined;
  if (!meta) throw new Error("No capture to export yet — capture a page first.");
  return meta;
}

/**
 * Inject the content script, and if the browser refuses, say something the
 * user can act on instead of passing its developer-facing message through.
 */
async function injectContentScript(tabId: number): Promise<void> {
  try {
    await ext.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);

    let url = "";
    try {
      url = (await ext.tabs.get(tabId)).url ?? "";
    } catch {
      // Without the URL the explanation falls back to the raw message, which
      // is no worse than before.
    }

    let fileAccessAllowed: boolean | undefined;
    try {
      // Firefox has no such switch and no such API; undefined then means "not
      // the file-access case" rather than "denied".
      fileAccessAllowed = await ext.extension.isAllowedFileSchemeAccess();
    } catch {
      fileAccessAllowed = undefined;
    }

    throw new Error(explainInjectionFailure({ url, fileAccessAllowed, rawMessage }));
  }
}

async function sendToContent<T>(tabId: number, request: ContentRequest): Promise<T> {
  return ext.tabs.sendMessage(tabId, request) as Promise<T>;
}

export async function captureFullPage(tabId: number, windowId: number): Promise<CaptureOutcome> {
  await injectContentScript(tabId);

  const shotCore = await loadShotCore();

  const prep = await sendToContent<PrepResponse>(tabId, { action: "prep" });
  const metrics: PageMetrics = prep.metrics;
  const innerRect = prep.innerScrollRect;

  const targets = shotCore.scrollTargets(metrics.totalHeightCss, metrics.viewportHeightCss) as Float64Array;

  const session: ShotCoreSession = new shotCore.CaptureSession(metrics.dpr);

  for (const target of targets) {
    const { actualScrollCss } = await sendToContent<ScrollToResponse>(tabId, {
      action: "scrollTo",
      targetCss: target,
    });
    let pngBytes = await captureVisibleTabPaced(windowId);
    // Dominant-inner-scroller mode (see content/index.ts's
    // detectDominantScroller): captureVisibleTabPaced still returns the
    // whole browser viewport, most of which — anything outside the inner
    // container's own on-screen rect — never changes between slices, since
    // it's the container's content that scrolled, not the page. Crop each
    // slice down to just that rect before it reaches the stitcher, the
    // same cropAndEncode() a selected-area capture uses, so what gets
    // stitched is exactly analogous to window-scroll capture: a
    // fixed-size frame whose content changed by a known scroll delta.
    if (innerRect) {
      const xDev = Math.round(innerRect.x * metrics.dpr);
      const yDev = Math.round(innerRect.y * metrics.dpr);
      const widthDev = Math.round(innerRect.width * metrics.dpr);
      const heightDev = Math.round(innerRect.height * metrics.dpr);
      pngBytes = shotCore.cropAndEncode(pngBytes, xDev, yDev, widthDev, heightDev, metrics.dpr) as Uint8Array;
    }
    session.pushSlice(actualScrollCss, pngBytes);
  }

  await sendToContent(tabId, { action: "restore" });

  const options = JSON.stringify({
    lazy_images_forced: prep.lazyImagesForced,
    pinned_elements_handled: prep.pinnedElementsHandled,
    warnings: prep.warnings,
  });
  const result = session.finish(options) as { report: CaptureReport; images: Uint8Array[] };

  await rememberLastCapture(result);

  return { report: result.report, images: result.images };
}

export async function captureVisibleOnly(windowId: number): Promise<CaptureOutcome> {
  const shotCore = await loadShotCore();
  const pngBytes = await captureVisibleTabPaced(windowId);

  // A single-slice session: dpr doesn't matter for placement math with one
  // slice at scroll 0, but does matter for the report's css dimensions —
  // read it via the content script would require injection, so for the
  // visible-only path we accept dpr 1 here and let the report's px fields
  // (which are always correct, since they come from the decoded bitmap)
  // be the authoritative numbers.
  const session: ShotCoreSession = new shotCore.CaptureSession(1);
  session.pushSlice(0, pngBytes);
  const result = session.finish(JSON.stringify({})) as { report: CaptureReport; images: Uint8Array[] };
  await rememberLastCapture(result);
  return { report: result.report, images: result.images };
}

/// Captures a user-dragged rectangle of the currently visible viewport.
/// Returns `null` if the user cancelled (Escape or a too-small drag)
/// instead of throwing — cancellation is an expected outcome, not a
/// failure.
export async function captureSelectedArea(tabId: number, windowId: number): Promise<CaptureOutcome | null> {
  await injectContentScript(tabId);

  const shotCore = await loadShotCore();

  const { rect, dpr, target } = await sendToContent<SelectAreaResponse>(tabId, { action: "selectArea" });
  if (!rect) return null;

  const pngBytes = await captureVisibleTabPaced(windowId);
  const xDev = Math.round(rect.x * dpr);
  const yDev = Math.round(rect.y * dpr);
  const widthDev = Math.round(rect.width * dpr);
  const heightDev = Math.round(rect.height * dpr);
  const croppedPngBytes = shotCore.cropAndEncode(
    pngBytes,
    xDev,
    yDev,
    widthDev,
    heightDev,
    // An explicit output size is a request for that many pixels, full stop,
    // so the result is recorded at 1:1 rather than carrying the display's
    // device-pixel ratio. Left at `dpr`, a 640x360 image asked for on a 2x
    // screen would print and export as though it were 320x180 of physical
    // page, which is not what "I need 640x360" means.
    target ? 1 : dpr,
    target?.width,
    target?.height,
  ) as Uint8Array;

  // Route the single cropped image through a CaptureSession (rather than
  // handling it as a one-off) purely so exportLastCaptureAsPdf/
  // getLastCaptureFirstImage stay uniform across all three capture modes.
  const session: ShotCoreSession = new shotCore.CaptureSession(target ? 1 : dpr);
  session.pushSlice(0, croppedPngBytes);
  const result = session.finish(JSON.stringify({})) as { report: CaptureReport; images: Uint8Array[] };

  await rememberLastCapture(result);

  return { report: result.report, images: result.images };
}

// Rebuilds the PDF from persisted bytes rather than a live session object
// (see the comment above rememberLastCapture) — works whether the service
// worker that ran the capture is still alive or was evicted and restarted
// since.
export async function exportLastCaptureAsPdf(): Promise<Uint8Array> {
  const meta = await getLastCaptureMeta();
  const firstImage = await getBlob(LAST_CAPTURE_BLOB_KEY);
  if (!firstImage) throw new Error("No capture to export yet — capture a page first.");
  const restImages = await Promise.all(
    Array.from({ length: meta.imageCount - 1 }, (_, i) => getBlob(extraLastCaptureBlobKey(i + 1))),
  );
  const images = [firstImage, ...restImages.map((img, i) => {
    if (!img) throw new Error(`No capture to export yet — output image ${i + 1} is missing.`);
    return img;
  })];
  const shotCore = await loadShotCore();
  return shotCore.imagesToPdf(images, meta.dpr) as Uint8Array;
}

export async function getLastCaptureFirstImage(): Promise<Uint8Array> {
  const bytes = await getBlob(LAST_CAPTURE_BLOB_KEY);
  if (!bytes) throw new Error("No capture to open yet — capture a page first.");
  return bytes;
}

export async function getLastCaptureDpr(): Promise<number> {
  const meta = await getLastCaptureMeta();
  return meta.dpr;
}

// getLastCaptureFirstImage() only ever returns the first of a capture's
// output images — for a page tall/large enough to have split into more
// than one (see plan.rs's MAX_CANVAS_AREA_PX), the editor showing just
// that first image with no indication it's partial reads as data loss
// rather than the deliberate "cropping across a split boundary isn't
// well-defined" tradeoff it actually is. background/index.ts uses this to
// tell the editor which case it's in.
export async function getLastCaptureImageCount(): Promise<number> {
  const meta = await getLastCaptureMeta();
  return meta.imageCount;
}

// Exercises the wasm module without needing a real tab — used by the E2E
// "extension loads" smoke test (see background/index.ts's __test hook).
export async function testScrollTargets(totalHeightCss: number, viewportHeightCss: number): Promise<number[]> {
  const shotCore = await loadShotCore();
  return Array.from(shotCore.scrollTargets(totalHeightCss, viewportHeightCss) as Float64Array);
}
