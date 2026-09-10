import { expect, test } from "./fixtures";

// The two checks the static ones cannot make: a translation can sit in a
// catalogue and never reach the screen, and a choice can apply and then be
// forgotten on the next open. Both have to be asserted in a real browser.

/** A string that differs in all eight, so the assertion cannot pass by
 * accident. "Capture full page" does; a short label like "PDF" would not. */
const HEADLINE = {
  en: "Capture full page",
  "zh-Hans": "捕获整页",
  "zh-Hant": "擷取整頁",
  ja: "ページ全体をキャプチャ",
  ko: "전체 페이지 캡처",
  de: "Ganze Seite aufnehmen",
  es: "Capturar página completa",
  pt: "Capturar página inteira",
} as const;

/** The picker lives inside the collapsed settings disclosure — the same one
 * the save destination is in — so every test has to open it first, exactly
 * as a person would. */
async function openSettings(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForSelector("#saveSummary");
  if (await page.locator("#settingsPanel").isHidden()) await page.click("#saveSummary");
  await page.waitForSelector("#prefLanguage option", { state: "attached" });
}

test("every offered language actually renders", async ({ context, extensionId }) => {
  test.setTimeout(120_000);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await openSettings(popup);

  // The picker offers exactly the locales the app declares, by endonym.
  const offered = await popup.$$eval("#prefLanguage option", (os) =>
    os.map((o) => ({ code: (o as HTMLOptionElement).value, label: o.textContent })),
  );
  expect(offered.map((o) => o.code)).toEqual(Object.keys(HEADLINE));
  // Language names are never translated — 日本語 is 日本語 in every locale.
  expect(offered.find((o) => o.code === "ja")?.label).toBe("日本語");

  for (const [code, expected] of Object.entries(HEADLINE)) {
    await popup.selectOption("#prefLanguage", code);
    await expect(popup.locator("#captureFullPage")).toContainText(expected);
    // `lang` is not decoration: it picks the right glyphs for Han
    // characters and is what a screen reader switches voice on.
    expect(await popup.evaluate(() => document.documentElement.lang)).toBe(code);
  }

  // Attributes travel too. Wrapping the visible text but not the tooltip
  // beside it is the failure this catches.
  await popup.selectOption("#prefLanguage", "de");
  expect(await popup.getAttribute("#openHistory", "title")).toBe("Aufnahmeverlauf");
  expect(await popup.getAttribute("#openAccount", "title")).toBe("Konto");
  await popup.close();
});

test("the choice survives closing the popup", async ({ context, extensionId }) => {
  test.setTimeout(120_000);
  const first = await context.newPage();
  await first.goto(`chrome-extension://${extensionId}/popup.html`);
  await openSettings(first);
  await first.selectOption("#prefLanguage", "ko");
  await expect(first.locator("#captureFullPage")).toContainText(HEADLINE.ko);
  await first.close();

  // A popup is torn down and rebuilt every time it opens, so this is the
  // ordinary case rather than an edge one.
  const second = await context.newPage();
  await second.goto(`chrome-extension://${extensionId}/popup.html`);
  await openSettings(second);
  await expect(second.locator("#captureFullPage")).toContainText(HEADLINE.ko);
  expect(await second.evaluate(() => document.documentElement.lang)).toBe("ko");
  expect(await second.inputValue("#prefLanguage")).toBe("ko");

  // Put it back, so a later test in this suite does not read Korean.
  await second.selectOption("#prefLanguage", "en");
  await second.close();
});

test("the editor and history pages open translated too", async ({ context, extensionId }) => {
  test.setTimeout(120_000);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await openSettings(popup);
  await popup.selectOption("#prefLanguage", "ja");
  await popup.close();

  const history = await context.newPage();
  await history.goto(`chrome-extension://${extensionId}/history.html`);
  await history.waitForLoadState("domcontentloaded");
  await expect(history.locator("body")).toContainText("すべて消去");
  // The tab title too — it lives in <head>, which the body walk cannot see.
  expect(await history.title()).toBe("OpenCapture 履歴");
  await history.close();

  const editor = await context.newPage();
  await editor.goto(`chrome-extension://${extensionId}/editor.html`);
  await editor.waitForLoadState("domcontentloaded");
  // The toolbar is translated even with no capture loaded.
  expect(await editor.getAttribute("#toolCrop", "title")).toBe("画像を切り抜く");
  await editor.close();

  const reset = await context.newPage();
  await reset.goto(`chrome-extension://${extensionId}/popup.html`);
  await openSettings(reset);
  await reset.selectOption("#prefLanguage", "en");
  await reset.close();
});
