import { expect, test } from "./fixtures";
const BASE_URL = "http://localhost:8934";

const hasColour = (page: import("@playwright/test").Page, b64: string, rgb: [number, number, number]) =>
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
      let rows = 0;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (d[i] === rgb[0] && d[i + 1] === rgb[1] && d[i + 2] === rgb[2]) { rows++; break; }
        }
      }
      return { rows, height: c.height, width: c.width };
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

test("removing floating menus takes the side rails of a centred layout with them", async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${BASE_URL}/three-column-rails.html`);
  await page.waitForLoadState("domcontentloaded");
  await page.bringToFront();

  const result = await capture(page, serviceWorker, "remove");
  const right = await hasColour(page, result.imagesBase64[0], [255, 0, 0]);
  const left = await hasColour(page, result.imagesBase64[0], [0, 200, 0]);
  console.log("RAILS remove: right=" + JSON.stringify(right) + " left=" + JSON.stringify(left));

  expect(right.rows).toBe(0);
  expect(left.rows).toBe(0);
});

test("and keeps them when floating menus are kept", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${BASE_URL}/three-column-rails.html`);
  await page.waitForLoadState("domcontentloaded");
  await page.bringToFront();

  const result = await capture(page, serviceWorker, "keep");
  const right = await hasColour(page, result.imagesBase64[0], [255, 0, 0]);
  console.log("RAILS keep: right=" + JSON.stringify(right));
  expect(right.rows).toBeGreaterThan(1000);
});

test("and finds them on a wide monitor, where a capped layout sits far from the window edge", async ({
  context,
  serviceWorker,
}) => {
  // LinkedIn caps its layout at 1128px, so at this width the rails stop ~640px
  // short of the window's edges. A rule that asked how close they were to the
  // window would find them on a laptop and miss them here.
  const page = await context.newPage();
  await page.setViewportSize({ width: 2400, height: 900 });
  await page.goto(`${BASE_URL}/three-column-rails.html`);
  await page.waitForLoadState("domcontentloaded");
  await page.bringToFront();

  const result = await capture(page, serviceWorker, "remove");
  const right = await hasColour(page, result.imagesBase64[0], [255, 0, 0]);
  const left = await hasColour(page, result.imagesBase64[0], [0, 200, 0]);
  console.log("RAILS wide: right=" + JSON.stringify(right) + " left=" + JSON.stringify(left));
  expect(right.rows).toBe(0);
  expect(left.rows).toBe(0);
});
