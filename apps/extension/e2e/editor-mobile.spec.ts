import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

const BASE_URL = "http://localhost:8934";
const dist = process.env.DIST_OVERRIDE ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

async function phoneEditor(width: number, height: number): Promise<{ context: BrowserContext; editorPage: Page }> {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      // Playwright pins a fine pointer even with hasTouch; a phone has a
      // coarse one, and the editor sizes its targets by it.
      "--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2",
    ],
    viewport: { width, height },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent("serviceworker", { timeout: 20_000 });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/ruler-3000.html`);
  await page.bringToFront();
  const windowId = await sw.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
    if (!tab) throw new Error(`no tab for ${url}`);
    return tab.windowId;
  }, page.url());
  await sw.evaluate(async (winId) => {
    // @ts-expect-error test-only global
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);
  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    // @ts-expect-error test-only global
    sw.evaluate(async () => globalThis.__test.openEditor()),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    const stack = document.getElementById("canvasStack");
    return c.width > 0 && c.height > 0 && !!stack && !stack.classList.contains("loading");
  });
  return { context, editorPage };
}

/** The canvas fills the scroll area's width (less its padding) and no more. */
async function expectFitsWidth(editorPage: Page): Promise<void> {
  const fit = await editorPage.evaluate(() => {
    const wrap = document.getElementById("canvasWrap")!;
    const pad = parseFloat(getComputedStyle(wrap).paddingLeft) + parseFloat(getComputedStyle(wrap).paddingRight);
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return { shown: c.getBoundingClientRect().width, room: wrap.clientWidth - pad, native: c.width };
  });
  expect(fit.shown).toBeLessThanOrEqual(fit.room + 0.5);
  expect(fit.shown).toBeGreaterThanOrEqual(Math.min(fit.room, fit.native) - 1);
}

for (const [width, height] of [
  [390, 844],
  [360, 740],
] as const) {
  test(`at ${width}x${height} by touch: no sideways page, finger-sized tools and handles, Fit fits, crop applies`, async () => {
    test.setTimeout(180_000);
    const { context, editorPage } = await phoneEditor(width, height);
    try {
      const cdp = await context.newCDPSession(editorPage);
      const touch = (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) =>
        cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
      const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
        await touch("touchStart", from.x, from.y);
        for (let i = 1; i <= 6; i++) {
          await touch("touchMove", from.x + ((to.x - from.x) * i) / 6, from.y + ((to.y - from.y) * i) / 6);
        }
        await touch("touchEnd");
      };

      // Laid out at the phone's width, not a shrunken desktop page.
      const page = await editorPage.evaluate(() => ({
        inner: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(page.inner).toBe(width);
      expect(page.scroll).toBeLessThanOrEqual(width);

      // Every toolbar control is a 44px target, and the last one can be
      // reached by scrolling the strip — without the page moving sideways.
      const sizes = await editorPage.$$eval("#toolbar button", (els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return { id: e.id, w: Math.round(r.width), h: Math.round(r.height) };
        }),
      );
      expect(sizes.length).toBeGreaterThan(10);
      for (const s of sizes) {
        expect(s.h, `${s.id} height`).toBeGreaterThanOrEqual(44);
        expect(s.w, `${s.id} width`).toBeGreaterThanOrEqual(44);
      }
      await editorPage.locator("#closeEditor").scrollIntoViewIfNeeded();
      const close = (await editorPage.locator("#closeEditor").boundingBox())!;
      expect(close.x + close.width).toBeLessThanOrEqual(width + 0.5);
      expect(await editorPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await editorPage.evaluate(() => (document.getElementById("toolbar")!.scrollLeft = 0));

      // Fit on open, and Fit again after zooming in.
      await expectFitsWidth(editorPage);
      await editorPage.locator("#zoomIn").tap();
      await editorPage.locator("#zoomIn").tap();
      await editorPage.locator("#zoomFit").tap();
      await expectFitsWidth(editorPage);
      expect(await editorPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

      // Crop by touch.
      await editorPage.locator("#toolCrop").tap();
      const c = (await editorPage.locator("#canvas").boundingBox())!;
      const a = { x: c.x + c.width * 0.2, y: c.y + 60 };
      const b = { x: c.x + c.width * 0.6, y: c.y + 260 };
      await drag(a, b);
      await expect(editorPage.locator("#cropBar")).toBeVisible();
      const readout = async () => {
        const m = (await editorPage.locator("#cropSize").textContent())!.match(/^(\d+) × (\d+)/)!;
        return { w: Number(m[1]), h: Number(m[2]) };
      };
      const first = await readout();

      // A corner handle answers a finger 21px off its centre — inside a 44px
      // target — and resizes rather than starting a new box.
      await drag({ x: b.x + 21, y: b.y + 21 }, { x: b.x + 60, y: b.y + 60 });
      const grown = await readout();
      const scale = await editorPage.evaluate(() => {
        const cv = document.getElementById("canvas") as HTMLCanvasElement;
        return cv.width / cv.getBoundingClientRect().width;
      });
      expect(grown.w - first.w).toBeGreaterThanOrEqual(Math.floor(30 * scale));
      expect(grown.h - first.h).toBeGreaterThanOrEqual(Math.floor(30 * scale));

      // The bar is still outside the frame and on screen.
      // resizeRect puts the corner under the finger.
      const frameBottom = b.y + 60 - 1;
      const bar = (await editorPage.locator("#cropBar").boundingBox())!;
      const side = await editorPage.locator("#cropBar").getAttribute("data-side");
      expect(side).toBe("below");
      expect(bar.y).toBeGreaterThanOrEqual(frameBottom);
      expect(bar.x).toBeGreaterThanOrEqual(0);
      expect(bar.x + bar.width).toBeLessThanOrEqual(width + 0.5);

      // A tap on Apply crops to the box. Within a pixel, not exactly: a
      // resized box has fractional edges, which the readout rounds and the
      // crop truncates.
      await editorPage.locator("#cropApply").tap();
      await expect(editorPage.locator("#cropBar")).toBeHidden();
      const after = await editorPage.evaluate(() => {
        const cv = document.getElementById("canvas") as HTMLCanvasElement;
        return { w: cv.width, h: cv.height };
      });
      expect(Math.abs(after.w - grown.w)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.h - grown.h)).toBeLessThanOrEqual(1);
      expect(await editorPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    } finally {
      await context.close();
    }
  });
}
