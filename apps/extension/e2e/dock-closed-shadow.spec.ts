import { expect, test } from "./fixtures";
const BASE_URL = "http://localhost:8934";

/**
 * A dock whose contents cannot be read from outside.
 *
 * On Firefox this is the everyday case, not an exotic one: content scripts see
 * the page through an Xray wrapper, and `element.shadowRoot` is null for a
 * shadow root the page created — so an *open* root is as unreadable there as a
 * closed one is anywhere. A closed root reproduces that condition in Chromium,
 * where the test suite can actually drive the extension.
 */
test("a dock whose shadow content cannot be read is still found and shown once", async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1200, height: 805 });
  await page.goto(`${BASE_URL}/dock-closed-shadow.html`);
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
    for (let y = 0; y < hit.length; y++) if (hit[y] && !hit[y - 1]) runs++;
    return { runs, rows: hit.filter(Boolean).length, height: c.height };
  }, result.imagesBase64[0]);

  console.log("CLOSED-SHADOW DOCK:", JSON.stringify(dock), "handled:", result.report.pinned_elements_handled);
  expect(result.report.pinned_elements_handled).toBeGreaterThan(0);
  expect(dock.runs).toBe(1);
  expect(dock.rows).toBeLessThan(dock.height * 0.4);

  await page.close();
});
