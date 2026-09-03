import { expect, test } from "./fixtures";
const BASE_URL = "http://localhost:8934";

/**
 * A dock that is rebuilt rather than restyled.
 *
 * Hiding is applied, and then up to half a second passes before the screenshot
 * — the browser's screenshot quota sits in between. A page that replaces the
 * element in that window produces a brand new node with none of our styles on
 * it, and watching the style attribute cannot notice: nothing was edited, the
 * element is simply a different one.
 */
test("a dock rebuilt between hiding and the screenshot is still kept out", async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${BASE_URL}/dock-rebuilds-itself.html`);
  await page.waitForLoadState("domcontentloaded");
  await page.bringToFront();

  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ capturePrefs: { sticky: "remove" } });
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

  const magenta = await page.evaluate(async (b64: string) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d")!;
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) n++;
    return n;
  }, result.imagesBase64[0]);

  console.log("REBUILT DOCK PIXELS:", magenta, "handled:", result.report.pinned_elements_handled);
  expect(magenta).toBe(0);

  await page.close();
});
