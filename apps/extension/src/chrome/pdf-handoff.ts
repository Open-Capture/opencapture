// Handing an exported PDF to app.openpdfedit.com.
//
// A capture too long for this extension's own editor is kept as a PDF, and
// the app that can edit one is a separate web app. Getting the file there is
// the awkward part: that app takes a PDF only through a native picker its own
// page opens — `showOpenFilePicker` on Chromium, `<input type=file>` on
// Firefox — and nothing outside a page can fill either. It has no upload
// endpoint to post to on purpose, since it edits on the user's own machine.
//
// So the file goes the only way it can: a content script sharing the page's
// window posts the bytes in, and the page takes delivery through the same
// entry point the iOS share sheet already uses. The protocol lives in
// openpdfedit's own lib/handoff.ts; this side only has to open the tab with
// the marker and answer when the page says it is ready.
//
// Same shape as auth-permission.ts, for the same reason: an optional host
// permission, so nobody who never exports a PDF is asked to grant access to a
// site they may not use, and a content script registered at runtime rather
// than declared — a declarative entry produces the install warning by itself,
// whatever the manifest's host_permissions say.
import { ext } from "../platform/webext";

export const PDF_EDIT_ORIGIN = "https://app.openpdfedit.com/*";

/** Named in the URL so the page knows a document is coming, and from whom. */
export const PDF_EDIT_HANDOFF_URL = "https://app.openpdfedit.com/?handoff=opencapture";

const HANDOFF_SCRIPT_ID = "openpdfedit-handoff";

export async function hasPdfEditAccess(): Promise<boolean> {
  try {
    return await ext.permissions.contains({ origins: [PDF_EDIT_ORIGIN] });
  } catch {
    return false;
  }
}

/**
 * Ask for the origin. Must be the FIRST await in the click or change handler
 * that calls it — Firefox spends the user gesture on the first await and then
 * resolves this false without ever prompting, which reads as a silent refusal.
 * See ensureAuthAccess in auth-permission.ts, where that cost a while.
 */
export async function requestPdfEditAccess(): Promise<boolean> {
  try {
    return await ext.permissions.request({ origins: [PDF_EDIT_ORIGIN] });
  } catch {
    return false;
  }
}

export async function dropPdfEditAccess(): Promise<void> {
  try {
    await ext.permissions.remove({ origins: [PDF_EDIT_ORIGIN] });
  } catch {
    // Nothing to do about a refusal here: the setting is already off, and the
    // permission being left behind costs the user nothing they can see.
  }
}

/**
 * Register the delivery script. Idempotent — this runs on startup and again
 * on permissions.onAdded, and re-registering a live id throws.
 *
 * Registered for the whole site rather than the handoff URL, because match
 * patterns cannot address a query string. The script itself does nothing at
 * all unless the page it landed on is expecting a document.
 */
export async function registerHandoffScript(): Promise<void> {
  if (!(await hasPdfEditAccess())) return;
  try {
    const existing = await ext.scripting.getRegisteredContentScripts({ ids: [HANDOFF_SCRIPT_ID] });
    if (existing.length > 0) return;
  } catch {
    // Rejects rather than returning [] on some builds when nothing is
    // registered; fall through and let register decide.
  }
  try {
    await ext.scripting.registerContentScripts([
      {
        id: HANDOFF_SCRIPT_ID,
        matches: [PDF_EDIT_ORIGIN],
        js: ["pdf-handoff.js"],
        // document_start, unlike the callback script: the page announces that
        // it is ready as soon as it mounts, and announcements made before
        // this script exists are ones nobody hears. It re-announces on a
        // timer for exactly that reason, so being late is survivable rather
        // than fatal — but there is no reason to be late.
        runAt: "document_start",
        persistAcrossSessions: true,
      },
    ]);
  } catch (error) {
    if (!String(error).includes("Duplicate script ID")) {
      console.warn("[opencapture] could not register the PDF handoff script", error);
    }
  }
}
