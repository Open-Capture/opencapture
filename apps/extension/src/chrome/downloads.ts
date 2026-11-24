// downloads.download needs a URL. Chrome accepts a data: URL directly
// (and MV3 service workers can't create object URLs from Blobs anyway, no
// document) — but Firefox's downloads.download schema validator rejects
// data: URLs outright (DISALLOW_INHERIT_PRINCIPAL; see
// https://github.com/mdn/webextensions-examples/issues/202), so on
// rejection we fall back to a Blob object URL instead. Firefox's
// background context (an event page, not a true service worker — see
// platform/webext.ts) and the editor's own extension page both have
// `document`, so createObjectURL works there; Chrome never reaches this
// fallback since its data: URL attempt always succeeds.
//
// Firefox for Android is different again: downloads.download() never settles
// there, with a data: URL refused and a Blob URL simply never answered — no
// id, no error, no file — whether the background or a page calls it. A link
// with `download`, clicked in a page that is a tab (the popup, the editor),
// goes through the browser's own download prompt and saves. The background is
// not a tab, and a link clicked there does nothing, so on Android it hands its
// files to the page instead (the `inPage` requests in types.ts).
import { detectAndroid, ext } from "../platform/webext";

/**
 * Save through the browser's own download prompt, from the page in front.
 *
 * Refuses in the background rather than doing nothing: a link clicked there
 * saves no file and raises no error, which is the silent failure this
 * replaces. The name is the last path segment, since a link cannot choose a
 * subfolder of Downloads.
 */
function clickDownloadLink(bytes: Uint8Array, filename: string, mimeType: string): void {
  if (typeof document === "undefined" || location.pathname.includes("background")) {
    throw new Error("On Firefox for Android a file can only be saved from a page, not from the background.");
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.split("/").pop() || filename;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The prompt reads the URL after this returns; a minute is ample.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function downloadBytes(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  saveAs = false,
): Promise<void> {
  if (await detectAndroid()) {
    clickDownloadLink(bytes, filename, mimeType);
    return;
  }
  const dataUrl = `data:${mimeType};base64,${bytesToBase64(bytes)}`;
  try {
    await ext.downloads.download({ url: dataUrl, filename, saveAs });
    return;
  } catch (err) {
    // Firefox: data: URLs are rejected by the downloads API's URL
    // validator. Fall back to a Blob object URL, revoked once the
    // download completes (or immediately fails) so it doesn't leak.
    const blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
    try {
      const downloadId = await ext.downloads.download({ url: blobUrl, filename, saveAs });
      const listener = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id !== downloadId) return;
        if (delta.state?.current === "complete" || delta.state?.current === "interrupted") {
          URL.revokeObjectURL(blobUrl);
          ext.downloads.onChanged.removeListener(listener);
        }
      };
      ext.downloads.onChanged.addListener(listener);
    } catch (fallbackErr) {
      URL.revokeObjectURL(blobUrl);
      throw fallbackErr;
    }
  }
}
