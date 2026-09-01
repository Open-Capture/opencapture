import { describe, expect, it } from "vitest";
import { addressFieldBox, formatStamp, frameMetrics, framePixelInsets } from "./frame";

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

describe("addressFieldBox", () => {
  // The macOS preset centres its address field. It used to be centred on the
  // whole window while sized to the whole band, so its right edge ran under
  // the timestamp — and the field is filled *after* the stamp is drawn, so it
  // painted the date and time out entirely.
  const macos = (stampWidth: number) =>
    addressFieldBox({ width: 1000, s: 1, left: 92, centred: true, rightInset: 0, stampWidth });

  it("keeps the centred field clear of the timestamp", () => {
    const stampWidth = 136; // ~"Aug 28, 2026, 14:32" plus its gap
    const box = macos(stampWidth)!;
    const stampLeftEdge = 1000 - 14 - stampWidth;
    expect(box.x + box.width).toBeLessThanOrEqual(stampLeftEdge);
  });

  it("still centres the field on the window", () => {
    const box = macos(136)!;
    const centre = box.x + box.width / 2;
    expect(centre).toBeCloseTo(500, 5);
  });

  it("grows the field when there is no timestamp to avoid", () => {
    const withStamp = macos(136)!;
    const without = macos(0)!;
    expect(without.width).toBeGreaterThan(withStamp.width);
  });

  it("clears the window buttons on the left too", () => {
    const box = macos(136)!;
    expect(box.x).toBeGreaterThanOrEqual(92);
  });

  it("fills the band for the left-aligned (Windows) layout", () => {
    const box = addressFieldBox({ width: 1000, s: 1, left: 14, centred: false, rightInset: 60, stampWidth: 136 })!;
    expect(box.x).toBe(14);
    expect(box.x + box.width).toBe(1000 - 60 - 14 - 136);
  });

  it("gives up rather than overlap when the bar is too narrow", () => {
    // A tiny capture with a long timestamp: there is nowhere for a field to go.
    expect(addressFieldBox({ width: 200, s: 1, left: 92, centred: true, rightInset: 0, stampWidth: 120 })).toBeNull();
  });

  it("never overlaps the stamp at any width or stamp size", () => {
    for (const width of [320, 640, 900, 1440, 2560]) {
      for (const stampWidth of [0, 60, 136, 240]) {
        for (const centred of [true, false]) {
          const rightInset = centred ? 0 : 60;
          const box = addressFieldBox({ width, s: 1, left: centred ? 92 : 14, centred, rightInset, stampWidth });
          if (!box) continue;
          expect(box.x + box.width).toBeLessThanOrEqual(width - rightInset - 14 + 0.001);
          expect(box.x + box.width).toBeLessThanOrEqual(width - rightInset - 14 - stampWidth + 0.001);
        }
      }
    }
  });
});
