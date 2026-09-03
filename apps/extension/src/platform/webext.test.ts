import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("ext", () => {
  it("aliases the native browser global when present (Firefox)", async () => {
    const fakeBrowser = { tabs: {}, marker: "firefox-browser" } as unknown as typeof chrome;
    vi.stubGlobal("browser", fakeBrowser);
    vi.stubGlobal("chrome", { tabs: {}, marker: "chrome" } as unknown as typeof chrome);

    const { ext } = await import("./webext");

    expect(ext).toBe(fakeBrowser);
  });

  it("falls back to chrome when no browser global exists (Chrome)", async () => {
    vi.stubGlobal("browser", undefined);
    const fakeChrome = { tabs: {}, marker: "chrome" } as unknown as typeof chrome;
    vi.stubGlobal("chrome", fakeChrome);

    const { ext } = await import("./webext");

    expect(ext).toBe(fakeChrome);
  });
});

describe("captureRateLimit", () => {
  it("returns Chrome's real constant when the runtime exposes it", async () => {
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", {
      tabs: { MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: 5 },
    } as unknown as typeof chrome);

    const { captureRateLimit } = await import("./webext");

    expect(captureRateLimit()).toBe(5);
  });

  it("falls back to 2 when the runtime exposes no rate-limit constant (Firefox, or older Chrome)", async () => {
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", { tabs: {} } as unknown as typeof chrome);

    const { captureRateLimit } = await import("./webext");

    // Nothing declared means nothing to pace to. Assuming Chromium's limit
    // here cost half a second a slice on every Firefox capture, for a quota
    // Firefox does not have.
    expect(captureRateLimit()).toBeNull();
  });
});
