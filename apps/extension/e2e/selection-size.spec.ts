import { expect, test } from "./fixtures";

const BASE_URL = "http://localhost:8934";
const SIZE = "[data-oc-size]";
const TARGET_W = 'input[aria-label="Output width in pixels"]';
const TARGET_H = 'input[aria-label="Output height in pixels"]';

test("selection shows its output size live, locks to a typed ratio, and delivers that exact size", async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab found for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  const resultPromise = serviceWorker.evaluate(
    async ({ tabId, windowId }) => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureSelectedArea(tabId, windowId);
    },
    tabInfo,
  );

  await page.waitForTimeout(200); // let the overlay attach

  // --- the size is live while drawing, before any mouseup ---
  await page.mouse.move(100, 200);
  await page.mouse.down();
  await page.mouse.move(300, 320, { steps: 5 });
  // Headless Chrome runs at dpr 1, so output pixels equal CSS pixels here.
  // The readout deliberately reports *output* pixels, which on a 2x display
  // would be double these numbers — that is the whole point of showing it.
  await expect(page.locator(SIZE)).toHaveText("200 × 120");

  await page.mouse.move(400, 400, { steps: 5 });
  await expect(page.locator(SIZE)).toHaveText("300 × 200");
  await page.mouse.up();

  // ...and it survives into the adjusting phase rather than blanking out.
  await expect(page.locator(SIZE)).toHaveText("300 × 200");

  // --- typing a target re-shapes the box that is already on screen ---
  // A half-filled pair must not lock anything: it reads as still being typed.
  await page.fill(TARGET_W, "640");
  await expect(page.locator(SIZE)).toHaveText("300 × 200");

  // Two boxes, not one "640x360" string: a resolution is two numbers.
  await page.fill(TARGET_W, "640");
  await page.fill(TARGET_H, "360");
  const locked = await page.locator(SIZE).textContent();
  expect(locked).toMatch(/^\d+ × \d+ → 640 × 360$/);

  const lockedMatch = locked!.match(/^(\d+) × (\d+)/)!;
  const w = Number(lockedMatch[1]);
  const h = Number(lockedMatch[2]);
  // 16:9, to within the rounding of a whole pixel.
  expect(w / h).toBeCloseTo(640 / 360, 1);
  // The selection is nothing like 640x360 — that is the point: the drag sets
  // the framing, the target sets the pixels.
  expect(w).toBeLessThan(640);

  // --- resizing keeps the lock ---
  await page.mouse.move(400, 400);
  await page.mouse.down();
  await page.mouse.move(500, 500, { steps: 5 });
  await page.mouse.up();
  const afterResize = (await page.locator(SIZE).textContent())!;
  const resizeMatch = afterResize.match(/^(\d+) × (\d+)/)!;
  const rw = Number(resizeMatch[1]);
  const rh = Number(resizeMatch[2]);
  expect(rw / rh).toBeCloseTo(640 / 360, 1);

  await page.keyboard.press("Enter");

  const result = await resultPromise;
  expect(result).not.toBeNull();
  // Delivered at exactly the requested size, whatever the selection was.
  expect(result.report.output_width_px).toBe(640);
  expect(result.report.output_height_px).toBe(360);

  await page.close();
});
