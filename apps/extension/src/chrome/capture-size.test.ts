import { describe, expect, it } from "vitest";
import {
  MAX_EDITABLE_AREA_PX,
  MAX_EDITABLE_HEIGHT_PX,
  MAX_EDITABLE_WIDTH_PX,
  editableHeightFor,
  exceedsEditableArea,
  needsFormatChoice,
} from "./capture-size";
import type { CaptureReport } from "../types";

const report = (over: Partial<CaptureReport>): CaptureReport => ({
  css_width: 1400,
  css_height: 5000,
  dpr: 1,
  slice_count: 6,
  output_width_px: 1400,
  output_height_px: 5000,
  output_image_count: 1,
  lazy_images_forced: 0,
  pinned_elements_handled: 0,
  aborted: false,
  warnings: [],
  ...over,
});

describe("editableHeightFor", () => {
  it("leaves a capture within the budget at its own height", () => {
    expect(editableHeightFor(1400, 5000)).toBe(5000);
  });

  it("cuts one over the budget to what the budget buys", () => {
    expect(editableHeightFor(1400, 90_000)).toBe(Math.floor(MAX_EDITABLE_AREA_PX / 1400));
  });

  it("gives a narrow capture more rows than a wide one, since the budget is pixels", () => {
    expect(editableHeightFor(700, 200_000)).toBeGreaterThan(editableHeightFor(2940, 200_000));
  });

  it("holds the reference shape exactly", () => {
    expect(editableHeightFor(MAX_EDITABLE_WIDTH_PX, MAX_EDITABLE_HEIGHT_PX)).toBe(MAX_EDITABLE_HEIGHT_PX);
    expect(exceedsEditableArea(MAX_EDITABLE_WIDTH_PX, MAX_EDITABLE_HEIGHT_PX)).toBe(false);
    expect(exceedsEditableArea(MAX_EDITABLE_WIDTH_PX, MAX_EDITABLE_HEIGHT_PX + 1)).toBe(true);
  });

  it("never returns nothing to show, however extreme the shape", () => {
    expect(editableHeightFor(100_000, 100_000)).toBeGreaterThanOrEqual(1);
  });

  it("has nothing to say about a width of zero", () => {
    expect(editableHeightFor(0, 5000)).toBe(5000);
    expect(exceedsEditableArea(0, 5000)).toBe(false);
  });
});

describe("needsFormatChoice", () => {
  it("leaves an ordinary capture alone", () => {
    expect(needsFormatChoice(report({}))).toBe(false);
  });

  it("asks when the capture was split across several PNGs", () => {
    expect(needsFormatChoice(report({ output_image_count: 3 }))).toBe(true);
  });

  it("asks when it is one image the editor still could not hold whole", () => {
    expect(needsFormatChoice(report({ output_height_px: 60_000 }))).toBe(true);
  });
});
