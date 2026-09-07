// How much of a capture the editor will take on, and what to do when a
// capture is bigger than that.
//
// Shared by the background (which decides what happens when a capture
// finishes), the popup (which offers the choice) and the editor (which
// shows as much as it agreed to).

import type { CaptureReport } from "../types";

/**
 * The largest capture the editor still feels like an editor on.
 *
 * Cost here is total pixels, not height: committing a shape re-rasterises
 * the whole canvas, whatever shape it is (see the comment above
 * requestEditorImageBytes in editor.ts for why the editor keeps full
 * resolution and pays that cost). So the budget is an area, and 2940x15559
 * is where it comes from — the largest capture that still responded to a
 * click without a visible stall when this was measured by hand.
 *
 * Nothing is refused for being bigger. Every pixel is captured and every
 * pixel survives into a PNG or a PDF; what changes past this point is that
 * the editor stops being handed the whole thing as though it could cope.
 */
export const MAX_EDITABLE_WIDTH_PX = 2940;
export const MAX_EDITABLE_HEIGHT_PX = 15559;
export const MAX_EDITABLE_AREA_PX = MAX_EDITABLE_WIDTH_PX * MAX_EDITABLE_HEIGHT_PX;

/**
 * How many rows of a capture this wide the editor will show.
 *
 * A capture narrower than the reference shape gets proportionally more rows,
 * because the budget is pixels rather than length — a 1000px-wide page costs
 * a third of what a 2940px-wide one does per row, and there is no reason to
 * cut it at the same height.
 */
export function editableHeightFor(width: number, height: number): number {
  if (width <= 0) return height;
  return Math.max(1, Math.min(height, Math.floor(MAX_EDITABLE_AREA_PX / width)));
}

/** True when the editor would only be showing part of this capture. */
export function exceedsEditableArea(width: number, height: number): boolean {
  return width > 0 && height > editableHeightFor(width, height);
}

/**
 * Whether finishing this capture is the user's decision rather than ours.
 *
 * Two ways to get here, and they want the same conversation: the capture was
 * too large for one PNG and shot-core split it (plan.rs's MAX_CANVAS_AREA_PX),
 * or it fits in one PNG but not in an editor that stays responsive. Either
 * way no single next step is right for everyone — PNG loses the ability to
 * edit, PDF keeps everything but leaves the extension, the editor keeps only
 * the top — so the choice is put to the user instead of picked for them.
 */
export function needsFormatChoice(report: CaptureReport): boolean {
  if (report.output_image_count > 1) return true;
  return exceedsEditableArea(report.output_width_px, report.output_height_px);
}
