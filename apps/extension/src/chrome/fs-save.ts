// Writes directly into a user-chosen directory (via a stored
// FileSystemDirectoryHandle) instead of going through chrome.downloads —
// this is what actually makes an arbitrary, persisted, outside-Downloads
// folder possible (chrome.downloads.download can only ever write relative
// to the browser's Downloads directory; see save-prefs.ts). Every caller
// must be prepared for this to fail and fall back to that relative-
// subfolder path instead — see the call sites for why.

/** Checks (without prompting) whether we still have write access to a
 * previously-granted directory. Permission grants can be revoked or can
 * expire between sessions, and re-requesting needs a user gesture we don't
 * have at capture time — so a `false` here means "fall back", not "error". */
export async function hasWritePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const opts = { mode: "readwrite" as const };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  // Only useful right after a real user gesture (e.g. the settings page's
  // own "Choose Folder" click) — harmless to attempt elsewhere, since
  // without a gesture the browser just re-returns the current (non-granted)
  // state rather than throwing.
  return (await handle.requestPermission(opts)) === "granted";
}

/** How far to count before giving up on a free name. Reaching it throws,
 * and every caller falls back to chrome.downloads, which has its own
 * numbering — so this bounds a loop rather than being a real limit. */
const MAX_NUMBERED_NAME = 10_000;

/** Whether `name` is taken in `handle`. A directory of that name counts as
 * taken too: it cannot be written as a file either. */
async function isTaken(handle: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await handle.getFileHandle(name);
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") return false;
    return true;
  }
}

/** `opencapture.png` -> `opencapture (2).png`: the browser's own numbering,
 * so a folder picked with Browse… fills the same way Downloads does. */
function numberedName(filename: string, n: number): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return `${filename} (${n})`;
  return `${filename.slice(0, dot)} (${n})${filename.slice(dot)}`;
}

/**
 * Writes `bytes` into `handle` under `filename`, or under the first free
 * numbered variant of it, and returns the name actually used.
 *
 * APP-113: never onto a file that is already there. `getFileHandle` with
 * `create: true` opens an existing file of that name, and `createWritable`
 * then truncates it — so with the default name every capture saved to a
 * Browse… folder silently replaced the one before it, with nothing to say
 * so. chrome.downloads, the other way a save goes, never had this problem:
 * its default conflict action numbers the new file instead. This makes the
 * two agree.
 */
export async function saveToDirectory(handle: FileSystemDirectoryHandle, filename: string, bytes: Uint8Array): Promise<string> {
  let name = filename;
  for (let n = 1; await isTaken(handle, name); n++) {
    if (n > MAX_NUMBERED_NAME) throw new Error(`no free name for ${filename}`);
    name = numberedName(filename, n);
  }
  const fileHandle = await handle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes as BufferSource);
  await writable.close();
  return name;
}
