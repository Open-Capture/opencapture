import { describe, expect, it } from "vitest";
import { placeCropBar, type ScreenBox } from "./crop-bar";

// A desktop editor window below a 60px toolbar, and a phone-width one.
const DESKTOP: ScreenBox = { left: 0, top: 60, right: 1440, bottom: 900 };
const PHONE: ScreenBox = { left: 0, top: 110, right: 390, bottom: 844 };
const BAR = { width: 460, height: 44 };
const GAP = 13;
const M = 8;

function box(left: number, top: number, right: number, bottom: number): ScreenBox {
  return { left, top, right, bottom };
}

describe("placeCropBar", () => {
  it("sits just below the frame, right-aligned with it", () => {
    const p = placeCropBar(box(200, 150, 900, 500), DESKTOP, BAR, GAP, M);
    expect(p).toEqual({ left: 900 - BAR.width, top: 500 + GAP, side: "below" });
  });

  it("flips above when the frame reaches the bottom of the view", () => {
    const p = placeCropBar(box(200, 300, 900, 880), DESKTOP, BAR, GAP, M);
    expect(p.side).toBe("above");
    expect(p.top).toBe(300 - GAP - BAR.height);
    // Above, never overlapping the frame.
    expect(p.top + BAR.height).toBeLessThanOrEqual(300);
  });

  it("goes beside the frame when there is no room above or below", () => {
    const p = placeCropBar(box(100, 70, 600, 890), DESKTOP, BAR, GAP, M);
    expect(p.side).toBe("right");
    expect(p.left).toBe(600 + GAP);
    expect(p.top + BAR.height).toBeLessThanOrEqual(DESKTOP.bottom - M);
  });

  it("uses the left side when the frame is against the right edge", () => {
    const p = placeCropBar(box(800, 70, 1430, 890), DESKTOP, BAR, GAP, M);
    expect(p.side).toBe("left");
    expect(p.left + BAR.width).toBe(800 - GAP);
  });

  it("goes inside the frame when the frame fills the view", () => {
    const p = placeCropBar(box(0, 60, 1440, 900), DESKTOP, BAR, GAP, M);
    expect(p.side).toBe("inside");
    expect(p.left + BAR.width).toBeLessThanOrEqual(1440 - GAP);
    expect(p.top + BAR.height).toBeLessThanOrEqual(900 - GAP);
    expect(p.top).toBeGreaterThanOrEqual(60);
  });

  it("stays inside the visible part of a frame that runs off the view", () => {
    // Taller and wider than the window, as a full-page capture often is.
    const p = placeCropBar(box(-50, -400, 2000, 3000), DESKTOP, BAR, GAP, M);
    expect(p.side).toBe("inside");
    expect(p.left).toBeGreaterThanOrEqual(DESKTOP.left + M);
    expect(p.left + BAR.width).toBeLessThanOrEqual(DESKTOP.right - M);
    expect(p.top + BAR.height).toBeLessThanOrEqual(DESKTOP.bottom - M);
  });

  it("is clamped horizontally rather than leaving the screen", () => {
    // A narrow box near the left edge: right-aligning would push the bar off
    // the left side of the window.
    const p = placeCropBar(box(10, 150, 120, 400), DESKTOP, BAR, GAP, M);
    expect(p.side).toBe("below");
    expect(p.left).toBe(DESKTOP.left + M);
  });

  it("on a phone, a bar wider than the screen starts at the left margin", () => {
    // The bar wraps in CSS at phone width; if it is still wider, the start —
    // where Apply is — is what must stay on screen.
    const wide = { width: 500, height: 84 };
    const p = placeCropBar(box(40, 200, 350, 500), PHONE, wide, GAP, M);
    expect(p.side).toBe("below");
    expect(p.left).toBe(PHONE.left + M);
  });

  it("on a phone, flips above near the bottom and stays below the toolbar", () => {
    const bar = { width: 374, height: 84 };
    const p = placeCropBar(box(40, 400, 350, 820), PHONE, bar, GAP, M);
    expect(p.side).toBe("above");
    expect(p.top).toBeGreaterThanOrEqual(PHONE.top + M);
    expect(p.top + bar.height).toBeLessThanOrEqual(400 - GAP);
  });

  it("returns whole pixels", () => {
    const p = placeCropBar(box(100.4, 150.6, 700.3, 400.2), DESKTOP, BAR, 12.5, M);
    expect(Number.isInteger(p.left)).toBe(true);
    expect(Number.isInteger(p.top)).toBe(true);
  });
});
