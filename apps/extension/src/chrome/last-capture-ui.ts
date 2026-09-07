// What the popup shows on reopen for "here's your last capture" — status
// text, the report, and (via LAST_CAPTURE_BLOB_KEY in blob-store.ts,
// fetched separately) the preview image.
//
// Written from the background context, not the popup that triggered the
// capture. A full-page or visible-area capture opens the editor as its
// very next step (openEditorWithBytes in background/index.ts), and
// ext.tabs.create() activates that new tab by default — which blurs and
// tears down the popup before its own response handler ever runs. Writing
// this from background, right where openedEditor/report are already
// computed, means it's recorded regardless of whether the popup survives
// long enough to see the response at all — the popup that opens later just
// reads it back.
import { ext } from "../platform/webext";
import type { CaptureReport } from "../types";

const STORAGE_KEY = "lastCaptureUi";

export interface LastCaptureUi {
  report: CaptureReport;
  openedEditor: boolean;
  /**
   * Set once the user has said how they want a too-long capture kept (see
   * capture-size.ts). Without it the popup would ask again on every reopen,
   * including after the answer had already been carried out — the popup is
   * torn down and rebuilt each time, so this is the only place that memory
   * can live.
   */
  formatChosen?: boolean;
}

export async function setLastCaptureUi(ui: LastCaptureUi): Promise<void> {
  await ext.storage.local.set({ [STORAGE_KEY]: ui });
}

export async function getLastCaptureUi(): Promise<LastCaptureUi | undefined> {
  const stored = await ext.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] as LastCaptureUi | undefined;
}
