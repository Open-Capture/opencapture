import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pacing is the whole cost of a long capture — every other per-slice step
 * fits inside the wait — so what the wait is derived from matters more than
 * anything else in this file.
 */
const calls: number[] = [];
let limit: number | undefined;

const tabs = {
  get MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND() {
    return limit;
  },
  captureVisibleTab: vi.fn(async () => {
    calls.push(Date.now());
    // A 1x1 PNG, enough for dataUrlToBytes to return something.
    return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  }),
};

// Only the two things capture.ts uses. Importing the real module here would
// evaluate it, and it touches `chrome` at load.
vi.mock("../platform/webext", () => ({
  ext: { tabs },
  captureRateLimit: () => (typeof limit === "number" && limit > 0 ? limit : null),
}));

const { captureVisibleTabPaced, layoutViewportShot } = await import("./capture");

describe("captureVisibleTabPaced", () => {
  beforeEach(() => {
    calls.length = 0;
    tabs.captureVisibleTab.mockClear();
  });

  it("waits out the browser's declared rate between calls", async () => {
    limit = 2; // Chromium: two a second
    await captureVisibleTabPaced(1);
    const first = Date.now();
    await captureVisibleTabPaced(1);
    // 1000/2 = 500ms, less whatever the first call itself took.
    expect(Date.now() - first).toBeGreaterThanOrEqual(400);
  });

  it("does not wait at all when the browser declares no rate", async () => {
    limit = undefined; // Firefox declares nothing, and has no such quota
    await captureVisibleTabPaced(1);
    const first = Date.now();
    await captureVisibleTabPaced(1);
    await captureVisibleTabPaced(1);
    // Two further captures back to back. Assuming Chromium's limit here made
    // every Firefox capture pay 500ms a slice for a quota that is not there.
    expect(Date.now() - first).toBeLessThan(100);
    expect(tabs.captureVisibleTab).toHaveBeenCalledTimes(3);
  });

  it("retries once when the browser refuses for going too fast", async () => {
    limit = undefined;
    let attempts = 0;
    tabs.captureVisibleTab.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded");
      calls.push(Date.now());
      return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    });
    await captureVisibleTabPaced(1);
    // Guessing wrong about the quota costs one retry, not a wait on every slice.
    expect(attempts).toBe(2);
  });

  it("does not retry a failure that is not about the rate", async () => {
    limit = undefined;
    tabs.captureVisibleTab.mockImplementation(async () => {
      throw new Error("Some other failure");
    });
    await expect(captureVisibleTabPaced(1)).rejects.toThrow(/Some other failure/);
    expect(tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
  });

  it("explains a lost permission instead of passing the raw message on", async () => {
    limit = undefined;
    tabs.captureVisibleTab.mockImplementation(async () => {
      throw new Error("Missing host permission for the tab");
    });
    // activeTab is revoked when the page navigates, so this is a thing that
    // just happened rather than a broken install — and retrying will not fix
    // it, so it is not retried.
    await expect(captureVisibleTabPaced(1)).rejects.toThrow(/reloads or navigates/);
    expect(tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
  });
});

describe("layoutViewportShot", () => {
  // Measured on Firefox 160 for Android, 1080px-wide screen: dpr 2.6087, so
  // the screen is 414 CSS px wide.
  const dpr = 1080 / 414;

  it("photographs a desktop-width layout whole, at the scale that fits the screen", () => {
    // "Desktop site" on: a 980 x 1845 layout viewport, zoomed out to fit.
    const region = layoutViewportShot({ widthCss: 980, heightCss: 1845, screenWidthCss: 414 }, { x: 0, y: 1845 }, dpr);
    expect(region!.rect).toEqual({ x: 0, y: 1845, width: 980, height: 1845 });
    // 1080 device pixels across 980 CSS px — the bitmap is as wide as the
    // screen, not a 2.6x strip of its left edge.
    expect(Math.round(980 * region!.scale)).toBe(1080);
  });

  it("leaves a mobile layout at the device pixel ratio, as before", () => {
    const region = layoutViewportShot({ widthCss: 414, heightCss: 779, screenWidthCss: 414 }, { x: 0, y: 0 }, dpr);
    expect(region!.scale).toBeCloseTo(dpr, 6);
    expect(region!.rect).toEqual({ x: 0, y: 0, width: 414, height: 779 });
  });

  it("never drops below one pixel per CSS pixel on a very wide layout", () => {
    const region = layoutViewportShot({ widthCss: 2400, heightCss: 4000, screenWidthCss: 414 }, { x: 0, y: 0 }, dpr);
    expect(region!.scale).toBe(1);
  });

  it("falls back to the device pixel ratio when the screen width is unknown", () => {
    const region = layoutViewportShot({ widthCss: 980, heightCss: 1845, screenWidthCss: 0 }, { x: 0, y: 0 }, dpr);
    expect(region!.scale).toBeCloseTo(dpr, 6);
  });

  it("gives up on nonsense rather than asking for an empty picture", () => {
    expect(layoutViewportShot({ widthCss: 0, heightCss: 1845, screenWidthCss: 414 }, { x: 0, y: 0 }, dpr)).toBeNull();
    expect(layoutViewportShot({ widthCss: 980, heightCss: 1845, screenWidthCss: 414 }, { x: 0, y: Number.NaN }, dpr)).toBeNull();
  });
});

describe("captureVisibleTabPaced with a region", () => {
  beforeEach(() => {
    tabs.captureVisibleTab.mockClear();
    limit = undefined;
  });

  it("passes the rect and scale through", async () => {
    tabs.captureVisibleTab.mockImplementation(async () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
    const region = { rect: { x: 0, y: 100, width: 980, height: 1845 }, scale: 1.1 };
    await captureVisibleTabPaced(7, undefined, region);
    expect(tabs.captureVisibleTab).toHaveBeenCalledWith(7, { format: "png", rect: region.rect, scale: 1.1 });
  });

  it("sends nothing but the format without one, which is all Chromium accepts", async () => {
    await captureVisibleTabPaced(7);
    expect(tabs.captureVisibleTab).toHaveBeenCalledWith(7, { format: "png" });
  });
});
