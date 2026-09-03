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

const { captureVisibleTabPaced } = await import("./capture");

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
      throw new Error("Missing host permission for the tab");
    });
    await expect(captureVisibleTabPaced(1)).rejects.toThrow(/Missing host permission/);
    expect(tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
  });
});
