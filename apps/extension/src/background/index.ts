import { EDITOR_IMAGE_BLOB_KEY, EDITOR_IMAGE_PORT_NAME, deleteBlob, getBlob, putBlob } from "../chrome/blob-store";
import { HISTORY_LIST_PORT_NAME, addHistoryEntry, clearHistory, deleteHistoryEntry, getHistoryEntry, listHistoryEntries } from "../chrome/capture-history";
import { setLastCaptureUi } from "../chrome/last-capture-ui";
import { client as openappsClient, ready as openappsReady, store as openappsStore } from "../chrome/openapps-session";
import { bumpUsageCount } from "../chrome/rating-prompt";
import { saveOutput } from "../chrome/save";
import { registerCallbackScript } from "../chrome/auth-permission";
import { ext } from "../platform/webext";
import type { PopupRequest, PopupResponse } from "../types";
import {
  captureFullPage,
  captureSelectedArea,
  captureVisibleOnly,
  exportLastCaptureAsPdf,
  getLastCaptureDpr,
  getLastCaptureFirstImage,
  getLastCaptureImageCount,
  testScrollTargets,
} from "./orchestrator";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || tab.windowId === undefined) {
    throw new Error("No active tab to capture.");
  }
  return tab;
}

// The image bytes go through blob-store.ts (IndexedDB), not
// chrome.storage.session — a full-page capture's PNG can exceed
// storage.session's 10MB default quota. dpr is a single number, tiny
// enough that chrome.storage.session is still fine for it.
//
// The write happens here, in the background context, and only here —
// editor.ts fetches it back over the "editorImage" port below rather than
// opening its own IndexedDB connection, since that connection would run
// inside the editor tab's own (possibly private) document. See
// EDITOR_IMAGE_PORT_NAME's comment in blob-store.ts for why that matters.
// imageCount defaults to 1: every call site except "openEditor" below
// captures fresh, and captureFullPage only ever calls this for its own
// images.length === 1 branch — so 1 is correct there, not a placeholder.
// "openEditor" reopens the *last* capture, which could have been a
// multi-image split even though it only ever hands over the first image
// (see getLastCaptureFirstImage's own comment) — that's the one case that
// needs the real count, so the editor can say so instead of silently
// showing a partial page.
/**
 * `source` is what the browser-frame tool stamps into the address bar. It is
 * carried here rather than read in the editor because the editor runs in its
 * own tab and has no idea which page the pixels came from — and by the time it
 * opens, the original tab may already have navigated somewhere else.
 */
async function openEditorWithBytes(
  bytes: Uint8Array,
  dpr: number,
  imageCount = 1,
  source?: { url: string; capturedAt: number },
): Promise<number | undefined> {
  await putBlob(EDITOR_IMAGE_BLOB_KEY, bytes);
  await ext.storage.session.set({ editorDpr: dpr, editorImageCount: imageCount });
  // Only a fresh capture knows where the pixels came from. Re-opening the last
  // capture (the popup's Annotate button) deliberately leaves these alone, so
  // the frame tool still stamps the page that was actually captured rather
  // than blanking it on the second visit.
  if (source) {
    await ext.storage.session.set({ editorPageUrl: source.url, editorCapturedAt: source.capturedAt });
  }
  const tab = await ext.tabs.create({ url: ext.runtime.getURL("editor.html") });
  return tab.id;
}

// Each Port postMessage() is structured-clone serialized under the hood,
// same as chrome.runtime.sendMessage — the same ~64MiB hard cap that broke
// the old pngBytes-in-message editor/clipboard handoff this got replaced
// by (see the comment above). Streaming the blob across as several chunks,
// each well under that cap, avoids hitting it again for a large capture
// while still never putting the bytes through IndexedDB from inside the
// editor tab itself.
//
// Sent as base64 text, not the Uint8Array chunk itself: from this service
// worker context, a Uint8Array posted over a Port arrives on the other end
// stripped of its prototype (no .slice/.length as a real TypedArray would
// have) — structured clone doesn't preserve it intact across this
// particular boundary, silently corrupting the reassembled image. Base64
// is plain text, so it round-trips exactly regardless — same reasoning as
// bytesToDataUrl above, just chunked instead of one string.
const EDITOR_IMAGE_CHUNK_SIZE = 16 * 1024 * 1024;

ext.runtime.onConnect.addListener((port) => {
  if (port.name !== EDITOR_IMAGE_PORT_NAME) return;
  (async () => {
    const bytes = await getBlob(EDITOR_IMAGE_BLOB_KEY);
    await deleteBlob(EDITOR_IMAGE_BLOB_KEY);
    if (bytes) {
      for (let offset = 0; offset < bytes.length; offset += EDITOR_IMAGE_CHUNK_SIZE) {
        const chunk = bytes.subarray(offset, offset + EDITOR_IMAGE_CHUNK_SIZE);
        port.postMessage({ chunk: bytesToBase64(chunk) });
      }
    }
    port.postMessage({ done: true });
  })();
});

// Streams the whole history log to history.html: one entryStart/chunk*/
// entryDone sequence per capture (newest first, so the page can render
// entries as they arrive instead of waiting for all 50), then a final
// allDone. Same base64-chunking and same reason as EDITOR_IMAGE_PORT_NAME
// above — a history entry's bytes are exactly as large as a fresh
// capture's, and streamed rather than batched into one message so a slow
// history doesn't hold up rendering the first few entries.
ext.runtime.onConnect.addListener((port) => {
  if (port.name !== HISTORY_LIST_PORT_NAME) return;
  (async () => {
    const entries = await listHistoryEntries();
    for (const entry of entries) {
      const { bytes, ...meta } = entry;
      port.postMessage({ entryStart: meta });
      for (let offset = 0; offset < bytes.length; offset += EDITOR_IMAGE_CHUNK_SIZE) {
        const chunk = bytes.subarray(offset, offset + EDITOR_IMAGE_CHUNK_SIZE);
        port.postMessage({ chunk: bytesToBase64(chunk) });
      }
      port.postMessage({ entryDone: true });
    }
    port.postMessage({ allDone: true });
  })();
});

// Small, non-image requests from history.html — deleting or clearing
// entries, and reopening one in the editor (which reuses
// openEditorWithBytes exactly as a fresh capture does, since by the time
// the image is out of IndexedDB there's no difference between the two).
// The callback relay is registered at runtime rather than declared in the
// manifest — a declarative content_scripts entry shows "Read and change your
// data on <host>" in the install dialog even when the host is optional. Chrome
// persists dynamic registrations, but re-asserting on startup covers a profile
// that lost them, and onAdded covers the grant happening in another context.
void registerCallbackScript();
ext.permissions.onAdded.addListener(() => {
  void registerCallbackScript();
});

ext.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as { type?: string; id?: number };
  if (request?.type === "history:delete" && typeof request.id === "number") {
    deleteHistoryEntry(request.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }
  if (request?.type === "history:clear") {
    clearHistory()
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }
  if (request?.type === "history:openInEditor" && typeof request.id === "number") {
    (async () => {
      const entry = await getHistoryEntry(request.id!);
      if (!entry) {
        sendResponse({ ok: false, error: "That capture is no longer in history." });
        return;
      }
      await openEditorWithBytes(entry.bytes, entry.dpr, 1, { url: entry.url, capturedAt: entry.timestamp });
      sendResponse({ ok: true });
    })();
    return true;
  }
  return false;
});

// Best-effort: a capture the user can already see in the editor shouldn't
// fail, or even show an error, just because the history log couldn't be
// written — logged instead of thrown.
async function rememberInHistory(tab: chrome.tabs.Tab, report: { output_width_px: number; output_height_px: number; dpr: number }, bytes: Uint8Array): Promise<void> {
  try {
    await addHistoryEntry({
      title: tab.title ?? "",
      url: tab.url ?? "",
      width: report.output_width_px,
      height: report.output_height_px,
      dpr: report.dpr,
      bytes,
    });
  } catch (err) {
    console.warn("[opencapture] failed to save capture to history", err);
  }
}

async function handleRequest(request: PopupRequest): Promise<PopupResponse> {
  switch (request.action) {
    case "captureFullPage": {
      const tab = await getActiveTab();
      const { report, images } = await captureFullPage(tab.id!, tab.windowId);
      let openedEditor = false;
      if (images.length === 1) {
        // Single-image case (the common one — a page has to exceed ~16000px
        // stitched height before it splits): route through the editor so
        // the user can crop and pick PNG/PDF before anything is written to
        // disk, instead of downloading sight-unseen.
        await openEditorWithBytes(images[0]!, report.dpr, 1, { url: tab.url ?? "", capturedAt: Date.now() });
        openedEditor = true;
      } else {
        // Very long pages that split across multiple output PNGs: cropping
        // across split boundaries isn't well-defined, so these still
        // download immediately as before. Use "Export as PDF" afterward
        // for a single merged file instead of N separate PNGs.
        await Promise.all(images.map((img, i) => saveOutput(img, `-page-${i + 1}-of-${images.length}`, "png", "image/png")));
      }
      await setLastCaptureUi({ report, openedEditor });
      await rememberInHistory(tab, report, images[0]!);
      await bumpUsageCount();
      return { ok: true, report, pngDataUrls: images.map((img) => bytesToDataUrl(img, "image/png")), openedEditor };
    }
    case "captureVisible": {
      const tab = await getActiveTab();
      const { report, images } = await captureVisibleOnly(tab.windowId);
      await openEditorWithBytes(images[0]!, report.dpr, 1, { url: tab.url ?? "", capturedAt: Date.now() });
      await setLastCaptureUi({ report, openedEditor: true });
      await rememberInHistory(tab, report, images[0]!);
      await bumpUsageCount();
      return { ok: true, report, pngDataUrls: images.map((img) => bytesToDataUrl(img, "image/png")), openedEditor: true };
    }
    case "captureSelectedArea": {
      // The popup closes as soon as the user clicks into the page to start
      // dragging a selection (normal Chrome popup-blur behavior) — that's
      // fine, this whole flow runs in the background independent of the
      // popup's lifetime, and the editor still opens even though there's
      // usually no popup left alive to show the result/preview. What used
      // to be lost along with the popup was *this popup's own* memory of
      // what happened — see last-capture-ui.ts for why that's written here
      // instead of back in the popup's response handler.
      const tab = await getActiveTab();
      const outcome = await captureSelectedArea(tab.id!, tab.windowId);
      if (!outcome) {
        return { ok: true, cancelled: true };
      }
      await openEditorWithBytes(outcome.images[0]!, outcome.report.dpr, 1, { url: tab.url ?? "", capturedAt: Date.now() });
      await setLastCaptureUi({ report: outcome.report, openedEditor: true });
      await rememberInHistory(tab, outcome.report, outcome.images[0]!);
      await bumpUsageCount();
      return {
        ok: true,
        report: outcome.report,
        pngDataUrls: outcome.images.map((img) => bytesToDataUrl(img, "image/png")),
        openedEditor: true,
      };
    }
    case "exportPdf": {
      const pdfBytes = await exportLastCaptureAsPdf();
      await saveOutput(pdfBytes, "", "pdf", "application/pdf");
      return { ok: true };
    }
    case "openEditor": {
      const [bytes, dpr, imageCount] = await Promise.all([getLastCaptureFirstImage(), getLastCaptureDpr(), getLastCaptureImageCount()]);
      await openEditorWithBytes(bytes, dpr, imageCount);
      return { ok: true };
    }
    default: {
      const exhaustive: never = request;
      throw new Error(`Unhandled action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

ext.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as Partial<PopupRequest>;
  if (!request?.action) return false;

  handleRequest(request as PopupRequest)
    .then(sendResponse)
    .catch((err: unknown) => {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });

  return true; // keep the message channel open for the async response
});

// Adopts a session handed off by openapps-callback/index.ts (the content
// script scoped to the OpenApps server's OIDC callback URL — see
// manifest.json). Only that content script may install a session, and it
// only ever runs on the server origin declared there — re-check the
// sender here too, so a compromised page in some other tab can't message
// its way into a session by guessing this message's shape.
ext.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const openappsMessage = message as { type?: string; accessToken?: string; refreshToken?: string };
  if (openappsMessage?.type !== "openapps:session") return false;

  // Origins compared whole, not by prefix: `startsWith` would have counted
  // https://auth.opencapture.app.evil.test as our own server. Nothing
  // could reach it today — the content script only runs on URLs the
  // manifest lists — but this is the check standing between a page and a
  // session, and it should not depend on a second file staying narrow.
  const from = sender.url ?? "";
  let sameOrigin = false;
  try {
    sameOrigin = new URL(from).origin === new URL(openappsClient.baseUrl).origin;
  } catch {
    sameOrigin = false; // no sender URL, or not a URL at all
  }
  if (!openappsMessage.accessToken || !openappsMessage.refreshToken || !sameOrigin) {
    console.warn("[openapps] ignoring session message from unexpected sender", from);
    return false;
  }

  (async () => {
    await openappsReady;
    openappsClient.adoptSession(openappsMessage.accessToken!, openappsMessage.refreshToken!);
    if (sender.tab?.id !== undefined) {
      ext.tabs.remove(sender.tab.id).catch(() => {});
    }
    sendResponse({ ok: true });
  })();
  return true; // keep the message channel open for the async work above
});

// The reverse handoff: openapps-callback/index.ts on a /link tab (opened
// from account.ts to connect a second identity) asks for the *current*
// session's access token, since chrome.storage — where it actually lives —
// is invisible to that page. Same sender-origin check as the session
// listener above, and for the same reason: this is the one thing standing
// between a page and a live, usable bearer token.
ext.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const request = message as { type?: string };
  if (request?.type !== "openapps:request-token") return false;

  const from = sender.url ?? "";
  let sameOrigin = false;
  try {
    sameOrigin = new URL(from).origin === new URL(openappsClient.baseUrl).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) {
    console.warn("[openapps] ignoring token request from unexpected sender", from);
    sendResponse({});
    return false;
  }

  (async () => {
    await openappsReady;
    // A raw store read can hand over an access token that already expired —
    // nothing checks it until some request 401s, and /link's calls are
    // plain fetch()es with none of openappsClient's own 401-refresh-retry
    // handling. Force that check now, through a call that does have it, so
    // a stale token gets rotated before it ever leaves this file.
    try {
      await openappsClient.credits.balance();
    } catch {
      // Ignored: a dead session already cleared itself (openappsClient sets
      // the store to null on a 401 that survives its own refresh attempt),
      // and a network hiccup here shouldn't block handing over whatever
      // token is still cached.
    }
    sendResponse({ accessToken: openappsStore.get()?.accessToken });
  })();
  return true; // keep the message channel open for the async work above
});

declare const __OPENCAPTURE_E2E__: boolean;

// Test-only hook: lets Playwright drive a capture by explicit tabId,
// sidestepping the fact that activeTab's permission grant requires a real
// toolbar-icon click, which automation can't simulate. `__OPENCAPTURE_E2E__`
// is a Vite `define` resolved at build time (see vite.config.ts) — when
// false, this whole block is dead-code-eliminated out of the shipped
// bundle, never just hidden behind a runtime check.
if (__OPENCAPTURE_E2E__) {
  (globalThis as unknown as { __test: Record<string, unknown> }).__test = {
    captureFullPage: async (tabId: number, windowId: number) => {
      const { report, images } = await captureFullPage(tabId, windowId);
      return { report, imagesBase64: images.map(bytesToBase64) };
    },
    captureVisibleOnly: async (windowId: number) => {
      const { report, images } = await captureVisibleOnly(windowId);
      return { report, imagesBase64: images.map(bytesToBase64) };
    },
    captureSelectedArea: async (tabId: number, windowId: number) => {
      const outcome = await captureSelectedArea(tabId, windowId);
      if (!outcome) return null;
      return { report: outcome.report, imagesBase64: outcome.images.map(bytesToBase64) };
    },
    exportLastCaptureAsPdf: async () => bytesToBase64(await exportLastCaptureAsPdf()),
    scrollTargets: testScrollTargets,
    openEditor: async () => {
      const [bytes, dpr, imageCount] = await Promise.all([getLastCaptureFirstImage(), getLastCaptureDpr(), getLastCaptureImageCount()]);
      return openEditorWithBytes(bytes, dpr, imageCount);
    },
    // Unlike the hooks above (which call orchestrator functions directly,
    // bypassing the popup-message plumbing entirely), this calls the exact
    // same handleRequest() the real chrome.runtime.onMessage listener
    // calls — the only way to exercise the download-vs-open-editor
    // branching without a second tab whose Playwright-driven activation
    // fights the popup's real activeTab target. See capture.spec.ts.
    captureVisibleViaHandleRequest: () => handleRequest({ action: "captureVisible" }),
    // Exercises blob-store.ts (IndexedDB) directly with a payload larger
    // than chrome.runtime.sendMessage's ~64MiB cap — the exact limit that
    // broke the old pngBytes-in-message clipboard/editor handoff. Proves
    // the storage layer those fixes now depend on actually holds payloads
    // that size in this real extension environment, independent of
    // whether any single test capture happens to compress that large.
    testLargeBlobRoundtrip: async (sizeBytes: number) => {
      const key = "e2e-large-blob-test";
      const bytes = new Uint8Array(sizeBytes);
      bytes[0] = 0xab;
      bytes[bytes.length - 1] = 0xcd;
      await putBlob(key, bytes);
      const back = await getBlob(key);
      await deleteBlob(key);
      return back !== null && back.length === bytes.length && back[0] === 0xab && back[back.length - 1] === 0xcd;
    },
  };
}
