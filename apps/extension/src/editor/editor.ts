// Annotation editor: opened in its own tab after a capture (see
// background/index.ts's "openEditor" handler). Pure TypeScript/canvas for
// the annotation tools — interactive UI, not correctness-critical
// geometry, so per the project's Rust/TS split they don't route through
// shot-core. (Contrast with capture/crop/stitch, which are Rust precisely
// because those results get asserted on in tests — see PLAN.md.) PDF
// export is the one thing here that *does* route through shot-core's wasm
// build, since PDF page geometry is exactly the kind of pixel-correctness
// code the project keeps in Rust — see wasm-loader below.
import { EDITOR_IMAGE_PORT_NAME } from "../chrome/blob-store";
import { copyPngBytesToClipboard } from "../chrome/copy-image";
import { getSavedDirectoryHandle } from "../chrome/dir-handle-store";
import { client as openappsClient, ready as openappsReady, store as openappsStore, OPENAPPS_BASE_URL, OPENAPPS_GATEWAY_URL } from "../chrome/openapps-session";
import { pickDirectory } from "../chrome/pick-directory";
import { saveOutput } from "../chrome/save";
import { getSavePrefs, setSavePrefs } from "../chrome/save-prefs";
import { clearWatermarkLogoDataUrl, getWatermarkLogoDataUrl, setWatermarkLogoDataUrl } from "../chrome/watermark-logo-store";
import { isDoubleTap, type TapState } from "./double-tap";
import { drawFrame, framePixelInsets, type FramePreset } from "./frame";
import { applyWatermarkPattern, drawWatermarkCell, type WatermarkLocation } from "../../vendor-private/watermark-premium/src/watermark";
import init, * as ShotCore from "../wasm-gen/shot_core.js";
import { ext } from "../platform/webext";

type Tool = "select" | "crop" | "arrow" | "rect" | "text" | "blur" | "watermark" | null;

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
// willReadFrequently: this canvas only does getImageData() readback at
// actual commit points now (see previewCanvas below for why it's no
// longer doing so on every mousemove) — still a cheap, correct hint for
// those occasional reads.
const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
// Live drag previews (arrow/rect/blur outline, crop marquee+handles) draw
// here instead of on `canvas` — see editor.html's comment on
// #previewCanvas. This canvas is GPU-backed (no willReadFrequently; we
// never read pixels back from it) and only ever cleared/drawn with cheap
// shape primitives, so its cost is independent of the main capture's
// resolution — unlike the getImageData/putImageData round-trip the old
// "restore snapshot, redraw" approach did on `canvas` itself every single
// mousemove, which is what made dragging (blur especially, since users
// drag it slowly and deliberately) very laggy on a large capture.
const previewCanvas = document.getElementById("previewCanvas") as HTMLCanvasElement;
const previewCtx = previewCanvas.getContext("2d")!;
const canvasWrap = document.getElementById("canvasWrap") as HTMLDivElement;
const statusEl = document.getElementById("status")!;
const toolButtons = document.querySelectorAll<HTMLButtonElement>("#toolbar button[data-tool]");
const cropBar = document.getElementById("cropBar") as HTMLDivElement;
const cropApplyBtn = document.getElementById("cropApply") as HTMLButtonElement;
const cropCancelBtn = document.getElementById("cropCancel") as HTMLButtonElement;

let currentTool: Tool = null;
let currentDpr = 1;

// Two kinds, because "before" state costs very different amounts to
// capture depending on what changed. Crop resizes canvas.width/height, so
// undoing it needs the whole prior canvas back — a plain ImageData (which
// putImageData will silently clip instead of resizing the canvas back to)
// isn't enough on its own, hence "full" carrying its own dimensions.
// Arrow/rect/blur/text never resize the canvas and only ever touch a
// small region of it — capturing the whole canvas for those (as this used
// to do unconditionally) meant every commit after the first paid a
// multi-megapixel getImageData/putImageData cost on a full-page capture,
// regardless of how small the shape actually was. "region" captures just
// the bounding box commitPendingShape() is about to touch — see
// shapeBoundingBox() below.
// "regions" (plural): a watermark pattern can touch more than one
// disjoint area in a single action (top AND bottom, say) — snapshotting
// their bounding box would cover everything in between too, which for a
// tall page is the same full-canvas cost region snapshots exist to avoid.
// A list of independent regions restores together as one undo step
// instead.
type Snapshot =
  // `frame` rides along on full snapshots so undo/redo restores *which frame
  // is on the image*, not just the pixels. Without it, undoing a frame would
  // leave the editor believing a frame it just removed was still there, and
  // the next apply would crop chrome off a picture that no longer has any.
  | { kind: "full"; width: number; height: number; data: ImageData; frame?: FramePreset }
  | { kind: "region"; x: number; y: number; data: ImageData }
  | { kind: "regions"; regions: { x: number; y: number; data: ImageData }[] };

const undoBtn = document.getElementById("undo") as HTMLButtonElement;
const redoBtn = document.getElementById("redo") as HTMLButtonElement;
const undoCountEl = document.getElementById("undoCount") as HTMLSpanElement;
const redoCountEl = document.getElementById("redoCount") as HTMLSpanElement;

const undoStack: Snapshot[] = [];
const redoStack: Snapshot[] = [];
const MAX_HISTORY = 20;

/**
 * Snapshot whatever the canvas currently holds under `like`'s footprint.
 *
 * Undo entries record the pixels as they were *before* an edit, which is all
 * you need to step backwards. Stepping forward again needs the opposite, and
 * the cheapest way to get it is to photograph the same footprint just before
 * restoring — so an undo produces its own redo entry, of the same kind and
 * cost, rather than the history storing two copies of everything up front.
 */
function inverseOf(like: Snapshot): Snapshot {
  if (like.kind === "full") {
    return { kind: "full", width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height), frame: appliedFrame };
  }
  if (like.kind === "region") {
    return { kind: "region", x: like.x, y: like.y, data: ctx.getImageData(like.x, like.y, like.data.width, like.data.height) };
  }
  return {
    kind: "regions",
    regions: like.regions.map((r) => ({ x: r.x, y: r.y, data: ctx.getImageData(r.x, r.y, r.data.width, r.data.height) })),
  };
}

function applySnapshot(snap: Snapshot): void {
  if (snap.kind === "full") {
    canvas.width = snap.width;
    canvas.height = snap.height;
    ctx.putImageData(snap.data, 0, 0);
    // Only frame steps record this; a crop's snapshot leaves it undefined
    // because a crop does not change which frame is on the image.
    if (snap.frame !== undefined) appliedFrame = snap.frame;
    syncPreviewCanvas(); // canvas dimensions may have just changed (undoing a crop)
  } else if (snap.kind === "region") {
    ctx.putImageData(snap.data, snap.x, snap.y);
  } else {
    for (const region of snap.regions) ctx.putImageData(region.data, region.x, region.y);
  }
}

/**
 * The single place an edit enters history. Every new edit drops the redo
 * stack: once you branch off, the steps that were ahead of you describe a
 * future that no longer exists.
 */
function pushHistory(snap: Snapshot): void {
  undoStack.push(snap);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  refreshHistoryUi();
}

function refreshHistoryUi(): void {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
  // Blank rather than "0": a zero next to a greyed-out button is noise, and
  // the disabled state already says there is nothing to step through.
  undoCountEl.textContent = undoStack.length > 0 ? String(undoStack.length) : "";
  redoCountEl.textContent = redoStack.length > 0 ? String(redoStack.length) : "";
}

/** Keeps previewCanvas's on-screen position/size matching `canvas`'s own
 * (post max-width:100% scaling, post margin:auto centering) rendered box.
 * Must run after anything that changes canvas.width/height (load, crop,
 * undo) or could change its rendered size (window resize). offsetLeft/
 * offsetTop/clientWidth/clientHeight read canvas's own already-computed
 * layout — simpler and more robust than re-deriving the same max-width/
 * centering math by hand.
 *
 * previewCanvas's *backing buffer* is deliberately sized to its own
 * rendered CSS box (× devicePixelRatio), not to `canvas`'s full native
 * resolution — a full-page capture's buffer can be tens of millions of
 * pixels, and clearing + compositing a buffer that large on every single
 * mousemove was still expensive even with nothing but cheap shape draws on
 * it (the earlier fix here removed the getImageData/putImageData stall,
 * not this one — the GPU still has to push every pixel of whatever's
 * actually in the buffer each frame, regardless of how cheap the draw
 * calls that filled it were). A canvas 2D scale transform maps every draw
 * call below back onto this smaller buffer, so every call site still
 * thinks and works purely in `canvas`'s own buffer-space coordinates. */
function syncPreviewCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  previewCanvas.width = width;
  previewCanvas.height = height;
  previewCanvas.style.left = `${canvas.offsetLeft}px`;
  previewCanvas.style.top = `${canvas.offsetTop}px`;
  previewCanvas.style.width = `${canvas.clientWidth}px`;
  previewCanvas.style.height = `${canvas.clientHeight}px`;
  // Every draw call targeting previewCtx passes coordinates in `canvas`'s
  // buffer space (canvas.width/height) — this scale maps that space onto
  // previewCanvas's much smaller actual buffer. Resizing a canvas resets
  // its transform, so this has to be reapplied every time width/height
  // change above, not just once at startup.
  previewCtx.setTransform(width / canvas.width, 0, 0, height / canvas.height, 0, 0);
}

// Clears in `canvas`'s buffer-space coordinates (not previewCanvas's own,
// much smaller, physical pixel dimensions) — clearRect is subject to the
// same scale transform as every other draw call, so this is the size that
// actually covers the whole (transformed) buffer.
function clearPreview(): void {
  previewCtx.clearRect(0, 0, canvas.width, canvas.height);
}

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function undo(): void {
  // A pending (not-yet-applied) crop marquee or shape (arrow/rect/blur/
  // text) lives on previewCanvas, outside the undo stack entirely —
  // discard it first rather than treating Undo as "pop the real stack",
  // so it doesn't survive past whatever undo() restores underneath it.
  if (pendingCrop) {
    cancelPendingCrop();
    return;
  }
  if (pendingShape) {
    cancelPendingShape();
    return;
  }
  const prev = undoStack.pop();
  if (!prev) return;
  // Photograph the current state before overwriting it — that is the redo.
  redoStack.push(inverseOf(prev));
  applySnapshot(prev);
  refreshHistoryUi();
}

function redo(): void {
  // Discard a pending crop/shape first, exactly as undo does: it lives on
  // previewCanvas outside history, and letting it survive a redo would leave
  // it floating over content it was never drawn against.
  if (pendingCrop) {
    cancelPendingCrop();
    return;
  }
  if (pendingShape) {
    cancelPendingShape();
    return;
  }
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(inverseOf(next));
  applySnapshot(next);
  refreshHistoryUi();
}

function selectTool(tool: Tool): void {
  if (pendingCrop && tool !== "crop") cancelPendingCrop();
  // Unlike the crop marquee (discarded on tool switch), a drawn shape is
  // actual content the user made — switching away bakes it in instead of
  // losing it. Switching *to* Select is the one exception, since that's
  // specifically "let me keep adjusting what's already there."
  if (pendingShape && tool !== "select") commitPendingShape();
  currentTool = tool;
  toolButtons.forEach((b) => b.classList.toggle("active", b.dataset["tool"] === tool));
  canvas.style.cursor = tool === "text" ? "text" : tool === "select" ? "default" : "crosshair";
}

// --- drag-based tools (arrow, rect, blur) ---------------------------------

let dragStart: { x: number; y: number } | null = null;

// The canvas displays scaled to fit the window (see editor.html's
// `max-width:100%; height:auto`) rather than always at its native pixel
// size — a retina/high-DPR capture would otherwise render at up to 2-3x
// the size it actually appeared on the page, overflowing the window. Every
// mouse position arrives in CSS/client pixels, so it has to be converted
// into canvas-buffer pixels (what canvas.width/height and every draw call
// here actually operate in) via this ratio before use.
function displayScale(): number {
  const rect = canvas.getBoundingClientRect();
  return rect.width > 0 ? canvas.width / rect.width : 1;
}

function canvasPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scale = displayScale();
  return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale };
}

// All four drawing helpers below take an explicit target context — either
// `ctx` (the real canvas, for a final commit) or `previewCtx` (the
// overlay, for a live drag preview) — rather than assuming `ctx`, so the
// exact same drawing code produces both.

function drawArrow(target: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  target.strokeStyle = "#ff3b30";
  target.fillStyle = "#ff3b30";
  target.lineWidth = 3;
  target.beginPath();
  target.moveTo(x0, y0);
  target.lineTo(x1, y1);
  target.stroke();

  const angle = Math.atan2(y1 - y0, x1 - x0);
  const headLen = 14;
  target.beginPath();
  target.moveTo(x1, y1);
  target.lineTo(x1 - headLen * Math.cos(angle - Math.PI / 6), y1 - headLen * Math.sin(angle - Math.PI / 6));
  target.lineTo(x1 - headLen * Math.cos(angle + Math.PI / 6), y1 - headLen * Math.sin(angle + Math.PI / 6));
  target.closePath();
  target.fill();
}

function drawRect(target: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  target.strokeStyle = "#ff3b30";
  target.lineWidth = 3;
  target.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
}

function drawCropPreview(target: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  target.save();
  target.strokeStyle = "#4f7cff";
  target.lineWidth = 2;
  target.setLineDash([6, 4]);
  target.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  target.restore();
}

/** Clamps a drag's two endpoints to a rect within the canvas — shared by
 * the crop and blur tools. Returns null if the drag was too small to be
 * an intentional selection (an accidental click, not a real drag). */
function dragRect(x0: number, y0: number, x1: number, y1: number): { x: number; y: number; width: number; height: number } | null {
  const x = Math.max(0, Math.round(Math.min(x0, x1)));
  const y = Math.max(0, Math.round(Math.min(y0, y1)));
  const width = Math.min(canvas.width - x, Math.round(Math.abs(x1 - x0)));
  const height = Math.min(canvas.height - y, Math.round(Math.abs(y1 - y0)));
  if (width < 2 || height < 2) return null;
  return { x, y, width, height };
}

/** Commits a crop: shrinks the canvas itself to the given rect, discarding
 * everything outside it. */
function applyCrop(rect: { x: number; y: number; width: number; height: number }): void {
  const cropped = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
  canvas.width = rect.width;
  canvas.height = rect.height;
  ctx.putImageData(cropped, 0, 0);
  syncPreviewCanvas();
  setStatus(`${rect.width}×${rect.height}`);
}

// --- crop tool: adjustable selection with auto-scroll ----------------------
//
// Unlike arrow/rect/blur (single drag, committed immediately on release),
// crop is two-phase: an initial drag defines a marquee, then the user can
// resize it via corner/edge handles or reposition it by dragging inside it
// — nothing is applied to the actual canvas until they click "Apply Crop"
// (or press Enter), or discard it via "Cancel Crop" (or Escape). The page
// screenshots this operates on are routinely taller than the editor
// window, so #canvasWrap (a scrollable container — see editor.html) also
// auto-scrolls while the cursor sits near its edge during any of the three
// drag sub-modes, the same way desktop image editors handle a selection
// larger than the visible canvas.

type Rect = { x: number; y: number; width: number; height: number };
type CropHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type CropDragMode = "draw" | "move" | "resize" | null;

// See content/index.ts's own isCoarsePointer comment — same reasoning: a
// touch fingertip needs a bigger target than a mouse cursor does.
const HANDLE_SIZE = matchMedia("(pointer: coarse)").matches ? 20 : 10; // target on-screen (CSS px) size, not canvas-buffer px
const AUTO_SCROLL_EDGE = 36; // px from #canvasWrap's edge that triggers scrolling
const AUTO_SCROLL_MAX_SPEED = 18; // px per animation frame at the very edge

/** HANDLE_SIZE converted to canvas-buffer pixels, so the resize handles
 * stay a consistent visual size on screen regardless of how much the
 * canvas is currently scaled down to fit the window. */
function handleSizeBuffer(): number {
  return HANDLE_SIZE * displayScale();
}

let pendingCrop: Rect | null = null;
let cropDragMode: CropDragMode = null;
let cropResizeHandle: CropHandle | null = null;
let cropDragOrigRect: Rect | null = null;
let cropDragAnchor: { x: number; y: number } | null = null;
let lastClientPos: { x: number; y: number } | null = null;
let autoScrollRafId: number | null = null;

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function pointFromClient(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scale = displayScale();
  return {
    x: clampNum((clientX - rect.left) * scale, 0, canvas.width),
    y: clampNum((clientY - rect.top) * scale, 0, canvas.height),
  };
}

function handlePositions(r: Rect): Record<CropHandle, { x: number; y: number }> {
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  return {
    nw: { x: r.x, y: r.y },
    n: { x: cx, y: r.y },
    ne: { x: r.x + r.width, y: r.y },
    e: { x: r.x + r.width, y: cy },
    se: { x: r.x + r.width, y: r.y + r.height },
    s: { x: cx, y: r.y + r.height },
    sw: { x: r.x, y: r.y + r.height },
    w: { x: r.x, y: cy },
  };
}

function hitTestHandle(r: Rect, p: { x: number; y: number }): CropHandle | null {
  const size = handleSizeBuffer();
  for (const [name, pos] of Object.entries(handlePositions(r)) as [CropHandle, { x: number; y: number }][]) {
    if (Math.abs(p.x - pos.x) <= size && Math.abs(p.y - pos.y) <= size) return name;
  }
  return null;
}

function pointInRect(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

function resizeRect(orig: Rect, handle: CropHandle, p: { x: number; y: number }): Rect {
  let x0 = orig.x;
  let y0 = orig.y;
  let x1 = orig.x + orig.width;
  let y1 = orig.y + orig.height;
  if (handle.includes("w")) x0 = clampNum(p.x, 0, x1 - 1);
  if (handle.includes("e")) x1 = clampNum(p.x, x0 + 1, canvas.width);
  if (handle.includes("n")) y0 = clampNum(p.y, 0, y1 - 1);
  if (handle.includes("s")) y1 = clampNum(p.y, y0 + 1, canvas.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function moveRect(orig: Rect, anchor: { x: number; y: number }, p: { x: number; y: number }): Rect {
  return {
    x: clampNum(orig.x + (p.x - anchor.x), 0, canvas.width - orig.width),
    y: clampNum(orig.y + (p.y - anchor.y), 0, canvas.height - orig.height),
    width: orig.width,
    height: orig.height,
  };
}

function drawCropHandles(target: CanvasRenderingContext2D, r: Rect): void {
  target.save();
  target.fillStyle = "#4f7cff";
  target.strokeStyle = "#ffffff";
  target.lineWidth = 1;
  const size = handleSizeBuffer();
  for (const pos of Object.values(handlePositions(r))) {
    target.fillRect(pos.x - size / 2, pos.y - size / 2, size, size);
    target.strokeRect(pos.x - size / 2, pos.y - size / 2, size, size);
  }
  target.restore();
}

// The marquee/handles draw on previewCanvas, never on the real canvas — it
// stays untouched (and thus doesn't need restoring) for the whole
// adjustable phase, so this just redraws the overlay from scratch.
function renderCropOverlay(r: Rect): void {
  clearPreview();
  drawCropPreview(previewCtx, r.x, r.y, r.x + r.width, r.y + r.height);
  drawCropHandles(previewCtx, r);
}

function updateCropActionButtons(): void {
  // The whole bar toggles, not the two buttons individually: they live in a
  // floating container now, so there is one thing to show and its layout is
  // the container's business rather than something this has to restate.
  cropBar.hidden = pendingCrop === null;
}

function cancelPendingCrop(): void {
  clearPreview();
  pendingCrop = null;
  updateCropActionButtons();
}

function commitPendingCrop(): void {
  if (!pendingCrop) return;
  clearPreview();
  // Taken now, at the actual commit — not per-frame during adjustment,
  // since the real canvas was never touched until this exact point.
  const preCropSnapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
  pushHistory({ kind: "full", width: canvas.width, height: canvas.height, data: preCropSnapshot });
  applyCrop(pendingCrop);
  pendingCrop = null;
  updateCropActionButtons();
}

function updateCropDrag(): void {
  if (!lastClientPos || !cropDragMode) return;
  const p = pointFromClient(lastClientPos.x, lastClientPos.y);
  if (cropDragMode === "draw" && dragStart) {
    clearPreview();
    drawCropPreview(previewCtx, dragStart.x, dragStart.y, p.x, p.y);
  } else if (cropDragMode === "resize" && cropDragOrigRect && cropResizeHandle) {
    pendingCrop = resizeRect(cropDragOrigRect, cropResizeHandle, p);
    renderCropOverlay(pendingCrop);
  } else if (cropDragMode === "move" && cropDragOrigRect && cropDragAnchor) {
    pendingCrop = moveRect(cropDragOrigRect, cropDragAnchor, p);
    renderCropOverlay(pendingCrop);
  }
}

// While any crop drag is active, scroll #canvasWrap toward the cursor once
// it's within AUTO_SCROLL_EDGE px of the wrapper's boundary — driven by a
// rAF loop rather than the mousemove event, since the cursor doesn't move
// (and so fires no mousemove) while the page scrolls underneath it.
function autoScrollStep(): void {
  if (!lastClientPos || !cropDragMode) {
    autoScrollRafId = null;
    return;
  }
  const wrapRect = canvasWrap.getBoundingClientRect();
  let vy = 0;
  let vx = 0;
  const distTop = lastClientPos.y - wrapRect.top;
  const distBottom = wrapRect.bottom - lastClientPos.y;
  if (distTop < AUTO_SCROLL_EDGE) vy = -AUTO_SCROLL_MAX_SPEED * (1 - clampNum(distTop, 0, AUTO_SCROLL_EDGE) / AUTO_SCROLL_EDGE);
  else if (distBottom < AUTO_SCROLL_EDGE) vy = AUTO_SCROLL_MAX_SPEED * (1 - clampNum(distBottom, 0, AUTO_SCROLL_EDGE) / AUTO_SCROLL_EDGE);
  const distLeft = lastClientPos.x - wrapRect.left;
  const distRight = wrapRect.right - lastClientPos.x;
  if (distLeft < AUTO_SCROLL_EDGE) vx = -AUTO_SCROLL_MAX_SPEED * (1 - clampNum(distLeft, 0, AUTO_SCROLL_EDGE) / AUTO_SCROLL_EDGE);
  else if (distRight < AUTO_SCROLL_EDGE) vx = AUTO_SCROLL_MAX_SPEED * (1 - clampNum(distRight, 0, AUTO_SCROLL_EDGE) / AUTO_SCROLL_EDGE);

  if (vy !== 0 || vx !== 0) {
    canvasWrap.scrollTop += vy;
    canvasWrap.scrollLeft += vx;
    updateCropDrag();
  }
  autoScrollRafId = requestAnimationFrame(autoScrollStep);
}

function startAutoScrollTracking(): void {
  if (autoScrollRafId === null) autoScrollRafId = requestAnimationFrame(autoScrollStep);
}

function stopAutoScrollTracking(): void {
  if (autoScrollRafId !== null) {
    cancelAnimationFrame(autoScrollRafId);
    autoScrollRafId = null;
  }
}

function handleCropMouseDown(p: { x: number; y: number }): void {
  if (pendingCrop) {
    const handle = hitTestHandle(pendingCrop, p);
    if (handle) {
      cropDragMode = "resize";
      cropResizeHandle = handle;
      cropDragOrigRect = pendingCrop;
      startAutoScrollTracking();
      return;
    }
    if (pointInRect(pendingCrop, p)) {
      cropDragMode = "move";
      cropDragAnchor = p;
      cropDragOrigRect = pendingCrop;
      startAutoScrollTracking();
      return;
    }
    // Clicked outside the existing marquee — discard it and start fresh,
    // same as most image editors' crop tools.
    cancelPendingCrop();
  }
  cropDragMode = "draw";
  dragStart = p;
  startAutoScrollTracking();
}

function handleCropMouseUp(p: { x: number; y: number }): void {
  stopAutoScrollTracking();
  const mode = cropDragMode;
  cropDragMode = null;

  if (mode === "draw") {
    const start = dragStart;
    dragStart = null;
    const rect = start ? dragRect(start.x, start.y, p.x, p.y) : null;
    if (!rect) {
      clearPreview();
      return; // too small to be an intentional selection — no marquee left behind
    }
    pendingCrop = rect;
    renderCropOverlay(pendingCrop);
    updateCropActionButtons();
  } else if (mode === "resize" || mode === "move") {
    // pendingCrop was already kept live by updateCropDrag(); just clear
    // the transient per-drag state, leaving the marquee up for further
    // adjustment or Apply/Cancel.
    cropDragOrigRect = null;
    cropResizeHandle = null;
    cropDragAnchor = null;
  }
}

/** Mosaic-style pixelation: each blockSize×blockSize block is replaced by
 * its own average color — an irreversible blur, not a cosmetic filter. */
function pixelateRegion(x: number, y: number, width: number, height: number): void {
  if (width < 1 || height < 1) return;
  const blockSize = Math.max(6, Math.round(Math.min(width, height) / 12));
  const imageData = ctx.getImageData(x, y, width, height);
  const data = imageData.data;

  for (let by = 0; by < height; by += blockSize) {
    for (let bx = 0; bx < width; bx += blockSize) {
      const bw = Math.min(blockSize, width - bx);
      const bh = Math.min(blockSize, height - by);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const count = bw * bh;
      for (let dy = 0; dy < bh; dy++) {
        for (let dx = 0; dx < bw; dx++) {
          const off = ((by + dy) * width + (bx + dx)) * 4;
          r += data[off]!;
          g += data[off + 1]!;
          b += data[off + 2]!;
          a += data[off + 3]!;
        }
      }
      r = Math.round(r / count);
      g = Math.round(g / count);
      b = Math.round(b / count);
      a = Math.round(a / count);
      for (let dy = 0; dy < bh; dy++) {
        for (let dx = 0; dx < bw; dx++) {
          const off = ((by + dy) * width + (bx + dx)) * 4;
          data[off] = r;
          data[off + 1] = g;
          data[off + 2] = b;
          data[off + 3] = a;
        }
      }
    }
  }
  ctx.putImageData(imageData, x, y);
}

// --- pending shape: arrow/rect/blur/text stay "live" (movable, resizable,
// via the Select tool or by re-grabbing the handles with the tool that
// drew them) instead of being baked into the canvas the instant they're
// drawn — that's what made it impossible to nudge or resize an arrow/
// rectangle/text box after the fact. Only one shape is ever pending at a
// time: starting a new one, or clicking away from it with the Select
// tool, bakes ("commits") whatever was pending into the real canvas
// first. Already-baked pixels (from earlier in the session, or before
// this feature existed) are not retroactively selectable — the same
// one-thing-at-a-time tradeoff the crop marquee above already makes, in
// exchange for a much simpler mental model than a full layer stack.

// Watermark used to be a kind here (a single draggable/resizable
// instance), but it now stamps a whole tiled pattern across one or more
// regions of the page — there's nothing sensible to "drag" once it can
// cover the entire capture, so it commits directly instead. See
// applyWatermarkPattern() and its own comment.
type PendingShape =
  | { kind: "arrow"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "rect"; rect: Rect }
  | { kind: "blur"; rect: Rect }
  | { kind: "text"; rect: Rect; value: string; fontSizeBuffer: number };

type ArrowHandle = "start" | "end";
type ShapeDrawKind = "arrow" | "rect" | "blur";

let pendingShape: PendingShape | null = null;
let shapeDrawKind: ShapeDrawKind | null = null;
let shapeDragMode: "move" | "resize" | null = null;
let shapeResizeHandle: CropHandle | ArrowHandle | null = null;
let shapeDragOrig: PendingShape | null = null;
let shapeDragAnchor: { x: number; y: number } | null = null;

function distanceToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0 ? clampNum(((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Where (if anywhere) a point hits the pending shape — a resize handle,
 * or its body (for a move). Shared by the Select tool and by arrow/rect/
 * blur's own tool re-adjusting the shape they just drew instead of
 * starting a new one on top of it. */
function hitTestShape(shape: PendingShape, p: { x: number; y: number }): { mode: "resize"; handle: CropHandle | ArrowHandle } | { mode: "move" } | null {
  const size = handleSizeBuffer();
  if (shape.kind === "arrow") {
    if (Math.hypot(p.x - shape.x0, p.y - shape.y0) <= size) return { mode: "resize", handle: "start" };
    if (Math.hypot(p.x - shape.x1, p.y - shape.y1) <= size) return { mode: "resize", handle: "end" };
    if (distanceToSegment(p, { x: shape.x0, y: shape.y0 }, { x: shape.x1, y: shape.y1 }) <= size) return { mode: "move" };
    return null;
  }
  const handle = hitTestHandle(shape.rect, p);
  if (handle) return { mode: "resize", handle };
  if (pointInRect(shape.rect, p)) return { mode: "move" };
  return null;
}

function drawPointHandle(target: CanvasRenderingContext2D, x: number, y: number): void {
  target.save();
  target.fillStyle = "#4f7cff";
  target.strokeStyle = "#ffffff";
  target.lineWidth = 1;
  const size = handleSizeBuffer();
  target.beginPath();
  target.arc(x, y, size / 2, 0, Math.PI * 2);
  target.fill();
  target.stroke();
  target.restore();
}

function drawTextShape(target: CanvasRenderingContext2D, shape: { rect: Rect; value: string; fontSizeBuffer: number }): void {
  target.fillStyle = "#ff3b30";
  target.font = `${shape.fontSizeBuffer}px system-ui, sans-serif`;
  target.textBaseline = "top";
  target.fillText(shape.value, shape.rect.x, shape.rect.y);
}

// Watermark rendering (drawWatermarkCell, applyWatermarkPattern, and the
// tiling math behind them) lives in vendor-private/watermark-premium — a
// private module, not part of this AGPL codebase, gating the Supporter
// feature. See that module's own README for why, and the panel wiring
// further down this file for the sign-in/unlock flow around it.

// The pending shape (and its handles) draws on previewCanvas, never on
// the real canvas — nothing here is applied until commitPendingShape().
function renderPendingShape(): void {
  clearPreview();
  if (!pendingShape) return;
  if (pendingShape.kind === "arrow") {
    drawArrow(previewCtx, pendingShape.x0, pendingShape.y0, pendingShape.x1, pendingShape.y1);
    drawPointHandle(previewCtx, pendingShape.x0, pendingShape.y0);
    drawPointHandle(previewCtx, pendingShape.x1, pendingShape.y1);
  } else if (pendingShape.kind === "rect") {
    const r = pendingShape.rect;
    drawRect(previewCtx, r.x, r.y, r.x + r.width, r.y + r.height);
    drawCropHandles(previewCtx, r);
  } else if (pendingShape.kind === "blur") {
    // Dashed selection outline, not a solid red rect — visually this is a
    // pending *operation area* like the crop marquee, not a permanent
    // red-ink annotation like arrow/rect.
    const r = pendingShape.rect;
    drawCropPreview(previewCtx, r.x, r.y, r.x + r.width, r.y + r.height);
    drawCropHandles(previewCtx, r);
  } else {
    drawTextShape(previewCtx, pendingShape);
    drawCropHandles(previewCtx, pendingShape.rect);
  }
}

function cancelPendingShape(): void {
  clearPreview();
  pendingShape = null;
}

/** Bounding box (canvas-buffer px, clamped to the canvas) of the pixels a
 * pending shape's commit is about to touch, padded well past its stroke
 * width/arrowhead reach/font-metric overshoot — see the Snapshot type's
 * comment for why commitPendingShape() needs this instead of just
 * snapshotting the whole canvas. Getting the padding wrong in the wrong
 * direction (too small) would leave undo unable to fully restore what was
 * there before, so it's generous rather than tight. */
function shapeBoundingBox(shape: PendingShape): Rect {
  const MARGIN = 20;
  const r =
    shape.kind === "arrow"
      ? {
          x: Math.min(shape.x0, shape.x1),
          y: Math.min(shape.y0, shape.y1),
          width: Math.abs(shape.x1 - shape.x0),
          height: Math.abs(shape.y1 - shape.y0),
        }
      : shape.rect;
  const x = clampNum(r.x - MARGIN, 0, canvas.width);
  const y = clampNum(r.y - MARGIN, 0, canvas.height);
  const right = clampNum(r.x + r.width + MARGIN, 0, canvas.width);
  const bottom = clampNum(r.y + r.height + MARGIN, 0, canvas.height);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/** Bakes the pending shape into the real canvas — the only point any of
 * arrow/rect/blur/text actually touch `ctx`'s pixels, mirroring how crop
 * only touches the canvas at commitPendingCrop(). */
function commitPendingShape(): void {
  if (!pendingShape) return;
  clearPreview();
  const box = shapeBoundingBox(pendingShape);
  const preSnapshot = ctx.getImageData(box.x, box.y, box.width, box.height);
  pushHistory({ kind: "region", x: box.x, y: box.y, data: preSnapshot });

  if (pendingShape.kind === "arrow") {
    drawArrow(ctx, pendingShape.x0, pendingShape.y0, pendingShape.x1, pendingShape.y1);
  } else if (pendingShape.kind === "rect") {
    const r = pendingShape.rect;
    drawRect(ctx, r.x, r.y, r.x + r.width, r.y + r.height);
  } else if (pendingShape.kind === "blur") {
    const r = pendingShape.rect;
    pixelateRegion(r.x, r.y, r.width, r.height);
  } else {
    drawTextShape(ctx, pendingShape);
  }
  pendingShape = null;
}

function startShapeAdjust(hit: { mode: "resize"; handle: CropHandle | ArrowHandle } | { mode: "move" }, p: { x: number; y: number }): void {
  if (!pendingShape) return;
  shapeDragOrig = pendingShape;
  if (hit.mode === "move") {
    shapeDragMode = "move";
    shapeDragAnchor = p;
  } else {
    shapeDragMode = "resize";
    shapeResizeHandle = hit.handle;
  }
}

function updateShapeDrag(p: { x: number; y: number }): void {
  if (!pendingShape || !shapeDragOrig || !shapeDragMode) return;
  if (pendingShape.kind === "arrow" && shapeDragOrig.kind === "arrow") {
    const orig = shapeDragOrig;
    if (shapeDragMode === "move" && shapeDragAnchor) {
      const dx = p.x - shapeDragAnchor.x;
      const dy = p.y - shapeDragAnchor.y;
      pendingShape = { kind: "arrow", x0: orig.x0 + dx, y0: orig.y0 + dy, x1: orig.x1 + dx, y1: orig.y1 + dy };
    } else if (shapeDragMode === "resize" && shapeResizeHandle === "start") {
      pendingShape = { kind: "arrow", x0: p.x, y0: p.y, x1: orig.x1, y1: orig.y1 };
    } else if (shapeDragMode === "resize" && shapeResizeHandle === "end") {
      pendingShape = { kind: "arrow", x0: orig.x0, y0: orig.y0, x1: p.x, y1: p.y };
    }
  } else if (pendingShape.kind !== "arrow" && shapeDragOrig.kind !== "arrow") {
    const origRect = shapeDragOrig.rect;
    let newRect: Rect | null = null;
    if (shapeDragMode === "move" && shapeDragAnchor) {
      newRect = moveRect(origRect, shapeDragAnchor, p);
    } else if (shapeDragMode === "resize" && shapeResizeHandle && shapeResizeHandle !== "start" && shapeResizeHandle !== "end") {
      newRect = resizeRect(origRect, shapeResizeHandle, p);
    }
    if (!newRect) return;
    if (pendingShape.kind === "rect") pendingShape = { kind: "rect", rect: newRect };
    else if (pendingShape.kind === "blur") pendingShape = { kind: "blur", rect: newRect };
    else if (pendingShape.kind === "text" && shapeDragOrig.kind === "text") {
      // Resizing a text box scales its font size with the box height —
      // there's no sensible "reflow" for a single line of canvas text, so
      // dragging a corner just scales it, the same way most simple
      // annotation tools handle resizing text.
      const scale = origRect.height > 0 ? newRect.height / origRect.height : 1;
      const fontSizeBuffer = Math.max(6, shapeDragOrig.fontSizeBuffer * scale);
      pendingShape = { kind: "text", rect: newRect, value: shapeDragOrig.value, fontSizeBuffer };
    }
  }
  renderPendingShape();
}

function endShapeDrag(): void {
  shapeDragMode = null;
  shapeResizeHandle = null;
  shapeDragOrig = null;
  shapeDragAnchor = null;
}

// Touch has no dblclick — double-clicking an existing pending text shape
// to re-edit its value (see the old dblclick listener this replaced) is
// now detected here instead, at the very start of pointerdown, before any
// of the tool-specific hit-testing below runs. This placement matters: a
// tap on an existing pending text shape is already fully consumed by this
// same handler's text-tool branch (via startShapeAdjust, further down),
// so by the time a hypothetical pointerup-based check ran, shapeDragMode
// would already be truthy and short-circuit it. Native dblclick avoided
// this because it fires as its own, separate event after both click
// cycles complete; Pointer Events have no equivalent, so the check has to
// preempt the single-tap handling instead of following it.
let lastTap: TapState = null;

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);

  if (pendingShape?.kind === "text") {
    const now = performance.now();
    if (isDoubleTap(lastTap, now, e.clientX, e.clientY) && pointInRect(pendingShape.rect, canvasPoint(e))) {
      lastTap = null; // consumed — a third tap right after shouldn't chain into another double-tap
      const existing = pendingShape;
      pendingShape = null;
      clearPreview();
      // See the single-tap text-creation branch below for why this
      // preventDefault() is load-bearing: `canvas` isn't focusable, so
      // without it the browser's own default pointerdown handling blurs
      // the <input> startTextInput() is about to focus almost immediately
      // — which fires its blur handler (commit()) and removes it again
      // before the user (or, here, an e2e test) ever sees it.
      e.preventDefault();
      startTextInput({ x: existing.rect.x, y: existing.rect.y }, { x: e.clientX, y: e.clientY }, existing);
      return;
    }
    lastTap = { time: now, x: e.clientX, y: e.clientY };
  }

  const p = canvasPoint(e);

  if (currentTool === "crop") {
    lastClientPos = { x: e.clientX, y: e.clientY };
    handleCropMouseDown(pointFromClient(e.clientX, e.clientY));
    return;
  }

  if (currentTool === "select") {
    if (pendingShape) {
      const hit = hitTestShape(pendingShape, p);
      if (hit) {
        startShapeAdjust(hit, p);
        return;
      }
      commitPendingShape(); // clicked elsewhere — done adjusting
    }
    return;
  }

  if (currentTool === "arrow" || currentTool === "rect" || currentTool === "blur") {
    if (pendingShape) {
      const hit = hitTestShape(pendingShape, p);
      if (hit) {
        startShapeAdjust(hit, p);
        return;
      }
      commitPendingShape(); // clicked elsewhere — bake the old one, start fresh
    }
    shapeDrawKind = currentTool;
    // No canvas snapshot here — the real canvas isn't touched until the
    // actual commit, only previewCanvas is drawn to during the drag
    // itself (see editor.html's #previewCanvas comment).
    dragStart = p;
    return;
  }

  if (currentTool === "text") {
    if (pendingShape) {
      if (pendingShape.kind === "text") {
        const hit = hitTestShape(pendingShape, p);
        if (hit) {
          startShapeAdjust(hit, p);
          return;
        }
      }
      commitPendingShape();
    }
    // `canvas` isn't itself focusable, so the browser's own default
    // pointerdown handling blurs whatever's currently focused once this
    // event finishes — including the <input> startTextInput is about to
    // create and focus, synchronously undoing that focus() call before a
    // single frame renders. This is what actually made the text tool look
    // like it did nothing at all: the input existed for a moment, then
    // lost focus immediately and (per its own blur handler) removed
    // itself. preventDefault() here is what lets the focus stick (and, as
    // a side effect, suppresses the synthetic mousedown/click a real touch
    // tap would otherwise also dispatch for legacy compatibility).
    e.preventDefault();
    startTextInput(p, { x: e.clientX, y: e.clientY });
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (currentTool === "crop" && cropDragMode) {
    lastClientPos = { x: e.clientX, y: e.clientY };
    updateCropDrag();
    return;
  }
  const p = canvasPoint(e);
  if (shapeDragMode) {
    updateShapeDrag(p);
    return;
  }
  if (!dragStart || !shapeDrawKind) return;
  clearPreview();
  if (shapeDrawKind === "arrow") drawArrow(previewCtx, dragStart.x, dragStart.y, p.x, p.y);
  else if (shapeDrawKind === "rect") drawRect(previewCtx, dragStart.x, dragStart.y, p.x, p.y);
  else if (shapeDrawKind === "blur") drawCropPreview(previewCtx, dragStart.x, dragStart.y, p.x, p.y);
});

canvas.addEventListener("pointerup", (e) => {
  if (currentTool === "crop" && cropDragMode) {
    handleCropMouseUp(pointFromClient(e.clientX, e.clientY));
    return;
  }
  if (shapeDragMode) {
    endShapeDrag(); // pendingShape was already kept live by updateShapeDrag(); stays up for further adjustment
    return;
  }
  if (!dragStart || !shapeDrawKind) return;
  const p = canvasPoint(e);
  const start = dragStart;
  const kind = shapeDrawKind;
  dragStart = null;
  shapeDrawKind = null;
  clearPreview();

  if (kind === "arrow") {
    if (Math.hypot(p.x - start.x, p.y - start.y) < 4) return; // accidental click, not a real drag
    pendingShape = { kind: "arrow", x0: start.x, y0: start.y, x1: p.x, y1: p.y };
  } else {
    const rect = dragRect(start.x, start.y, p.x, p.y);
    if (!rect) return;
    pendingShape = kind === "rect" ? { kind: "rect", rect } : { kind: "blur", rect };
  }
  renderPendingShape();
});

// --- text tool -------------------------------------------------------------

/** `bufferPos` is where the text will actually be drawn (canvas-buffer
 * space, what `pendingShape`/`ctx.fillText` operate in); `clientPos` is
 * only for placing the floating <input> the user types into, in real CSS
 * pixels. These are NOT the same number once the canvas is displayed at
 * anything other than 1:1 scale (i.e. almost always — see
 * displayScale()) — conflating them is what previously placed the input
 * far outside the visible page for any capture wider than the editor
 * window, silently: it wasn't that the text tool did nothing, it created
 * the input off-screen every time. `existing` re-opens the input
 * pre-filled, for double-click-to-edit on an already-placed text shape. */
function startTextInput(
  bufferPos: { x: number; y: number },
  clientPos: { x: number; y: number },
  existing?: Extract<PendingShape, { kind: "text" }>,
): void {
  const rect = canvas.getBoundingClientRect();
  const scale = displayScale();
  const cssLeft = clientPos.x - rect.left + canvas.offsetLeft;
  const cssTop = clientPos.y - rect.top + canvas.offsetTop;
  // Buffer-space font size (what actually gets drawn on `ctx`) — divided
  // by `scale` below just for the floating input's own on-screen CSS size,
  // so it looks the same size while typing as it will once baked in and
  // displayed at the canvas's current (possibly scaled-down) size.
  const fontSizeBuffer = existing?.fontSizeBuffer ?? 20 * scale;

  const input = document.createElement("input");
  input.type = "text";
  input.value = existing?.value ?? "";
  input.style.cssText = `position:absolute;left:${cssLeft}px;top:${cssTop}px;
    font:${fontSizeBuffer / scale}px system-ui, sans-serif;color:#ff3b30;background:transparent;border:1px dashed #ff3b30;z-index:1000;`;
  canvas.parentElement!.appendChild(input);
  input.focus();
  if (existing) input.select();

  let settled = false;
  function commit(): void {
    if (settled) return;
    settled = true;
    input.remove();
    if (!input.value.trim()) return;
    ctx.font = `${fontSizeBuffer}px system-ui, sans-serif`;
    const width = Math.max(1, ctx.measureText(input.value).width);
    const height = fontSizeBuffer * 1.2;
    pendingShape = { kind: "text", rect: { x: bufferPos.x, y: bufferPos.y, width, height }, value: input.value, fontSizeBuffer };
    renderPendingShape();
  }
  function cancel(): void {
    if (settled) return;
    settled = true;
    input.remove();
  }
  input.addEventListener("keydown", (e) => {
    // Without this, the same keypress that commits the *typed text* into
    // a pending shape (via commit(), below) also bubbles up to the
    // window-level keydown handler that commits/cancels the *pending
    // shape* — instantly re-baking the text this exact keystroke just
    // created, before the user ever gets a chance to move or resize it.
    e.stopPropagation();
    if (e.key === "Enter") commit();
    if (e.key === "Escape") cancel();
  });
  input.addEventListener("blur", commit);
}

// --- watermark panel ---------------------------------------------------
//
// Unlike the other tools, watermark has no drawing gesture of its own —
// there's nothing to click-and-drag on the canvas to define it, just
// configuration (text and/or a logo, how see-through it is, where the
// tiled pattern goes and at what angle). So the toolbar button opens
// this panel directly instead of switching into a persistent "watermark
// mode", and confirming it bakes the whole pattern straight into the
// canvas — see applyWatermarkPattern() and the click wiring at the
// bottom of this section.

const watermarkPanel = document.getElementById("watermarkPanel")!;
const watermarkPreviewEl = document.getElementById("watermarkPreview") as HTMLCanvasElement;
const watermarkPreviewCtx = watermarkPreviewEl.getContext("2d")!;
const watermarkTextEl = document.getElementById("watermarkText") as HTMLInputElement;
const watermarkTextSizeEl = document.getElementById("watermarkTextSize") as HTMLInputElement;
const watermarkTextSizeValueEl = document.getElementById("watermarkTextSizeValue")!;
const watermarkOpacityEl = document.getElementById("watermarkOpacity") as HTMLInputElement;
const watermarkOpacityValueEl = document.getElementById("watermarkOpacityValue")!;
const watermarkLocationEl = document.getElementById("watermarkLocation") as HTMLSelectElement;
const watermarkOrientationEl = document.getElementById("watermarkOrientation") as HTMLSelectElement;
const watermarkLogoFileEl = document.getElementById("watermarkLogoFile") as HTMLInputElement;
const watermarkLogoPreviewEl = document.getElementById("watermarkLogoPreview") as HTMLImageElement;
const watermarkLogoNameEl = document.getElementById("watermarkLogoName")!;
const watermarkChooseLogoBtn = document.getElementById("watermarkChooseLogo") as HTMLButtonElement;
const watermarkRemoveLogoBtn = document.getElementById("watermarkRemoveLogo") as HTMLButtonElement;
const watermarkAddBtn = document.getElementById("watermarkAdd") as HTMLButtonElement;
const watermarkCancelBtn = document.getElementById("watermarkCancel") as HTMLButtonElement;

let watermarkLogoDataUrl: string | null = null;
// Decoded once per logo change rather than on every preview repaint or Add
// click — createImageBitmap is async, so the Add handler awaits this
// promise instead of re-decoding, which both avoids redundant work and
// keeps Add from committing before the *latest* chosen logo is ready.
let watermarkLogoBitmap: ImageBitmap | null = null;
let watermarkLogoBitmapReady: Promise<void> = Promise.resolve();

function updateWatermarkAddEnabled(): void {
  watermarkAddBtn.disabled = !watermarkTextEl.value.trim() && !watermarkLogoDataUrl;
}

function refreshWatermarkLogoBitmap(): void {
  const dataUrl = watermarkLogoDataUrl;
  watermarkLogoBitmapReady = (async () => {
    watermarkLogoBitmap = dataUrl ? await createImageBitmap(await (await fetch(dataUrl)).blob()) : null;
    updateWatermarkPreview();
  })();
}

function showWatermarkLogoPreview(dataUrl: string | null, name: string): void {
  watermarkLogoDataUrl = dataUrl;
  watermarkLogoPreviewEl.hidden = !dataUrl;
  watermarkLogoPreviewEl.src = dataUrl ?? "";
  watermarkLogoNameEl.textContent = dataUrl ? name : "No logo chosen";
  watermarkRemoveLogoBtn.hidden = !dataUrl;
  updateWatermarkAddEnabled();
  refreshWatermarkLogoBitmap();
}

/** Renders a live preview of a single watermark instance — logo plus text,
 * at the configured opacity/text size/orientation — not the tiled pattern
 * across the actual page. Location doesn't affect this: it only decides
 * *where the pattern repeats*, not what one instance looks like, so
 * there's nothing for it to change here. A flat neutral background (not
 * the real capture) keeps the focus on the watermark's own contrast,
 * which is what actually determines legibility on any page. */
function updateWatermarkPreview(): void {
  const boxW = watermarkPreviewEl.width;
  const boxH = watermarkPreviewEl.height;
  watermarkPreviewCtx.clearRect(0, 0, boxW, boxH);
  watermarkPreviewCtx.fillStyle = "#9aa0a6";
  watermarkPreviewCtx.fillRect(0, 0, boxW, boxH);

  const text = watermarkTextEl.value.trim();
  if (!text && !watermarkLogoBitmap) return;

  const opacity = Number(watermarkOpacityEl.value) / 100;
  const orientationDeg = Number(watermarkOrientationEl.value) as 0 | 45;
  const textScale = Number(watermarkTextSizeEl.value) / 100;
  const cellWidth = boxW * 0.7;
  const cellHeight = boxH * 0.5;
  const angle = (-orientationDeg * Math.PI) / 180;

  watermarkPreviewCtx.save();
  watermarkPreviewCtx.translate(boxW / 2, boxH / 2);
  if (angle) watermarkPreviewCtx.rotate(angle);
  drawWatermarkCell(watermarkPreviewCtx, { x: -cellWidth / 2, y: -cellHeight / 2, width: cellWidth, height: cellHeight }, text, watermarkLogoBitmap, opacity, textScale);
  watermarkPreviewCtx.restore();
}

function updateWatermarkTextSizeLabel(): void {
  watermarkTextSizeValueEl.textContent = `${watermarkTextSizeEl.value}%`;
}

function updateWatermarkOpacityLabel(): void {
  watermarkOpacityValueEl.textContent = `${watermarkOpacityEl.value}%`;
}

async function openWatermarkPanel(): Promise<void> {
  watermarkTextEl.value = "";
  watermarkTextSizeEl.value = "100";
  watermarkOpacityEl.value = "15";
  watermarkLocationEl.value = "full";
  watermarkOrientationEl.value = "0";
  watermarkLogoFileEl.value = "";
  updateWatermarkTextSizeLabel();
  updateWatermarkOpacityLabel();
  // Preload whatever logo was saved from a previous session, so repeated
  // branded exports don't need re-picking the file every time — see
  // chrome/watermark-logo-store.ts.
  const saved = await getWatermarkLogoDataUrl();
  showWatermarkLogoPreview(saved, saved ? "Saved logo" : "");
  watermarkPanel.hidden = false;
  watermarkTextEl.focus();
  updateWatermarkPreview();
}

function closeWatermarkPanel(): void {
  watermarkPanel.hidden = true;
}

watermarkTextEl.addEventListener("input", () => {
  updateWatermarkAddEnabled();
  updateWatermarkPreview();
});

watermarkTextSizeEl.addEventListener("input", () => {
  updateWatermarkTextSizeLabel();
  updateWatermarkPreview();
});

watermarkOpacityEl.addEventListener("input", () => {
  updateWatermarkOpacityLabel();
  updateWatermarkPreview();
});

watermarkOrientationEl.addEventListener("change", updateWatermarkPreview);

watermarkChooseLogoBtn.addEventListener("click", () => watermarkLogoFileEl.click());

watermarkLogoFileEl.addEventListener("change", async () => {
  const file = watermarkLogoFileEl.files?.[0];
  if (!file) return;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("failed to read logo file"));
    reader.readAsDataURL(file);
  });
  await setWatermarkLogoDataUrl(dataUrl);
  showWatermarkLogoPreview(dataUrl, file.name);
});

watermarkRemoveLogoBtn.addEventListener("click", async () => {
  await clearWatermarkLogoDataUrl();
  watermarkLogoFileEl.value = "";
  showWatermarkLogoPreview(null, "");
});

watermarkCancelBtn.addEventListener("click", closeWatermarkPanel);

watermarkAddBtn.addEventListener("click", async () => {
  await watermarkLogoBitmapReady;
  const text = watermarkTextEl.value.trim();
  const opacity = Number(watermarkOpacityEl.value) / 100;
  const location = watermarkLocationEl.value as WatermarkLocation;
  const orientationDeg = Number(watermarkOrientationEl.value) as 0 | 45;
  const textScale = Number(watermarkTextSizeEl.value) / 100;
  if (!text && !watermarkLogoBitmap) return; // belt-and-suspenders; the button is disabled for this case already
  if (pendingShape) commitPendingShape(); // bake whatever was already pending first, same as switching tools
  // The private module only renders — it doesn't know this page's undo
  // stack shape, so it hands back the pre-draw snapshot of each band and
  // this is what pushes it as a single "regions" undo entry.
  const regions = applyWatermarkPattern(ctx, canvas.width, canvas.height, location, orientationDeg, text, watermarkLogoBitmap, opacity, textScale);
  pushHistory({ kind: "regions", regions });
  closeWatermarkPanel();
  selectTool("select");
});

// --- watermark: Supporter gate -------------------------------------------
//
// The watermark tool is OpenCapture's one paid feature — a one-time,
// 1000-credit unlock via openapps-gateway (see that crate's README for why
// this is a deduct that isn't a "deduct proxy": it charges for granting a
// server-verifiable entitlement, not for a claimed local job). Every other
// tool in this editor works with no account at all; clicking Watermark is
// the only place any of this is ever checked.

const SUPPORTER_REF_ID = "opencapture_supporter_unlock";

const watermarkGatePanel = document.getElementById("watermarkGatePanel")!;
const watermarkGateMessageEl = document.getElementById("watermarkGateMessage")!;
const watermarkGateCancelBtn = document.getElementById("watermarkGateCancel") as HTMLButtonElement;
const watermarkGateActionBtn = document.getElementById("watermarkGateAction") as HTMLButtonElement;

type WatermarkGateState =
  | { kind: "checking" }
  | { kind: "signed-out" }
  | { kind: "locked" }
  | { kind: "unlocking" }
  | { kind: "insufficient"; have: number; need: number }
  | { kind: "error"; message: string };

function openAccountTab(): void {
  ext.tabs.create({ url: ext.runtime.getURL("account.html") });
}

function renderWatermarkGate(state: WatermarkGateState): void {
  watermarkGatePanel.hidden = false;
  watermarkGateActionBtn.hidden = false;
  watermarkGateActionBtn.disabled = false;
  switch (state.kind) {
    case "checking":
      watermarkGateMessageEl.textContent = "Checking your account…";
      watermarkGateActionBtn.hidden = true;
      break;
    case "signed-out":
      watermarkGateMessageEl.textContent = "The watermark tool is a Supporter feature. Sign in to unlock it — 1000 credits, one time.";
      watermarkGateActionBtn.textContent = "Sign in";
      watermarkGateActionBtn.onclick = () => {
        closeWatermarkGate();
        openAccountTab();
      };
      break;
    case "locked":
      watermarkGateMessageEl.textContent = "The watermark tool is a Supporter feature — 1000 credits, one time, unlocks it for good.";
      watermarkGateActionBtn.textContent = "Unlock for 1000 credits";
      watermarkGateActionBtn.onclick = () => void handleUnlockClick();
      break;
    case "unlocking":
      watermarkGateMessageEl.textContent = "Unlocking…";
      watermarkGateActionBtn.disabled = true;
      break;
    case "insufficient":
      watermarkGateMessageEl.textContent = `You have ${state.have.toLocaleString()} credits — unlocking Supporter costs ${state.need.toLocaleString()}.`;
      watermarkGateActionBtn.textContent = "Buy credits";
      watermarkGateActionBtn.onclick = () => {
        closeWatermarkGate();
        openAccountTab();
      };
      break;
    case "error":
      watermarkGateMessageEl.textContent = state.message;
      watermarkGateActionBtn.textContent = "Try again";
      watermarkGateActionBtn.onclick = () => void handleWatermarkToolClick();
      break;
  }
}

function closeWatermarkGate(): void {
  watermarkGatePanel.hidden = true;
}

watermarkGateCancelBtn.addEventListener("click", closeWatermarkGate);

/** Read-only: has this account already redeemed the Supporter unlock?
 * Calls openapps-server directly (no app key needed — it only ever
 * answers about the caller's own ledger), not the gateway, which is only
 * for the one route that actually spends credits. */
async function isSupporterUnlocked(): Promise<boolean> {
  const token = openappsStore.get()?.accessToken;
  if (!token) return false;
  try {
    const res = await fetch(`${OPENAPPS_BASE_URL}/v1/credits/entitlement?ref_id=${encodeURIComponent(SUPPORTER_REF_ID)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { unlocked?: boolean };
    return body.unlocked === true;
  } catch {
    return false;
  }
}

type UnlockResult =
  | { ok: true; newBalance: number }
  | { ok: false; kind: "insufficient_credits"; have: number; need: number }
  | { ok: false; kind: "other"; message: string };

/** The one place this extension ever spends credits. Talks to
 * openapps-gateway, never openapps-server directly — the gateway is what
 * holds the app key that turns a user token into an actual charge. */
async function unlockSupporter(): Promise<UnlockResult> {
  const token = openappsStore.get()?.accessToken;
  if (!token) return { ok: false, kind: "other", message: "not signed in" };
  try {
    const res = await fetch(`${OPENAPPS_GATEWAY_URL}/opencapture/supporter/unlock`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { new_balance?: number; have?: number; need?: number; error?: string };
    if (res.ok && typeof body.new_balance === "number") return { ok: true, newBalance: body.new_balance };
    if (res.status === 402 && typeof body.have === "number" && typeof body.need === "number") {
      return { ok: false, kind: "insufficient_credits", have: body.have, need: body.need };
    }
    return { ok: false, kind: "other", message: body.error ?? "unlock failed" };
  } catch {
    return { ok: false, kind: "other", message: "network" };
  }
}

/**
 * The gateway is an optional host permission, so the browser's install dialog
 * never names it. That dialog is the highest-friction moment in the whole
 * funnel — "Read and change your data on <host>" costs installs — and the
 * gateway is only ever contacted by the one person in a hundred who buys the
 * watermark unlock. Asking then, rather than at install, is both less
 * alarming and more honest about when the access is actually used.
 *
 * Must run before any other await in the click handler: `permissions.request`
 * needs the user gesture, and the first await spends it.
 */
async function ensureGatewayAccess(): Promise<boolean> {
  const origins = [`${OPENAPPS_GATEWAY_URL}/*`];
  try {
    // Already granted on every run after the first — and in the E2E build,
    // whose <all_urls> covers it, so the tests never see a prompt.
    if (await ext.permissions.contains({ origins })) return true;
    return await ext.permissions.request({ origins });
  } catch {
    return false;
  }
}

async function handleUnlockClick(): Promise<void> {
  if (!(await ensureGatewayAccess())) {
    renderWatermarkGate({
      kind: "error",
      message: "Permission is needed to complete the purchase. Try Unlock again and choose Allow.",
    });
    return;
  }
  renderWatermarkGate({ kind: "unlocking" });
  const result = await unlockSupporter();
  if (result.ok) {
    closeWatermarkGate();
    void openWatermarkPanel();
    return;
  }
  if (result.kind === "insufficient_credits") {
    renderWatermarkGate({ kind: "insufficient", have: result.have, need: result.need });
    return;
  }
  renderWatermarkGate({ kind: "error", message: "Couldn't unlock — please try again." });
}

// Also called automatically (see the visibilitychange and storage
// listeners below) whenever this tab might have gone from signed-out or
// locked to unlocked while it was in the background. Without the two
// guards below, a trigger that fires while an earlier call is still
// awaiting the entitlement check — or after the watermark panel is
// already open — would run a second, overlapping check that reopens
// openWatermarkPanel() and resets the text field mid-edit; each
// straggler resolving at its own pace is what made typing look like it
// randomly stopped getting eaten "after a while".
let watermarkGateCheckInFlight = false;

async function handleWatermarkToolClick(): Promise<void> {
  if (watermarkGateCheckInFlight || !watermarkPanel.hidden) return;
  watermarkGateCheckInFlight = true;
  try {
    renderWatermarkGate({ kind: "checking" });
    await openappsReady;
    if (!openappsClient.isLoggedIn) {
      renderWatermarkGate({ kind: "signed-out" });
      return;
    }
    const unlocked = await isSupporterUnlocked();
    if (unlocked) {
      closeWatermarkGate();
      void openWatermarkPanel();
      return;
    }
    renderWatermarkGate({ kind: "locked" });
  } finally {
    watermarkGateCheckInFlight = false;
  }
}

// openappsClient here was constructed once at page load and hydrated from
// chrome.storage.session then — it has no built-in way to notice a session
// adopted later by background.ts from a *different* tab's sign-in (see
// asyncBackedStore in the SDK: the in-memory copy only updates via this
// same instance's own set()/adoptSession()). account.ts solves this with a
// full page reload; that would be wrong here, since it could discard
// in-progress canvas edits. Re-hydrating this client directly, in place,
// gets the same result without touching the canvas.
ext.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "session" || !("openapps.session" in changes)) return;
  const next = changes["openapps.session"].newValue as { accessToken: string; refreshToken: string } | undefined;
  if (next) {
    openappsClient.adoptSession(next.accessToken, next.refreshToken);
  } else {
    openappsClient.clearSession();
  }
  if (!watermarkGatePanel.hidden) void handleWatermarkToolClick();
});

// Buying credits happens in the account tab too (see "insufficient" above),
// and a balance top-up isn't a session change, so the listener above won't
// catch it. Re-running the check whenever this tab becomes visible again
// covers that case, and is a harmless no-op re-check otherwise. Only while
// the gate is actually open: an unrelated tab switch while the watermark
// panel itself is in use shouldn't trigger a check.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !watermarkGatePanel.hidden) {
    void handleWatermarkToolClick();
  }
});

// --- toolbar / load / save --------------------------------------------------

toolButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset["tool"] === "watermark") {
      void handleWatermarkToolClick();
      return;
    }
    selectTool(btn.dataset["tool"] as Tool);
  });
});

undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);
refreshHistoryUi();

document.getElementById("closeEditor")!.addEventListener("click", async () => {
  // window.close() alone can silently no-op for a tab this document didn't
  // itself open via window.open() — which is exactly how the editor tab
  // gets created (chrome.tabs.create() from the background service
  // worker) — so close it explicitly by tab id, falling back to
  // window.close() if getCurrent() ever comes back empty (e.g. this page
  // opened some other way).
  const tab = await ext.tabs.getCurrent();
  if (tab?.id !== undefined) {
    await ext.tabs.remove(tab.id);
  } else {
    window.close();
  }
});

document.getElementById("splitNoticeClose")!.addEventListener("click", () => {
  document.getElementById("splitNotice")!.classList.remove("visible");
});

cropApplyBtn.addEventListener("click", commitPendingCrop);
cropCancelBtn.addEventListener("click", cancelPendingCrop);

// --- zoom -----------------------------------------------------------------

// "fit" is the default and means what the CSS already did: scale down to the
// window's width. A retina capture is 2-3x its CSS size, so fit is the only
// sensible starting point — but it also means you cannot inspect anything at
// native resolution, which is what zoom is for.
type Zoom = "fit" | number;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
let zoom: Zoom = "fit";

const zoomOutBtn = document.getElementById("zoomOut") as HTMLButtonElement;
const zoomInBtn = document.getElementById("zoomIn") as HTMLButtonElement;
const zoomLevelBtn = document.getElementById("zoomLevel") as HTMLButtonElement;
// The level is written into the label span, not the button: the button also
// holds an icon, and setting its textContent would delete it.
const zoomLevelLabel = document.getElementById("zoomLevelLabel") as HTMLSpanElement;
const zoomFitBtn = document.getElementById("zoomFit") as HTMLButtonElement;

/** What "fit" currently works out to, so stepping from it continues sensibly. */
function fittedFactor(): number {
  const rect = canvas.getBoundingClientRect();
  return canvas.width > 0 && rect.width > 0 ? rect.width / canvas.width : 1;
}

function applyZoom(): void {
  if (zoom === "fit") {
    canvas.classList.remove("is-zoomed");
    canvas.style.width = "";
    zoomLevelLabel.textContent = "Fit";
  } else {
    canvas.classList.add("is-zoomed");
    canvas.style.width = `${Math.round(canvas.width * zoom)}px`;
    zoomLevelLabel.textContent = `${Math.round(zoom * 100)}%`;
  }
  zoomOutBtn.disabled = zoom !== "fit" && zoom <= ZOOM_STEPS[0]!;
  zoomInBtn.disabled = zoom !== "fit" && zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  // The preview overlay is positioned in JS against the canvas's rendered box,
  // so it has to be re-laid-out or the crop marquee drifts off the image.
  syncPreviewCanvas();
}

function stepZoom(direction: 1 | -1): void {
  const current = zoom === "fit" ? fittedFactor() : zoom;
  const next =
    direction > 0
      ? ZOOM_STEPS.find((z) => z > current + 0.001)
      : [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001);
  if (next === undefined) return;
  zoom = next;
  applyZoom();
}

function setZoom(next: Zoom): void {
  zoom = next;
  applyZoom();
}

zoomInBtn.addEventListener("click", () => stepZoom(1));
zoomOutBtn.addEventListener("click", () => stepZoom(-1));
zoomFitBtn.addEventListener("click", () => setZoom("fit"));
zoomLevelBtn.addEventListener("click", () => setZoom(zoom === 1 ? "fit" : 1));

// Ctrl/Cmd+wheel is what people expect on an image; without preventDefault the
// browser zooms the whole page instead, which moves the toolbar too.
canvasWrap.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  },
  { passive: false },
);

applyZoom();

// --- browser frame --------------------------------------------------------

const framePanel = document.getElementById("framePanel") as HTMLDivElement;
const framePresetEl = document.getElementById("framePreset") as HTMLSelectElement;
const frameShowUrlEl = document.getElementById("frameShowUrl") as HTMLInputElement;
const frameShowDateEl = document.getElementById("frameShowDate") as HTMLInputElement;
const frameShowTimeEl = document.getElementById("frameShowTime") as HTMLInputElement;
const frameUrlPreviewEl = document.getElementById("frameUrlPreview") as HTMLParagraphElement;
const frameApplyBtn = document.getElementById("frameApply") as HTMLButtonElement;
const frameCancelBtn = document.getElementById("frameCancel") as HTMLButtonElement;
const toolFrameBtn = document.getElementById("toolFrame") as HTMLButtonElement;

// Handed over by the background worker at capture time — the editor is its own
// tab and cannot ask which page the pixels came from.
let capturePageUrl = "";
let captureTakenAt = Date.now();

/**
 * Which frame is currently composited into the canvas.
 *
 * A frame is a property of the image, not an edit stacked onto it: choosing a
 * second preset must *replace* the first. Tracking what is already there is
 * what makes that possible — the old chrome is cropped back off before the new
 * one is drawn, so "macOS then Windows" gives a Windows window, and "None"
 * gives the bare screenshot back.
 */
let appliedFrame: FramePreset = "none";

function refreshFramePreview(): void {
  // The URL shows whatever the preset, because it is information about the
  // capture rather than about the frame — and seeing it is how you tell
  // whether stamping it is safe to share before you commit to the frame.
  const source = capturePageUrl
    ? `URL: ${capturePageUrl}`
    : "No URL recorded for this capture — the address bar will be left empty.";
  const preset = framePresetEl.value as FramePreset;
  frameUrlPreviewEl.textContent = preset === "none" ? `${source} · no frame selected` : source;
}

function openFramePanel(): void {
  // Show the frame that is actually on the image, not whatever was picked
  // last time. Reopening the panel is how you check, change, or remove it.
  framePresetEl.value = appliedFrame;
  framePanel.hidden = false;
  refreshFramePreview();
}

function closeFramePanel(): void {
  framePanel.hidden = true;
  selectTool("select");
}

/**
 * The screenshot with the current frame cropped back off.
 *
 * Frames are drawn into the canvas rather than kept beside it, so removing or
 * replacing one means undoing that draw geometrically. `framePixelInsets` is
 * the same arithmetic `drawFrame` used to add the chrome, so this lands on
 * exactly the original pixel bounds. Annotations drawn on top of the
 * screenshot survive; anything drawn on the chrome itself goes with it, which
 * is the only sensible reading of "replace this frame".
 */
function unframedSource(): HTMLCanvasElement {
  const { top, bottom, side } = framePixelInsets(appliedFrame, currentDpr);
  const out = document.createElement("canvas");
  out.width = Math.max(1, canvas.width - side * 2);
  out.height = Math.max(1, canvas.height - top - bottom);
  const octx = out.getContext("2d");
  if (octx) octx.drawImage(canvas, side, top, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/**
 * Put the chosen frame on the image as one undoable step — replacing whatever
 * frame was there, never wrapping it. It changes the canvas size, so the
 * snapshot has to be a full one, the same shape a crop pushes.
 */
function applyFrame(): void {
  const preset = framePresetEl.value as FramePreset;

  // Nothing to add and nothing to strip.
  if (preset === "none" && appliedFrame === "none") {
    closeFramePanel();
    return;
  }

  const before: Snapshot = {
    kind: "full",
    width: canvas.width,
    height: canvas.height,
    data: ctx.getImageData(0, 0, canvas.width, canvas.height),
    frame: appliedFrame,
  };

  // Strip the old chrome first; `unframedSource` is a copy, so the canvas is
  // safe to resize out from under it below.
  const bare = appliedFrame === "none" ? null : unframedSource();
  const source = bare ?? canvas;
  const framed = drawFrame(source, {
    preset,
    url: capturePageUrl,
    capturedAt: captureTakenAt,
    showUrl: frameShowUrlEl.checked,
    showDate: frameShowDateEl.checked,
    showTime: frameShowTimeEl.checked,
  }, currentDpr);

  // drawFrame returns null for "none" — then the bare screenshot *is* the
  // result. `bare` is non-null here: the both-none case returned above.
  const next = framed ?? bare;
  if (!next) {
    closeFramePanel();
    return;
  }

  pushHistory(before);
  canvas.width = next.width;
  canvas.height = next.height;
  ctx.drawImage(next, 0, 0);
  appliedFrame = preset;
  syncPreviewCanvas();
  closeFramePanel();
  setStatus(preset === "none" ? "Frame removed." : "Frame applied.");
}

toolFrameBtn.addEventListener("click", openFramePanel);
frameCancelBtn.addEventListener("click", closeFramePanel);
frameApplyBtn.addEventListener("click", applyFrame);
framePresetEl.addEventListener("change", refreshFramePreview);

window.addEventListener("keydown", (e) => {
  // The shortcuts people already have in their fingers. Checked before the
  // pending-crop/shape branches below return early, since those swallow keys.
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    if ((key === "z" && e.shiftKey) || key === "y") {
      e.preventDefault();
      redo();
      return;
    }
    // "=" is the unshifted key most keyboards put "+" on.
    if (key === "=" || key === "+") {
      e.preventDefault();
      stepZoom(1);
      return;
    }
    if (key === "-" || key === "_") {
      e.preventDefault();
      stepZoom(-1);
      return;
    }
    if (key === "0") {
      e.preventDefault();
      setZoom("fit");
      return;
    }
  }
  if (pendingCrop) {
    if (e.key === "Enter") commitPendingCrop();
    else if (e.key === "Escape") cancelPendingCrop();
    return;
  }
  if (pendingShape) {
    if (e.key === "Enter") commitPendingShape();
    else if (e.key === "Escape") cancelPendingShape();
    else if (e.key === "Delete" || e.key === "Backspace") cancelPendingShape();
  }
});

function canvasPngBytes(): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("canvas.toBlob returned null"));
        return;
      }
      blob
        .arrayBuffer()
        .then((buf) => resolve(new Uint8Array(buf)))
        .catch(reject);
    }, "image/png");
  });
}

// Where PNG/PDF exports land — saveOutput() (chrome/save.ts) already reads
// the same getSavePrefs()/getSavedDirectoryHandle() the popup's own
// "Save to" fieldset writes, so this panel is a second place to see and
// change the *same* setting, not a separate one. Mirrors popup.ts's own
// loadSavePrefs/persistSavePrefs/refreshCustomFolder exactly.
const saveSettingsBtn = document.getElementById("saveSettingsBtn") as HTMLButtonElement;
const saveSettingsLabel = document.getElementById("saveSettingsLabel")!;
const saveSettingsPanel = document.getElementById("saveSettingsPanel")!;
const editorPrefFilenameEl = document.getElementById("editorPrefFilename") as HTMLInputElement;
const editorPrefAskWhereEl = document.getElementById("editorPrefAskWhere") as HTMLInputElement;
const editorCustomFolderNameEl = document.getElementById("editorCustomFolderName")!;
const editorBrowseFolderBtn = document.getElementById("editorBrowseFolder") as HTMLButtonElement;

// Same as popup.ts: showDirectoryPicker() (Chromium-only) has no Firefox
// equivalent at all, so hide the button entirely rather than showing
// something that can only error.
if (!("showDirectoryPicker" in window)) {
  editorBrowseFolderBtn.style.display = "none";
}

async function refreshSaveSettingsUi(): Promise<void> {
  const [prefs, handle] = await Promise.all([getSavePrefs(), getSavedDirectoryHandle()]);
  editorPrefFilenameEl.placeholder = prefs.filename;
  editorPrefFilenameEl.value = prefs.filename === "opencapture" ? "" : prefs.filename;
  editorPrefAskWhereEl.checked = prefs.askWhereToSave;
  const folderLabel = handle ? handle.name : "Your Downloads folder (default)";
  editorCustomFolderNameEl.textContent = folderLabel;
  saveSettingsLabel.textContent = handle ? handle.name : "Downloads";
}

async function persistEditorSavePrefs(): Promise<void> {
  await setSavePrefs({
    folder: "",
    filename: editorPrefFilenameEl.value.trim() || "opencapture",
    askWhereToSave: editorPrefAskWhereEl.checked,
  });
  await refreshSaveSettingsUi();
}

editorPrefFilenameEl.addEventListener("change", () => void persistEditorSavePrefs());
editorPrefAskWhereEl.addEventListener("change", () => void persistEditorSavePrefs());

editorBrowseFolderBtn.addEventListener("click", async () => {
  const result = await pickDirectory();
  if (!result.ok && !result.cancelled) {
    setStatus(`Couldn't set that folder: ${result.error}`);
  }
  await refreshSaveSettingsUi();
});

saveSettingsBtn.addEventListener("click", () => {
  saveSettingsPanel.hidden = !saveSettingsPanel.hidden;
});

void refreshSaveSettingsUi();

// Called directly, not routed through the service worker — same reasoning
// as popup.ts's own copy button (see chrome/copy-image.ts): the clipboard
// write must happen in the document that received the real click, and the
// editor tab is one, same as the popup is.
document.getElementById("copyToClipboard")!.addEventListener("click", async () => {
  if (pendingShape) commitPendingShape(); // so the copy matches what's on screen
  setStatus("Copying to clipboard…");
  try {
    await copyPngBytesToClipboard(await canvasPngBytes());
    setStatus("Copied to clipboard.");
  } catch (err) {
    setStatus(`Copy failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

document.getElementById("downloadPng")!.addEventListener("click", async () => {
  if (pendingShape) commitPendingShape(); // so the download matches what's on screen
  try {
    const result = await saveOutput(await canvasPngBytes(), "-annotated", "png", "image/png");
    setStatus(result.savedToCustomFolder ? `Saved to your chosen folder — ${canvas.width}×${canvas.height}` : `${canvas.width}×${canvas.height}`);
  } catch (err) {
    setStatus(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

document.getElementById("downloadPdf")!.addEventListener("click", async () => {
  if (pendingShape) commitPendingShape(); // so the download matches what's on screen
  setStatus("Building PDF…");
  try {
    const pngBytes = await canvasPngBytes();
    const shotCore = await loadShotCore();
    const pdfBytes = shotCore.pngToPdf(pngBytes, currentDpr) as Uint8Array;
    const result = await saveOutput(pdfBytes, "-annotated", "pdf", "application/pdf");
    setStatus(result.savedToCustomFolder ? `Saved to your chosen folder — ${canvas.width}×${canvas.height}` : `${canvas.width}×${canvas.height}`);
  } catch (err) {
    setStatus(`PDF export failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// Static import (see the top-of-file import) so Vite bundles the
// wasm-bindgen glue and rewrites its internal `new URL(..., import.meta.url)`
// into a proper hashed asset — same reasoning as
// background/wasm-loader.ts, though a normal extension page (unlike a
// service worker) could also use a dynamic import() here if ever needed.
let shotCorePromise: Promise<typeof ShotCore> | null = null;
function loadShotCore(): Promise<typeof ShotCore> {
  if (!shotCorePromise) shotCorePromise = init().then(() => ShotCore);
  return shotCorePromise;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Fetches the pending capture from the background context over a
// runtime.connect Port instead of reading blob-store's IndexedDB directly
// from this document — see EDITOR_IMAGE_PORT_NAME's comment in
// blob-store.ts for why (Firefox private-browsing storage partitioning).
// Resolves null if there was no pending image (background sends a bare
// `{done: true}` with no chunks first).
function requestEditorImageBytes(): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const port = ext.runtime.connect({ name: EDITOR_IMAGE_PORT_NAME });
    const chunks: Uint8Array[] = [];
    port.onMessage.addListener((msg: { chunk?: string; done?: boolean }) => {
      if (msg.chunk) {
        chunks.push(base64ToBytes(msg.chunk));
        return;
      }
      if (!msg.done) return;
      port.disconnect();
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(merged);
    });
  });
}

// No resolution cap here: the editor always loads a capture at its true
// native resolution. commitPendingShape() bakes every shape directly into
// this canvas's own pixels, so the browser has to rasterize/composite
// however large the canvas is on every single commit — measured as a real
// multi-hundred-ms main-thread stall on unusually large full-page
// captures (many megapixels at a high DPR), regardless of GPU vs CPU
// canvas rendering mode, since the canvas itself is just too big to push
// around quickly either way. A resolution cap traded that lag away for
// reduced output quality on those captures; kept off deliberately, so a
// large enough capture is genuinely slow to edit again. Fixing that
// without giving up resolution means re-rendering annotations onto the
// original at export time instead of baking them into a capped canvas —
// which needs every shape kept as data, not pixels — a much bigger change
// than this file makes today.
async function loadImage(): Promise<void> {
  const bytes = await requestEditorImageBytes();
  const stored = await ext.storage.session.get(["editorDpr", "editorImageCount", "editorPageUrl", "editorCapturedAt"]);
  const dpr: number | undefined = stored["editorDpr"];
  const imageCount: number | undefined = stored["editorImageCount"];
  capturePageUrl = (stored["editorPageUrl"] as string | undefined) ?? "";
  captureTakenAt = (stored["editorCapturedAt"] as number | undefined) ?? Date.now();
  if (!bytes) {
    setStatus("No captured image found — capture a page first, then click Annotate.");
    return;
  }
  currentDpr = dpr ?? 1;
  const blob = new Blob([bytes as BlobPart], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  ctx.drawImage(bitmap, 0, 0);
  syncPreviewCanvas();
  setStatus(`${bitmap.width}×${bitmap.height}`);
  selectTool("crop");
  // A page large enough to exceed shot-core's per-image pixel cap
  // (plan.rs's MAX_CANVAS_AREA_PX) splits into several output PNGs — this
  // editor only ever gets the first one (see getLastCaptureFirstImage's
  // own comment for why: cropping across a split boundary isn't
  // well-defined). Silently showing part of the page as if it were the
  // whole thing reads as data loss, not a deliberate tradeoff, unless
  // this says so — a persistent banner rather than the status caption
  // above, since that gets overwritten by the very next tool click.
  if (imageCount && imageCount > 1) {
    document.getElementById("splitNoticeText")!.textContent =
      `Showing part 1 of ${imageCount} — this page was too large for one image and was split. Use “Export as PDF” from the popup for the complete page.`;
    document.getElementById("splitNotice")!.classList.add("visible");
  }
}

// The canvas's rendered size (and so previewCanvas's, which tracks it)
// depends on the window's available width via max-width:100% — resync on
// resize so preview drawings stay aligned with the real canvas.
window.addEventListener("resize", syncPreviewCanvas);

loadImage();
