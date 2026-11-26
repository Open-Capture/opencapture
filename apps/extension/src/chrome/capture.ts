// Wraps tabs.captureVisibleTab with quota pacing. See
// ../platform/webext.ts's captureRateLimit() for why the rate itself is
// read defensively rather than hardcoded.
import { captureRateLimit, ext } from "../platform/webext";

let lastCallAtMs = 0;

function quotaIntervalMs(): number {
  const perSecond = captureRateLimit();
  // No declared limit means no waiting. If the browser turns out to enforce
  // one anyway, the retry below absorbs it.
  return perSecond === null ? 0 : Math.ceil(1000 / perSecond);
}

/** Extra wait after actually being throttled, before trying that slice again. */
const THROTTLED_BACKOFF_MS = 250;
const MAX_ATTEMPTS = 3;

/**
 * The browser refusing a screenshot for going too fast, as opposed to any
 * other failure — a discarded tab, a page that cannot be captured.
 */
function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(message);
}

/**
 * The browser saying it has no access to this tab.
 *
 * `activeTab` is granted for the tab that was showing when the extension was
 * invoked, and it is revoked the moment that tab navigates — a reload, a
 * link, a redirect. A capture runs for seconds, so a page that reloads part
 * way through takes the permission with it and the next screenshot is
 * refused. The raw message says "Missing host permission for the tab", which
 * reads like a broken install rather than something that just happened.
 */
function isPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /missing host permission|cannot access|not allowed to access/i.test(message);
}

/**
 * A part of the page to photograph, and at what scale.
 *
 * Firefox-only `captureVisibleTab` options (`rect`, `scale`); Chromium's
 * schema rejects any option it does not know, so these are never sent there.
 * `rect` is in CSS px of the document — measured on Firefox 160 for Android,
 * where `{y: 0}` returned the top of a page scrolled 600px down.
 */
export interface ShotRegion {
  rect: { x: number; y: number; width: number; height: number };
  scale: number;
}

/**
 * The region that photographs the window's whole layout viewport, for
 * Firefox for Android.
 *
 * Asked for nothing, Firefox for Android returns a bitmap of the screen's
 * size at the device pixel ratio, starting at the scroll position — that is,
 * a phone-width strip of the page. With a mobile layout that strip is the
 * viewport. With "Desktop site" on it is not: the layout is ~980 CSS px wide,
 * zoomed out to fit the screen, and the strip held its left 414px only and
 * under half its height, magnified 2.6x. Every slice of a full-page capture then
 * covered a different area from the one it was placed at, which is the
 * clipped, banded result.
 *
 * Naming the viewport's rect makes the bitmap cover exactly the area the
 * scroll arithmetic assumes. The scale is the one at which that layout fills
 * the screen's width — what the phone itself shows — and never more than the
 * device pixel ratio or less than 1. For a mobile layout that is the device
 * pixel ratio, the same picture as before.
 */
export function layoutViewportShot(
  viewport: { widthCss: number; heightCss: number; screenWidthCss: number },
  scroll: { x: number; y: number },
  dpr: number,
): ShotRegion | null {
  const { widthCss, heightCss, screenWidthCss } = viewport;
  if (!(widthCss > 0) || !(heightCss > 0) || !(dpr > 0)) return null;
  if (!Number.isFinite(scroll.x) || !Number.isFinite(scroll.y)) return null;
  const fit = screenWidthCss > 0 ? (screenWidthCss * dpr) / widthCss : dpr;
  const scale = Math.min(dpr, Math.max(1, fit));
  return { rect: { x: scroll.x, y: scroll.y, width: widthCss, height: heightCss }, scale };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Captures the currently visible viewport of `windowId` as a PNG, waiting
 * as needed to respect the capture-rate quota.
 */
export async function captureVisibleTabPaced(
  windowId: number,
  /**
   * Run after the quota wait and immediately before the screenshot.
   *
   * The wait is the whole point: it is up to half a second long, and anything
   * the page does in it — re-rendering a panel that was hidden, say — lands in
   * the picture. A caller that needs the page in a particular state needs it
   * *here*, not before the wait.
   */
  beforeShot?: () => Promise<void>,
  /** Firefox only — see ShotRegion. Omitted, the browser picks the area. */
  region?: ShotRegion,
): Promise<Uint8Array> {
  // Paced at exactly the quota, not a little under it.
  //
  // This used to add 50ms of slack to every single call so as never to ride
  // the edge. That slack is the dominant cost of a long capture — the quota
  // wait is the whole per-slice budget, everything else fits inside it, so
  // 50ms a slice is 50ms of the total per slice, on every page anyone
  // captures. Paying it up front on the chance of being throttled is the
  // wrong trade when being throttled is both detectable and recoverable:
  // ask at the real rate, and on the rare refusal, wait and ask again.
  for (let attempt = 1; ; attempt++) {
    const wait = quotaIntervalMs() - (Date.now() - lastCallAtMs);
    if (wait > 0) await sleep(wait);

    try {
      if (beforeShot) await beforeShot();
      const options = region ? { format: "png" as const, rect: region.rect, scale: region.scale } : { format: "png" as const };
      const dataUrl = await ext.tabs.captureVisibleTab(windowId, options as chrome.tabs.CaptureVisibleTabOptions);
      lastCallAtMs = Date.now();
      return dataUrlToBytes(dataUrl);
    } catch (error) {
      if (isPermissionError(error)) {
        throw new Error(
          "OpenCapture lost access to this tab, which happens when the page reloads or navigates while a capture is running. Open OpenCapture again and retry.",
        );
      }
      if (attempt >= MAX_ATTEMPTS || !isQuotaError(error)) throw error;
      // Count the refusal as a call: whatever the browser's clock thinks, it
      // has just told us we are early.
      lastCallAtMs = Date.now();
      await sleep(THROTTLED_BACKOFF_MS);
    }
  }
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
