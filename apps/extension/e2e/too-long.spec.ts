import { expect, test } from "./fixtures";

const BASE_URL = "http://localhost:8934";

// Mirrors chrome/capture-size.ts. Duplicated rather than imported because
// this file is compiled by Playwright, not by the extension's own build, and
// the point of the assertion is that the shipped constant is what the editor
// actually honours.
const MAX_EDITABLE_AREA_PX = 2940 * 15559;

// What the download stub below records, declared so the assertions can read
// it back without casting at every call site.
declare global {
  // eslint-disable-next-line no-var
  var __downloads: string[];
}

test("a capture too long to finish is left to the user, not downloaded or opened", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  test.setTimeout(300_000);

  // Count downloads instead of letting them happen: the assertion is that
  // *nothing* is written until the user says so, and an absence has to be
  // observed at the call rather than in a folder.
  await serviceWorker.evaluate(() => {
    globalThis.__downloads = [];
    const real = chrome.downloads.download;
    chrome.downloads.download = ((options: chrome.downloads.DownloadOptions) => {
      globalThis.__downloads.push(options.filename ?? "");
      return real(options);
    }) as typeof chrome.downloads.download;
  });

  const page = await context.newPage();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${BASE_URL}/very-long.html`);
  await page.waitForLoadState("domcontentloaded");
  await page.bringToFront();

  const pagesBefore = context.pages().length;
  // Through the real message handler, not the orchestrator: what is being
  // tested is the decision about what to do with the capture, and that lives
  // in handleRequest. The direct hook downloads nothing and opens nothing
  // whatever the size, so it would pass this test while broken.
  const result = await serviceWorker.evaluate(
    // @ts-expect-error test-only global
    async () => globalThis.__test.captureFullPageViaHandleRequest(),
  );
  const report = result.report;
  console.log("TOO LONG report: " + JSON.stringify(report));

  // The capture itself is complete and past the budget — otherwise the rest
  // of this test is asserting nothing.
  expect(report.output_width_px * report.output_height_px).toBeGreaterThan(MAX_EDITABLE_AREA_PX);
  expect(report.aborted).toBe(false);

  // Neither of the two things it used to do on its own.
  const downloads = await serviceWorker.evaluate(() => globalThis.__downloads);
  expect(downloads).toEqual([]);
  expect(context.pages().length).toBe(pagesBefore);

  // What it does instead: asks, with the cost of each answer attached.
  const popup = await context.newPage();
  popup.on("pageerror", (e) => console.log("POPUP ERROR: " + e.message));
  popup.on("console", (m) => { if (m.type() === "error") console.log("POPUP CONSOLE: " + m.text()); });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForSelector("#formatChoice:not([hidden])", { timeout: 60_000 });
  await expect(popup.locator("#resultActions")).toBeHidden();
  // The OpenPdfEdit tickbox belongs to the PDF answer, so it follows that
  // option into the list rather than sitting under all three, where it reads
  // as a setting on the whole panel.
  await expect(popup.locator("#pdfEditRow")).toBeVisible();
  expect(
    await popup.evaluate(() => {
      const row = document.getElementById("pdfEditRow")!;
      return {
        after: row.previousElementSibling?.id,
        // Inside the PDF option's own box, not merely next to it.
        inside: row.parentElement?.className,
      };
    }),
  ).toEqual({ after: "choosePdf", inside: "choice-group" });
  const lead = await popup.locator("#formatChoiceLead").textContent();
  expect(lead).toContain("too long to keep whole and editable at once");
  expect(await popup.locator("#choosePdfNote").textContent()).toContain("app.openpdfedit.com");
  expect(await popup.locator("#choosePngNote").textContent()).toContain("Editing isn't possible");
  const editable = Math.floor(MAX_EDITABLE_AREA_PX / report.output_width_px);
  // This capture split, so the editor gets part 1 — and the panel says so
  // rather than quoting a row count that belongs to the unsplit case.
  expect(report.output_image_count).toBeGreaterThan(1);
  expect(await popup.locator("#chooseEditorNote").textContent()).toContain(
    `part 1 of ${report.output_image_count}`,
  );

  // Choosing the editor opens one, showing exactly the part it offered.
  const [editorPage] = await Promise.all([context.waitForEvent("page"), popup.click("#chooseEditor")]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const stack = document.getElementById("canvasStack");
    return !!stack && !stack.classList.contains("loading");
  });
  const shown = await editorPage.evaluate(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return { width: c.width, height: c.height };
  });
  expect(shown.width).toBe(report.output_width_px);
  // Part 1 of the split, and no more of it than the editor agreed to take.
  expect(shown.height).toBeLessThan(report.output_height_px);
  expect(shown.height).toBeLessThanOrEqual(editable);
  const notice = await editorPage.locator("#splitNoticeText").textContent();
  expect(notice).toContain("app.openpdfedit.com");
  await editorPage.close();

  // And the answer is remembered, so reopening does not ask again.
  const popup2 = await context.newPage();
  await popup2.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup2.waitForSelector("#resultActions:not([hidden])");
  await expect(popup2.locator("#formatChoice")).toBeHidden();
  await popup2.close();

  // The PNG answer writes the file it promised. Asked again from a fresh
  // state, since the question has already been answered once above.
  await serviceWorker.evaluate(async () => {
    const stored = await chrome.storage.local.get("lastCaptureUi");
    const ui = stored["lastCaptureUi"];
    await chrome.storage.local.set({ lastCaptureUi: { ...ui, formatChosen: false } });
  });
  const popup3 = await context.newPage();
  await popup3.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup3.waitForSelector("#formatChoice:not([hidden])");
  await popup3.click("#choosePng");
  await expect
    .poll(async () => serviceWorker.evaluate(() => globalThis.__downloads.length), { timeout: 60_000 })
    .toBeGreaterThan(0);
  const saved = await serviceWorker.evaluate(() => globalThis.__downloads);
  console.log("TOO LONG downloads: " + JSON.stringify(saved));
  expect(saved.every((name) => name.endsWith(".png"))).toBe(true);
  expect(saved.length).toBe(report.output_image_count);
  await popup3.close();

  // And the PDF answer, which is the recommended one, says where a PDF of a
  // page this long is actually edited — the editor here has just been ruled
  // out for being unable to hold it.
  await serviceWorker.evaluate(async () => {
    const stored = await chrome.storage.local.get("lastCaptureUi");
    await chrome.storage.local.set({ lastCaptureUi: { ...stored["lastCaptureUi"], formatChosen: false } });
  });
  const popup4 = await context.newPage();
  await popup4.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup4.waitForSelector("#formatChoice:not([hidden])");
  await popup4.click("#choosePdf");
  await popup4.waitForSelector("#pdfHandoff:not([hidden])", { timeout: 60_000 });
  expect(await popup4.locator("#pdfHandoffLead").textContent()).toContain("opencapture.pdf");
  const note = await popup4.locator("#openPdfEditNote").textContent();
  expect(note).toContain("app.openpdfedit.com");
  // It says which file to pick, because the site cannot be handed one.
  expect(note).toContain("opencapture.pdf");
  const [handoffTab] = await Promise.all([
    context.waitForEvent("page"),
    popup4.click("#openPdfEdit"),
  ]);
  expect(handoffTab.url()).toContain("app.openpdfedit.com");
  await handoffTab.close();
  await expect(popup4.locator("#pdfHandoff")).toBeHidden();
  const pdfSaved = await serviceWorker.evaluate(() => globalThis.__downloads);
  expect(pdfSaved.some((name) => name.endsWith(".pdf"))).toBe(true);
});

test("the ordinary PDF button offers the same follow-up as the panel's", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  test.setTimeout(120_000);

  // An everyday capture — no choice panel involved. This is the path most
  // PDFs are exported by, and it used to say nothing about what opens one.
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);
  await page.waitForLoadState("domcontentloaded");
  await page.bringToFront();
  await serviceWorker.evaluate(async () => {
    // @ts-expect-error test-only global
    await globalThis.__test.captureVisibleViaHandleRequest();
  });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForSelector("#exportPdf:not([disabled])");
  await popup.click("#exportPdf");
  await popup.waitForSelector("#pdfHandoff:not([hidden])", { timeout: 60_000 });
  expect(await popup.locator("#pdfHandoffLead").textContent()).toContain(".pdf");
  expect(await popup.locator("#openPdfEditNote").textContent()).toContain("app.openpdfedit.com");
});

test("one image the editor still cannot hold whole is trimmed, and says so", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  test.setTimeout(300_000);

  // Wide and just under shot-core's split length: one output PNG, but more
  // pixels than the editor will take. That is the other way to be too long,
  // and the only one where the editor's own budget does the cutting.
  const page = await context.newPage();
  await page.setViewportSize({ width: 1600, height: 800 });
  await page.goto(`${BASE_URL}/very-long.html?h=29000`);
  await page.waitForLoadState("domcontentloaded");
  await page.bringToFront();

  const result = await serviceWorker.evaluate(
    // @ts-expect-error test-only global
    async () => globalThis.__test.captureFullPageViaHandleRequest(),
  );
  const report = result.report;
  console.log("TRIM report: " + JSON.stringify(report));
  expect(report.output_image_count).toBe(1);
  expect(report.output_width_px * report.output_height_px).toBeGreaterThan(MAX_EDITABLE_AREA_PX);

  const editable = Math.floor(MAX_EDITABLE_AREA_PX / report.output_width_px);
  expect(editable).toBeLessThan(report.output_height_px);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForSelector("#formatChoice:not([hidden])", { timeout: 60_000 });
  // The unsplit case quotes the exact number of rows, because here it knows it.
  expect(await popup.locator("#chooseEditorNote").textContent()).toContain(
    new Intl.NumberFormat().format(editable),
  );

  const [editorPage] = await Promise.all([context.waitForEvent("page"), popup.click("#chooseEditor")]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const stack = document.getElementById("canvasStack");
    return !!stack && !stack.classList.contains("loading");
  });
  const shown = await editorPage.evaluate(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    const ctx = c.getContext("2d")!;
    // The last row must be real capture, not blank canvas: a trim that left
    // the bottom empty would satisfy a height check on its own.
    const bottom = ctx.getImageData(0, c.height - 1, Math.min(c.width, 200), 1).data;
    let opaque = 0;
    for (let i = 3; i < bottom.length; i += 4) if ((bottom[i] ?? 0) > 0) opaque++;
    return { width: c.width, height: c.height, opaqueBottomPixels: opaque };
  });
  expect(shown.width).toBe(report.output_width_px);
  expect(shown.height).toBe(editable);
  expect(shown.opaqueBottomPixels).toBeGreaterThan(0);

  const notice = await editorPage.locator("#splitNoticeText").textContent();
  expect(notice).toContain("too long to annotate in one piece");
  expect(notice).toContain("app.openpdfedit.com");
});
