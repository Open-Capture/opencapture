// Stand-in for the Supporter watermark renderer, used when the private
// module that implements it is not checked out.
//
// The real renderer lives in its own repository (see .gitmodules) and is not
// covered by this repository's licence. A clone without it used to fail the
// build outright at editor.ts's import — which meant the "Build from source"
// instructions in the README, and the link to them from the website, invited
// people to build something that could not be built. Now the build resolves
// that import to this file instead, says which one it picked, and everything
// except the watermark tool behaves exactly as it does in a release.
//
// The signatures below are the ones editor.ts uses, and they mirror the real
// module's. Drawing nothing is deliberate: a placeholder baked into someone's
// capture would be worse than a tool that visibly does nothing.

export type WatermarkLocation = "top" | "bottom" | "top-bottom" | "full";

export interface WatermarkRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WatermarkSnapshotRegion {
  x: number;
  y: number;
  data: ImageData;
}

let announced = false;

function announce(): void {
  if (announced) return;
  announced = true;
  console.info(
    "OpenCapture: built without the private watermark module, so the watermark tool draws nothing. " +
      "Every other tool is unaffected. See README > Build from source.",
  );
}

/** No-op. The real one draws one watermark instance into `rect`. */
export function drawWatermarkCell(
  _target: CanvasRenderingContext2D,
  _rect: WatermarkRect,
  _text: string,
  _logoBitmap: ImageBitmap | null,
  _opacity: number,
  _textScale?: number,
): void {
  announce();
}

/** Returns no regions, having changed no pixels, so the caller pushes an
 * empty undo entry rather than one that would restore something that was
 * never drawn. */
export function applyWatermarkPattern(
  _ctx: CanvasRenderingContext2D,
  _canvasWidth: number,
  _canvasHeight: number,
  _location: WatermarkLocation,
  _orientationDeg: 0 | 45,
  _text: string,
  _logoBitmap: ImageBitmap | null,
  _opacity: number,
  _textScale: number,
): WatermarkSnapshotRegion[] {
  announce();
  return [];
}
