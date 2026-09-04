import { expect, test } from "./fixtures";
const BASE_URL = "http://localhost:8934";

/** How many separate horizontal bands of a colour the capture contains. */
const bandsOf = (page: import("@playwright/test").Page, b64: string, rgb: [number, number, number]) =>
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
      for (let y = 0; y < hit.length; y++) if (hit[y] && !hit[y - 1]) runs++;
      // The colour of the rail's column at the very bottom of the capture.
      const y = c.height - 4;
      const i = (y * c.width + 60) * 4;
      return { runs, rows: hit.filter(Boolean).length, width: c.width, height: c.height, bottomLeft: [d[i], d[i + 1], d[i + 2]] };
    },
    { b64, rgb },
  );

async function capture(page: import("@playwright/test").Page, serviceWorker: import("@playwright/test").Worker, mode: "keep" | "remove") {
  await serviceWorker.evaluate(async (m) => {
    await chrome.storage.local.set({ capturePrefs: { sticky: m } });
  }, mode);
  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());
  return serviceWorker.evaluate(
    // @ts-expect-error test-only global
    async (t) => globalThis.__test.captureFullPage(t.tabId, t.windowId),
    tabInfo,
  );
}

test("a static sidebar beside the scrolling pane is captured once, and its column continues", async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${BASE_URL}/appshell-sidebar.html`);
  await page.waitForLoadState("domcontentloaded");
  await page.bringToFront();

  const result = await capture(page, serviceWorker, "keep");
  const marker = await bandsOf(page, result.imagesBase64[0], [255, 0, 0]);
  console.log("APPSHELL SIDEBAR keep: " + JSON.stringify(marker));

  // The window's width, not the pane's: the sidebar is in the picture.
  expect(marker.width).toBe(1200);
  // Its contents appear exactly once, rather than in every slice.
  expect(marker.runs).toBe(1);
  // And the column keeps the sidebar's own colour all the way down, rather
  // than becoming a bare gutter once the contents stop.
  expect(marker.bottomLeft).toEqual([20, 30, 40]);
});

test("and is left out entirely when floating menus are removed", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${BASE_URL}/appshell-sidebar.html`);
  await page.waitForLoadState("domcontentloaded");
  await page.bringToFront();

  const result = await capture(page, serviceWorker, "remove");
  const marker = await bandsOf(page, result.imagesBase64[0], [255, 0, 0]);
  console.log("APPSHELL SIDEBAR remove: " + JSON.stringify(marker));

  expect(marker.width).toBe(960);
  expect(marker.runs).toBe(0);
});
