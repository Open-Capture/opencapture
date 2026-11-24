import { expect, test } from "./fixtures";

// On Firefox for Android the popup is a full-screen page, and it
// rendered as a 380px desktop column in the left four-tenths of the phone.
// Playwright cannot drive Firefox for Android, so this checks the part that is
// engine-independent: given an Android user agent and a phone-sized viewport,
// the popup takes the phone layout, and without one it keeps the desktop box.

const ANDROID_UA = "Mozilla/5.0 (Android 14; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0";

async function openPopup(
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
  userAgent: string | null,
  width: number,
) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 900 });
  if (userAgent) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setUserAgentOverride", { userAgent });
  }
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForSelector("#captureFullPage");
  return page;
}

test("on Android the popup spans the phone instead of a 380px column", async ({ context, extensionId }) => {
  const popup = await openPopup(context, extensionId, ANDROID_UA, 412);
  const layout = await popup.evaluate(() => ({
    android: document.documentElement.classList.contains("is-android"),
    body: document.body.getBoundingClientRect().width,
    button: document.getElementById("captureFullPage")!.getBoundingClientRect().width,
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute("content"),
  }));
  expect(layout.android).toBe(true);
  expect(layout.body).toBe(412);
  expect(layout.button).toBeGreaterThan(412 - 48);
  expect(layout.overflow).toBe(false);
  expect(layout.viewportMeta).toContain("width=device-width");
  await popup.close();
});

// The phones that matter span 360px (small Android) to 412px (Pixel,
// Galaxy S at default zoom). Every width must fill the screen with nothing
// spilling sideways — the header in particular, which carries three controls
// beside the wordmark.
for (const width of [360, 375, 390, 412]) {
  test(`at ${width}px the Android popup fills the width with nothing overflowing`, async ({ context, extensionId }) => {
    const popup = await openPopup(context, extensionId, ANDROID_UA, width);
    const layout = await popup.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const spill = [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((el) => {
          if (el.closest("[hidden]") || getComputedStyle(el).display === "none") return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5);
        })
        .map((el) => `${el.tagName.toLowerCase()}#${el.id}.${el.className}`);
      return {
        body: document.body.getBoundingClientRect().width,
        scrollWidth: document.documentElement.scrollWidth,
        vw,
        spill,
        fullPage: document.getElementById("captureFullPage")!.getBoundingClientRect().height,
        report: getComputedStyle(document.getElementById("report")!).display,
      };
    });
    expect(layout.body).toBe(width);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.vw);
    expect(layout.spill).toEqual([]);
    expect(layout.fullPage).toBeGreaterThanOrEqual(44);
    // Nothing captured yet, and the debug report is never shown before one.
    expect(layout.report).toBe("none");
    await popup.screenshot({ path: `test-results/android-popup-${width}.png`, fullPage: true });
    await popup.close();
  });
}

// Firefox for Android's "Desktop site" setting gives the popup a desktop user
// agent. The platform still says Android, and that is what the popup goes by.
test("a desktop user agent on Android still gets the phone layout", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(() => {
    const runtime = (globalThis as unknown as { chrome: typeof chrome }).chrome.runtime;
    runtime.getPlatformInfo = (async () => ({ os: "android", arch: "arm64", nacl_arch: "arm" })) as typeof runtime.getPlatformInfo;
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForFunction(() => document.documentElement.classList.contains("is-android"));
  expect(await page.evaluate(() => document.body.getBoundingClientRect().width)).toBe(390);
  await page.close();
});

// History and account open as tabs; on a phone they need the same viewport
// meta the popup lacked, or they render as a shrunken desktop page.
for (const name of ["history", "account"]) {
  test(`${name}.html lays out at phone width`, async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 800 });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setUserAgentOverride", { userAgent: ANDROID_UA });
    await page.goto(`chrome-extension://${extensionId}/${name}.html`);
    await page.waitForLoadState("domcontentloaded");
    const layout = await page.evaluate(() => ({
      meta: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "",
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    expect(layout.meta).toContain("width=device-width");
    expect(layout.overflow).toBe(false);
    await page.close();
  });
}

test("on desktop the popup keeps its fixed width", async ({ context, extensionId }) => {
  const popup = await openPopup(context, extensionId, null, 800);
  const layout = await popup.evaluate(() => ({
    android: document.documentElement.classList.contains("is-android"),
    body: document.body.getBoundingClientRect().width,
  }));
  expect(layout.android).toBe(false);
  expect(layout.body).toBe(380);
  await popup.close();
});
