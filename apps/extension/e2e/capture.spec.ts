import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

const BASE_URL = "http://localhost:8934";
const SHOT_QA_BIN = process.env.SHOT_QA_BIN ?? "/tmp/opencapture-target/debug/shot-qa";
// A real, small PNG already in the repo — no synthetic fixture needed.
const LOGO_FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons", "icon48.png");

function shotQa(args: string[]): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(SHOT_QA_BIN, args, { encoding: "utf8" });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string };
    return { code: e.status ?? 1, stdout: (e.stdout ?? "").toString() };
  }
}

function writeBase64Png(dir: string, name: string, base64: string): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.from(base64, "base64"));
  return path;
}

test.beforeAll(() => {
  if (!existsSync(SHOT_QA_BIN)) {
    throw new Error(`shot-qa binary not found at ${SHOT_QA_BIN} — build it first: cargo build -p shot-qa`);
  }
});

test("extension loads: service worker starts and wasm module initializes", async ({ serviceWorker }) => {
  const targets = await serviceWorker.evaluate(async () => {
    // @ts-expect-error test-only global, see background/index.ts
    return globalThis.__test.scrollTargets(3000, 720);
  });
  expect(targets[0]).toBe(0);
  expect(targets[targets.length - 1]! + 720).toBeGreaterThanOrEqual(3000);
});

test("popup renders its controls", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator("#captureFullPage")).toBeVisible();
  await expect(page.locator("#captureVisible")).toBeVisible();
  await page.close();
});

test("full-page capture stitches a long page without duplicated or missing bands", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const tabId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab found for ${url}; open tabs: ${JSON.stringify(tabs.map((t) => t.url))}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  const result = await serviceWorker.evaluate(
    async ({ tabId, windowId }) => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureFullPage(tabId, windowId);
    },
    { tabId: tabId.tabId, windowId: tabId.windowId },
  );

  expect(result.report.slice_count).toBeGreaterThan(1);
  expect(result.report.output_height_px).toBe(3000);
  expect(result.report.output_width_px).toBe(1000);
  expect(result.imagesBase64.length).toBe(1);

  const dir = mkdtempSync(join(tmpdir(), "opencapture-e2e-"));
  const pngPath = writeBase64Png(dir, "ruler.png", result.imagesBase64[0]);

  const info = shotQa(["png-info", pngPath]);
  expect(info.code).toBe(0);
  const parsedInfo = JSON.parse(info.stdout);
  expect(parsedInfo.width).toBe(1000);
  expect(parsedInfo.height).toBe(3000);

  // Every one of the 30 generated bands must appear at its exact expected
  // row with its exact expected color — this is the golden assertion for
  // the whole scroll-and-stitch pipeline: a duplicated or skipped slice
  // shows up here as a wrong color at a specific, named band index.
  const bandSample = shotQa([
    "band-sample",
    pngPath,
    "--bands",
    "30",
    "--band-height",
    "100",
    "--x",
    "10",
    "--y-offset",
    "50",
  ]);
  expect(bandSample.code).toBe(0);
  const bands = JSON.parse(bandSample.stdout) as Array<{ band: number; r: number; g: number; b: number }>;
  expect(bands.length).toBe(30);
  for (const band of bands) {
    const expectedR = (band.band * 53) % 256;
    const expectedG = (band.band * 97) % 256;
    const expectedB = (band.band * 151) % 256;
    expect(band, `band ${band.band}`).toMatchObject({ r: expectedR, g: expectedG, b: expectedB });
  }

  await page.close();
});

test("full-page capture on a page with an inner scroller captures its full content, not just what's visible at the top", async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/inner-scroll.html`);

  const tabId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab found for ${url}; open tabs: ${JSON.stringify(tabs.map((t) => t.url))}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  const result = await serviceWorker.evaluate(
    async ({ tabId, windowId }) => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureFullPage(tabId, windowId);
    },
    { tabId: tabId.tabId, windowId: tabId.windowId },
  );

  // The outer page (80px header + 500px scroll box = 580px) fits inside
  // the 600px-tall viewport on its own — a naive window-scroll capture
  // would need exactly one slice and would only ever show whatever
  // #scrollBox displayed at scrollTop 0 (its first ~500px of content).
  // 2000px of output height only happens if the inner container's own
  // 20 bands x 100px were actually driven and stitched, not the window.
  expect(result.report.output_height_px).toBe(2000);
  expect(result.report.output_width_px).toBe(800);
  expect(result.report.warnings).toContain("Captured an inner scrolling area on this page instead of the full window.");

  const dir = mkdtempSync(join(tmpdir(), "opencapture-e2e-"));
  const pngPath = writeBase64Png(dir, "inner-scroll.png", result.imagesBase64[0]);

  const info = JSON.parse(shotQa(["png-info", pngPath]).stdout);
  expect(info.width).toBe(800);
  expect(info.height).toBe(2000);

  // Same golden per-band assertion ruler-3000's test uses — every one of
  // the 20 bands generated *inside* #scrollBox, at its exact row and
  // color, proves the whole inner container was captured in order with
  // no duplicated or skipped slice.
  const bandSample = shotQa(["band-sample", pngPath, "--bands", "20", "--band-height", "100", "--x", "10", "--y-offset", "50"]);
  expect(bandSample.code).toBe(0);
  const bands = JSON.parse(bandSample.stdout) as Array<{ band: number; r: number; g: number; b: number }>;
  expect(bands.length).toBe(20);
  for (const band of bands) {
    const expectedR = (band.band * 53) % 256;
    const expectedG = (band.band * 97) % 256;
    const expectedB = (band.band * 151) % 256;
    expect(band, `band ${band.band}`).toMatchObject({ r: expectedR, g: expectedG, b: expectedB });
  }

  await page.close();
});

test("capturing the same tab twice without a reload doesn't throw a content-script re-injection SyntaxError", async ({
  context,
  serviceWorker,
}) => {
  // chrome.scripting.executeScript's isolated world persists across
  // repeated injections into the same tab/frame (only torn down on
  // navigation) — content.js's top-level const/let declarations used to
  // throw "Uncaught SyntaxError: Identifier '...' has already been
  // declared" on the second injection into a page the user hadn't
  // reloaded, silently breaking every capture after the first one. See
  // content/index.ts's re-injection guard.
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab found for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  // The redeclaration SyntaxError surfaces as an uncaught exception on the
  // *page* (a `pageerror` event) — not a console.error call, and not a
  // rejected chrome.scripting.executeScript() promise (that call resolves
  // "ok" regardless, since the file genuinely was injected; it's the
  // re-injected script's own top-level execution that throws, separately
  // and asynchronously). It also doesn't break the capture's *own*
  // report/result — the first injection's already-registered message
  // listener keeps handling requests fine even while the second injection
  // silently fails in the background — so report assertions alone
  // wouldn't have caught this bug; only the pageerror listener does.
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const captureOnce = () =>
    serviceWorker.evaluate(async ({ tabId, windowId }) => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureFullPage(tabId, windowId);
    }, tabInfo);

  const first = await captureOnce();
  const second = await captureOnce(); // same tab, no navigation in between — this used to throw
  await page.waitForTimeout(300); // pageerror fires asynchronously relative to executeScript resolving

  expect(first.report.output_height_px).toBe(3000);
  expect(second.report.output_height_px).toBe(3000);
  expect(pageErrors.filter((m) => m.includes("has already been declared"))).toEqual([]);

  await page.close();
});

test("sticky/fixed elements appear once, not duplicated across every slice", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/sticky-fixed.html`);

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab found for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  const result = await serviceWorker.evaluate(
    async ({ tabId, windowId }) => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureFullPage(tabId, windowId);
    },
    tabInfo,
  );

  expect(result.report.pinned_elements_handled).toBeGreaterThanOrEqual(2); // header + badge (+ sticky subheader)

  const dir = mkdtempSync(join(tmpdir(), "opencapture-e2e-"));
  const pngPath = writeBase64Png(dir, "sticky.png", result.imagesBase64[0]);

  // magenta header: must appear at the very top, and must NOT reappear at
  // a middle-of-page sample point (which would mean it leaked into every
  // slice instead of being hidden after the first).
  const top = JSON.parse(shotQa(["band-sample", pngPath, "--bands", "1", "--band-height", "1", "--x", "10", "--y-offset", "10"]).stdout)[0];
  expect(top).toMatchObject({ r: 255, g: 0, b: 255 });

  const middle = JSON.parse(
    shotQa(["band-sample", pngPath, "--bands", "1", "--band-height", "1", "--x", "10", "--y-offset", String(Math.floor(result.report.output_height_px / 2))]).stdout,
  )[0];
  expect(middle.r).not.toBe(255);
  expect(middle.g).not.toBe(0);
  expect(middle.b).not.toBe(255);

  await page.close();
});

test("sticky elements inside an inner scroller appear once, not in every slice", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/sticky-inner-scroll.html`);

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab found for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  const result = await serviceWorker.evaluate(
    async ({ tabId, windowId }) => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureFullPage(tabId, windowId);
    },
    tabInfo,
  );

  // The window-scroll path already handled this; the inner-scroll path did
  // not classify pinned elements at all, so this was 0 and both bars were
  // burned into every slice.
  expect(result.report.pinned_elements_handled).toBeGreaterThanOrEqual(2);

  const dir = mkdtempSync(join(tmpdir(), "opencapture-e2e-"));
  const pngPath = writeBase64Png(dir, "sticky-inner.png", result.imagesBase64[0]);

  // The magenta header belongs at the top of the stitched image and nowhere
  // else. Sampling the middle catches the regression precisely: if the bar is
  // being re-photographed per slice it lands at a slice boundary mid-image.
  const top = JSON.parse(shotQa(["band-sample", pngPath, "--bands", "1", "--band-height", "1", "--x", "10", "--y-offset", "10"]).stdout)[0];
  expect(top).toMatchObject({ r: 255, g: 0, b: 255 });

  const middle = JSON.parse(
    shotQa(["band-sample", pngPath, "--bands", "1", "--band-height", "1", "--x", "10", "--y-offset", String(Math.floor(result.report.output_height_px / 2))]).stdout,
  )[0];
  expect(middle).not.toMatchObject({ r: 255, g: 0, b: 255 });
  expect(middle).not.toMatchObject({ r: 0, g: 255, b: 255 });

  await page.close();
});

test("cookie consent banner and its scrim are absent from the whole capture", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/cookie-banner.html`);

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab found for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  const result = await serviceWorker.evaluate(
    async ({ tabId, windowId }) => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureFullPage(tabId, windowId);
    },
    tabInfo,
  );

  // Both the banner and the scrim. The scrim only gets this far because a
  // consent match is allowed past the half-viewport size guard.
  expect(result.report.pinned_elements_handled).toBeGreaterThanOrEqual(2);

  const dir = mkdtempSync(join(tmpdir(), "opencapture-e2e-"));
  const pngPath = writeBase64Png(dir, "cookie.png", result.imagesBase64[0]);

  // Unlike a header or a footer bar, a consent overlay should appear on *no*
  // slice — not even the last — so sample the whole height rather than a
  // point. The banner is full width, so any x would catch it.
  const samples = JSON.parse(
    shotQa(["band-sample", pngPath, "--bands", "20", "--band-height", "1", "--x", "400"]).stdout,
  ) as Array<{ r: number; g: number; b: number }>;
  const magenta = samples.filter((s) => s.r === 255 && s.g === 0 && s.b === 255);
  expect(magenta).toHaveLength(0);

  // An opaque scrim left visible would black out every band. Asserting an
  // exact expected colour catches that, where "not magenta" would not.
  const band5 = JSON.parse(
    shotQa(["band-sample", pngPath, "--bands", "1", "--band-height", "1", "--x", "400", "--y-offset", "550"]).stdout,
  )[0];
  expect(band5).toMatchObject({ r: (5 * 53) % 256, g: (5 * 97) % 256, b: (5 * 151) % 256 });

  await page.close();
});

test("redo restores an undone edit, and the counters track both stacks", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);

  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.openEditor();
    }),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  const readPixel = (x: number, y: number) =>
    editorPage.evaluate(
      ({ px, py }) => {
        const canvas = document.getElementById("canvas") as HTMLCanvasElement;
        return Array.from(canvas.getContext("2d")!.getImageData(px, py, 1, 1).data);
      },
      { px: x, py: y },
    );
  const history = () =>
    editorPage.evaluate(() => ({
      undo: document.getElementById("undoCount")!.textContent,
      redo: document.getElementById("redoCount")!.textContent,
      undoDisabled: (document.getElementById("undo") as HTMLButtonElement).disabled,
      redoDisabled: (document.getElementById("redo") as HTMLButtonElement).disabled,
      toolbarH: Math.round(document.getElementById("toolbar")!.getBoundingClientRect().height),
    }));

  const canvasBox = await editorPage.locator("#canvas").boundingBox();
  if (!canvasBox) throw new Error("canvas has no bounding box");
  const toPage = (x: number, y: number) => ({ x: canvasBox.x + x, y: canvasBox.y + y });

  const atRest = await history();
  expect(atRest).toMatchObject({ undo: "", redo: "", undoDisabled: true, redoDisabled: true });

  const clean = await readPixel(100, 60);

  await editorPage.click("#toolRect");
  const start = toPage(60, 60);
  const end = toPage(160, 160);
  await editorPage.mouse.move(start.x, start.y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(end.x, end.y, { steps: 5 });
  await editorPage.mouse.up();
  await editorPage.keyboard.press("Enter");

  const drawn = await readPixel(100, 60);
  expect(drawn).not.toEqual(clean);
  const afterDraw = await history();
  expect(afterDraw).toMatchObject({ undo: "1", redo: "", undoDisabled: false, redoDisabled: true });
  // The counters must not resize the strip: a toolbar that grows when a count
  // appears moves the canvas under the pointer mid-session, which is exactly
  // how this shifted a crop by a pixel before the badge was taken out of flow.
  expect(afterDraw.toolbarH).toBe(atRest.toolbarH);

  await editorPage.click("#undo");
  expect(await readPixel(100, 60)).toEqual(clean);
  // The step moved across rather than vanishing — that is the whole point.
  expect(await history()).toMatchObject({ undo: "", redo: "1", undoDisabled: true, redoDisabled: false });

  await editorPage.click("#redo");
  expect(await readPixel(100, 60)).toEqual(drawn);
  expect(await history()).toMatchObject({ undo: "1", redo: "", undoDisabled: false, redoDisabled: true });

  // A new edit after an undo discards the redo stack: that future is gone.
  await editorPage.click("#undo");
  expect(await history()).toMatchObject({ redo: "1" });
  await editorPage.click("#toolRect");
  const s2 = toPage(200, 200);
  const e2 = toPage(260, 260);
  await editorPage.mouse.move(s2.x, s2.y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(e2.x, e2.y, { steps: 5 });
  await editorPage.mouse.up();
  await editorPage.keyboard.press("Enter");
  expect(await history()).toMatchObject({ undo: "1", redo: "", redoDisabled: true });

  await editorPage.close();
  await page.close();
});

test("a local file:// page captures when the browser allows file access", async ({ context, serviceWorker }) => {
  // The reported bug is the other branch: Chromium does not extend activeTab
  // to file:// until "Allow access to file URLs" is on, which is off for a
  // store install, and the browser's own message reads like a bug in the
  // extension. That branch cannot be reproduced here — Playwright grants file
  // access to a loaded extension, so isAllowedFileSchemeAccess() is true — and
  // the wording for it is covered by injection-error.test.ts instead.
  //
  // What this pins down is that wrapping executeScript to produce that message
  // did not break capturing a local file when the permission *is* granted.
  const fileUrl = `file://${join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "test-pages", "ruler-3000.html")}`;
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(fileUrl);

  const probe = await serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url?.startsWith("file://"));
    if (!tab?.id) throw new Error(`no file:// tab; saw ${JSON.stringify(tabs.map((t) => t.url))}`);
    return { tabId: tab.id, windowId: tab.windowId, allowed: await chrome.extension.isAllowedFileSchemeAccess() };
  });
  expect(probe.allowed).toBe(true);

  const result = await serviceWorker.evaluate(
    async ({ tabId, windowId }) => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureFullPage(tabId, windowId);
    },
    { tabId: probe.tabId, windowId: probe.windowId },
  );

  expect(result.report.output_height_px).toBeGreaterThan(600);
  expect(result.imagesBase64.length).toBeGreaterThan(0);

  await page.close();
});

test("zoom changes the rendered size without breaking draw coordinates", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);
  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);
  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.openEditor();
    }),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  const rendered = () =>
    editorPage.evaluate(() => {
      const c = document.getElementById("canvas") as HTMLCanvasElement;
      const p = document.getElementById("previewCanvas") as HTMLCanvasElement;
      return {
        // The label span, not the button: the button also holds an icon.
        label: document.getElementById("zoomLevelLabel")!.textContent,
        cssWidth: Math.round(c.getBoundingClientRect().width),
        pixelWidth: c.width,
        // The overlay is positioned in JS; if it stops matching, the crop
        // marquee draws somewhere the image is not.
        previewWidth: Math.round(p.getBoundingClientRect().width),
      };
    });

  const fit = await rendered();
  expect(fit.label).toBe("Fit");
  expect(fit.previewWidth).toBe(fit.cssWidth);

  await editorPage.click("#zoomIn");
  const zoomed = await rendered();
  expect(zoomed.cssWidth).toBeGreaterThan(fit.cssWidth);
  expect(zoomed.label).toMatch(/%$/);
  expect(zoomed.previewWidth).toBe(zoomed.cssWidth);

  await editorPage.click("#zoomFit");
  expect(await rendered()).toMatchObject({ label: "Fit", cssWidth: fit.cssWidth });

  // 100% must mean one image pixel per CSS pixel, whatever "fit" worked out to.
  await editorPage.click("#zoomLevel");
  const native = await rendered();
  expect(native.label).toBe("100%");
  expect(native.cssWidth).toBe(native.pixelWidth);

  // Drawing still lands where the pointer is: canvasPoint() divides by the
  // rendered box, so a wrong scale would offset every shape.
  const box = (await editorPage.locator("#canvas").boundingBox())!;
  // Sample the stroke, not the interior: the rectangle tool outlines, so a
  // point inside the shape is untouched even when the draw worked.
  const SAMPLE = { x: 70, y: 20 };
  const before = await editorPage.evaluate(
    (p) => {
      const c = document.getElementById("canvas") as HTMLCanvasElement;
      return Array.from(c.getContext("2d")!.getImageData(p.x, p.y, 1, 1).data);
    },
    SAMPLE,
  );
  await editorPage.click("#toolRect");
  await editorPage.mouse.move(box.x + 20, box.y + 20);
  await editorPage.mouse.down();
  await editorPage.mouse.move(box.x + 120, box.y + 120, { steps: 5 });
  await editorPage.mouse.up();
  await editorPage.keyboard.press("Enter");
  const after = await editorPage.evaluate(
    (p) => {
      const c = document.getElementById("canvas") as HTMLCanvasElement;
      return Array.from(c.getContext("2d")!.getImageData(p.x, p.y, 1, 1).data);
    },
    SAMPLE,
  );
  expect(after).not.toEqual(before);

  await editorPage.close();
  await page.close();
});

test("popup: Rate us is always available and Save to is collapsed by default", async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForFunction(() => (document.getElementById("prefFilename") as HTMLInputElement).placeholder === "opencapture");

  // Rate us is permanent — the milestone prompt only appears after the 3rd
  // capture and sits at the bottom of a scrolling panel, so a happy user on
  // day one previously had nowhere to say so.
  await expect(popup.locator("#rateUs")).toBeVisible();
  // Labelled, not just a star: an icon alone beside the wordmark reads as
  // decoration rather than an invitation.
  await expect(popup.locator("#rateUs")).toContainText("Rate us!");
  // And the header must still fit the popup's fixed width without wrapping.
  const header = (await popup.locator("#popupHeader").boundingBox())!;
  const rate = (await popup.locator("#rateUs").boundingBox())!;
  const account = (await popup.locator("#openAccount").boundingBox())!;
  expect(rate.y).toBeCloseTo(account.y, 0);
  expect(header.height).toBeLessThan(60);
  await expect(popup.locator("#ratingPrompt")).toBeHidden();

  // Save to starts collapsed, with the destination still legible.
  await expect(popup.locator("#saveLocation")).toBeHidden();
  await expect(popup.locator("#saveSummary")).toBeVisible();
  await expect(popup.locator("#saveSummaryText")).toHaveText(/Downloads · .*\.png/);

  // The capture buttons are what the popup is for: they must sit above the
  // settings, which is the whole point of moving the fieldset down.
  const actionsY = (await popup.locator("#captureActions").boundingBox())!.y;
  const saveY = (await popup.locator("#saveSummaryRow").boundingBox())!.y;
  expect(actionsY).toBeLessThan(saveY);

  const collapsedHeight = await popup.evaluate(() => document.body.scrollHeight);

  await popup.click("#saveSummary");
  await expect(popup.locator("#saveLocation")).toBeVisible();
  await expect(popup.locator("#saveSummary")).toHaveAttribute("aria-expanded", "true");
  const expandedHeight = await popup.evaluate(() => document.body.scrollHeight);
  expect(expandedHeight).toBeGreaterThan(collapsedHeight);

  await popup.click("#saveSummary");
  await expect(popup.locator("#saveLocation")).toBeHidden();

  // Rate us opens the store listing rather than doing anything in-popup.
  const [tab] = await Promise.all([context.waitForEvent("page"), popup.click("#rateUs")]);
  expect(tab.url()).toMatch(/chromewebstore\.google\.com|microsoftedge\.microsoft\.com|addons\.mozilla\.org/);
  await tab.close();
  await popup.close();
});

test("a chat dock is kept out of the capture, without hiding a wide sticky area", async ({
  context,
  serviceWorker,
}) => {
  // Reported on LinkedIn: the messaging overlay appeared throughout a
  // scrolling capture. It is tall, so the "taller than half the band means it
  // is content" guard skipped it — but it is also narrow, which is what tells
  // a corner widget apart from a content column. Measured before the fix, the
  // dock covered 348,828 pixels from y=180 to the bottom of the image.
  //
  // The fixture carries a wide *and* tall sticky area too, so the fix cannot
  // be "hide anything tall".
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/chat-overlay.html`);

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab found for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  const result = await serviceWorker.evaluate(
    async ({ tabId, windowId }) => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureFullPage(tabId, windowId);
    },
    tabInfo,
  );

  // Counting pixels rather than sampling rows: "appears nowhere" is the claim,
  // and a row sample can miss a band while the element is still smeared over
  // most of the image.
  const scan = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d")!;
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let magenta = 0;
    let cyan = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) magenta++;
      else if (d[i] === 0 && d[i + 1] === 255 && d[i + 2] === 255) cyan++;
    }
    return { magenta, cyan };
  }, result.imagesBase64[0]!);

  expect(scan.magenta).toBe(0);
  // And the wide sticky area is still there — the guard it relies on survived.
  expect(scan.cyan).toBeGreaterThan(0);

  await page.close();
});

test("browser frame wraps the capture, carries the URL, and undoes as one step", async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);
  // Through handleRequest rather than the orchestrator hook: the page URL is
  // recorded by the capture path, so driving the orchestrator directly would
  // test the frame against a URL the product never actually loses.
  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureVisibleViaHandleRequest();
    }),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  const size = () =>
    editorPage.evaluate(() => {
      const c = document.getElementById("canvas") as HTMLCanvasElement;
      return { w: c.width, h: c.height };
    });
  const before = await size();

  await editorPage.click("#toolFrame");
  await expect(editorPage.locator("#framePanel")).toBeVisible();
  // The URL travels from the background worker: the editor is its own tab and
  // cannot ask which page the pixels came from.
  await expect(editorPage.locator("#frameUrlPreview")).toContainText("ruler-3000.html");

  await editorPage.selectOption("#framePreset", "macos");
  await editorPage.click("#frameApply");

  const framed = await size();
  // Chrome above, hairline either side: the image is inset, not resized.
  expect(framed.h).toBeGreaterThan(before.h);
  expect(framed.w).toBeGreaterThan(before.w);
  await expect(editorPage.locator("#framePanel")).toBeHidden();

  // One undo step, not one per drawing operation.
  await expect(editorPage.locator("#undoCount")).toHaveText("1");
  await editorPage.click("#undo");
  expect(await size()).toEqual(before);

  // Redo brings it back, which is what proves it went through history rather
  // than mutating the canvas behind undo's back.
  await editorPage.click("#redo");
  expect(await size()).toEqual(framed);

  // Reopening the panel shows the frame that is on the image, not whatever
  // was picked last time — that is how you can tell what you are replacing.
  await editorPage.click("#toolFrame");
  await expect(editorPage.locator("#framePreset")).toHaveValue("macos");

  // A second preset REPLACES the first. Choosing another style used to wrap
  // the already-framed picture in a second window, which is never what
  // anyone means by changing the frame. macOS and Windows reserve the same
  // chrome, so a correct replace lands on exactly the same size — stacking
  // would add another title bar and two more hairlines.
  await editorPage.selectOption("#framePreset", "windows");
  await editorPage.click("#frameApply");
  expect(await size()).toEqual(framed);

  // ...and it is still one undoable step back to the macOS frame, not a
  // rebuild from the bare screenshot.
  await editorPage.click("#undo");
  expect(await size()).toEqual(framed);
  await editorPage.click("#redo");

  // "None" removes the frame that is on the image, returning the bare
  // screenshot at exactly its original size.
  await editorPage.click("#toolFrame");
  await expect(editorPage.locator("#framePreset")).toHaveValue("windows");
  await editorPage.selectOption("#framePreset", "none");
  await editorPage.click("#frameApply");
  expect(await size()).toEqual(before);

  // Undo puts the frame back, so removing one is as reversible as adding one.
  await editorPage.click("#undo");
  expect(await size()).toEqual(framed);

  await editorPage.close();
  await page.close();
});

test("native lazy-loaded image is forced to load before capture", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 400, height: 600 });
  await page.goto(`${BASE_URL}/lazy-native.html`);

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab found for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  const result = await serviceWorker.evaluate(
    async ({ tabId, windowId }) => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureFullPage(tabId, windowId);
    },
    tabInfo,
  );

  expect(result.report.lazy_images_forced).toBeGreaterThanOrEqual(1);

  const dir = mkdtempSync(join(tmpdir(), "opencapture-e2e-"));
  const pngPath = writeBase64Png(dir, "lazy.png", result.imagesBase64[0]);

  // The image sits at CSS y=800..1000, x=0..200 — sample its center.
  const sample = JSON.parse(shotQa(["band-sample", pngPath, "--bands", "1", "--band-height", "1", "--x", "100", "--y-offset", "900"]).stdout)[0];
  expect(sample).toMatchObject({ r: 50, g: 205, b: 50 }); // lime-green loaded content, not a blank/placeholder pixel

  await page.close();
});

test("selected-area capture crops to exactly the dragged rectangle", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab found for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  // Kick off the background-driven selection flow, THEN drive real mouse
  // events on the page — captureSelectedArea's promise won't resolve until
  // the content script's overlay sees a mouseup, so these must run
  // concurrently, not sequentially.
  const resultPromise = serviceWorker.evaluate(
    async ({ tabId, windowId }) => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureSelectedArea(tabId, windowId);
    },
    tabInfo,
  );

  // Band 5 spans CSS y=[500,600) with color rgb(9,229,243) (see
  // ruler-3000.html's formula); select well clear of its text label.
  await page.waitForTimeout(200); // let the overlay actually attach
  await page.mouse.move(10, 540);
  await page.mouse.down();
  await page.mouse.move(110, 580, { steps: 5 });
  await page.mouse.up();
  // The drag alone only lands in the "adjusting" phase now (a resizable/
  // movable box, not an immediate finalize) — Enter is what actually
  // confirms it. See the new adjust/reselect test below for that phase
  // itself.
  await page.keyboard.press("Enter");

  const result = await resultPromise;
  expect(result).not.toBeNull();
  expect(result.report.output_width_px).toBe(100);
  expect(result.report.output_height_px).toBe(40);

  const dir = mkdtempSync(join(tmpdir(), "opencapture-e2e-"));
  const pngPath = writeBase64Png(dir, "selection.png", result.imagesBase64[0]);

  const info = JSON.parse(shotQa(["png-info", pngPath]).stdout);
  expect(info.width).toBe(100);
  expect(info.height).toBe(40);

  const sample = JSON.parse(shotQa(["band-sample", pngPath, "--bands", "1", "--band-height", "1", "--x", "50", "--y-offset", "20"]).stdout)[0];
  expect(sample).toMatchObject({ r: 9, g: 229, b: 243 });

  await page.close();
});

test("selected-area capture: dragging a resize handle after the initial drag changes the final crop", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab found for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  const resultPromise = serviceWorker.evaluate(
    async ({ tabId, windowId }) => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureSelectedArea(tabId, windowId);
    },
    tabInfo,
  );

  await page.waitForTimeout(200);
  // Rough initial drag: (10,540) to (110,580) — a deliberately imprecise
  // first pass, 100x40.
  await page.mouse.move(10, 540);
  await page.mouse.down();
  await page.mouse.move(110, 580, { steps: 5 });
  await page.mouse.up();

  // Now drag the SE resize handle, whose visible circle is centered right
  // on the box's bottom-right corner (110,580), out to (150,620) —
  // enlarging the box by 40px each direction instead of redrawing it.
  await page.mouse.move(110, 580);
  await page.mouse.down();
  await page.mouse.move(150, 620, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("Enter");

  const result = await resultPromise;
  expect(result).not.toBeNull();
  // 10..150 wide (140), 540..620 tall (80) — the resized box, not the
  // original 100x40 rough drag.
  expect(result.report.output_width_px).toBe(140);
  expect(result.report.output_height_px).toBe(80);

  await page.close();
});

test("selected-area capture: Esc after a drag clears the selection to reselect, not a full cancel", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab found for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  const resultPromise = serviceWorker.evaluate(
    async ({ tabId, windowId }) => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureSelectedArea(tabId, windowId);
    },
    tabInfo,
  );

  await page.waitForTimeout(200);
  // First pass — deliberately wrong, then abandoned via Esc.
  await page.mouse.move(10, 10);
  await page.mouse.down();
  await page.mouse.move(60, 60, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("Escape");

  // If Esc had fully cancelled (the old, pre-adjust-phase behavior), the
  // promise would already be resolved to null here and this second drag
  // would race a content script that's already torn itself down. Band 5
  // again (CSS y=[500,600), rgb(9,229,243)), same as the first test.
  await page.mouse.move(10, 540);
  await page.mouse.down();
  await page.mouse.move(110, 580, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("Enter");

  const result = await resultPromise;
  expect(result).not.toBeNull();
  expect(result.report.output_width_px).toBe(100);
  expect(result.report.output_height_px).toBe(40);

  await page.close();
});

test("selected-area capture returns null when the user cancels", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab found for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  const resultPromise = serviceWorker.evaluate(
    async ({ tabId, windowId }) => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureSelectedArea(tabId, windowId);
    },
    tabInfo,
  );

  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");

  const result = await resultPromise;
  expect(result).toBeNull();

  await page.close();
});

test("annotation editor: rectangle draws, blur pixelates, undo reverts", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  // ruler-3000's band colors follow an exact known formula with no
  // surrounding page chrome (headers/margins) to reason about, unlike
  // sticky-fixed.html — keeps the blur assertions below independent of any
  // CSS layout assumption.
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);

  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.openEditor();
    }),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    // canvas.width > 0 alone is satisfied by the browser's default
    // un-initialized canvas size (300x150) even before loadImage() runs --
    // wait for dimensions that actually differ from that default pair.
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  function readPixel(x: number, y: number) {
    return editorPage.evaluate(
      ({ px, py }) => {
        const canvas = document.getElementById("canvas") as HTMLCanvasElement;
        const ctx = canvas.getContext("2d")!;
        return Array.from(ctx.getImageData(px, py, 1, 1).data);
      },
      { px: x, py: y },
    );
  }

  // The canvas sits inside a padded, toolbar-offset wrapper — mouse
  // coordinates are page-viewport-relative, but readPixel/getImageData are
  // canvas-local, so every drag must be translated through the canvas's
  // actual bounding box rather than assumed to start at the page origin.
  const canvasBox = await editorPage.locator("#canvas").boundingBox();
  if (!canvasBox) throw new Error("canvas has no bounding box — did it fail to load the image?");
  function canvasToPage(localX: number, localY: number) {
    return { x: canvasBox!.x + localX, y: canvasBox!.y + localY };
  }

  const beforeRect = await readPixel(100, 60);

  await editorPage.click("#toolRect");
  const start = canvasToPage(60, 60);
  const end = canvasToPage(160, 160);
  await editorPage.mouse.move(start.x, start.y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(end.x, end.y, { steps: 5 });
  await editorPage.mouse.up();

  // Releasing the drag must NOT touch the real canvas either — the shape
  // stays "pending" (movable/resizable via Select, see the dedicated test
  // for that) until committed. Confirm that here before committing via
  // Enter, the same way pendingCrop already works.
  expect(await readPixel(100, 60)).toEqual(beforeRect);
  await editorPage.keyboard.press("Enter");

  // The rectangle's stroke sits at its edges, not its center — sample
  // exactly on the top edge's centerline (y=60, the strokeRect path
  // itself) rather than one pixel off it, which lands in the antialiased
  // fade rather than the solid stroke.
  const onStroke = await readPixel(100, 60);
  expect(onStroke[0]).toBeGreaterThan(200); // red channel dominant
  expect(onStroke[1]).toBeLessThan(100);

  await editorPage.click("#undo");
  const afterUndo = await readPixel(100, 60);
  expect(afterUndo).toEqual(beforeRect);

  // Blur: drag a region spanning the band2/band3 boundary at CSS y=300
  // (band2 rgb(106,194,46) above, band3 rgb(159,35,197) below). Sample one
  // pixel on each side of that exact boundary (y=299/y=300) — deep inside
  // a uniformly-colored band, pixelating is legitimately a no-op (a
  // uniform region's block average equals its own color), so the only
  // sample pair that *must* change is one that straddles a real color
  // transition. With blockSize computed as
  // max(6, round(min(width,height)/12)) for this fixed 190×160 drag
  // region, that's 13 — both y=299 and y=300 fall inside the same
  // boundary-straddling mosaic block (canvas-local rows 298–310), so they
  // must end up equal after blur despite starting from different colors.
  const p1Before = await readPixel(30, 299);
  const p2Before = await readPixel(30, 300);
  expect(p1Before).not.toEqual(p2Before); // sanity: they really did straddle a boundary

  await editorPage.click("#toolBlur");
  const blurStart = canvasToPage(10, 220);
  const blurEnd = canvasToPage(200, 380);
  await editorPage.mouse.move(blurStart.x, blurStart.y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(blurEnd.x, blurEnd.y, { steps: 5 });
  await editorPage.mouse.up();
  // Same pending/commit split as rect above — nothing pixelated yet.
  expect(await readPixel(30, 299)).toEqual(p1Before);
  await editorPage.keyboard.press("Enter");

  const p1After = await readPixel(30, 299);
  const p2After = await readPixel(30, 300);
  expect(p1After).toEqual(p2After); // same mosaic block -> mixed, identical color now
  expect(p1After).not.toEqual(p1Before); // and it's a real mix, not coincidentally unchanged

  function canvasSize() {
    return editorPage.evaluate(() => {
      const c = document.getElementById("canvas") as HTMLCanvasElement;
      return { width: c.width, height: c.height };
    });
  }

  // --- crop tool: canvas must resize to exactly the dragged rect, and the
  // resulting pixels must be the source region's own content. Band 4 (CSS
  // y=400..500) is untouched by the rect/undo/blur steps above, so its
  // color is still the exact ruler formula — a clean region to crop.
  const beforeCrop = await canvasSize();
  expect(beforeCrop).toEqual({ width: 800, height: 600 });

  const band4 = [(4 * 53) % 256, (4 * 97) % 256, (4 * 151) % 256]; // readPixel returns [r,g,b,a]

  await editorPage.click("#toolCrop");
  const cropStart = canvasToPage(300, 400);
  const cropEnd = canvasToPage(400, 450);
  await editorPage.mouse.move(cropStart.x, cropStart.y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(cropEnd.x, cropEnd.y, { steps: 5 });
  await editorPage.mouse.up();

  // Releasing the drag must NOT commit the crop — it enters an adjustable
  // state instead (Apply/Cancel Crop appear, canvas is untouched).
  expect(await canvasSize()).toEqual({ width: 800, height: 600 });
  await expect(editorPage.locator("#cropApply")).toBeVisible();
  await expect(editorPage.locator("#cropCancel")).toBeVisible();

  // Adjust the marquee before committing: drag its bottom-right (se)
  // handle — sitting exactly at the just-drawn (400,450) corner — out to
  // (500,500), growing the pending selection from 100x50 to 200x100.
  const seHandle = canvasToPage(400, 450);
  const resizedCorner = canvasToPage(500, 500);
  await editorPage.mouse.move(seHandle.x, seHandle.y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(resizedCorner.x, resizedCorner.y, { steps: 5 });
  await editorPage.mouse.up();
  expect(await canvasSize()).toEqual({ width: 800, height: 600 }); // still not committed

  await editorPage.click("#cropApply");
  const afterCrop = await canvasSize();
  expect(afterCrop).toEqual({ width: 200, height: 100 }); // the *adjusted* rect, not the original 100x50 draw
  expect((await readPixel(0, 0)).slice(0, 3)).toEqual(band4);
  expect((await readPixel(199, 99)).slice(0, 3)).toEqual(band4);
  await expect(editorPage.locator("#cropApply")).toBeHidden();

  // Undo must restore the original canvas *dimensions*, not just clip the
  // pre-crop pixels into the still-cropped-size canvas (the bug the
  // width/height-carrying Snapshot type exists to prevent).
  await editorPage.click("#undo");
  const afterCropUndo = await canvasSize();
  expect(afterCropUndo).toEqual({ width: 800, height: 600 });
  expect((await readPixel(350, 420)).slice(0, 3)).toEqual(band4); // same point, pre-crop coordinate space

  // --- format choice: both PNG and PDF must be real downloadable files.
  const [pngDownload] = await Promise.all([context.waitForEvent("download"), editorPage.click("#downloadPng")]);
  const pngPath = await pngDownload.path();
  if (!pngPath) throw new Error("PNG download produced no local path");
  const pngMagic = readFileSync(pngPath).subarray(0, 8);
  expect(Array.from(pngMagic)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const [pdfDownload] = await Promise.all([context.waitForEvent("download"), editorPage.click("#downloadPdf")]);
  const pdfPath = await pdfDownload.path();
  if (!pdfPath) throw new Error("PDF download produced no local path");
  expect(readFileSync(pdfPath).subarray(0, 5).toString("utf8")).toBe("%PDF-");
  const pdfInfo = JSON.parse(shotQa(["pdf-info", pdfPath]).stdout);
  expect(pdfInfo.pageCount).toBe(1);

  await editorPage.close();
  await page.close();
});

test("drag tools (arrow/rect/blur) don't touch canvas pixel data mid-drag, only at commit", async ({ context, serviceWorker }) => {
  // The actual bug this guards against: the old implementation restored a
  // full-canvas getImageData/putImageData snapshot on *every* mousemove
  // during a drag — for a large capture that's a lot of pixel-copy work
  // happening dozens of times a second, which is what made dragging
  // (blur especially, since users drag it slowly and deliberately) very
  // laggy. The fix moved live previews to a separate overlay canvas, so
  // the real canvas should see getImageData called exactly zero times
  // during the drag, and pixel reads only at the actual commit. This is a
  // deterministic call-count check instead of a timing measurement,
  // which would be flaky and environment-dependent.
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab found for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());
  await serviceWorker.evaluate(async ({ tabId, windowId }) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureFullPage(tabId, windowId);
  }, tabInfo);

  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.openEditor();
    }),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  await editorPage.evaluate(() => {
    (window as unknown as { __getImageDataCalls: number }).__getImageDataCalls = 0;
    const proto = CanvasRenderingContext2D.prototype;
    const original = proto.getImageData;
    proto.getImageData = function (this: CanvasRenderingContext2D, ...args: Parameters<typeof original>) {
      (window as unknown as { __getImageDataCalls: number }).__getImageDataCalls++;
      return original.apply(this, args);
    };
  });

  await editorPage.click("#toolBlur");
  const canvasBox = await editorPage.locator("#canvas").boundingBox();
  if (!canvasBox) throw new Error("canvas has no bounding box");

  const start = { x: canvasBox.x + 20, y: canvasBox.y + 20 };
  const end = { x: canvasBox.x + 200, y: canvasBox.y + 200 };
  await editorPage.mouse.move(start.x, start.y);
  await editorPage.mouse.down();

  const callsAtDragStart = await editorPage.evaluate(
    () => (window as unknown as { __getImageDataCalls: number }).__getImageDataCalls,
  );

  // Many intermediate steps — a slow, deliberate drag, exactly what was
  // reported as laggy — checking the call count never grows, not just
  // that it matches at the two endpoints.
  for (let i = 1; i <= 20; i++) {
    const t = i / 20;
    await editorPage.mouse.move(start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t);
  }

  const callsBeforeMouseUp = await editorPage.evaluate(
    () => (window as unknown as { __getImageDataCalls: number }).__getImageDataCalls,
  );
  expect(callsBeforeMouseUp).toBe(callsAtDragStart);

  await editorPage.mouse.up();

  // Releasing the drag doesn't commit it either now — blur stays "pending"
  // (adjustable via Select) until explicitly committed, so it shouldn't
  // have touched real pixel data yet at this point either.
  const callsAfterMouseUp = await editorPage.evaluate(
    () => (window as unknown as { __getImageDataCalls: number }).__getImageDataCalls,
  );
  expect(callsAfterMouseUp).toBe(callsBeforeMouseUp);

  await editorPage.keyboard.press("Enter"); // commit the pending blur

  const callsAfterCommit = await editorPage.evaluate(
    () => (window as unknown as { __getImageDataCalls: number }).__getImageDataCalls,
  );
  expect(callsAfterCommit).toBeGreaterThan(callsAfterMouseUp);

  await editorPage.close();
  await page.close();
});

test("crop tool auto-scrolls the canvas wrapper while dragging near its edge", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab found for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());
  await serviceWorker.evaluate(async ({ tabId, windowId }) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureFullPage(tabId, windowId);
  }, tabInfo);

  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.openEditor();
    }),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    // canvas.width > 0 alone is satisfied by the browser's default
    // un-initialized canvas size (300x150) even before loadImage() runs --
    // wait for dimensions that actually differ from that default pair.
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  // ruler-3000 stitched at 800x600 viewport is 800x3000 — far taller than
  // #canvasWrap's visible area, so the wrapper starts scrolled to the top
  // with most of the image below the fold.
  const canvasHeight = await editorPage.evaluate(() => (document.getElementById("canvas") as HTMLCanvasElement).height);
  expect(canvasHeight).toBe(3000);

  const wrapBoxBefore = await editorPage.locator("#canvasWrap").boundingBox();
  const canvasBoxBefore = await editorPage.locator("#canvas").boundingBox();
  if (!wrapBoxBefore || !canvasBoxBefore) throw new Error("canvasWrap/canvas has no bounding box");
  const scrollTopBefore = await editorPage.evaluate(() => document.getElementById("canvasWrap")!.scrollTop);
  expect(scrollTopBefore).toBe(0);

  await editorPage.click("#toolCrop");
  // x from the canvas's own box, not the wrapper's — the canvas is
  // centered horizontally within #canvasWrap (see editor.html) whenever
  // it's narrower than the available width, so it doesn't necessarily
  // start at the wrapper's left edge.
  await editorPage.mouse.move(canvasBoxBefore.x + 40, wrapBoxBefore.y + 40);
  await editorPage.mouse.down();
  // Hold the cursor a couple pixels above the wrapper's bottom edge — well
  // inside the AUTO_SCROLL_EDGE zone — without further movement. The
  // auto-scroll loop is self-sustaining via requestAnimationFrame once
  // started, so it keeps scrolling on this stationary cursor without any
  // new mousemove events.
  await editorPage.mouse.move(canvasBoxBefore.x + 40, wrapBoxBefore.y + wrapBoxBefore.height - 5, { steps: 3 });
  await editorPage.waitForTimeout(600);

  const scrollTopDuring = await editorPage.evaluate(() => document.getElementById("canvasWrap")!.scrollTop);
  expect(scrollTopDuring).toBeGreaterThan(0);

  await editorPage.mouse.up();
  // Discard the resulting marquee — this test only cares about scroll
  // behavior, not the crop it incidentally drew.
  await editorPage.keyboard.press("Escape");

  await editorPage.close();
  await page.close();
});

test("editor canvas scales to fit the window and maps clicks correctly when scaled", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  // Wider than the editor tab's own window (a fresh tab defaults to the
  // browser window's real size, independent of whatever viewport this
  // capture used) — the point is to force the canvas to actually be
  // scaled down by editor.html's `max-width:100%`, not just render at its
  // unscaled native size like every other test in this suite does.
  await page.setViewportSize({ width: 2000, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);

  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.openEditor();
    }),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    // canvas.width > 0 alone is satisfied by the browser's default
    // un-initialized canvas size (300x150) even before loadImage() runs --
    // wait for dimensions that actually differ from that default pair.
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  const bufferWidth = await editorPage.evaluate(() => (document.getElementById("canvas") as HTMLCanvasElement).width);
  expect(bufferWidth).toBe(2000);

  const canvasBox = await editorPage.locator("#canvas").boundingBox();
  if (!canvasBox) throw new Error("canvas has no bounding box");
  // The actual regression this test guards: without CSS scaling (or with
  // scaling but broken coordinate math), canvasBox.width would equal
  // bufferWidth exactly (either genuinely unscaled, or visually scaled
  // but every click still computed against the raw unscaled buffer size).
  expect(canvasBox.width).toBeLessThan(bufferWidth);

  const scale = bufferWidth / canvasBox.width;
  function toScreen(bufferX: number, bufferY: number): { x: number; y: number } {
    return { x: canvasBox!.x + bufferX / scale, y: canvasBox!.y + bufferY / scale };
  }

  await editorPage.click("#toolRect");
  const start = toScreen(200, 60);
  const end = toScreen(1800, 160);
  await editorPage.mouse.move(start.x, start.y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(end.x, end.y, { steps: 5 });
  await editorPage.mouse.up();
  await editorPage.keyboard.press("Enter"); // commit the pending rect

  // strokeRect(200, 60, 1600, 100) — its top edge runs y=60, x=[200,1800].
  // Sampling near its horizontal midpoint in *buffer* space (not client
  // space) proves the drag was translated through the scale factor
  // correctly, not left at raw unscaled coordinates (which would miss the
  // stroke entirely at this buffer-space point once genuinely scaled
  // down). A small window rather than one exact pixel: mouse events are
  // integer CSS pixels, so the CSS-to-buffer scale factor (which depends
  // on the canvas's own rendered box, itself layout-dependent) rounds
  // slightly differently depending on chrome/toolbar geometry — the point
  // here is "landed near the intended edge", not sub-pixel exactness.
  const hasStrokeNearby = await editorPage.evaluate(() => {
    const canvas = document.getElementById("canvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const region = ctx.getImageData(990, 54, 20, 12).data;
    for (let i = 0; i < region.length; i += 4) {
      if (region[i]! > 200 && region[i + 1]! < 100) return true; // red stroke, dominant red channel
    }
    return false;
  });
  expect(hasStrokeNearby).toBe(true);

  await editorPage.close();
  await page.close();
});

test("previewCanvas's backing buffer tracks its own rendered size, not the full capture resolution", async ({
  context,
  serviceWorker,
}) => {
  // The actual bug this guards against: previewCanvas used to be sized to
  // `canvas`'s full native buffer resolution (tens of millions of pixels
  // for a real full-page capture), so even though its draws were cheap
  // shape primitives, the GPU still had to clear/composite that whole
  // buffer on every single mousemove — which is what made dragging still
  // "extremely laggy" even after the getImageData/putImageData stall
  // (measured elsewhere in this suite) was fixed. previewCanvas's buffer
  // should instead track its own on-screen CSS size, independent of how
  // large the underlying capture is.
  const page = await context.newPage();
  await page.setViewportSize({ width: 2000, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);

  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.openEditor();
    }),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  const sizes = await editorPage.evaluate(() => {
    const canvas = document.getElementById("canvas") as HTMLCanvasElement;
    const preview = document.getElementById("previewCanvas") as HTMLCanvasElement;
    return {
      canvasWidth: canvas.width,
      canvasClientWidth: canvas.clientWidth,
      previewWidth: preview.width,
      dpr: window.devicePixelRatio || 1,
    };
  });

  // The editor tab's own window is narrower than the 2000px-wide capture,
  // so canvas is genuinely scaled down (clientWidth < width) — confirms
  // this test actually exercises the scaled-down case, not a no-op.
  expect(sizes.canvasClientWidth).toBeLessThan(sizes.canvasWidth);
  // previewCanvas's buffer should sit tight against its own rendered CSS
  // width (× devicePixelRatio) — a couple of px of rounding tolerance, not
  // the generous margin a "just less than the full capture" check would
  // need, which would still pass even at the full multi-thousand-pixel
  // capture width and so wouldn't actually catch a regression back to it.
  expect(Math.abs(sizes.previewWidth - sizes.canvasClientWidth * sizes.dpr)).toBeLessThanOrEqual(2);

  await editorPage.close();
  await page.close();
});

test("text tool creates an editable text box at the clicked position, stays adjustable until committed", async ({
  context,
  serviceWorker,
}) => {
  // Two real, previously-broken failure modes this guards against: (1)
  // the input was silently placed thousands of pixels away from the
  // click — a canvas-buffer-space vs. CSS-space coordinate mixup, which
  // made the text tool look like it did nothing at all rather than "did
  // something invisible"; (2) even once positioned correctly, the input
  // lost focus and removed itself in the same tick it was created —
  // `canvas` isn't a focusable element, so the browser's own default
  // mousedown handling blurs whatever was just focus()'d unless that
  // default is explicitly suppressed.
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);

  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.openEditor();
    }),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  const canvasBox = await editorPage.locator("#canvas").boundingBox();
  if (!canvasBox) throw new Error("canvas has no bounding box");
  const clickX = canvasBox.x + 200;
  const clickY = canvasBox.y + 150;

  await editorPage.click("#toolText");
  await editorPage.mouse.click(clickX, clickY);

  // Scoped to #canvasStack, not just input[type="text"]: that also matches
  // the watermark tool's own (persistent, normally-hidden) text field —
  // see editor.ts's startTextInput(), which appends this one to
  // canvas.parentElement (#canvasStack) specifically.
  const inputBox = await editorPage.locator('#canvasStack input[type="text"]').boundingBox();
  if (!inputBox) throw new Error("text tool did not create an <input> at all");
  expect(Math.abs(inputBox.x - clickX)).toBeLessThan(20);
  expect(Math.abs(inputBox.y - clickY)).toBeLessThan(20);

  await editorPage.keyboard.type("hello");
  await editorPage.keyboard.press("Enter");
  await expect(editorPage.locator('#canvasStack input[type="text"]')).toHaveCount(0);

  const bufferPoint = await editorPage.evaluate(
    ({ x, y }) => {
      const canvas = document.getElementById("canvas") as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const scale = canvas.width / rect.width;
      return { x: Math.round((x - rect.left) * scale), y: Math.round((y - rect.top) * scale) };
    },
    { x: clickX, y: clickY },
  );

  function hasGlyphInkNear(point: { x: number; y: number }) {
    return editorPage.evaluate(({ x, y }) => {
      const canvas = document.getElementById("canvas") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      const region = ctx.getImageData(Math.max(0, x - 10), Math.max(0, y - 5), 70, 25).data;
      for (let i = 0; i < region.length; i += 4) {
        if (region[i]! > 200 && region[i + 1]! < 100) return true; // red-dominant, anti-alias-free glyph ink
      }
      return false;
    }, point);
  }

  // Committing the typed text (Enter) only turns it into a *pending*
  // shape — selectable/movable/resizable, not yet baked — exactly like a
  // freshly-drawn rect/arrow/blur. The real canvas shouldn't show it yet.
  expect(await hasGlyphInkNear(bufferPoint)).toBe(false);

  // Switching to a *different* tool commits it for real — switching to
  // Select specifically would not (that's the one tool meant to keep it
  // pending for further adjustment; see the dedicated select-tool test).
  await editorPage.click("#toolCrop");
  expect(await hasGlyphInkNear(bufferPoint)).toBe(true);

  await editorPage.close();
  await page.close();
});

test("double-clicking a pending text shape re-opens it for editing, pre-filled with its current text", async ({
  context,
  serviceWorker,
}) => {
  // Touch has no dblclick — editor.ts now detects this itself (see
  // src/editor/double-tap.ts) from two quick pointerdown events instead of
  // relying on the browser's native dblclick event. Chromium's mouse
  // automation dispatches real PointerEvents under the hood, so
  // page.mouse.dblclick() below exercises that same detection path,
  // proving the touch-oriented rewrite didn't regress the desktop mouse
  // case it replaced.
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);

  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.openEditor();
    }),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  const canvasBox = await editorPage.locator("#canvas").boundingBox();
  if (!canvasBox) throw new Error("canvas has no bounding box");
  const clickX = canvasBox.x + 200;
  const clickY = canvasBox.y + 150;

  await editorPage.click("#toolText");
  await editorPage.mouse.click(clickX, clickY);
  await editorPage.keyboard.type("hello");
  await editorPage.keyboard.press("Enter");
  await expect(editorPage.locator('#canvasStack input[type="text"]')).toHaveCount(0);

  // Still "pending" (not committed — no tool switch happened), same as the
  // sibling text-tool test above. Double-click it to re-open for editing.
  await editorPage.mouse.dblclick(clickX, clickY);

  const reopenedInput = editorPage.locator('#canvasStack input[type="text"]');
  await expect(reopenedInput).toHaveCount(1);
  await expect(reopenedInput).toHaveValue("hello");

  await editorPage.close();
  await page.close();
});

test("select tool moves and resizes a pending shape before it's committed", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);

  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.openEditor();
    }),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  function readPixel(x: number, y: number) {
    return editorPage.evaluate(
      ({ px, py }) => {
        const canvas = document.getElementById("canvas") as HTMLCanvasElement;
        const ctx = canvas.getContext("2d")!;
        return Array.from(ctx.getImageData(px, py, 1, 1).data);
      },
      { px: x, py: y },
    );
  }
  function isRedStroke(pixel: number[]) {
    return pixel[0]! > 200 && pixel[1]! < 100;
  }

  const canvasBox = await editorPage.locator("#canvas").boundingBox();
  if (!canvasBox) throw new Error("canvas has no bounding box");
  function canvasToPage(localX: number, localY: number) {
    return { x: canvasBox!.x + localX, y: canvasBox!.y + localY };
  }

  // Draw a rect from (60,60) to (160,160) — its top edge sits at y=60 —
  // then, with the Select tool, drag its body down by 100px before ever
  // committing it.
  await editorPage.click("#toolRect");
  const start = canvasToPage(60, 60);
  const end = canvasToPage(160, 160);
  await editorPage.mouse.move(start.x, start.y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(end.x, end.y, { steps: 5 });
  await editorPage.mouse.up();

  await editorPage.click("#toolSelect");
  const bodyPoint = canvasToPage(100, 100); // inside the pending rect, not on a handle
  const moveTo = canvasToPage(100, 200);
  await editorPage.mouse.move(bodyPoint.x, bodyPoint.y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(moveTo.x, moveTo.y, { steps: 5 });
  await editorPage.mouse.up();
  await editorPage.keyboard.press("Enter"); // commit

  // Only the *moved* position was ever baked — the rect was never
  // committed at its original spot, since it moved before any commit.
  expect(isRedStroke(await readPixel(100, 60))).toBe(false);
  expect(isRedStroke(await readPixel(100, 160))).toBe(true);

  await editorPage.click("#undo"); // back to a blank canvas for the resize check below

  // Draw a second, small rect, then resize it via its se handle.
  await editorPage.click("#toolRect");
  const start2 = canvasToPage(300, 300);
  const end2 = canvasToPage(340, 340);
  await editorPage.mouse.move(start2.x, start2.y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(end2.x, end2.y, { steps: 5 });
  await editorPage.mouse.up();

  await editorPage.click("#toolSelect");
  const seHandle = canvasToPage(340, 340); // the rect's own se corner
  const resizedCorner = canvasToPage(500, 500);
  await editorPage.mouse.move(seHandle.x, seHandle.y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(resizedCorner.x, resizedCorner.y, { steps: 5 });
  await editorPage.mouse.up();
  await editorPage.keyboard.press("Enter"); // commit

  // The resized rect's right edge now runs through x=500 (y in [300,500]) —
  // well outside the original 40×40 box.
  expect(isRedStroke(await readPixel(500, 420))).toBe(true);

  await editorPage.close();
  await page.close();
});

test("capturing opens the editor instead of downloading immediately", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id || tab.windowId === undefined) throw new Error(`no tab found for ${url}`);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  }, page.url());

  // Drives handleRequest({action:"captureVisible"}) — the exact function
  // the real chrome.runtime.onMessage listener calls for a "Capture
  // Visible Area" click — instead of the other __test.* hooks (which call
  // orchestrator functions directly, bypassing handleRequest's download-
  // vs-open-editor branch entirely). Doesn't go through a second tab
  // standing in for popup.html: opening one as a real Playwright page and
  // clicking it — even synthetically — reactivates that tab in Chrome and
  // steals activeTab's target away from the page being captured, which a
  // real toolbar popup (not a tab at all) never does.
  const [editorPage, response] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureVisibleViaHandleRequest();
    }),
  ]);

  expect(response.ok).toBe(true);
  expect(response.openedEditor).toBe(true);

  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    // canvas.width > 0 alone is satisfied by the browser's default
    // un-initialized canvas size (300x150) even before loadImage() runs --
    // wait for dimensions that actually differ from that default pair.
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  const canvasSize = await editorPage.evaluate(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return { width: c.width, height: c.height };
  });
  expect(canvasSize).toEqual({ width: 800, height: 600 });

  await editorPage.close();
  await page.close();
});

test("the popup's last-capture state is written even when no popup exists to write it", async ({ context, serviceWorker, extensionId }) => {
  // The actual bug this proves fixed: opening the editor tab (as every real
  // capture does) activates that tab, which tears down a real toolbar
  // popup before its response handler can run — so persisting "what was
  // captured" from the popup's own response, awaited or not, is a race the
  // popup always loses. This test drives the exact same handleRequest()
  // path a real capture uses, with zero popup page open at any point
  // (matching the real MV3 popup, which isn't a tab at all — see the
  // previous test's own comment on why a stand-in tab is wrong here too),
  // then checks storage directly before ever creating one. If this were
  // still written from the popup's response handler instead of
  // background/index.ts, this assertion would fail every time.
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id || tab.windowId === undefined) throw new Error(`no tab found for ${url}`);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  }, page.url());

  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureVisibleViaHandleRequest();
    }),
  ]);
  await editorPage.waitForLoadState();

  const persisted = await serviceWorker.evaluate(async () => {
    const stored = await chrome.storage.local.get("lastCaptureUi");
    return stored.lastCaptureUi;
  });
  expect(persisted?.openedEditor).toBe(true);
  expect(persisted?.report?.output_width_px).toBeGreaterThan(0);

  // Now confirm a *freshly opened* popup — the only kind that ever really
  // exists, per MV3 — restores correctly from exactly that state.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator("#report")).toBeVisible();
  await expect(popup.locator("#preview")).toBeVisible();
  await expect(popup.locator("#status")).toHaveText("Opened in editor — crop, annotate, then choose PNG or PDF to save.");
  await popup.close();

  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.remove("lastCaptureUi");
  });
  await editorPage.close();
  await page.close();
});

test("history: a real capture appears in history.html, opens back in the editor, and can be deleted", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id || tab.windowId === undefined) throw new Error(`no tab found for ${url}`);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  }, page.url());

  const [firstEditorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureVisibleViaHandleRequest();
    }),
  ]);
  await firstEditorPage.waitForLoadState();
  await firstEditorPage.close();

  const history = await context.newPage();
  await history.goto(`chrome-extension://${extensionId}/history.html`);

  const tile = history.locator(".history-tile").first();
  await expect(tile).toBeVisible();
  await expect(history.locator(".history-tile")).toHaveCount(1);
  await expect(tile.locator(".history-tile-sub")).toContainText("800×600");
  await expect(history.locator("#clearHistory")).toBeVisible();
  await expect(history.locator("#historyEmpty")).toBeHidden();

  // Reopening a history entry goes through the exact same
  // openEditorWithBytes() a fresh capture uses — a new editor tab, not a
  // navigation of this one.
  const [reopenedEditorPage] = await Promise.all([context.waitForEvent("page"), tile.locator(".history-tile-open").click()]);
  await reopenedEditorPage.waitForLoadState();
  await reopenedEditorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });
  const canvasSize = await reopenedEditorPage.evaluate(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return { width: c.width, height: c.height };
  });
  expect(canvasSize).toEqual({ width: 800, height: 600 });
  await reopenedEditorPage.close();

  await tile.locator(".history-tile-delete").click();
  await expect(history.locator(".history-tile")).toHaveCount(0);
  await expect(history.locator("#historyEmpty")).toBeVisible();
  await expect(history.locator("#clearHistory")).toBeHidden();

  await history.close();
  await page.close();
});

test("save-location preferences (filename) apply to downloads", async ({ context, serviceWorker, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  // popup.ts's async loadSavePrefs() sets the field's value (and
  // placeholder) once chrome.storage.local resolves — wait for it,
  // otherwise it can race a fill() below and clobber it back to empty.
  await popup.waitForFunction(() => (document.getElementById("prefFilename") as HTMLInputElement).placeholder === "opencapture");
  // The save fields live behind a disclosure now — the popup opens with just
  // a one-line summary so the capture buttons are not pushed down the panel.
  await popup.click("#saveSummary");
  await popup.fill("#prefFilename", "e2e-custom");
  // The popup only persists on "change", not every keystroke (see
  // popup.ts) — dispatch it explicitly rather than relying on a real blur.
  await popup.locator("#prefFilename").dispatchEvent("change");
  await popup.close();

  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);
  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);

  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.openEditor();
    }),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    // canvas.width > 0 alone is satisfied by the browser's default
    // un-initialized canvas size (300x150) even before loadImage() runs --
    // wait for dimensions that actually differ from that default pair.
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  // Playwright's persistent context intercepts real downloads at the CDP
  // level and redirects them into its own artifacts directory for test
  // hermeticity — chrome.downloads.search()'s own `filename` record ends
  // up reflecting *that* redirected path, not what the extension actually
  // requested, so it can't verify our code produced the right path. What
  // we actually want to verify is that our code called
  // chrome.downloads.download() with the right `filename` argument in the
  // first place — so stub that call out entirely (no real download needs
  // to happen for this test) and inspect what it was invoked with.
  await editorPage.evaluate(() => {
    (window as unknown as { __downloadCalls: chrome.downloads.DownloadOptions[] }).__downloadCalls = [];
    chrome.downloads.download = ((opts: chrome.downloads.DownloadOptions) => {
      (window as unknown as { __downloadCalls: chrome.downloads.DownloadOptions[] }).__downloadCalls.push(opts);
      return Promise.resolve(999);
    }) as typeof chrome.downloads.download;
  });

  await editorPage.click("#downloadPng");
  await editorPage.waitForFunction(
    () => (window as unknown as { __downloadCalls: unknown[] }).__downloadCalls.length > 0,
  );
  const calls = await editorPage.evaluate(
    () => (window as unknown as { __downloadCalls: chrome.downloads.DownloadOptions[] }).__downloadCalls,
  );
  expect(calls[0]!.filename).toBe("e2e-custom-annotated.png");

  // Reset for any other test that happens to run in this same worker
  // session afterward.
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.remove("savePrefs");
  });

  await editorPage.close();
  await page.close();
});

// Headless Chromium has no real OS folder dialog to show, so
// showDirectoryPicker() can't actually be driven end-to-end here the way
// everything else in this suite is — Chromium auto-rejects it with an
// AbortError instead (the same rejection a real user cancelling the dialog
// produces), which pick-directory.ts already treats as a silent no-op.
// This test covers what *is* verifiable headlessly: clicking Browse
// directly in the popup (no separate tab — see pick-directory.ts) doesn't
// crash the popup or leave a stale handle behind. Whether a *real*,
// toolbar-anchored popup survives long enough for the OS dialog to
// actually resolve is a real open question Playwright can't answer here
// (it can't simulate opening one at all) — needs manual verification in a
// real Chrome window, see PLAN.md.
test("\"Ask where to save\" reaches downloads.download as saveAs", async ({ context, serviceWorker, extensionId }) => {
  // The only location control Firefox users have: the folder picker beside it
  // is the File System Access API, which Firefox does not implement, so this
  // option is the whole feature there. Worth asserting it actually arrives at
  // the download call rather than just persisting in storage.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForFunction(() => (document.getElementById("prefFilename") as HTMLInputElement).placeholder === "opencapture");
  // The save fields live behind a disclosure now — the popup opens with just
  // a one-line summary so the capture buttons are not pushed down the panel.
  await popup.click("#saveSummary");
  await popup.check("#prefAskWhere");
  await popup.locator("#prefAskWhere").dispatchEvent("change");
  await popup.close();

  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);
  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);

  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.openEditor();
    }),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  // Same reason as the filename test: Playwright redirects real downloads, so
  // inspect the arguments rather than the resulting file.
  await editorPage.evaluate(() => {
    (window as unknown as { __downloadCalls: chrome.downloads.DownloadOptions[] }).__downloadCalls = [];
    chrome.downloads.download = ((opts: chrome.downloads.DownloadOptions) => {
      (window as unknown as { __downloadCalls: chrome.downloads.DownloadOptions[] }).__downloadCalls.push(opts);
      return Promise.resolve(999);
    }) as typeof chrome.downloads.download;
  });

  await editorPage.click("#downloadPng");
  await editorPage.waitForFunction(
    () => (window as unknown as { __downloadCalls: chrome.downloads.DownloadOptions[] }).__downloadCalls.length > 0,
  );
  const withAsk = await editorPage.evaluate(
    () => (window as unknown as { __downloadCalls: chrome.downloads.DownloadOptions[] }).__downloadCalls[0] ?? null,
  );
  expect(withAsk?.saveAs).toBe(true);

  // And that it is genuinely driven by the pref, not hardcoded the other way.
  await editorPage.evaluate(() => {
    (window as unknown as { __downloadCalls: chrome.downloads.DownloadOptions[] }).__downloadCalls = [];
    (document.getElementById("editorPrefAskWhere") as HTMLInputElement).checked = false;
    document.getElementById("editorPrefAskWhere")!.dispatchEvent(new Event("change"));
  });
  await editorPage.click("#downloadPng");
  await editorPage.waitForFunction(
    () => (window as unknown as { __downloadCalls: chrome.downloads.DownloadOptions[] }).__downloadCalls.length > 0,
  );
  const withoutAsk = await editorPage.evaluate(
    () => (window as unknown as { __downloadCalls: chrome.downloads.DownloadOptions[] }).__downloadCalls[0] ?? null,
  );
  expect(withoutAsk?.saveAs).toBe(false);

  await editorPage.close();
  await page.close();
});

test("popup: clicking Browse doesn't crash or persist a handle when the picker can't be shown", async ({ context, extensionId }) => {
  const popup = await context.newPage();
  const pageErrors: Error[] = [];
  popup.on("pageerror", (err) => pageErrors.push(err));
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  // Browse lives behind the save disclosure now.
  await popup.click("#saveSummary");
  await expect(popup.locator("#customFolderName")).toHaveText("Your Downloads folder (default)");
  await popup.click("#browseFolder");
  await popup.waitForTimeout(1000);

  expect(pageErrors).toEqual([]);
  await expect(popup.locator("#customFolderName")).toHaveText("Your Downloads folder (default)");

  await popup.close();
});

test("copy to clipboard: popup writes directly, without a background/offscreen round-trip", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  // M9/M11 history: this used to route through background -> an offscreen
  // document -> navigator.clipboard.write(). That could never work at all —
  // offscreen documents are invisible and never become the focused
  // document that API (and its execCommand fallback's transient-
  // activation requirement) needs, confirmed in real Chrome, not just this
  // headless harness. The real fix was architectural: do the write in the
  // popup itself, the one document that actually receives the real click.
  // See chrome/copy-image.ts.
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  // The capture above went through the __test hook directly (orchestrator
  // functions, not handleRequest — see other tests' comments on why),
  // so popup.ts never saw a capture response and never enabled its
  // buttons accordingly. That wiring is covered elsewhere; force the
  // button open here so this test is only about the clipboard write
  // itself, reading LAST_CAPTURE_BLOB_KEY (which the capture above did
  // populate, via orchestrator.ts's rememberLastCapture()).
  await popup.evaluate(() => {
    (document.getElementById("copyToClipboard") as HTMLButtonElement).disabled = false;
  });

  // A real Playwright .click() dispatches trusted input, and popup.html —
  // opened as a real tab here, unlike an offscreen document — genuinely
  // can hold document focus, so this is close enough to real usage that a
  // real navigator.clipboard.write() success is plausible, not just its
  // execCommand fallback's own distinct failure (which is what every
  // previous fully-synthetic attempt at testing this could ever reach).
  await popup.click("#copyToClipboard");
  await popup.waitForFunction(() => {
    const s = document.getElementById("status")?.textContent ?? "";
    return s.length > 0 && s !== "Copying to clipboard…";
  });
  const status = await popup.locator("#status").textContent();

  // This genuinely succeeds now — not just "doesn't hit the old errors"
  // like every previous attempt at testing this had to settle for.
  expect(status).toBe("Copied to clipboard.");

  await popup.close();
  await page.close();
});

test("editor: save-settings panel shows the default folder and persists a filename", async ({ context, extensionId }) => {
  // Opened directly, no prior capture — editor.ts's loadImage() handles a
  // null image gracefully (shows a status message, doesn't throw), and
  // this test is only about the toolbar chrome, not a loaded capture.
  const editor = await context.newPage();
  await editor.goto(`chrome-extension://${extensionId}/editor.html`);

  await expect(editor.locator("#saveSettingsLabel")).toHaveText("Downloads");
  await expect(editor.locator("#saveSettingsPanel")).toBeHidden();

  await editor.click("#saveSettingsBtn");
  await expect(editor.locator("#saveSettingsPanel")).toBeVisible();
  await expect(editor.locator("#editorCustomFolderName")).toHaveText("Your Downloads folder (default)");

  await editor.fill("#editorPrefFilename", "my-custom-name");
  await editor.locator("#editorPrefFilename").dispatchEvent("change");

  // Persisted to the same storage popup.ts's own filename field reads —
  // reopening the editor (a fresh document, same as a real close+reopen)
  // proves it's actually durable, not just left in this input's own value.
  await editor.close();
  const editor2 = await context.newPage();
  await editor2.goto(`chrome-extension://${extensionId}/editor.html`);
  await expect(editor2.locator("#editorPrefFilename")).toHaveValue("my-custom-name");

  await editor2.click("#saveSettingsBtn");
  await expect(editor2.locator("#saveSettingsPanel")).toBeVisible();

  // Reset so no other test in this worker session sees the custom filename
  // — done here, panel still open, not after closing it (the field lives
  // inside the panel; a fill() against a hidden element just hangs).
  await editor2.fill("#editorPrefFilename", "");
  await editor2.locator("#editorPrefFilename").dispatchEvent("change");

  await editor2.click("#saveSettingsBtn");
  await expect(editor2.locator("#saveSettingsPanel")).toBeHidden();
  await editor2.close();
});

test("popup: restores report/preview/enabled buttons after closing and reopening", async ({ context, serviceWorker, extensionId }) => {
  // MV3 popups are fully destroyed and recreated on every close, so this
  // has to prove state survives an actual close+reopen, not just a single
  // popup instance's in-memory state. Driving the capture itself through a
  // real click on a *popup* page was already tried and abandoned earlier in
  // this project (M12) — it repeatedly crashed the whole browser context,
  // unrelated to the product code — so, like the clipboard test above,
  // this seeds the "as if a prior popup capture already ran" state
  // directly: a real capture (via the __test hook, which populates
  // LAST_CAPTURE_BLOB_KEY through the real orchestrator.rememberLastCapture
  // path) plus the small "lastCaptureUi" JSON exactly as popup.ts's own
  // persistLastCaptureUi would have written it. What this test actually
  // exercises — the part that was genuinely broken — is restoreLastCaptureUi
  // itself: does a brand-new popup document correctly rebuild its UI from
  // that persisted state.
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());
  const report = await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global, see background/index.ts
    const { report } = await globalThis.__test.captureVisibleOnly(winId);
    return report;
  }, windowId);

  await serviceWorker.evaluate(
    async ({ key, ui }) => {
      await chrome.storage.local.set({ [key]: ui });
    },
    { key: "lastCaptureUi", ui: { report, openedEditor: true } },
  );

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  await expect(popup.locator("#report")).toBeVisible();
  await expect(popup.locator("#preview")).toBeVisible();
  const reportText = await popup.locator("#report").textContent();
  expect(JSON.parse(reportText ?? "")).toEqual(report);
  const previewSrc = await popup.locator("#preview").getAttribute("src");
  expect(previewSrc).toMatch(/^blob:/);
  await expect(popup.locator("#exportPdf")).toBeEnabled();
  await expect(popup.locator("#copyToClipboard")).toBeEnabled();
  await expect(popup.locator("#openEditor")).toBeEnabled();
  await expect(popup.locator("#status")).toHaveText("Opened in editor — crop, annotate, then choose PNG or PDF to save.");

  await popup.close();

  // Reset for any other test that happens to run in this same worker
  // session afterward.
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.remove("lastCaptureUi");
  });

  await page.close();
});

test("blob-store round-trips a payload larger than chrome.runtime.sendMessage's 64MiB cap", async ({ serviceWorker }) => {
  // Directly exercises the storage layer the clipboard/editor-handoff
  // fixes now depend on, at a size (80MiB) that would have failed outright
  // as a chrome.runtime.sendMessage payload — independent of whether any
  // given test capture happens to PNG-compress that large.
  const ok = await serviceWorker.evaluate(async () => {
    // @ts-expect-error test-only global, see background/index.ts
    return globalThis.__test.testLargeBlobRoundtrip(80 * 1024 * 1024);
  });
  expect(ok).toBe(true);
});

test("export-as-PDF and annotate survive the background service worker being evicted after a capture", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  // MV3 service workers suspend after ~30s idle and respawn with a
  // completely fresh JS realm on the next event — orchestrator.ts used to
  // keep the last capture's session/images/dpr in module-level `let`
  // variables, which is exactly the kind of state that doesn't survive
  // that respawn. M13's popup-persistence feature made this a real,
  // user-facing bug rather than a theoretical one: the popup can now show
  // "Export PDF"/"Annotate" as enabled for as long as the user likes after
  // a capture (its own state comes from chrome.storage.local + blob-store,
  // both durable), so clicking either after the service worker has
  // recycled has to actually work, not throw "No capture to export/copy
  // yet" against a session that's still technically valid from the user's
  // point of view. Reproduced here by forcibly closing the real service
  // worker's CDP target (not a timer) and confirming the request still
  // succeeds once Chrome lazily respawns it.
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);
  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);

  // A probe on the doomed worker's globalThis — read back afterward to
  // confirm the request below actually ran in a genuinely new JS realm,
  // not that closeTarget silently no-op'd and left the same one running.
  await serviceWorker.evaluate(() => {
    (globalThis as unknown as { __evictionProbe: number }).__evictionProbe = 42;
  });

  const cdp = await context.newCDPSession(page);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const swTarget = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("background.js"));
  if (!swTarget) throw new Error(`no service_worker target found; targets: ${JSON.stringify(targetInfos.map((t) => t.type))}`);
  await cdp.send("Target.closeTarget", { targetId: swTarget.targetId });

  // Closing the target alone doesn't respawn it — MV3 only spins a service
  // worker back up lazily, on the next event a live listener needs to
  // handle. A real chrome.runtime.sendMessage from an extension page (the
  // exact call popup.ts's own buttons make) is that event, so this both
  // triggers the respawn and exercises the real request path in one step —
  // not a __test hook standing in for it.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  const pdfResponse = await popup.evaluate(() => chrome.runtime.sendMessage({ action: "exportPdf" }));
  expect(pdfResponse.ok).toBe(true);

  const [freshWorker] = context.serviceWorkers();
  if (!freshWorker) throw new Error("expected a respawned service worker after the message above");
  const probeAfter = await freshWorker.evaluate(() => (globalThis as unknown as { __evictionProbe?: number }).__evictionProbe);
  expect(probeAfter).toBeUndefined();

  const editorResponse = await popup.evaluate(() => chrome.runtime.sendMessage({ action: "openEditor" }));
  expect(editorResponse.ok).toBe(true);

  await popup.close();
  await page.close();
});

test("watermark tool: tiled pattern respects location/orientation, remembers the chosen logo, undo reverts", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);

  // Bypass the Supporter gate: seed a fake signed-in session *before* the
  // editor page loads (its own openapps store only hydrates once, from
  // whatever chrome.storage.session holds at that first read — writing to
  // it after the page has already loaded would not be picked up), and mock
  // the entitlement check as already-unlocked. The gate itself has its own
  // dedicated tests below; this test is about the watermark panel's own
  // behavior once past it.
  await serviceWorker.evaluate(async () => {
    await chrome.storage.session.set({
      "openapps.session": { accessToken: "e2e-fake-token", refreshToken: "e2e-fake-refresh" },
    });
  });
  await context.route("https://auth.opencapture.app/v1/credits/entitlement*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ unlocked: true }) }),
  );

  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.openEditor();
    }),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  const canvasSize = await editorPage.evaluate(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return { width: c.width, height: c.height };
  });

  function sampleRegion(rect: { x: number; y: number; width: number; height: number }): Promise<number[]> {
    return editorPage.evaluate((r) => {
      const canvas = document.getElementById("canvas") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      return Array.from(ctx.getImageData(r.x, r.y, r.width, r.height).data);
    }, rect);
  }
  function regionsDiffer(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return true;
    return a.some((v, i) => v !== b[i]);
  }

  const fullRect = { x: 0, y: 0, width: canvasSize.width, height: canvasSize.height };
  // Mirrors editor.ts's watermarkCellSize()/watermarkBands() exactly, for
  // the location checks below — "top"/"bottom" are sized to exactly one
  // tile's height (a single row), not a fixed fraction of the page.
  const cellWidth = Math.max(40, Math.round(canvasSize.width * 0.16));
  const bandHeight = Math.max(24, Math.round(cellWidth * 0.5));
  const topRect = { x: 0, y: 0, width: canvasSize.width, height: Math.min(bandHeight, canvasSize.height) };
  const bottomHeight = Math.min(bandHeight, canvasSize.height);
  const bottomRect = { x: 0, y: canvasSize.height - bottomHeight, width: canvasSize.width, height: bottomHeight };
  // A band safely outside both top and bottom bands, to prove
  // location-scoped patterns leave the rest of the page untouched.
  const middleRect = {
    x: 0,
    y: Math.round(canvasSize.height * 0.4),
    width: canvasSize.width,
    height: Math.max(1, Math.round(canvasSize.height * 0.2)),
  };

  const baselineFull = await sampleRegion(fullRect);
  const baselineTop = await sampleRegion(topRect);
  const baselineBottom = await sampleRegion(bottomRect);
  const baselineMiddle = await sampleRegion(middleRect);

  // --- default (full page) text watermark: Add bakes it in immediately, undo reverts exactly ---
  await editorPage.click("#toolWatermark");
  await expect(editorPage.locator("#watermarkPanel")).toBeVisible();
  await expect(editorPage.locator("#watermarkAdd")).toBeDisabled(); // neither text nor logo yet

  await editorPage.fill("#watermarkText", "TEST");
  await expect(editorPage.locator("#watermarkAdd")).toBeEnabled();
  await editorPage.click("#watermarkAdd");
  // Unlike the old single-instance, draggable version, Add now tiles the
  // pattern straight into the canvas — no separate commit click needed.
  await expect(editorPage.locator("#watermarkPanel")).toBeHidden();

  expect(regionsDiffer(baselineFull, await sampleRegion(fullRect))).toBe(true);

  await editorPage.click("#undo");
  expect(regionsDiffer(baselineFull, await sampleRegion(fullRect))).toBe(false);

  // --- "top only" location: top band changes, an untouched middle/bottom band doesn't ---
  await editorPage.click("#toolWatermark");
  await editorPage.fill("#watermarkText", "TOP");
  await editorPage.selectOption("#watermarkLocation", "top");
  await editorPage.click("#watermarkAdd");
  await expect(editorPage.locator("#watermarkPanel")).toBeHidden();

  expect(regionsDiffer(baselineTop, await sampleRegion(topRect))).toBe(true);
  expect(regionsDiffer(baselineMiddle, await sampleRegion(middleRect))).toBe(false);
  expect(regionsDiffer(baselineBottom, await sampleRegion(bottomRect))).toBe(false);
  await editorPage.click("#undo");

  // --- "bottom only" location: bottom band changes, top/middle don't ---
  await editorPage.click("#toolWatermark");
  await editorPage.fill("#watermarkText", "BOTTOM");
  await editorPage.selectOption("#watermarkLocation", "bottom");
  await editorPage.click("#watermarkAdd");
  await expect(editorPage.locator("#watermarkPanel")).toBeHidden();

  expect(regionsDiffer(baselineBottom, await sampleRegion(bottomRect))).toBe(true);
  expect(regionsDiffer(baselineTop, await sampleRegion(topRect))).toBe(false);
  expect(regionsDiffer(baselineMiddle, await sampleRegion(middleRect))).toBe(false);
  await editorPage.click("#undo");

  // --- 45° orientation still commits fine across the full page ---
  await editorPage.click("#toolWatermark");
  await editorPage.fill("#watermarkText", "SLANT");
  await editorPage.selectOption("#watermarkOrientation", "45");
  await editorPage.click("#watermarkAdd");
  await expect(editorPage.locator("#watermarkPanel")).toBeHidden();
  expect(regionsDiffer(baselineFull, await sampleRegion(fullRect))).toBe(true);
  await editorPage.click("#undo");

  // --- logo watermark: choosing a file is enough on its own (no text needed) ---
  await editorPage.click("#toolWatermark");
  await editorPage.locator("#watermarkLogoFile").setInputFiles(LOGO_FIXTURE_PATH);
  await expect(editorPage.locator("#watermarkLogoPreview")).toBeVisible();
  await expect(editorPage.locator("#watermarkAdd")).toBeEnabled();
  await editorPage.click("#watermarkCancel");
  await expect(editorPage.locator("#watermarkPanel")).toBeHidden();

  // Reopening remembers the logo without re-picking the file — see
  // chrome/watermark-logo-store.ts. Each panel open also resets Location
  // back to its "full" default, so this exercises that path too.
  await editorPage.click("#toolWatermark");
  await expect(editorPage.locator("#watermarkLogoPreview")).toBeVisible();
  await editorPage.click("#watermarkAdd");
  // Unlike the text-only cases above, this Add click awaits decoding the
  // logo (fetch + createImageBitmap) before it applies the pattern — wait
  // for the panel to actually close before sampling.
  await expect(editorPage.locator("#watermarkPanel")).toBeHidden();
  expect(regionsDiffer(baselineFull, await sampleRegion(fullRect))).toBe(true);

  await editorPage.close();
  await page.close();
});

test("watermark tool: signed-out click shows the Supporter sign-in gate, not the panel", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);

  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.openEditor();
    }),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  // No session seeded — a genuinely fresh, signed-out profile.
  await editorPage.click("#toolWatermark");
  await expect(editorPage.locator("#watermarkGatePanel")).toBeVisible();
  await expect(editorPage.locator("#watermarkGateMessage")).toContainText("Sign in");
  await expect(editorPage.locator("#watermarkGateAction")).toHaveText("Sign in");
  // The real configuration panel — logo/text/location/etc. — must never
  // appear before the gate is satisfied.
  await expect(editorPage.locator("#watermarkPanel")).toBeHidden();

  await editorPage.close();
  await page.close();
});

test("watermark tool: signed in but not yet Supporter shows the 1000-credit unlock prompt", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());
  await serviceWorker.evaluate(async (winId) => {
    // @ts-expect-error test-only global, see background/index.ts
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);

  await serviceWorker.evaluate(async () => {
    await chrome.storage.session.set({
      "openapps.session": { accessToken: "e2e-fake-token", refreshToken: "e2e-fake-refresh" },
    });
  });
  await context.route("https://auth.opencapture.app/v1/credits/entitlement*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ unlocked: false }) }),
  );
  // The unlock click itself: refused for insufficient credits, so this
  // also covers the "buy credits" branch of the gate in one pass.
  await context.route("https://gateway.opencapture.app/opencapture/supporter/unlock", (route) =>
    route.fulfill({ status: 402, contentType: "application/json", body: JSON.stringify({ have: 100, need: 1000 }) }),
  );

  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    serviceWorker.evaluate(async () => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.openEditor();
    }),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    return c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
  });

  await editorPage.click("#toolWatermark");
  await expect(editorPage.locator("#watermarkGateMessage")).toContainText("1000");
  await expect(editorPage.locator("#watermarkGateAction")).toHaveText("Unlock for 1000 credits");
  await expect(editorPage.locator("#watermarkPanel")).toBeHidden();

  await editorPage.click("#watermarkGateAction");
  await expect(editorPage.locator("#watermarkGateMessage")).toContainText("100");
  await expect(editorPage.locator("#watermarkGateAction")).toHaveText("Buy credits");
  // Still never the real panel — an insufficient-credits refusal must not
  // let the tool through.
  await expect(editorPage.locator("#watermarkPanel")).toBeHidden();

  await editorPage.close();
  await page.close();
});

test("rating prompt: stays hidden until the 3rd real capture, then a 4-5 star tap opens the store review page and hides it for good", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${BASE_URL}/ruler-3000.html`);

  const windowId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab found for ${url}`);
    return tab.windowId;
  }, page.url());

  // captureVisibleViaHandleRequest runs the exact same handleRequest()
  // path a real popup click does (see background/index.ts's own comment
  // on this hook) — including bumpUsageCount() — just without driving
  // three full popup UIs through it.
  async function realCapture() {
    await serviceWorker.evaluate(async (winId) => {
      // @ts-expect-error test-only global, see background/index.ts
      await globalThis.__test.captureVisibleViaHandleRequest();
    }, windowId);
  }

  await realCapture();
  await realCapture();

  const popupAfter2 = await context.newPage();
  await popupAfter2.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popupAfter2.locator("#ratingPrompt")).toBeHidden();
  await popupAfter2.close();

  await realCapture();

  const popupAfter3 = await context.newPage();
  await popupAfter3.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popupAfter3.locator("#ratingPrompt")).toBeVisible();

  const [reviewTab] = await Promise.all([context.waitForEvent("page"), popupAfter3.click('.rating-star[data-stars="5"]')]);
  expect(reviewTab.url()).toContain("chromewebstore.google.com");
  await reviewTab.close();
  await expect(popupAfter3.locator("#ratingPromptAsk")).toBeHidden();
  await expect(popupAfter3.locator("#ratingPromptThanks")).toBeVisible();
  await popupAfter3.close();

  // Having responded once, it never comes back — not even on a later
  // popup open past the 10th-use threshold.
  const popupFinal = await context.newPage();
  await popupFinal.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popupFinal.locator("#ratingPrompt")).toBeHidden();
  await popupFinal.close();

  await page.close();
});

test("rating prompt: a 1-3 star tap shows a feedback link instead of opening the store page", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ usageCount: 3, ratingPromptState: { timesShown: 0, respondedForever: false } });
  });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator("#ratingPrompt")).toBeVisible();

  await popup.click('.rating-star[data-stars="2"]');
  await expect(popup.locator("#ratingPromptAsk")).toBeHidden();
  await expect(popup.locator("#ratingPromptFeedback")).toBeVisible();
  await expect(popup.locator("#ratingFeedbackLink")).toHaveAttribute("href", /^mailto:opencaptureapp@proton\.me\?subject=/);
  await popup.close();
});

test("account page: connecting a wallet or Nostr identity opens /link instead of attempting an in-page connection", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  // <openapps-account>'s own "Connect a wallet"/"Connect Nostr" buttons
  // call wallet.js's connectEthereum()/signNostr() directly, which can
  // never work on a chrome-extension:// page — no signer is ever injected
  // into one, the same reason /signin exists for the initial sign-in.
  // account.ts intercepts those clicks in the capture phase and redirects
  // to /link instead; this proves the redirect fires, not that /link's own
  // flow completes (that's link_page.rs's job, server-side).
  await serviceWorker.evaluate(async () => {
    await chrome.storage.session.set({
      "openapps.session": { accessToken: "e2e-fake-token", refreshToken: "e2e-fake-refresh" },
    });
  });
  await context.route("https://auth.opencapture.app/v1/auth/methods", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ methods: { google: true, eip155: true, nostr: true } }),
    }),
  );
  await context.route("https://auth.opencapture.app/v1/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "e2e-user",
        display_name: "E2E Test",
        balance: 500,
        linked_accounts: [{ namespace: "google", caip10: "google:e2e", label: "e2e@example.com" }],
      }),
    }),
  );
  await context.route("https://auth.opencapture.app/v1/credits/balance", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ balance: 500 }) }),
  );
  const accountPage = await context.newPage();
  await accountPage.goto(`chrome-extension://${extensionId}/account.html`);
  await accountPage.waitForLoadState();

  // Stubbed rather than let it really open a tab: this sandbox has no
  // route to auth.opencapture.app at all, so a real navigation just
  // hits a Chrome network-error page, which proves nothing either way.
  // What matters is what ext.tabs.create() was *asked* to do — same
  // pattern popup.ts's own download tests already use for
  // chrome.downloads.download, for the same reason.
  await accountPage.evaluate(() => {
    (window as unknown as { __capturedTabCreate: chrome.tabs.CreateProperties[] }).__capturedTabCreate = [];
    chrome.tabs.create = ((opts: chrome.tabs.CreateProperties) => {
      (window as unknown as { __capturedTabCreate: chrome.tabs.CreateProperties[] }).__capturedTabCreate.push(opts);
      return Promise.resolve({} as chrome.tabs.Tab);
    }) as typeof chrome.tabs.create;
  });

  const connectWallet = accountPage.getByRole("button", { name: "Connect Wallet" });
  await expect(connectWallet).toBeVisible();
  await connectWallet.click();

  const captured = await accountPage.evaluate(
    () => (window as unknown as { __capturedTabCreate: chrome.tabs.CreateProperties[] }).__capturedTabCreate,
  );
  expect(captured).toHaveLength(1);
  expect(captured[0]?.url).toBe("https://auth.opencapture.app/link");
  // Never navigated the account tab itself, and the doomed in-page
  // wallet.js call never ran (no "no Ethereum wallet found" error here) —
  // the interception genuinely replaced the built-in behavior rather than
  // running alongside it.
  expect(accountPage.url()).toContain("account.html");
  await expect(accountPage.locator(".error")).toHaveCount(0);

  await accountPage.close();
});
