// Transient storage for handing large binary payloads between extension
// contexts (background service worker, offscreen document, editor tab)
// without going through chrome.runtime.sendMessage, which has a hard
// ~64MiB per-message cap a full-page screenshot's PNG bytes can exceed —
// and without chrome.storage.session, whose default quota (10MB) is
// smaller still. IndexedDB is shared across every context of the same
// extension (they're all the same chrome-extension://<id> origin) and has
// no comparable ceiling for realistic image sizes.

const DB_NAME = "opencapture-blobs";
const DB_VERSION = 1;
const STORE_NAME = "blobs";

// Shared between background/index.ts (writer) and editor.ts (reader) for
// handing off a capture's raw PNG bytes — see the same reasoning as above.
export const EDITOR_IMAGE_BLOB_KEY = "editorImage";

// Name of the runtime.connect() Port editor.ts uses to fetch the bytes
// stored under EDITOR_IMAGE_BLOB_KEY — background/index.ts is the only
// reader of that key, not editor.ts itself. Firefox partitions IndexedDB
// (unlike browser.storage) per private-browsing window even for the same
// moz-extension:// origin, so a getBlob() called from inside the editor
// tab's own document would silently miss the write background.js just
// made whenever that tab was opened from a private window, leaving the
// editor blank. Routing the read through the background context (which is
// never private) sidesteps that; see background/index.ts's onConnect
// listener for the chunking this requires.
export const EDITOR_IMAGE_PORT_NAME = "editorImage";

// The most recent capture's first image, kept around (not deleted after one
// read, unlike EDITOR_IMAGE_BLOB_KEY) so the popup's "Copy to Clipboard"
// button can read it directly — see chrome/copy-image.ts for why the copy
// itself has to happen in the popup's own document, not a message-passed
// background/offscreen round-trip.
// The PDF an export just produced, waiting for the app.openpdfedit.com tab to
// ask for it. Written only when the user chose to carry it over, read once by
// the delivery content script and deleted on read — a capture's PDF is large,
// and holding one indefinitely for a tab that may never open is storage spent
// on nothing. See chrome/pdf-handoff.ts.
export const PDF_HANDOFF_BLOB_KEY = "pdfHandoff";
export const PDF_HANDOFF_PORT_NAME = "opencapture-pdf-handoff";

export const LAST_CAPTURE_BLOB_KEY = "lastCaptureImage";

// Output images beyond the first, only populated when a very tall page
// split into more than one output PNG (see orchestrator.ts's
// rememberLastCapture). Index 0 is always LAST_CAPTURE_BLOB_KEY above;
// this covers index >= 1, read only by the stateless PDF rebuild path
// (exportLastCaptureAsPdf) — nothing else in the extension ever needs more
// than the first image.
export function extraLastCaptureBlobKey(index: number): string {
  return `lastCaptureImage_${index}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("failed to open IndexedDB"));
  });
}

export async function putBlob(key: string, bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(bytes, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error(`failed to store blob "${key}"`));
    });
  } finally {
    db.close();
  }
}

export async function getBlob(key: string): Promise<Uint8Array | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error(`failed to read blob "${key}"`));
    });
  } finally {
    db.close();
  }
}

export async function deleteBlob(key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error(`failed to delete blob "${key}"`));
    });
  } finally {
    db.close();
  }
}
