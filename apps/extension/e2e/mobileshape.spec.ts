import { chromium } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = "http://localhost:8934";
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

/**
 * A phone-shaped window whose reported devicePixelRatio does not match the
 * scale the browser actually screenshots at.
 *
 * Reported on Edge for Android as "full page capture is not capturing fully".
 * `window.devicePixelRatio` is what the page believes; it is not a promise
 * about `tabs.captureVisibleTab`, and when the two disagree every slice is
 * placed at the wrong offset — placement converts a CSS scroll position into
 * image rows using that number. Emulating a 3x ratio while the screenshot
 * comes back at 1x reproduces it exactly: the capture used to come out 3200
 * rows tall for a 3000px page, with 200 rows of duplicated content.
 */
test("a screenshot scale that disagrees with devicePixelRatio still stitches to the true page height", async () => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    viewport: { width: 412, height: 800 },
    deviceScaleFactor: 3,
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker");

  const page = await context.newPage();
  await page.goto(`${BASE_URL}/ruler-3000.html`);
  await page.waitForLoadState("domcontentloaded");
  await page.bringToFront();

  const t = await page.evaluate(() => ({ dpr: devicePixelRatio, height: document.documentElement.scrollHeight }));
  expect(t.dpr).toBe(3); // the page really does believe it is a 3x display

  const tab = await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const found = tabs.find((x) => x.url === url);
    if (!found?.id) throw new Error(`no tab; saw ${tabs.map((x) => x.url).join("|")}`);
    return { tabId: found.id, windowId: found.windowId };
  }, page.url());

  const r = await sw.evaluate(
    // @ts-expect-error test-only global
    async (i) => globalThis.__test.captureFullPage(i.tabId, i.windowId),
    tab,
  );

  const check = await page.evaluate(async (b64: string) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d")!;
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    const expected = new Set<string>();
    for (let i = 0; i < 40; i++) expected.add(`${(i * 53) % 256},${(i * 97) % 256},${(i * 151) % 256}`);
    let bad = 0;
    for (let y = 0; y < c.height; y++) {
      const i = (y * c.width + Math.floor(c.width / 2)) * 4;
      if (!expected.has(`${d[i]},${d[i + 1]},${d[i + 2]}`)) bad++;
    }
    return { w: c.width, h: c.height, bad };
  }, r.imagesBase64[0]);

  // The page is 3000 CSS px and the screenshots come back at 1x, so a correct
  // capture is exactly 3000 rows — no more (duplicated content) and no fewer
  // (missing content).
  expect(check.h).toBe(t.height * (check.w / 412));
  expect(check.h).toBe(3000);
  expect(check.bad).toBe(0);
  expect(r.imagesBase64.length).toBe(1);

  await context.close();
});
