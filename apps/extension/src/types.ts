// Shared across background/popup only (never imported by content/index.ts,
// which must stay import-free — see its module doc). `import type` uses
// here are erased at compile time regardless, but non-content files may
// also import the runtime `Msg` helpers below.

export interface PageMetrics {
  viewportWidthCss: number;
  viewportHeightCss: number;
  totalHeightCss: number;
  dpr: number;
}

export interface CaptureReport {
  css_width: number;
  css_height: number;
  dpr: number;
  slice_count: number;
  output_width_px: number;
  output_height_px: number;
  output_image_count: number;
  lazy_images_forced: number;
  pinned_elements_handled: number;
  aborted: boolean;
  warnings: string[];
}

export type ContentRequest =
  | { action: "prep"; sticky: "keep" | "remove" }
  | { action: "scrollTo"; targetCss: number }
  | { action: "reassert" }
  | { action: "restore" }
  | { action: "selectArea" };

export interface PrepResponse {
  metrics: PageMetrics;
  pinnedElementsHandled: number;
  lazyImagesForced: number;
  warnings: string[];
  // Set when the page has an inner scrollable container dominant enough
  // (see content/index.ts's detectDominantScroller) that it's more useful
  // to capture its full scrolled content than just what the outer page
  // scroll shows. CSS px, viewport-relative — orchestrator.ts crops every
  // slice to this rect instead of using the whole captured viewport.
  /**
   * The scrolling element's box, plus how much of the window sits above it —
   * a global header, typically, which is not part of what scrolls and would
   * otherwise be cropped out of the capture entirely.
   */
  innerScrollRect: (SelectedRect & { headerCss: number; windowWidthCss: number }) | null;
}

export interface ScrollToResponse {
  actualScrollCss: number;
}

export interface RestoreResponse {
  ok: true;
}

export interface SelectedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An exact pixel size the user asked the selection to be delivered at. */
export interface OutputSize {
  width: number;
  height: number;
}

export interface SelectAreaResponse {
  rect: SelectedRect | null;
  dpr: number;
  /**
   * Present when the user typed a target size into the selection overlay.
   * The crop is resampled to exactly this, so the drag only has to get the
   * framing right — not the pixel count.
   */
  target?: OutputSize | null;
}

export type ContentResponse = PrepResponse | ScrollToResponse | RestoreResponse | SelectAreaResponse;

export type PopupRequest =
  // Does nothing, deliberately. Its only job is to come back: awaiting a
  // reply is how a caller learns the service worker is running and has its
  // message listener registered. See popup.ts's selected-area handler.
  | { action: "ping" }
  // `detached`: the popup has closed itself (or is about to) and the capture
  // must wait for the page to be back in front before touching it — how
  // these run on Android, where the popup covers the page. A failure is kept
  // for the next popup to show, since this one will not be there to hear it.
  // See background/target-tab.ts.
  | { action: "captureFullPage"; detached?: boolean }
  | { action: "captureVisible" }
  | { action: "captureSelectedArea"; detached?: boolean }
  // `handoff` chains the export straight into OpenPdfEdit, so the one click
  // that asked for a PDF also carries it there — the alternative being a
  // second gesture for something the user already said yes to.
  //
  // `inPage` asks for the file back instead of a download from here. Firefox
  // for Android's downloads.download() never settles — no id, no error, no
  // file — so on Android the page the user is looking at saves it, with a
  // download link (chrome/downloads.ts).
  | { action: "exportPdf"; handoff?: boolean; inPage?: boolean }
  | { action: "savePngs"; inPage?: boolean }
  | { action: "openPdfEdit" }
  | { action: "openEditor" };

export interface CaptureResult {
  ok: true;
  report: CaptureReport;
  pngDataUrls: string[];
  // True when the capture was routed to the editor for crop/annotate/format
  // review. False when it was too long for that (see capture-size.ts's
  // needsFormatChoice), in which case nothing has been written or opened at
  // all and the popup asks how the user wants to keep it — the one decision
  // this extension does not make on their behalf, because PNG, PDF and the
  // editor each lose something different.
  openedEditor: boolean;
}

export interface AckResult {
  ok: true;
  /** The files an `inPage` request asked for, for the page to save. */
  files?: OutputFile[];
  /** A tab now shows the result (Android's PDF viewer); the popup should go. */
  closePopup?: boolean;
}

/** One file to save: the bytes, and the parts saveOutput() names it from. */
export interface OutputFile {
  bytes: Uint8Array;
  suffix: string;
  ext: string;
  mime: string;
}

export interface CancelledResult {
  ok: true;
  cancelled: true;
}

export interface CaptureFailure {
  ok: false;
  error: string;
  /**
   * What kind of failure, for a surface that can translate it. Absent on
   * older messages and on anything that was never classified, which the
   * popup treats as "show the text as given".
   */
  reason?: "restricted-page" | "needs-refresh" | "file-access" | "page-unreachable" | "page-not-in-front" | "raw";
}

export type PopupResponse = CaptureResult | AckResult | CancelledResult | CaptureFailure;
