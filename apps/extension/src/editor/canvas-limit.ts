// A canvas larger than the browser's limits is not an error. The element
// still exists, `getContext("2d")` still hands back a context, and every
// draw call silently becomes a no-op — the exact behaviour shot-core's
// MAX_CANVAS_DIMENSION_PX / MAX_CANVAS_AREA_PX (plan.rs) are sized to stay
// under. Those two numbers are desktop Chrome's real, measured ceilings,
// fixed at compile time and never probed at runtime, so a device with a
// lower ceiling — which phones generally have — can be handed a capture
// this editor cannot display. Nothing throws on the way there, so without
// this check the user is left looking at a blank canvas with no way to
// tell why.
//
// Note this is the editor's problem alone: capture, stitching, PNG
// encoding and PDF assembly all happen in Rust/wasm with no canvas
// involved, so a saved file is unaffected by the device's canvas limits
// even when the editor cannot show it. That's what the message this
// drives tells the user to fall back to.

/**
 * Just enough of a 2D context to ask whether a draw survived — shaped so
 * that a real `CanvasRenderingContext2D` satisfies it structurally, and a
 * test can supply a plain object.
 */
export interface DrawSurface {
  readonly canvas: { readonly width: number; readonly height: number };
  getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
}

/**
 * Whether an image of `imageWidth`×`imageHeight`, already drawn at the
 * origin, actually landed on `surface`.
 *
 * Two ways it can fail. The size assignment itself may not stick, leaving
 * the canvas at some other dimensions; or it sticks and the draw no-ops,
 * leaving every pixel transparent black. Captures come from
 * `tabs.captureVisibleTab` and are fully opaque, so "transparent
 * everywhere sampled" means the pixels never arrived. Sampling three
 * points rather than one keeps a genuinely blank corner — a page with
 * wide white margins, say — from reading as failure on its own.
 */
export function canvasHeldImage(surface: DrawSurface, imageWidth: number, imageHeight: number): boolean {
  if (imageWidth <= 0 || imageHeight <= 0) return false;
  if (surface.canvas.width !== imageWidth || surface.canvas.height !== imageHeight) return false;

  const points: Array<[number, number]> = [
    [0, 0],
    [Math.floor(imageWidth / 2), Math.floor(imageHeight / 2)],
    [imageWidth - 1, imageHeight - 1],
  ];
  try {
    return points.some(([x, y]) => surface.getImageData(x, y, 1, 1).data[3] !== 0);
  } catch {
    // Not hypothetical, and not uniform: measured on desktop at
    // 1200x200000 and 40000x40000, Chromium keeps the canvas sized,
    // no-ops the draw and reads back transparent, while Firefox keeps it
    // sized and throws NS_ERROR_FAILURE out of getImageData instead.
    // Both mean the same thing here — the image is not on screen — so
    // both have to be caught.
    return false;
  }
}
