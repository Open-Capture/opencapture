// What a scrolling capture does with the bars and panels that follow you down
// a page — menus, chat bubbles, cookie banners, sidebars.
//
// Two choices, not three. An earlier version offered a middle setting that
// dropped chat and cookie widgets while keeping everything else, and in
// testing nobody could tell it apart from the default without reading the
// code. A choice people cannot predict the effect of is not a choice.

import { ext } from "../platform/webext";

export type StickyMode =
  /** Sidebars stay; bars and bubbles appear once, where they belong. */
  | "keep"
  /** The capture shows the page and nothing that floats over it. */
  | "remove";

export interface CapturePrefs {
  sticky: StickyMode;
}

const DEFAULT_PREFS: CapturePrefs = { sticky: "keep" };
const STORAGE_KEY = "capturePrefs";

/** Values written by earlier builds, which had three modes. */
function migrate(saved: string | undefined): StickyMode {
  if (saved === "keep" || saved === "remove") return saved;
  if (saved === "hide-all") return "remove";
  // "once" and "hide-overlays" both meant "show me the page with its
  // furniture", which is what keep does now.
  return DEFAULT_PREFS.sticky;
}

export async function getCapturePrefs(): Promise<CapturePrefs> {
  const stored = await ext.storage.local.get(STORAGE_KEY);
  const saved = stored[STORAGE_KEY] as Partial<CapturePrefs> | undefined;
  return { sticky: migrate(saved?.sticky) };
}

export async function setCapturePrefs(prefs: CapturePrefs): Promise<void> {
  await ext.storage.local.set({ [STORAGE_KEY]: prefs });
}
