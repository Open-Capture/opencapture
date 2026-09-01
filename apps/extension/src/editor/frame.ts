// Draws a browser window around a capture, the way people present screenshots
// in docs and posts.
//
// The chrome is drawn rather than screenshotted: the extension never sees the
// real window, and even if it could, a captured frame would carry the user's
// tabs, bookmarks and profile picture into every image they share.
//
// Sizes are in CSS px and scaled by the capture's own dpr at draw time, so a
// retina capture gets a proportionate frame instead of a hairline one.

export type FramePreset = "none" | "macos" | "windows" | "caption";

export interface FrameOptions {
  preset: FramePreset;
  url: string;
  /** Capture time; only read when showDate or showTime is set. */
  capturedAt: number;
  showUrl: boolean;
  showDate: boolean;
  showTime: boolean;
}

export interface FrameMetrics {
  /** Chrome above the image. */
  top: number;
  /** Chrome below it — the caption strip, when there is one. */
  bottom: number;
  side: number;
}

const BAR_HEIGHT = 38;
const CAPTION_HEIGHT = 30;
const SIDE = 1;

/**
 * How much room the chrome needs. Separate from the drawing so the editor can
 * size the new canvas before committing to it, and so the arithmetic is
 * testable without a canvas at all.
 */
export function frameMetrics(preset: FramePreset): FrameMetrics {
  switch (preset) {
    case "macos":
    case "windows":
      return { top: BAR_HEIGHT, bottom: SIDE, side: SIDE };
    case "caption":
      return { top: 0, bottom: CAPTION_HEIGHT, side: 0 };
    default:
      return { top: 0, bottom: 0, side: 0 };
  }
}

/**
 * The same chrome, in device pixels — what the canvas is actually sized in.
 *
 * Exported because removing a frame is the exact inverse of drawing one: the
 * editor crops these insets back off before applying a different preset, and
 * if the two ever rounded differently the crop would shave a pixel row off
 * the screenshot (or leave a sliver of the old chrome) every time the preset
 * changed. One function, so they cannot drift.
 */
export function framePixelInsets(preset: FramePreset, dpr: number): FrameMetrics {
  const s = Math.max(1, dpr);
  const m = frameMetrics(preset);
  return { top: Math.round(m.top * s), bottom: Math.round(m.bottom * s), side: Math.round(m.side * s) };
}

/**
 * The timestamp as it appears in the frame. Empty when neither part was asked
 * for, so callers can skip the draw rather than paint an empty string.
 */
export function formatStamp(capturedAt: number, showDate: boolean, showTime: boolean): string {
  if (!showDate && !showTime) return "";
  const d = new Date(capturedAt);
  const date = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (showDate && showTime) return `${date}, ${time}`;
  return showDate ? date : time;
}

/**
 * Trim a URL to what fits, from the end, keeping the origin visible — the part
 * that says whose page this is. A middle ellipsis would keep a path segment
 * nobody needs at the cost of the hostname.
 */
export function fitUrl(ctx: CanvasRenderingContext2D, url: string, maxWidth: number): string {
  if (ctx.measureText(url).width <= maxWidth) return url;
  let text = url;
  while (text.length > 1 && ctx.measureText(`${text}…`).width > maxWidth) {
    text = text.slice(0, -1);
  }
  return `${text}…`;
}

interface Palette {
  chrome: string;
  border: string;
  field: string;
  fieldBorder: string;
  text: string;
  muted: string;
}

const MACOS: Palette = {
  chrome: "#e8e6e4",
  border: "#c9c5c1",
  field: "#ffffff",
  fieldBorder: "#d6d2ce",
  text: "#33312f",
  muted: "#6f6a66",
};

const WINDOWS: Palette = {
  chrome: "#dee1e6",
  border: "#c3c7cc",
  field: "#ffffff",
  fieldBorder: "#c9ced4",
  text: "#2b2f33",
  muted: "#5f6469",
};

/**
 * Compose `source` inside the chosen frame and return the new canvas.
 *
 * Returns null for "none" so the caller can leave the image untouched rather
 * than round-trip it through a copy that changes nothing.
 */
export function drawFrame(source: HTMLCanvasElement, options: FrameOptions, dpr: number): HTMLCanvasElement | null {
  if (options.preset === "none") return null;

  const s = Math.max(1, dpr);
  const { top, bottom, side } = framePixelInsets(options.preset, dpr);

  const out = document.createElement("canvas");
  out.width = source.width + side * 2;
  out.height = source.height + top + bottom;
  const ctx = out.getContext("2d");
  if (!ctx) return null;

  const stamp = formatStamp(options.capturedAt, options.showDate, options.showTime);
  const palette = options.preset === "windows" ? WINDOWS : MACOS;

  if (options.preset === "caption") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(source, 0, 0);
    drawCaption(ctx, out.width, source.height, bottom, s, options, stamp);
  } else {
    ctx.fillStyle = palette.chrome;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(source, side, top);
    if (options.preset === "macos") drawMacBar(ctx, out.width, top, s, palette, options, stamp);
    else drawWindowsBar(ctx, out.width, top, s, palette, options, stamp);
    // A hairline around the whole thing so a white capture on a white page
    // still reads as a window.
    ctx.strokeStyle = palette.border;
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, out.width - ctx.lineWidth, out.height - ctx.lineWidth);
  }

  return out;
}

function drawCaption(
  ctx: CanvasRenderingContext2D,
  width: number,
  imageHeight: number,
  bottom: number,
  s: number,
  options: FrameOptions,
  stamp: string,
): void {
  ctx.fillStyle = "#f4f4f5";
  ctx.fillRect(0, imageHeight, width, bottom);
  ctx.fillStyle = "#d4d4d8";
  ctx.fillRect(0, imageHeight, width, Math.max(1, s));

  const pad = 12 * s;
  const mid = imageHeight + bottom / 2;
  ctx.textBaseline = "middle";
  ctx.font = `${Math.round(12 * s)}px system-ui, -apple-system, "Segoe UI", sans-serif`;

  if (stamp) {
    ctx.fillStyle = "#71717a";
    ctx.textAlign = "right";
    ctx.fillText(stamp, width - pad, mid);
  }
  if (options.showUrl && options.url) {
    ctx.fillStyle = "#3f3f46";
    ctx.textAlign = "left";
    const room = width - pad * 2 - (stamp ? ctx.measureText(stamp).width + pad : 0);
    ctx.fillText(fitUrl(ctx, options.url, room), pad, mid);
  }
}

/** Traffic lights, then the URL centred in a pill — Safari's arrangement. */
function drawMacBar(
  ctx: CanvasRenderingContext2D,
  width: number,
  top: number,
  s: number,
  palette: Palette,
  options: FrameOptions,
  stamp: string,
): void {
  ctx.fillStyle = palette.border;
  ctx.fillRect(0, top - Math.max(1, s), width, Math.max(1, s));

  const r = 6 * s;
  const cy = top / 2;
  ["#ff5f57", "#febc2e", "#28c840"].forEach((colour, i) => {
    ctx.beginPath();
    ctx.arc(16 * s + i * 20 * s, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
  });

  drawAddress(ctx, width, top, s, palette, options, stamp, { left: 92 * s, centred: true });
}

/** Address field left, window buttons right — Chrome on Windows. */
function drawWindowsBar(
  ctx: CanvasRenderingContext2D,
  width: number,
  top: number,
  s: number,
  palette: Palette,
  options: FrameOptions,
  stamp: string,
): void {
  ctx.fillStyle = palette.border;
  ctx.fillRect(0, top - Math.max(1, s), width, Math.max(1, s));

  const cy = top / 2;
  const right = width - 14 * s;
  ctx.strokeStyle = palette.muted;
  ctx.lineWidth = Math.max(1, s);
  // minimise
  ctx.beginPath();
  ctx.moveTo(right - 44 * s, cy);
  ctx.lineTo(right - 34 * s, cy);
  ctx.stroke();
  // maximise
  ctx.strokeRect(right - 24 * s, cy - 5 * s, 10 * s, 10 * s);
  // close
  ctx.beginPath();
  ctx.moveTo(right - 10 * s, cy - 5 * s);
  ctx.lineTo(right, cy + 5 * s);
  ctx.moveTo(right, cy - 5 * s);
  ctx.lineTo(right - 10 * s, cy + 5 * s);
  ctx.stroke();

  drawAddress(ctx, width, top, s, palette, options, stamp, { left: 14 * s, centred: false, rightInset: 60 * s });
}

function drawAddress(
  ctx: CanvasRenderingContext2D,
  width: number,
  top: number,
  s: number,
  palette: Palette,
  options: FrameOptions,
  stamp: string,
  layout: { left: number; centred: boolean; rightInset?: number },
): void {
  ctx.font = `${Math.round(12 * s)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = "middle";
  const cy = top / 2;

  let stampWidth = 0;
  if (stamp) {
    ctx.fillStyle = palette.muted;
    ctx.textAlign = "right";
    const stampRight = width - (layout.rightInset ?? 0) - 14 * s;
    ctx.fillText(stamp, stampRight, cy);
    stampWidth = ctx.measureText(stamp).width + 16 * s;
  }

  if (!options.showUrl || !options.url) return;

  const fieldHeight = 22 * s;
  const right = width - (layout.rightInset ?? 0) - 14 * s - stampWidth;
  const fieldWidth = Math.max(40 * s, right - layout.left);
  const x = layout.centred ? Math.max(layout.left, (width - fieldWidth) / 2) : layout.left;

  ctx.fillStyle = palette.field;
  ctx.strokeStyle = palette.fieldBorder;
  ctx.lineWidth = Math.max(1, s);
  const radius = fieldHeight / 2;
  ctx.beginPath();
  ctx.roundRect(x, cy - fieldHeight / 2, fieldWidth, fieldHeight, radius);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = palette.text;
  ctx.textAlign = "left";
  ctx.fillText(fitUrl(ctx, options.url, fieldWidth - 20 * s), x + 10 * s, cy);
}
