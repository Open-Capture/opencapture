// What a scrolling capture does with elements that stay put while the page
// moves underneath them — sticky headers, footers, chat docks, cookie bars.
//
// There is no right answer to impose. A sticky header is usually wanted, once,
// at the top; a chat dock usually is not wanted at all; and which is which is
// a judgement about the page, not a fact about the DOM. So the capture makes
// the safe choice by default — show everything, but only once — and the
// choice is the user's to change.

import { ext } from "../platform/webext";

export type StickyMode =
  /** Every pinned element appears once, at the end it belongs to. */
  | "once"
  /** Chat docks, cookie bars and corner widgets are dropped; the rest appear once. */
  | "hide-overlays"
  /** Nothing pinned appears at all. */
  | "hide-all";

export interface CapturePrefs {
  sticky: StickyMode;
}

/**
 * Show everything once.
 *
 * The alternative default — quietly dropping anything that looks like a
 * widget — means a capture can silently omit something the page really did
 * show, and the user has no way to know what went missing. Appearing once is
 * the honest version of "don't repeat it down the page", which is the actual
 * problem being solved.
 */
const DEFAULT_PREFS: CapturePrefs = { sticky: "once" };
const STORAGE_KEY = "capturePrefs";

export async function getCapturePrefs(): Promise<CapturePrefs> {
  const stored = await ext.storage.local.get(STORAGE_KEY);
  const saved = stored[STORAGE_KEY] as Partial<CapturePrefs> | undefined;
  const prefs = { ...DEFAULT_PREFS, ...saved };
  // Anything unrecognised (an older build, a hand-edited value) falls back
  // rather than reaching the content script as an unknown mode.
  if (prefs.sticky !== "once" && prefs.sticky !== "hide-overlays" && prefs.sticky !== "hide-all") {
    prefs.sticky = DEFAULT_PREFS.sticky;
  }
  return prefs;
}

export async function setCapturePrefs(prefs: CapturePrefs): Promise<void> {
  await ext.storage.local.set({ [STORAGE_KEY]: prefs });
}
