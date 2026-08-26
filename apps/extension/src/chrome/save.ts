// Single entry point every download call site uses: try the user's
// chosen arbitrary directory (via the File System Access API) first, and
// fall back to chrome.downloads.download's Downloads-relative path
// otherwise. Consolidated here so the fallback logic lives in exactly one
// place rather than being re-derived at each call site.

import { getSavedDirectoryHandle } from "./dir-handle-store";
import { downloadBytes } from "./downloads";
import { hasWritePermission, saveToDirectory } from "./fs-save";
import { getSavePrefs, resolveDownloadPath, resolveFilename } from "./save-prefs";

export interface SaveResult {
  savedToCustomFolder: boolean;
}

/** Saves `bytes` as `<filename-base><suffix>.<ext>`, using the user's
 * chosen directory if one is set and still writable, otherwise the
 * relative-subfolder chrome.downloads path. `suffix` distinguishes
 * multiple outputs from one capture (e.g. `-annotated`, `-page-2-of-3`);
 * pass `""` for a plain single file. */
export async function saveOutput(bytes: Uint8Array, suffix: string, ext: string, mime: string): Promise<SaveResult> {
  const prefs = await getSavePrefs();
  const handle = await getSavedDirectoryHandle();

  // Asking beats a remembered folder: someone who turned this on wants to be
  // asked, so the saved directory handle is deliberately bypassed rather than
  // silently winning.
  if (handle && !prefs.askWhereToSave) {
    try {
      if (await hasWritePermission(handle)) {
        await saveToDirectory(handle, resolveFilename(prefs, suffix, ext), bytes);
        return { savedToCustomFolder: true };
      }
    } catch {
      // Permission revoked, handle no longer valid, or (unverified in this
      // project's sandboxed dev environment) File System Access writes
      // just aren't supported from this execution context — either way,
      // silently fall through to the always-available chrome.downloads path
      // rather than surfacing an error for what the user still expects to
      // just work.
    }
  }

  await downloadBytes(bytes, resolveDownloadPath(prefs, suffix, ext), mime, prefs.askWhereToSave);
  return { savedToCustomFolder: false };
}
