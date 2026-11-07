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

  // The popup is opened as a tab here so it can receive the progress
  // messages, which makes it the active tab — and a capture now stops if the
  // active tab is not the one it is photographing. Put the page back in front;
  // the popup keeps receiving messages either way.
  await page.bringToFront();

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

test("a popup reopened while a capture runs shows the capture's progress, then its result", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 600 });
  // Long enough that the capture is still running long after the popup
  // below reloads: 10000px in a 600px viewport is ~17 slices at ~two a
  // second, and the reload lands one second in — nowhere near the tail.
  await page.goto(`${BASE_URL}/very-long.html?h=10000`);

  // The popup opens as a tab, which makes it the active tab — and a capture
  // stops if the active tab is not the one it is photographing (see the
  // test above). Put the page back in front before starting anything; the
  // popup keeps receiving messages either way.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();

  // Through handleRequest, not the orchestrator hook: the captureFinished
  // broadcast an attached popup waits on is emitted by the handler's
  // completion path, and setLastCaptureUi — which the popup restores from —
  // is written there too.
  const finished = serviceWorker.evaluate(() => {
    // @ts-expect-error test-only global, see background/index.ts
    return globalThis.__test.captureFullPageViaHandleRequest();
  });

  // A real reopen is the popup being destroyed on blur and rebuilt from
  // scratch on the next toolbar click. A reload is the same thing for this
  // purpose — a fresh popup instance that never heard the capture begin —
  // without making the popup tab the active tab mid-capture, which would
  // stop the capture for real.
  await popup.waitForTimeout(1000);
  await popup.reload();
  await popup.waitForSelector("#captureProgress:not([hidden])");
  await expect(popup.locator("#captureFullPage")).toBeDisabled();
  await expect(popup.locator("#status")).toContainText(/\d+ of \d+/);
  await finished;

  // The broadcast is what hands the attached popup over: the bar goes, the
  // buttons come back, and the restored UI is this capture's, not "No
  // capture yet".
  await expect(popup.locator("#captureProgress")).toBeHidden();
  await expect(popup.locator("#captureFullPage")).toBeEnabled();
  await expect(popup.locator("#report")).toBeVisible();

  await popup.close();
  await page.close();
});

test("a popup attached to a capture that fails shows why instead of hanging on the bar", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto(`${BASE_URL}/very-long.html?h=10000`);

  // Same construction as the test above: popup open and parked, page in
  // front. The capture is sent as a real runtime message from the popup
  // rather than through the handleRequest hook: the failure broadcast an
  // attached popup waits on lives in the message listener's catch, which a
  // direct handleRequest call never reaches.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  const finished = popup
    .evaluate(() => chrome.runtime.sendMessage({ action: "captureFullPage" }))
    .catch(() => null);
  await popup.waitForTimeout(1000);
  await popup.reload();
  await popup.waitForSelector("#captureProgress:not([hidden])");

  // Steal the active tab mid-capture — the one way a running capture stops
  // on its own. The attached popup must be told, not left on a bar that
  // never fills.
  await popup.bringToFront();
  // The abort rejects the request that started the capture — here reaching
  // nobody, exactly like the popup a real user blurred. The assertions below
  // are what check the failure arrived where it matters.
  await finished;

  await expect(popup.locator("#captureProgress")).toBeHidden();
  await expect(popup.locator("#captureFullPage")).toBeEnabled();
  await expect(popup.locator("#status")).toContainText("stopped");
  await expect(popup.locator("#status")).toHaveClass(/is-error/);

  await popup.close();
  await page.close();
});
