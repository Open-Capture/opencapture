import { LAST_CAPTURE_BLOB_KEY, getBlob } from "../chrome/blob-store";
import { copyPngBytesToClipboard } from "../chrome/copy-image";
import { getSavedDirectoryHandle } from "../chrome/dir-handle-store";
import { type LastCaptureUi, getLastCaptureUi } from "../chrome/last-capture-ui";
import { client as openappsClient, ready as openappsReady } from "../chrome/openapps-session";
import { pickDirectory } from "../chrome/pick-directory";
import {
  getRatingPromptState,
  getStoreReviewUrl,
  getFeedbackMailto,
  getUsageCount,
  recordPromptDismissed,
  recordPromptResponded,
  shouldShowRatingPrompt,
} from "../chrome/rating-prompt";
import { getSavePrefs, setSavePrefs } from "../chrome/save-prefs";
import { getCapturePrefs, setCapturePrefs, type StickyMode } from "../chrome/capture-prefs";
import { ext } from "../platform/webext";
import type { PopupRequest, PopupResponse } from "../types";

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

const statusEl = $("status");
const reportEl = $("report") as HTMLPreElement;
const previewEl = $("preview") as HTMLImageElement;
const exportPdfBtn = $("exportPdf") as HTMLButtonElement;
const copyBtn = $("copyToClipboard") as HTMLButtonElement;
const openEditorBtn = $("openEditor") as HTMLButtonElement;
const allButtons = document.querySelectorAll<HTMLButtonElement>("button");
const prefFilenameEl = $("prefFilename") as HTMLInputElement;
const customFolderNameEl = $("customFolderName");
const browseFolderBtn = $("browseFolder") as HTMLButtonElement;
const prefAskWhereEl = $("prefAskWhere") as HTMLInputElement;
const saveSummaryBtn = $("saveSummary") as HTMLButtonElement;
const saveSummaryTextEl = $("saveSummaryText");
const saveLocationEl = $("saveLocation") as HTMLFieldSetElement;
const rateUsBtn = $("rateUs") as HTMLButtonElement;

// showDirectoryPicker() (File System Access API) is Chromium-only — Firefox
// has no implementation at all, and no equivalent API to fall back to.
// Hide the button entirely rather than showing something that can only
// error; Firefox users keep the standard Downloads-folder save, same
// fallback Chrome itself uses when this API/permission isn't available.
const supportsFolderPicker = "showDirectoryPicker" in window;
if (!supportsFolderPicker) {
  browseFolderBtn.style.display = "none";
}

// Persist on every change (no explicit "Save" button — the popup is
// transient and can close at any moment, e.g. losing focus mid-edit, so
// there's no safe later point to defer saving to).
async function loadSavePrefs(): Promise<void> {
  const prefs = await getSavePrefs();
  prefFilenameEl.placeholder = prefs.filename;
  prefFilenameEl.value = prefs.filename === "opencapture" ? "" : prefs.filename;
  prefAskWhereEl.checked = prefs.askWhereToSave;
}

const prefStickyEl = $("prefSticky") as HTMLSelectElement;

async function loadCapturePrefs(): Promise<void> {
  const { sticky } = await getCapturePrefs();
  prefStickyEl.value = sticky;
}

prefStickyEl.addEventListener("change", () => {
  void setCapturePrefs({ sticky: prefStickyEl.value as StickyMode });
});

async function persistSavePrefs(): Promise<void> {
  await setSavePrefs({
    folder: "",
    filename: prefFilenameEl.value.trim() || "opencapture",
    askWhereToSave: prefAskWhereEl.checked,
  });
}

prefFilenameEl.addEventListener("change", () => {
  void persistSavePrefs();
  void refreshCustomFolder();
});
prefAskWhereEl.addEventListener("change", () => {
  void persistSavePrefs();
  void refreshCustomFolder();
});
loadSavePrefs();
loadCapturePrefs();

/** One line describing where the next capture lands, for the collapsed row. */
function setSaveSummary(destination: string): void {
  const filename = prefFilenameEl.value.trim() || "opencapture";
  saveSummaryTextEl.textContent = `${destination} · ${filename}.png`;
}

saveSummaryBtn.addEventListener("click", () => {
  const open = saveLocationEl.hidden;
  saveLocationEl.hidden = !open;
  saveSummaryBtn.setAttribute("aria-expanded", String(open));
});

// Always available, unlike the milestone prompt further down: someone who
// wants to leave a review on day one should not have to capture three times
// first.
rateUsBtn.addEventListener("click", () => {
  void recordPromptResponded();
  ext.tabs.create({ url: getStoreReviewUrl() });
});

async function refreshCustomFolder(): Promise<void> {
  if (prefAskWhereEl.checked) {
    // Saying "Your Downloads folder" under a ticked "ask every time" would be
    // a straight contradiction — the folder is chosen in the dialog now.
    customFolderNameEl.textContent = "Chosen in the Save dialog";
    setSaveSummary("Ask each time");
    browseFolderBtn.disabled = true;
    return;
  }
  browseFolderBtn.disabled = false;
  const handle = await getSavedDirectoryHandle();
  customFolderNameEl.textContent = handle ? handle.name : "Your Downloads folder (default)";
  setSaveSummary(handle ? handle.name : "Downloads");
}

// Single place that writes to #status, so error styling (a red status
// line) can't drift out of sync with the text — every other call site goes
// through this instead of touching statusEl directly.
function setStatusText(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("is-error", isError);
}

browseFolderBtn.addEventListener("click", async () => {
  const result = await pickDirectory();
  if (result.ok) {
    setStatusText(`Now saving to "${result.name}".`);
  } else if (!result.cancelled) {
    setStatusText(`Couldn't set that folder: ${result.error}`, true);
  }
  await refreshCustomFolder();
});

refreshCustomFolder();

// MV3 popups are fully torn down and recreated every time they close — all
// in-memory JS state (the report, preview, which buttons are enabled) is
// lost, even though the underlying capture is still very much there
// (background/index.ts's orchestrator state, and the image bytes in
// blob-store under LAST_CAPTURE_BLOB_KEY, both survive independently of
// this popup's lifetime). This redraws the same "last capture" UI on next
// open from what background/index.ts already persisted (see
// chrome/last-capture-ui.ts for why that write happens there and not
// here) — the image itself is re-read from blob-store rather than
// duplicated into that record, since a capture's PNG can be far too large
// for chrome.storage.local's 10MB default quota.
function captureStatusText(ui: LastCaptureUi): string {
  return ui.openedEditor
    ? "Opened in editor — crop, annotate, then choose PNG or PDF to save."
    : `Done — downloaded ${ui.report.output_image_count} PNG file(s) (page too long for one image; use "Export as PDF" for a single file).`;
}

async function restoreLastCaptureUi(): Promise<void> {
  const ui = await getLastCaptureUi();
  if (!ui) return;

  reportEl.style.display = "block";
  reportEl.textContent = JSON.stringify(ui.report, null, 2);

  const bytes = await getBlob(LAST_CAPTURE_BLOB_KEY);
  if (bytes) {
    previewEl.style.display = "block";
    previewEl.src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
  }

  exportPdfBtn.disabled = false;
  copyBtn.disabled = false;
  openEditorBtn.disabled = false;
  setStatusText(captureStatusText(ui));
}

restoreLastCaptureUi();

// Nudges toward a store rating after real, repeated use — see
// chrome/rating-prompt.ts for the show-again/never-again rules. Checked
// on every popup open (not synchronously after a capture) because a
// single-image capture immediately opens the editor in a new tab, which
// tears this popup down before it could ever show anything — the same
// MV3 popup-lifecycle gotcha last-capture-ui.ts already exists to work
// around, see that file's own comment.
const ratingPromptEl = $("ratingPrompt");
const ratingPromptAskEl = $("ratingPromptAsk");
const ratingPromptFeedbackEl = $("ratingPromptFeedback");
const ratingPromptThanksEl = $("ratingPromptThanks");
const ratingFeedbackLinkEl = $("ratingFeedbackLink") as HTMLAnchorElement;

async function initRatingPrompt(): Promise<void> {
  const [usageCount, state] = await Promise.all([getUsageCount(), getRatingPromptState()]);
  if (!shouldShowRatingPrompt(usageCount, state)) return;
  ratingPromptEl.style.display = "block";
}

initRatingPrompt();

document.querySelectorAll<HTMLButtonElement>(".rating-star").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const stars = Number(btn.dataset.stars);
    await recordPromptResponded();
    if (stars >= 4) {
      // No API on either store lets an extension submit a rating on the
      // user's behalf — the real review page is the closest a 4-5 star
      // tap can get to "not leaving the popup," so it opens in a new tab
      // while this one shows a short acknowledgement instead of just
      // vanishing.
      ext.tabs.create({ url: getStoreReviewUrl() });
      ratingPromptAskEl.style.display = "none";
      ratingPromptThanksEl.style.display = "block";
    } else {
      // A low rating is a signal worth capturing without pushing it into
      // a public review — routes to feedback instead of the store.
      ratingFeedbackLinkEl.href = getFeedbackMailto();
      ratingPromptAskEl.style.display = "none";
      ratingPromptFeedbackEl.style.display = "block";
    }
  });
});

$("ratingNotNow").addEventListener("click", async () => {
  await recordPromptDismissed();
  ratingPromptEl.style.display = "none";
});

// Only writes #status when going busy — the caller already left the right
// final text (and error styling, if any) in place before calling
// setBusy(false), so re-stamping it here would just risk clobbering that.
function setBusy(busy: boolean, busyMessage?: string): void {
  if (busy && busyMessage !== undefined) setStatusText(busyMessage);
  allButtons.forEach((b) => (b.disabled = busy));
  if (!busy) {
    exportPdfBtn.disabled = false;
    copyBtn.disabled = false;
    openEditorBtn.disabled = false;
  }
}

async function send(request: PopupRequest): Promise<PopupResponse> {
  return ext.runtime.sendMessage(request);
}

async function showCaptureResult(response: PopupResponse): Promise<void> {
  if (!response.ok) {
    setStatusText(`Error: ${response.error}`, true);
    return;
  }
  if ("cancelled" in response) {
    // Deliberately doesn't touch reportEl/previewEl/persisted state — a
    // cancelled selection leaves whatever the previous capture's state
    // was fully intact, exactly like an error does.
    setStatusText("Selection cancelled.");
    return;
  }
  if ("report" in response) {
    reportEl.style.display = "block";
    reportEl.textContent = JSON.stringify(response.report, null, 2);
    if (response.pngDataUrls[0]) {
      previewEl.style.display = "block";
      previewEl.src = response.pngDataUrls[0];
    }
    // background/index.ts already persisted this (see chrome/last-capture-ui.ts)
    // by the time this response reaches here, if it reaches here at all —
    // this popup instance might not even be the one that was open when the
    // capture finished, if the editor tab opening tore the original one down.
    setStatusText(captureStatusText({ report: response.report, openedEditor: response.openedEditor }));
  } else {
    setStatusText("Done.");
  }
}

// A full-page capture is paced by the browser's screenshot quota, so it takes
// seconds on a long page. Showing which slice it is on turns that wait into
// something legible instead of a frozen message.
let captureBusyMessage = "";
const captureProgressEl = $("captureProgress");
const captureProgressBarEl = $("captureProgressBar");

function showCaptureProgress(fraction: number | null): void {
  if (fraction === null) {
    captureProgressEl.hidden = true;
    captureProgressBarEl.style.width = "0%";
    return;
  }
  captureProgressEl.hidden = false;
  captureProgressBarEl.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

ext.runtime.onMessage.addListener((message: unknown) => {
  const m = message as { type?: string; done?: number; total?: number };
  if (m.type !== "captureProgress" || typeof m.done !== "number" || typeof m.total !== "number") return;
  if (!captureBusyMessage) return;
  showCaptureProgress(m.total > 0 ? m.done / m.total : 0);
  // The final call reports done === total; leave the words alone then, since
  // the result is about to replace them anyway.
  if (m.done >= m.total) return;
  setStatusText(`${captureBusyMessage} ${m.done + 1} of ${m.total}`);
});

async function runCapture(request: PopupRequest, busyMessage: string): Promise<void> {
  captureBusyMessage = busyMessage.replace(/…$/, "");
  // Zero-width to start: the bar appears the moment work begins, rather than
  // popping into existence at the first slice.
  showCaptureProgress(0);
  setBusy(true, busyMessage);
  try {
    const response = await send(request);
    await showCaptureResult(response);
  } catch (err) {
    setStatusText(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    // Stop listening for progress before the next click can start: a late
    // message from a finished capture would otherwise overwrite its result.
    captureBusyMessage = "";
    showCaptureProgress(null);
    setBusy(false);
  }
}

$("captureFullPage").addEventListener("click", () => runCapture({ action: "captureFullPage" }, "Capturing full page…"));
$("captureVisible").addEventListener("click", () => runCapture({ action: "captureVisible" }, "Capturing visible area…"));
$("captureSelectedArea").addEventListener("click", () => {
  // Sent, then this popup closes itself, rather than waiting to be dismissed.
  //
  // Selecting an area is the one action carried out on the page rather than
  // in here, and a popup is dismissed by the first click anywhere outside it.
  // That click was therefore spent closing this window instead of starting
  // the selection: the crosshair only appeared on the click *after* the one
  // the user meant as their first. Closing up front gives that click back.
  //
  // Nothing is lost by not awaiting the reply. The whole flow runs in the
  // background, independent of this popup's lifetime — it opens the editor
  // and records what happened for the next time the popup is opened (see
  // last-capture-ui.ts), neither of which needs anyone listening here.
  void send({ action: "captureSelectedArea" }).catch(() => {});
  window.close();
});
exportPdfBtn.addEventListener("click", () => runCapture({ action: "exportPdf" }, "Exporting PDF…"));
openEditorBtn.addEventListener("click", () => runCapture({ action: "openEditor" }, "Opening editor…"));

// Deliberately NOT routed through background/index.ts's message handler —
// the clipboard write has to happen in *this* document, the one that
// actually received the real click, or it can't work at all. See
// chrome/copy-image.ts.
copyBtn.addEventListener("click", async () => {
  setBusy(true, "Copying to clipboard…");
  try {
    const bytes = await getBlob(LAST_CAPTURE_BLOB_KEY);
    if (!bytes) throw new Error("No capture to copy yet — capture a page first.");
    await copyPngBytesToClipboard(bytes);
    setStatusText("Copied to clipboard.");
  } catch (err) {
    setStatusText(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    setBusy(false);
  }
});

// Account status: the only part of this popup that talks to a server.
// Always opens account.html in its own tab, whether the user is signed in
// or not — the popup closes the instant it loses focus, so it can't host
// a real sign-in redirect or a checkout flow itself (same reason the
// capture buttons above route "Annotate" to a separate editor tab).
$("openAccount").addEventListener("click", () => {
  ext.tabs.create({ url: ext.runtime.getURL("account.html") });
});

// Same reasoning as openAccount above — a grid of past captures needs a
// real page, not a 380px popup that closes on blur.
$("openHistory").addEventListener("click", () => {
  ext.tabs.create({ url: ext.runtime.getURL("history.html") });
});

(async () => {
  await openappsReady;
  const label = $("accountLabel");
  if (!openappsClient.isLoggedIn) return; // already showing "Sign in"
  try {
    const balance = await openappsClient.credits.balance();
    label.textContent = `${balance.toLocaleString()} credits`;
  } catch {
    label.textContent = "Account";
  }
})();

// Stamped by vite at build time — `git describe` against the nearest tag, so
// it reads like "v1.0.0-rc.6-3-g04943ae": three commits past rc.6. See
// vite.config.ts for why this exists.
declare const __OPENCAPTURE_BUILD__: string;
{
  const el = document.getElementById("buildLabel");
  if (el) el.textContent = __OPENCAPTURE_BUILD__;
}
