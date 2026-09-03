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
  innerScrollRect: (SelectedRect & { headerCss: number }) | null;
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
  | { action: "captureFullPage" }
  | { action: "captureVisible" }
  | { action: "captureSelectedArea" }
  | { action: "exportPdf" }
  | { action: "openEditor" };

export interface CaptureResult {
  ok: true;
  report: CaptureReport;
  pngDataUrls: string[];
  // True when the capture produced exactly one image and was routed to the
  // editor for crop/annotate/format review instead of being downloaded
  // immediately. False for the (rare, very-long-page) multi-image PNG case,
  // which still auto-downloads every part — see background/index.ts.
  openedEditor: boolean;
}

export interface AckResult {
  ok: true;
}

export interface CancelledResult {
  ok: true;
  cancelled: true;
}

export interface CaptureFailure {
  ok: false;
  error: string;
}

export type PopupResponse = CaptureResult | AckResult | CancelledResult | CaptureFailure;
