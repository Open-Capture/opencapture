import { expect, test } from "./fixtures";
const BASE_URL = "http://localhost:8934";

test("the editor never shows a small blank canvas before the capture arrives", async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);
  await page.waitForLoadState("domcontentloaded");
  await page.bringToFront();

  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url === url)!.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (w) => {
    // @ts-expect-error test-only global
    await globalThis.__test.captureVisibleOnly(w);
  }, windowId);

  const [editor] = await Promise.all([
    context.waitForEvent("page"),
    // @ts-expect-error test-only global
    serviceWorker.evaluate(async () => globalThis.__test.openEditor()),
  ]);

  // Sample the canvas from the earliest moment the document exists until the
  // image is drawn. The failure being guarded against is the HTML default —
  // a 300x150 canvas, which on a full-page capture is a small white box that
  // then jumps to full size.
  const samples: { w: number; h: number; loading: boolean; visible: boolean }[] = [];
  for (let i = 0; i < 40; i++) {
    const s = await editor
      .evaluate(() => {
        const c = document.getElementById("canvas") as HTMLCanvasElement | null;
        const l = document.getElementById("canvasLoading") as HTMLElement | null;
        if (!c) return null;
        const stack = document.getElementById("canvasStack");
        const visible = !!stack && getComputedStyle(stack).visibility !== "hidden";
        return { w: c.width, h: c.height, loading: !!l && !l.hidden, visible };
      })
      .catch(() => null);
    if (s) samples.push(s);
    if (s && !s.loading && s.w > 300) break;
    await editor.waitForTimeout(25);
  }

  const defaults = samples.filter((s) => s.w === 300 && s.h === 150);
  console.log("SAMPLES:", samples.length, "at-default:", defaults.length, "first:", JSON.stringify(samples[0]));

  // The canvas may briefly still be at its 300x150 default — what matters is
  // that it is never *visible* at that size. A small white box that jumps to
  // full size is the thing being fixed.
  expect(defaults.filter((s) => s.visible)).toHaveLength(0);
  // And it finished, at the real size.
  const last = samples[samples.length - 1]!;
  expect(last.loading).toBe(false);
  expect(last.w).toBe(1000);

  await editor.close();
  await page.close();
});
