// Where the crop bar (Apply / Cancel / size) goes, given where the marquee is
// on screen. It used to be pinned to the bottom centre of the window, which on
// a tall capture or a phone is a long way from the box you just drew — and on
// a phone the bottom edge is also where the browser's own toolbar and the
// system gesture area are, so the button was hard to hit at all.
//
// Pure geometry, kept out of editor.ts so it can be tested without a DOM.
// Everything is in client (CSS px, viewport) coordinates.

export type ScreenBox = { left: number; top: number; right: number; bottom: number };
export type CropBarSide = "below" | "above" | "right" | "left" | "inside";
export type CropBarPlacement = { left: number; top: number; side: CropBarSide };

function clamp(v: number, lo: number, hi: number): number {
  // When the bar is wider/taller than the view, lo > hi: pin to lo, so at
  // least its start (the Apply button) stays reachable.
  return hi < lo ? lo : Math.min(hi, Math.max(lo, v));
}

/**
 * Places a bar of `size` next to `box`, inside `view`.
 *
 * Preference order: just below the frame, right-aligned with it (where the
 * pointer usually is after drawing top-left to bottom-right); else just
 * above; else beside it, to the right or left; else, when the box leaves no
 * room on any side (it fills the view), inside the frame at its bottom-right.
 * The cross axis is always clamped into the view, so the bar follows the box
 * along an edge instead of leaving the screen.
 *
 * `gap` is the space between the frame line and the bar — the caller sizes
 * it to clear the resize handles, so the bar never covers one. `margin` is
 * the space kept between the bar and the edge of the view.
 */
export function placeCropBar(
  box: ScreenBox,
  view: ScreenBox,
  size: { width: number; height: number },
  gap: number,
  margin = 8,
): CropBarPlacement {
  const minLeft = view.left + margin;
  const maxLeft = view.right - margin - size.width;
  const minTop = view.top + margin;
  const maxTop = view.bottom - margin - size.height;
  const fitsV = (top: number) => top >= minTop && top <= maxTop;
  const fitsH = (left: number) => left >= minLeft && left <= maxLeft;

  const alignedLeft = Math.round(clamp(box.right - size.width, minLeft, maxLeft));
  const below = box.bottom + gap;
  if (fitsV(below)) return { left: alignedLeft, top: Math.round(below), side: "below" };
  const above = box.top - gap - size.height;
  if (fitsV(above)) return { left: alignedLeft, top: Math.round(above), side: "above" };

  // Beside the box, level with its bottom edge — or with the bottom of the
  // view when the box runs past it.
  const besideTop = Math.round(clamp(box.bottom - size.height, minTop, maxTop));
  const right = box.right + gap;
  if (fitsH(right)) return { left: Math.round(right), top: besideTop, side: "right" };
  const left = box.left - gap - size.width;
  if (fitsH(left)) return { left: Math.round(left), top: besideTop, side: "left" };

  return {
    left: Math.round(clamp(Math.min(box.right, view.right) - gap - size.width, minLeft, maxLeft)),
    top: Math.round(clamp(Math.min(box.bottom, view.bottom) - gap - size.height, minTop, maxTop)),
    side: "inside",
  };
}
