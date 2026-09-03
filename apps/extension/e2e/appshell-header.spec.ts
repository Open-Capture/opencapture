import { expect, test } from "./fixtures";
const BASE_URL = "http://localhost:8934";

const rowsOf = (page: import("@playwright/test").Page, b64: string, rgb: [number, number, number]) =>
  page.evaluate(
    async ({ b64, rgb }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const cx = c.getContext("2d")!;
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      const hit: boolean[] = [];
      for (let y = 0; y < c.height; y++) {
        let found = false;
        for (let x = 0; x < c.width && !found; x++) {
          const i = (y * c.width + x) * 4;
          if (d[i] === rgb[0] && d[i + 1] === rgb[1] && d[i + 2] === rgb[2]) found = true;
        }
        hit.push(found);
      }
      let runs = 0;
      let firstRow = -1;
      for (let y = 0; y < hit.length; y++) {
        if (hit[y] && !hit[y - 1]) runs++;
        if (hit[y] && firstRow === -1) firstRow = y;
      }
      return { runs, rows: hit.filter(Boolean).length, firstRow, height: c.height };
    },
    { b64, rgb },
  );

test("a header above the scrolling element is captured, once, at the top", async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${BASE_URL}/appshell-header.html`);
  await page.waitForLoadState("domcontentloaded");
  await page.bringToFront();

  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ capturePrefs: { sticky: "keep" } });
  });

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  const result = await serviceWorker.evaluate(
    // @ts-expect-error test-only global
    async (t) => globalThis.__test.captureFullPage(t.tabId, t.windowId),
    tabInfo,
  );

  const header = await rowsOf(page, result.imagesBase64[0], [255, 255, 0]);
  const dock = await rowsOf(page, result.imagesBase64[0], [255, 0, 255]);
  console.log("HEADER:", JSON.stringify(header), "DOCK:", JSON.stringify(dock));

  // Present at all — cropping to the scroller used to remove it entirely.
  expect(header.rows).toBeGreaterThan(0);
  // Once, and at the very top.
  expect(header.runs).toBe(1);
  expect(header.firstRow).toBe(0);
  // And the dock still appears once, whole.
  expect(dock.runs).toBe(1);
  expect(dock.rows).toBe(380);

  await page.close();
});
