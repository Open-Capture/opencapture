import { describe, expect, it } from "vitest";
import { formatStamp, frameMetrics, framePixelInsets } from "./frame";

// 2026-08-28T14:32:00 local — constructed from parts so the test does not
// depend on the runner's timezone.
const AT = new Date(2026, 7, 28, 14, 32).getTime();

describe("frameMetrics", () => {
  it("reserves a title bar above for the window presets", () => {
    for (const preset of ["macos", "windows"] as const) {
      const m = frameMetrics(preset);
      expect(m.top).toBeGreaterThan(0);
      expect(m.side).toBeGreaterThan(0);
    }
  });

  it("puts a caption below the image and nothing above it", () => {
    const m = frameMetrics("caption");
    expect(m.top).toBe(0);
    expect(m.bottom).toBeGreaterThan(0);
    // No side border either: a caption is a strip under the picture, not a
    // window around it.
    expect(m.side).toBe(0);
  });

  it("adds nothing at all for none", () => {
    expect(frameMetrics("none")).toEqual({ top: 0, bottom: 0, side: 0 });
  });
});

describe("formatStamp", () => {
  it("is empty when neither part was asked for, so the caller can skip drawing", () => {
    expect(formatStamp(AT, false, false)).toBe("");
  });

  it("shows only what was asked for", () => {
    const date = formatStamp(AT, true, false);
    const time = formatStamp(AT, false, true);
    const both = formatStamp(AT, true, true);

    expect(date).toContain("2026");
    expect(date).not.toBe(both);

    // A time carries a colon and no year; that holds across locales without
    // pinning the test to one format.
    expect(time).toContain(":");
    expect(time).not.toContain("2026");

    expect(both).toContain(date);
    expect(both).toContain(time);
  });
});

describe("framePixelInsets", () => {
  // The editor crops these exact insets back off to remove or replace a
  // frame. If they ever disagreed with what drawFrame added, every preset
  // change would shave a row off the screenshot or leave a sliver of the old
  // window behind — so the scaling is pinned here rather than trusted.
  it("scales the chrome by the device pixel ratio", () => {
    const css = frameMetrics("macos");
    const device = framePixelInsets("macos", 2);
    expect(device.top).toBe(css.top * 2);
    expect(device.side).toBe(css.side * 2);
    expect(device.bottom).toBe(css.bottom * 2);
  });

  it("never scales below 1, so a reported dpr of 0 cannot collapse the frame", () => {
    expect(framePixelInsets("macos", 0)).toEqual(framePixelInsets("macos", 1));
  });

  it("is all zeroes for none, so stripping 'no frame' is a no-op crop", () => {
    expect(framePixelInsets("none", 3)).toEqual({ top: 0, bottom: 0, side: 0 });
  });
});
