import { describe, expect, it } from "vitest";
import { canvasHeldImage, type DrawSurface } from "./canvas-limit";

/** A canvas that took the draw: opaque wherever it is sampled. */
function opaque(width: number, height: number): DrawSurface {
  return { canvas: { width, height }, getImageData: () => ({ data: [12, 34, 56, 255] }) };
}

/** A canvas over the device's limit: draws no-op, every pixel stays clear. */
function silentlyEmpty(width: number, height: number): DrawSurface {
  return { canvas: { width, height }, getImageData: () => ({ data: [0, 0, 0, 0] }) };
}

describe("canvasHeldImage", () => {
  it("accepts a canvas that took the draw", () => {
    expect(canvasHeldImage(opaque(1200, 40000), 1200, 40000)).toBe(true);
  });

  it("rejects a canvas whose draws silently no-opped", () => {
    expect(canvasHeldImage(silentlyEmpty(1200, 40000), 1200, 40000)).toBe(false);
  });

  it("rejects a canvas that refused the size, without comparing pixels", () => {
    // Some engines clamp rather than accept-and-no-op.
    const clamped: DrawSurface = {
      canvas: { width: 1200, height: 16384 },
      getImageData: () => {
        throw new Error("should not sample a canvas of the wrong size");
      },
    };
    expect(canvasHeldImage(clamped, 1200, 40000)).toBe(false);
  });

  it("rejects a canvas whose reads throw outright", () => {
    const hostile: DrawSurface = {
      canvas: { width: 1200, height: 40000 },
      getImageData: () => {
        throw new Error("canvas is unusable");
      },
    };
    expect(canvasHeldImage(hostile, 1200, 40000)).toBe(false);
  });

  it("accepts an image that is blank at the corners but not in the middle", () => {
    // A page with wide white margins is still a page. One clear sample
    // must not condemn the whole capture.
    const marginy: DrawSurface = {
      canvas: { width: 1000, height: 2000 },
      getImageData: (x, y) => ({ data: x === 500 && y === 1000 ? [255, 255, 255, 255] : [0, 0, 0, 0] }),
    };
    expect(canvasHeldImage(marginy, 1000, 2000)).toBe(true);
  });

  it("rejects an empty image rather than sampling out of bounds", () => {
    expect(canvasHeldImage(opaque(0, 0), 0, 0)).toBe(false);
  });
});
