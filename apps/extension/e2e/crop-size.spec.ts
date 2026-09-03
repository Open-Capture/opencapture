import { expect, test } from "./fixtures";

const BASE_URL = "http://localhost:8934";
const CROP_W = '#cropOutW';
const CROP_H = '#cropOutH';

test("crop reads out its size and delivers an exact one, like selected-area does", async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);
  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab for ${url}`);
    return tab.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);
  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    // @ts-expect-error test-only global
    serviceWorker.evaluate(async () => globalThis.__test.openEditor()),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    const stack = document.getElementById("canvasStack");
    // Size alone is no longer readiness: the canvas is given its real
    // dimensions before the pixels arrive, so that a full-size placeholder can
    // be shown instead of a small white box. The loading class is what says
    // the image is actually drawn.
    return c.width > 0 && c.height > 0 && !!stack && !stack.classList.contains("loading");
  });

  const canvasSize = () =>
    editorPage.evaluate(() => {
      const c = document.getElementById("canvas") as HTMLCanvasElement;
      return { width: c.width, height: c.height };
    });
  const box = (await editorPage.locator("#canvas").boundingBox())!;
  const toPage = (x: number, y: number) => ({ x: box.x + x, y: box.y + y });

  await editorPage.click("#toolCrop");

  // --- the size reads out live, mid-drag, before any mouseup ---
  const a = toPage(100, 100);
  const b = toPage(400, 300);
  await editorPage.mouse.move(a.x, a.y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(b.x, b.y, { steps: 5 });
  await expect(editorPage.locator("#cropSize")).toHaveText("300 × 200");
  await editorPage.mouse.up();
  await expect(editorPage.locator("#cropSize")).toHaveText("300 × 200");

  // --- a target locks the marquee's shape and shows the delivered size ---
  await editorPage.fill(CROP_W, "640");
  await editorPage.fill(CROP_H, "360");
  const locked = (await editorPage.locator("#cropSize").textContent())!;
  expect(locked).toMatch(/^\d+ × \d+ → 640 × 360$/);
  const m = locked.match(/^(\d+) × (\d+)/)!;
  const w = Number(m[1]);
  const h = Number(m[2]);
  expect(w / h).toBeCloseTo(640 / 360, 1);

  // --- and the crop is delivered at exactly that size ---
  await editorPage.click("#cropApply");
  expect(await canvasSize()).toEqual({ width: 640, height: 360 });

  // Undo restores the pre-crop canvas, so the resample went through history
  // rather than mutating the canvas behind it.
  await editorPage.click("#undo");
  expect(await canvasSize()).toEqual({ width: 800, height: 600 });

  await editorPage.close();
  await page.close();
});
