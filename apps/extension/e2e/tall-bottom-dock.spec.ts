import { expect, test } from "./fixtures";
const BASE_URL = "http://localhost:8934";

test("a tall bottom-pinned dock is captured whole, not clipped to the last sliver", async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${BASE_URL}/tall-bottom-dock.html`);
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

  const dock = await page.evaluate(async (b64: string) => {
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
        if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) found = true;
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
  }, result.imagesBase64[0]);

  console.log("TALL BOTTOM DOCK:", JSON.stringify(dock));
  // Once...
  expect(dock.runs).toBe(1);
  // ...and whole. It is 700px tall; the final slice only adds about 20 rows,
  // which is what used to be all of it that survived.
  expect(dock.rows).toBe(700);
  // ...at the end of the capture, where the dock belongs.
  expect(dock.firstRow).toBeGreaterThan(dock.height - 800);

  await page.close();
});
