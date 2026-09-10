import { LAST_CAPTURE_BLOB_KEY, getBlob } from "../chrome/blob-store";
import { copyPngBytesToClipboard } from "../chrome/copy-image";
import { getSavedDirectoryHandle } from "../chrome/dir-handle-store";
import { editableHeightFor, needsFormatChoice } from "../chrome/capture-size";
import { type LastCaptureUi, getLastCaptureUi, setLastCaptureUi } from "../chrome/last-capture-ui";
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
import { dropPdfEditAccess, hasPdfEditAccess, PDF_EDIT_APP_URL, requestPdfEditAccess } from "../chrome/pdf-handoff";
import { getSavePrefs, resolveFilename, setSavePrefs } from "../chrome/save-prefs";
import { getCapturePrefs, setCapturePrefs, type StickyMode } from "../chrome/capture-prefs";
import { LOCALES, getLocale, initPageLocale, onLocaleChange, setLocale, t } from "../i18n";
import { ext } from "../platform/webext";
import type { CaptureReport, PopupRequest, PopupResponse } from "../types";

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
const resultActionsEl = $("resultActions");
const formatChoiceEl = $("formatChoice");
const formatChoiceLeadEl = $("formatChoiceLead");
const choosePdfNoteEl = $("choosePdfNote");
const choosePngNoteEl = $("choosePngNote");
const chooseEditorNoteEl = $("chooseEditorNote");
const pdfHandoffEl = $("pdfHandoff");
const pdfHandoffLeadEl = $("pdfHandoffLead");
const openPdfEditNoteEl = $("openPdfEditNote");
const prefOpenInPdfEditEl = $("prefOpenInPdfEdit") as HTMLInputElement;
const pdfEditRowEl = $("pdfEditRow");
const allButtons = document.querySelectorAll<HTMLButtonElement>("button");
const prefFilenameEl = $("prefFilename") as HTMLInputElement;
const customFolderNameEl = $("customFolderName");
const browseFolderBtn = $("browseFolder") as HTMLButtonElement;
const prefAskWhereEl = $("prefAskWhere") as HTMLInputElement;
const saveSummaryBtn = $("saveSummary") as HTMLButtonElement;
const saveSummaryTextEl = $("saveSummaryText");
const languageSummaryTextEl = $("languageSummaryText");
const languageSummaryItemEl = $("languageSummaryItem");
const settingsPanelEl = $("settingsPanel");
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

/**
 * The tickbox, and the access it depends on.
 *
 * A revoked permission has to turn the setting off rather than leave it
 * looking on: permissions are managed in the browser's own extension page,
 * where nothing knows this checkbox exists, and a tick that quietly does
 * nothing is worse than one that was never offered.
 */
async function loadPdfEditPref(): Promise<void> {
  const prefs = await getSavePrefs();
  const allowed = prefs.openInPdfEdit && (await hasPdfEditAccess());
  prefOpenInPdfEditEl.checked = allowed;
  if (prefs.openInPdfEdit && !allowed) await setSavePrefs({ openInPdfEdit: false });
}

prefOpenInPdfEditEl.addEventListener("change", async () => {
  if (!prefOpenInPdfEditEl.checked) {
    await setSavePrefs({ openInPdfEdit: false });
    // Handed back, rather than kept against the next time it might be wanted.
    // Nothing here should hold access to another site it has been told to
    // stop using.
    await dropPdfEditAccess();
    return;
  }
  // FIRST await in this handler, and it has to be: Firefox spends the user
  // gesture on the first one and then resolves request() false without ever
  // prompting. Same trap as ensureAuthAccess in auth-permission.ts.
  const granted = await requestPdfEditAccess();
  prefOpenInPdfEditEl.checked = granted;
  await setSavePrefs({ openInPdfEdit: granted });
  if (!granted) {
    setStatusText(t("OpenPdfEdit needs access to openpdfedit.com to receive the file."), true);
  }
});

loadPdfEditPref();

/**
 * Report a handoff that never landed, and take the badge back down.
 *
 * background/index.ts raises this when the PDF it set aside for OpenPdfEdit
 * was still sitting there after the grace period — i.e. the delivery script
 * never came for it. Before this, that failed silently: a tab opened, no
 * document arrived, and nothing anywhere said why.
 */
async function reportPdfHandoffFailure(): Promise<void> {
  const stored = await ext.storage.session.get("pdfHandoffFailed");
  if (!stored["pdfHandoffFailed"]) return;
  await ext.storage.session.remove("pdfHandoffFailed");
  try {
    await ext.action.setBadgeText({ text: "" });
  } catch {
    // Nothing to do; the message below is the part that matters.
  }
  const name = resolveFilename(await getSavePrefs(), "", "pdf");
  setStatusText(
    `Couldn't hand ${name} to OpenPdfEdit. The PDF is saved \u2014 open openpdfedit.com/app and pick it there.`,
    true,
  );
}

reportPdfHandoffFailure();

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
  // Just the destination now. The filename it used to carry is one line
  // down inside the panel, and dropping it is what makes room for the
  // language beside it.
  saveSummaryTextEl.textContent = destination;
  fitSummary();
}

/**
 * Show the language beside the destination only while both fit.
 *
 * The row is one line in a popup a little under 400px wide, and how much a
 * translation needs of it is not knowable in advance — "Einstellungen" and
 * "Configurações" are half again as long as "Settings" before either value
 * is added. So it is measured rather than guessed: reveal the language,
 * and if the row then wants more width than it has, take it away again.
 * Nothing is lost when that happens — both settings are one click inside.
 */
function fitSummary(): void {
  languageSummaryItemEl.hidden = false;
  if (saveSummaryBtn.scrollWidth > saveSummaryBtn.clientWidth) {
    languageSummaryItemEl.hidden = true;
  }
}

function refreshLanguageSummary(): void {
  const active = LOCALES.find((l) => l.code === getLocale());
  // The endonym, not a translation of it — same rule as the picker.
  languageSummaryTextEl.textContent = active?.name ?? getLocale();
  fitSummary();
}

saveSummaryBtn.addEventListener("click", () => {
  const open = settingsPanelEl.hidden;
  settingsPanelEl.hidden = !open;
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
    setSaveSummary(t("Ask each time"));
    browseFolderBtn.disabled = true;
    return;
  }
  browseFolderBtn.disabled = false;
  const handle = await getSavedDirectoryHandle();
  customFolderNameEl.textContent = handle ? handle.name : "Your Downloads folder (default)";
  setSaveSummary(handle ? handle.name : t("Downloads"));
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
    setStatusText(t('Now saving to "{name}".', { name: result.name }));
  } else if (!result.cancelled) {
    setStatusText(t("Couldn't set that folder: {error}", { error: result.error }), true);
  }
  await refreshCustomFolder();
});

// --- language ----------------------------------------------------------
//
// The picker is built here rather than written into the markup: the option
// labels are endonyms, and hand-writing eight <option> tags means eight
// more places to forget when the locale list changes.
const prefLanguageEl = $("prefLanguage") as HTMLSelectElement;

function buildLanguagePicker(): void {
  prefLanguageEl.replaceChildren(
    ...LOCALES.map(({ code, name }) => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = name;
      // 日本語 stays 日本語 in every locale — see localizeDom's skip rule.
      option.setAttribute("data-i18n-skip", "");
      return option;
    }),
  );
  prefLanguageEl.value = getLocale();
}

prefLanguageEl.addEventListener("change", () => {
  setLocale(prefLanguageEl.value);
});

// initPageLocale retranslates everything the markup holds. These are the
// strings this file computed and put on screen itself, whose English is
// long gone by the time a DOM walk could look for it.
onLocaleChange(() => {
  prefLanguageEl.value = getLocale();
  refreshLanguageSummary();
  void refreshCustomFolder();
  void restoreLastCaptureUi();
});

initPageLocale();
buildLanguagePicker();
refreshLanguageSummary();

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
  if (ui.openedEditor) return t("Opened in editor — crop, annotate, then choose PNG or PDF to save.");
  if (isChoicePending(ui)) return t("Captured. Nothing saved yet — choose how to keep it.");
  return t("Done.");
}

const count = new Intl.NumberFormat();

/** Whether this capture is still waiting on the user to say how to keep it. */
function isChoicePending(ui: LastCaptureUi): boolean {
  return !ui.openedEditor && !ui.formatChosen && needsFormatChoice(ui.report);
}

/**
 * Offer the three ways to keep a capture too long to finish automatically.
 *
 * Each option says what it costs rather than only what it is. That is the
 * point of asking: a capture this size cannot be kept whole, editable, and
 * in one file all at once, and which of those to give up is not a decision
 * this extension can make from the pixel count.
 */
function showFormatChoice(report: CaptureReport): void {
  const width = report.output_width_px;
  const height = report.output_height_px;
  const parts = report.output_image_count;
  formatChoiceLeadEl.textContent = t(
    "This capture is {width} × {height} pixels — too long to keep whole and editable at once. Choose how to keep it:",
    { width: count.format(width), height: count.format(height) },
  );
  choosePdfNoteEl.textContent = t("One file, the whole page, nothing dropped. Edit it at openpdfedit.com/app.");
  choosePngNoteEl.textContent =
    parts > 1
      ? `${parts} separate images — the page is past what one PNG holds. Editing isn't possible.`
      : "One image, the whole page. Editing isn't possible at this size.";
  // Two different limits, and quoting the wrong one is a promise the editor
  // will not keep. A split capture hands the editor part 1 — whose height is
  // shot-core's business, not this file's — so it says "part 1" rather than
  // a row count it would have to derive from plan.rs's split rule. An
  // unsplit one is cut by the editable budget, which is known exactly here.
  chooseEditorNoteEl.textContent =
    parts > 1
      ? `Annotate part 1 of ${parts} only. The rest is kept, but not shown there.`
      : `Annotate the first ${count.format(editableHeightFor(width, height))} rows of ${count.format(height)}. The rest is kept, but not shown there.`;
  formatChoiceEl.hidden = false;
  // Not both: the row of small actions underneath offers two of these three
  // again, unlabelled and without the cost attached, which is exactly the
  // sight-unseen click this panel exists to replace.
  resultActionsEl.hidden = true;
  // The tickbox follows the PDF option into the list, rather than sitting
  // under all three where it reads as a setting on the whole panel. It is
  // moved rather than duplicated: two checkboxes for one preference is two
  // things to keep in step, and they would disagree the first time one of
  // them was missed.
  $("choosePdf").insertAdjacentElement("afterend", pdfEditRowEl);
  syncPdfEditRow();
}

function hideFormatChoice(): void {
  formatChoiceEl.hidden = true;
  resultActionsEl.hidden = false;
  // Back under the actions, beneath the PDF button it belongs to there.
  resultActionsEl.insertAdjacentElement("afterend", pdfEditRowEl);
  syncPdfEditRow();
}

/**
 * Carry out one of the three, and stop asking.
 *
 * The answer is recorded rather than kept in this popup, which does not
 * survive its own tab losing focus — without that, every reopen would put
 * the same question again to someone who has already answered it.
 */
async function takeFormatChoice(request: PopupRequest, busyMessage: string): Promise<void> {
  const ui = await getLastCaptureUi();
  if (ui) await setLastCaptureUi({ ...ui, formatChosen: true });
  hideFormatChoice();
  const ok = await runCapture(request, busyMessage);
  if (ok && request.action === "exportPdf" && !request.handoff) await showPdfHandoff();
}

/**
 * Where a PDF of a page this long actually gets edited.
 *
 * Offered only after the PDF answer to a too-long capture, which is the one
 * case where this extension's own editor is not an option — it was just
 * turned down for being unable to hold the page. Leaving the user with a
 * file and no idea what opens it is the gap this closes.
 *
 * It opens the site rather than the file. openpdfedit.com/app takes a PDF
 * only through a file picker its own page opens — it has no drop zone, no
 * file_handlers, and no URL intake (checked against the deployed build) —
 * and nothing outside a page can fill a native picker. So the panel says
 * which file to choose instead of pretending it will arrive on its own.
 */
async function showPdfHandoff(): Promise<void> {
  const filename = resolveFilename(await getSavePrefs(), "", "pdf");
  pdfHandoffLeadEl.textContent = t("Saved as {filename}.", { filename });
  openPdfEditNoteEl.textContent = t(
    "Opens openpdfedit.com/app with {filename} already in it. Nothing is uploaded — it edits on your own machine.",
    { filename },
  );
  pdfHandoffEl.hidden = false;
}

async function restoreLastCaptureUi(): Promise<void> {
  const ui = await getLastCaptureUi();
  if (!ui) return;

  reportEl.style.display = "block";
  reportEl.textContent = JSON.stringify(ui.report, null, 2);

  exportPdfBtn.disabled = false;
  copyBtn.disabled = false;
  openEditorBtn.disabled = false;
  // Before the preview, deliberately. The capture this asks about is the
  // large kind by definition, and reading tens of megabytes of PNG out of
  // the store to show a thumbnail of it takes long enough to be visible —
  // during which the popup would be sitting there with no sign that it is
  // waiting on an answer. The question does not depend on the picture.
  syncPdfEditRow();
  if (isChoicePending(ui)) showFormatChoice(ui.report);
  setStatusText(captureStatusText(ui));

  const bytes = await getBlob(LAST_CAPTURE_BLOB_KEY);
  if (bytes) {
    previewEl.style.display = "block";
    previewEl.src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
  }
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
  syncPdfEditRow(busy);
}

/**
 * The tickbox belongs to the PDF button and appears with it.
 *
 * It used to sit in the card unconditionally, which put it under "No capture
 * yet", under the progress bar of a capture still running, and under the
 * result of a save that had nothing to do with PDFs — a setting offering an
 * opinion about a file that did not exist. Tied to the one button it affects,
 * there is nowhere left for it to turn up uninvited.
 */
function syncPdfEditRow(busy = false): void {
  pdfEditRowEl.hidden = busy || exportPdfBtn.disabled;
}

async function send(request: PopupRequest): Promise<PopupResponse> {
  return ext.runtime.sendMessage(request);
}

async function showCaptureResult(response: PopupResponse): Promise<void> {
  if (!response.ok) {
    setStatusText(t("Error: {error}", { error: response.error }), true);
    return;
  }
  if ("cancelled" in response) {
    // Deliberately doesn't touch reportEl/previewEl/persisted state — a
    // cancelled selection leaves whatever the previous capture's state
    // was fully intact, exactly like an error does.
    setStatusText(t("Selection cancelled."));
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
    const ui: LastCaptureUi = { report: response.report, openedEditor: response.openedEditor };
    if (isChoicePending(ui)) showFormatChoice(response.report);
    setStatusText(captureStatusText(ui));
  } else {
    setStatusText(t("Done."));
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

/** Resolves true when the request came back without an error. */
async function runCapture(request: PopupRequest, busyMessage: string): Promise<boolean> {
  captureBusyMessage = busyMessage.replace(/…$/, "");
  // Zero-width to start: the bar appears the moment work begins, rather than
  // popping into existence at the first slice.
  showCaptureProgress(0);
  setBusy(true, busyMessage);
  let ok = false;
  try {
    const response = await send(request);
    ok = response.ok;
    await showCaptureResult(response);
  } catch (err) {
    setStatusText(t("Error: {error}", { error: err instanceof Error ? err.message : String(err) }), true);
  } finally {
    // Stop listening for progress before the next click can start: a late
    // message from a finished capture would otherwise overwrite its result.
    captureBusyMessage = "";
    showCaptureProgress(null);
    setBusy(false);
  }
  return ok;
}

$("captureFullPage").addEventListener("click", () => runCapture({ action: "captureFullPage" }, t("Capturing full page…")));
$("captureVisible").addEventListener("click", () => runCapture({ action: "captureVisible" }, t("Capturing visible area…")));
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
$("openPdfEdit").addEventListener("click", async () => {
  // FIRST await, for the gesture — see the tickbox handler above.
  const granted = await requestPdfEditAccess();
  pdfHandoffEl.hidden = true;
  if (!granted) {
    // Still worth opening: the file is saved, and picking it by hand is the
    // thing this was trying to save them, not the thing it replaced.
    ext.tabs.create({ url: PDF_EDIT_APP_URL });
    setStatusText(t("Opened OpenPdfEdit — choose {filename} there.", { filename: resolveFilename(await getSavePrefs(), "", "pdf") }));
    return;
  }
  await runCapture({ action: "openPdfEdit" }, t("Opening OpenPdfEdit…"));
});
$("pdfHandoffDismiss").addEventListener("click", () => {
  pdfHandoffEl.hidden = true;
});
$("choosePdf").addEventListener("click", () =>
  takeFormatChoice(
    { action: "exportPdf", handoff: prefOpenInPdfEditEl.checked },
    prefOpenInPdfEditEl.checked ? t("Exporting PDF and opening OpenPdfEdit…") : t("Exporting PDF…"),
  ),
);
$("choosePng").addEventListener("click", () => takeFormatChoice({ action: "savePngs" }, t("Saving PNG…")));
$("chooseEditor").addEventListener("click", () => takeFormatChoice({ action: "openEditor" }, t("Opening editor…")));
// The same follow-up as the format panel's PDF answer, because it is the
// same file and the same question. Wiring it only to the panel meant anyone
// who reached for this button — the ordinary way to get a PDF — was told
// nothing at all, which read as the offer being broken rather than absent.
exportPdfBtn.addEventListener("click", async () => {
  const handoff = prefOpenInPdfEditEl.checked;
  const ok = await runCapture(
    { action: "exportPdf", handoff },
    handoff ? t("Exporting PDF and opening OpenPdfEdit…") : t("Exporting PDF…"),
  );
  // Nothing to offer when it has already gone: the tab is opening as this
  // runs, and this popup is about to be torn down by it.
  if (ok && !handoff) await showPdfHandoff();
});
openEditorBtn.addEventListener("click", () => runCapture({ action: "openEditor" }, t("Opening editor…")));

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
    setStatusText(t("Copied to clipboard."));
  } catch (err) {
    setStatusText(t("Error: {error}", { error: err instanceof Error ? err.message : String(err) }), true);
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
