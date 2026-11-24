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

describe("isAndroidUserAgent", () => {
  it("recognises Firefox for Android and Edge for Android", async () => {
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", { tabs: {} } as unknown as typeof chrome);
    const { isAndroidUserAgent } = await import("./webext");

    expect(isAndroidUserAgent("Mozilla/5.0 (Android 14; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0")).toBe(true);
    expect(
      isAndroidUserAgent(
        "Mozilla/5.0 (Linux; Android 14; SM-S9260) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140.0.0.0",
      ),
    ).toBe(true);
  });

  it("does not mistake a desktop browser for one", async () => {
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", { tabs: {} } as unknown as typeof chrome);
    const { isAndroidUserAgent } = await import("./webext");

    expect(isAndroidUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0")).toBe(false);
    expect(
      isAndroidUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"),
    ).toBe(false);
  });
});

describe("detectAndroid", () => {
  it("believes the platform over a desktop user agent (Firefox for Android's Desktop site setting)", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0" });
    vi.stubGlobal("browser", { runtime: { getPlatformInfo: async () => ({ os: "android", arch: "arm64" }) }, tabs: {} });
    const { detectAndroid, onAndroid } = await import("./webext");

    expect(onAndroid).toBe(false);
    expect(await detectAndroid()).toBe(true);
  });

  it("answers from the user agent without asking when it already says Android", async () => {
    const getPlatformInfo = vi.fn(async () => ({ os: "linux" }));
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Android 14; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0" });
    vi.stubGlobal("browser", { runtime: { getPlatformInfo }, tabs: {} });
    const { detectAndroid } = await import("./webext");

    expect(await detectAndroid()).toBe(true);
    expect(getPlatformInfo).not.toHaveBeenCalled();
  });

  it("is false on desktop, and when the platform cannot be asked", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0" });
    vi.stubGlobal("browser", { runtime: { getPlatformInfo: async () => ({ os: "win" }) }, tabs: {} });
    expect(await (await import("./webext")).detectAndroid()).toBe(false);

    vi.resetModules();
    vi.stubGlobal("browser", { runtime: { getPlatformInfo: async () => Promise.reject(new Error("nope")) }, tabs: {} });
    expect(await (await import("./webext")).detectAndroid()).toBe(false);
  });
});
