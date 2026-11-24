// A detached capture's failure, kept for the next popup.
//
// A detached capture (see background/target-tab.ts) starts after its popup
// has closed, so when it fails there is nobody listening for the reply. Same
// shape as the PDF handoff's failure notice in background/index.ts: write it
// down, raise a badge, and let the next popup to open say what happened and
// take the badge down again.
import { ext } from "../platform/webext";
import type { CaptureFailure, PopupRequest } from "../types";

const STORAGE_KEY = "detachedCaptureFailure";

export interface DetachedFailure {
  action: PopupRequest["action"];
  failure: CaptureFailure;
}

export async function rememberDetachedFailure(record: DetachedFailure): Promise<void> {
  await ext.storage.session.set({ [STORAGE_KEY]: record });
  try {
    await ext.action.setBadgeBackgroundColor({ color: "#ff4d4d" });
    await ext.action.setBadgeText({ text: "!" });
  } catch {
    // A courtesy; the popup still explains on open.
  }
}

/** Read and forget: each failure is reported once. */
export async function takeDetachedFailure(): Promise<DetachedFailure | undefined> {
  const stored = await ext.storage.session.get(STORAGE_KEY);
  const record = stored[STORAGE_KEY] as DetachedFailure | undefined;
  if (!record) return undefined;
  await ext.storage.session.remove(STORAGE_KEY);
  try {
    await ext.action.setBadgeText({ text: "" });
  } catch {
    // Nothing to do.
  }
  return record;
}

const WAITING_KEY = "detachedCaptureWaiting";

/**
 * A detached capture that finished but did not open the editor — a page too
 * long for it, where the popup asks how to keep the capture. With no popup
 * left to ask in, the badge is the only sign anything happened at all.
 */
export async function markDetachedCaptureWaiting(): Promise<void> {
  await ext.storage.session.set({ [WAITING_KEY]: true });
  try {
    await ext.action.setBadgeBackgroundColor({ color: "#2fbf8f" });
    await ext.action.setBadgeText({ text: "1" });
  } catch {
    // A courtesy; the popup shows the question on open either way.
  }
}

/** Take the "waiting" badge down, if it is this module's to take down. */
export async function clearDetachedCaptureWaiting(): Promise<void> {
  const stored = await ext.storage.session.get(WAITING_KEY);
  if (!stored[WAITING_KEY]) return;
  await ext.storage.session.remove(WAITING_KEY);
  try {
    await ext.action.setBadgeText({ text: "" });
  } catch {
    // Nothing to do.
  }
}
