import { expect, test } from "./fixtures";

// The one line the popup shows at rest: what the settings are, without
// opening them. It has to survive eight languages in a window under 400px,
// and say something sensible when it cannot.

/** The label each locale renders, so the assertion cannot pass by accident. */
const SETTINGS = {
  en: "Settings",
  de: "Einstellungen",
  es: "Ajustes",
  pt: "Configurações",
  ja: "設定",
  ko: "설정",
  "zh-Hans": "设置",
  "zh-Hant": "設定",
} as const;

async function openSettings(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForSelector("#saveSummary");
  if (await page.locator("#settingsPanel").isHidden()) await page.click("#saveSummary");
  await page.waitForSelector("#prefLanguage option", { state: "attached" });
}

test("the row names both settings, in every language, without overflowing", async ({
  context,
  extensionId,
}) => {
  test.setTimeout(120_000);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 400, height: 700 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await openSettings(popup);

  for (const [code, label] of Object.entries(SETTINGS)) {
    await popup.selectOption("#prefLanguage", code);
    await popup.waitForTimeout(150);
    const row = await popup.evaluate(() => {
      const b = document.getElementById("saveSummary")!;
      return {
        text: (b.textContent || "").replace(/\s+/g, " ").trim(),
        languageShown: !document.getElementById("languageSummaryItem")!.hidden,
        overflows: b.scrollWidth > b.clientWidth,
      };
    });
    // The label, the destination and the language — and the language name is
    // the endonym, never translated.
    expect(row.text).toContain(label);
    expect(row.languageShown).toBe(true);
    expect(row.overflows).toBe(false);
  }

  await popup.selectOption("#prefLanguage", "en");
  await popup.close();
});

test("and drops the language rather than overflow when there is no room", async ({
  context,
  extensionId,
}) => {
  test.setTimeout(120_000);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 400, height: 700 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await openSettings(popup);
  expect(await popup.evaluate(() => !document.getElementById("languageSummaryItem")!.hidden)).toBe(true);

  // Narrow the popup past what the row can hold, then do the thing that
  // re-measures it. Nothing is lost when it goes: both settings are one
  // click inside, which is the whole reason the language is the half that
  // gives way rather than the destination.
  await popup.evaluate(() => {
    document.body.style.width = "150px";
  });
  await popup.selectOption("#prefLanguage", "de");
  await popup.waitForTimeout(250);
  expect(await popup.evaluate(() => document.getElementById("languageSummaryItem")!.hidden)).toBe(true);

  await popup.evaluate(() => {
    document.body.style.width = "";
  });
  await popup.selectOption("#prefLanguage", "en");
  await popup.close();
});
