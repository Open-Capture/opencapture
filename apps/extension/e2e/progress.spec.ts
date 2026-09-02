import { expect, test } from "./fixtures";
const BASE_URL = "http://localhost:8934";

test("a long capture reports which slice it is on, rather than sitting on one message", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  // The popup listens on runtime.onMessage; opening it as a tab is enough to
  // receive what the capture broadcasts. Clicking its capture button here is
  // not — the popup tab would be the active tab, and the capture would
  // photograph the popup itself.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(() => {
    (window as unknown as { __seen: string[] }).__seen = [];
    chrome.runtime.onMessage.addListener((m: { type?: string; done?: number; total?: number }) => {
      if (m.type === "captureProgress") {
        (window as unknown as { __seen: string[] }).__seen.push(`${m.done}/${m.total}`);
      }
    });
  });

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  await serviceWorker.evaluate(
    // @ts-expect-error test-only global
    async (t) => globalThis.__test.captureFullPage(t.tabId, t.windowId),
    tabInfo,
  );

  const seen = await popup.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
  console.log("PROGRESS:", JSON.stringify(seen));
  // 3000px of page in a 600px viewport is five slices, so there is real
  // progress to report rather than one message that never changes.
  expect(seen.length).toBeGreaterThan(2);
  expect(seen[0]).toBe(`0/${seen.length - 1}`);
  // The last one closes it out at 100%, which is what tells the popup to stop
  // overwriting the status.
  expect(seen[seen.length - 1]).toBe(`${seen.length - 1}/${seen.length - 1}`);

  await popup.close();
  await page.close();
});
