// Where captures get saved. `chrome.downloads.download`'s `filename` field
// is always resolved relative to the browser's configured Downloads
// directory — an extension can't point it at an arbitrary absolute path
// anywhere on disk (only a native "Save As" dialog, triggered per-download,
// can do that). A relative subfolder + filename under Downloads is what's
// actually achievable without a picker dialog on every single save, so
// that's what these preferences represent.
//
// Deliberately plain text inputs in the popup rather than a native folder
// picker: `showDirectoryPicker()` (File System Access API) needs a
// document context and reliably closes an extension's transient popup the
// moment the OS dialog steals focus, before the picker can even resolve —
// a well-known MV3 popup gotcha. A picker-based flow would need its own
// persistent tab, not the popup.

import { ext, isFirefox } from "../platform/webext";

export interface SavePrefs {
  folder: string;
  filename: string;
  /**
   * Hand the save to the browser's own Save As dialog instead of writing
   * straight to a folder.
   *
   * This is the only way a Firefox user can choose where a capture goes:
   * the folder picker beside it is the File System Access API, which is
   * Chromium-only (see popup.ts), so without this Firefox has no location
   * control at all. It is per-save by nature — the dialog cannot remember a
   * choice — which is why it is a separate option rather than another way of
   * setting the folder.
   */
  askWhereToSave: boolean;
  /**
   * Carry an exported PDF straight into OpenPdfEdit rather than leaving it in
   * a folder.
   *
   * Off by default and ticked deliberately: acting on it means opening a tab
   * and holding a permission on another site, neither of which should happen
   * to someone who only wanted a file. See background/pdf-handoff.ts.
   */
  openInPdfEdit: boolean;
}

// Default on for Firefox. There, the Save dialog is not one way of choosing a
// location among several — it is the only one, because the folder picker is
// the File System Access API and Firefox does not implement it. Defaulting it
// off would ship Firefox users an extension that always writes to Downloads
// with no visible way to change that. Chromium keeps it off, since Browse…
// already gives a folder that sticks, and being asked every time is worse than
// being asked once.
const DEFAULT_PREFS: SavePrefs = {
  folder: "",
  filename: "opencapture",
  askWhereToSave: isFirefox,
  openInPdfEdit: false,
};
const STORAGE_KEY = "savePrefs";

export async function getSavePrefs(): Promise<SavePrefs> {
  const stored = await ext.storage.local.get(STORAGE_KEY);
  const saved = stored[STORAGE_KEY] as Partial<SavePrefs> | undefined;
  return { ...DEFAULT_PREFS, ...saved };
}

/**
 * Merges rather than replaces.
 *
 * Both call sites build their object from the fields their own panel shows —
 * the popup's and the editor's save panels are not the same set — so a whole
 * -object write silently drops whatever the other one owns. That was harmless
 * while every field was on both panels and stopped being harmless the moment
 * one was not.
 */
export async function setSavePrefs(prefs: Partial<SavePrefs>): Promise<void> {
  const current = await getSavePrefs();
  await ext.storage.local.set({ [STORAGE_KEY]: { ...current, ...prefs } });
}

// Strips characters illegal in Windows/macOS/Linux filenames from a single
// path segment (no slashes allowed at all here).
function sanitizeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, "").trim();
}

// Same, but allows "/" as a subfolder separator; drops empty/"."/".."
// segments so leading/trailing/doubled slashes and path-traversal attempts
// collapse away rather than producing a malformed or escaping path. Chrome
// itself also refuses to write outside the sandboxed downloads directory,
// but there's no reason to hand it a mangled path to reject in the first
// place.
function sanitizeFolder(s: string): string {
  return s
    .split("/")
    .map((seg) => seg.replace(/[\\:*?"<>|]+/g, "").trim())
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..")
    .join("/");
}

/** Just the file's own name — `<sanitized-base><suffix>.<ext>` — with no
 * folder component. `suffix` distinguishes multiple outputs from one
 * capture (e.g. `-annotated`, `-page-2-of-3`); pass `""` for a plain single
 * file. This is what a direct filesystem write (save.ts, for a
 * user-chosen directory handle) needs — the folder there is the handle
 * itself, not a path string. */
export function resolveFilename(prefs: SavePrefs, suffix: string, extension: string): string {
  const base = sanitizeFilename(prefs.filename) || DEFAULT_PREFS.filename;
  return `${base}${suffix}.${extension}`;
}

/** Builds the `filename` value to pass to `chrome.downloads.download`:
 * `<folder>/<sanitized-base><suffix>.<ext>`, or just the file if no folder
 * is set. */
export function resolveDownloadPath(prefs: SavePrefs, suffix: string, extension: string): string {
  const folder = sanitizeFolder(prefs.folder);
  const name = resolveFilename(prefs, suffix, extension);
  return folder ? `${folder}/${name}` : name;
}
