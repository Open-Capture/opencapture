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
import { ext } from "../platform/webext";

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
