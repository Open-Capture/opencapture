import { expect, test } from "./fixtures";

/**
 * Capturing a page no extension may touch — chrome://settings, the new tab,
 * the extension store.
 *
 * All three capture buttons used to hand the browser's own developer-facing
 * sentence to the user: "Cannot access a chrome:// URL", or, from the visible
 * -area button, "Either the '<all_urls>' or 'activeTab' permission is
 * required." — which reads as a permission this extension forgot to ask for.
 * "Capture selected area" was worse: the popup closed and nothing appeared
 * anywhere, because its reply was never read.
 *
 * These drive the real popup with the background stubbed, because the failure
 * being tested is what the popup does with an answer, not how the answer is
 * produced — orchestrator/injection-error cover that, and the background half
 * is exercised against real chrome:// tabs in the published evidence.
 */
const RAW_CHROME_URL = "Cannot access a chrome:// URL";

/** Make every capture request come back refused, the way a browser page does. */
async function stubRefusal(popup: import("@playwright/test").Page, reason: string) {
  await popup.evaluate(
    ({ reason, raw }) => {
      const w = window as unknown as { __closed: boolean };
      w.__closed = false;
      window.close = () => {
        w.__closed = true;
      };
      chrome.runtime.sendMessage = ((message: { action: string }) =>
        message.action === "ping"
          ? Promise.resolve({ ok: true })
          : Promise.resolve({ ok: false, error: raw, reason })) as unknown as typeof chrome.runtime.sendMessage;
    },
    { reason, raw: RAW_CHROME_URL },
  );
}

test("a browser page is explained in words the reader can act on, not the browser's", async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await stubRefusal(popup, "restricted-page");

  await popup.click("#captureFullPage");
  const status = popup.locator("#status");
  await expect(status).toContainText("ordinary web page");
  // The sentence being replaced must not survive into it.
  await expect(status).not.toContainText("chrome://");
  await expect(status).not.toContainText("activeTab");

  // Nothing was captured, so the row of things to do with a capture has
  // nothing to act on and should not be sitting there offering three
  // disabled buttons beside the error.
  await expect(popup.locator("#resultActions")).toBeHidden();
  await popup.close();
});

test("the explanation is translated, not English with a translated prefix", async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(() => localStorage.setItem("opencapture.locale", "zh-Hans"));
  await popup.reload();
  await stubRefusal(popup, "restricted-page");

  await popup.click("#captureVisible");
  const text = (await popup.locator("#status").textContent()) ?? "";
  // The whole sentence is Chinese — the defect was "错误：" followed by a
  // paragraph of English.
  expect(text).toContain("浏览器不允许扩展");
  expect(text).not.toContain("Cannot access");
  await popup.close();
});

test("choosing selected area on a browser page says so instead of closing silently", async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await stubRefusal(popup, "restricted-page");

  await popup.click("#captureSelectedArea");
  await expect(popup.locator("#status")).toContainText("ordinary web page");
  // And it is still open to be read: the old behaviour destroyed the popup in
  // the same turn, so the error had nowhere to go.
  expect(await popup.evaluate(() => (window as unknown as { __closed: boolean }).__closed)).toBe(false);
  await popup.close();
});

test("an ordinary page whose grant went stale is told to reload, not that the page is forbidden", async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await stubRefusal(popup, "needs-refresh");

  await popup.click("#captureFullPage");
  const status = popup.locator("#status");
  await expect(status).toContainText("Reload it");
  await expect(status).not.toContainText("ordinary web page");
  await popup.close();
});
