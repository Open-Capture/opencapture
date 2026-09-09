import { expect, test } from "./fixtures";

const BASE_URL = "http://localhost:8934";

declare global {
  // eslint-disable-next-line no-var
  var __tabUrls: string[];
  // eslint-disable-next-line no-var
  var __received: { name: string; size: number; header: string; shape: string } | null;
}

test("an exported PDF is set aside and delivered into the page that asks for it", async ({
  context,
  serviceWorker,
}) => {
  test.setTimeout(180_000);

  // Something to export. A visible capture is the cheapest real one.
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);
  await page.waitForLoadState("domcontentloaded");
  await page.bringToFront();
  await serviceWorker.evaluate(async () => {
    // @ts-expect-error test-only global
    await globalThis.__test.captureVisibleViaHandleRequest();
  });

  // Don't let it open the real site — the assertion is about which URL it
  // asks for, and the delivery is tested below against a local stand-in.
  await serviceWorker.evaluate(() => {
    globalThis.__tabUrls = [];
    const real = chrome.tabs.create;
    chrome.tabs.create = ((options: chrome.tabs.CreateProperties) => {
      globalThis.__tabUrls.push(options.url ?? "");
      return Promise.resolve({ id: -1 } as chrome.tabs.Tab);
    }) as typeof chrome.tabs.create;
    void real;
  });

  await serviceWorker.evaluate(async () => {
    // @ts-expect-error test-only global
    await globalThis.__test.exportPdfWithHandoff();
  });

  const urls = await serviceWorker.evaluate(() => globalThis.__tabUrls);
  console.log("HANDOFF tab: " + JSON.stringify(urls));
  expect(urls).toHaveLength(1);
  expect(urls[0]).toBe("https://openpdfedit.com/app/?handoff=opencapture");

  // The far end: a page speaking openpdfedit's protocol, with the real
  // content script injected into it exactly as the registration would.
  const target = await context.newPage();
  await target.goto(`${BASE_URL}/pdfedit-handoff.html?handoff=opencapture`);
  await target.waitForLoadState("domcontentloaded");
  const tabId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url?.startsWith(url));
    if (!tab?.id) throw new Error("no target tab");
    return tab.id;
  }, `${BASE_URL}/pdfedit-handoff.html`);
  await serviceWorker.evaluate(
    async (id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ["pdf-handoff.js"] }),
    tabId,
  );

  await expect
    .poll(async () => target.evaluate(() => globalThis.__received), { timeout: 30_000 })
    .not.toBeNull();
  const received = await target.evaluate(() => globalThis.__received);
  console.log("HANDOFF received: " + JSON.stringify(received));
  expect(received!.name).toBe("opencapture.pdf");
  // A real PDF, not an empty or truncated one.
  expect(received!.header).toBe("%PDF-");
  expect(received!.size).toBeGreaterThan(1000);

  // One delivery only: the bytes are dropped on read, so a second tab that
  // opens later gets nothing rather than a stale document.
  const second = await context.newPage();
  await second.goto(`${BASE_URL}/pdfedit-handoff.html?handoff=opencapture`);
  const secondId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.filter((t) => t.url?.startsWith(url)).pop();
    return tab!.id!;
  }, `${BASE_URL}/pdfedit-handoff.html`);
  await serviceWorker.evaluate(
    async (id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ["pdf-handoff.js"] }),
    secondId,
  );
  await second.waitForTimeout(3000);
  expect(await second.evaluate(() => globalThis.__received)).toBeNull();
});

test("the OpenPdfEdit tickbox appears with the PDF button and nowhere else", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  test.setTimeout(120_000);

  // Nothing captured yet: there is no PDF for it to have an opinion about.
  const fresh = await context.newPage();
  await fresh.goto(`chrome-extension://${extensionId}/popup.html`);
  await fresh.waitForSelector("#exportPdf");
  await expect(fresh.locator("#pdfEditRow")).toBeHidden();
  await expect(fresh.locator("#exportPdf")).toBeDisabled();
  await fresh.close();

  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);
  await page.waitForLoadState("domcontentloaded");
  await page.bringToFront();
  await serviceWorker.evaluate(async () => {
    // @ts-expect-error test-only global
    await globalThis.__test.captureVisibleViaHandleRequest();
  });

  // With a capture in hand it appears — directly beneath the button it is a
  // setting for, not floating somewhere else in the card.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForSelector("#exportPdf:not([disabled])");
  await expect(popup.locator("#pdfEditRow")).toBeVisible();
  expect(
    await popup.evaluate(
      () => document.getElementById("pdfEditRow")!.previousElementSibling?.id,
    ),
  ).toBe("resultActions");

  // And it goes away again while something is running, rather than sitting
  // under a progress bar offering to open a file that does not exist yet.
  await popup.evaluate(() => {
    document.getElementById("exportPdf")!.click();
  });
  await expect(popup.locator("#pdfEditRow")).toBeHidden();
});
