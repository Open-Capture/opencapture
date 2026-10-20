import { chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

const BASE_URL = "http://localhost:8934";
const dist = process.env.DIST_OVERRIDE ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

type Box = { left: number; top: number; right: number; bottom: number };

/** Captures the test page and opens the result in the editor. */
async function openEditorOn(context: BrowserContext, sw: Worker, page: Page): Promise<Page> {
  await page.goto(`${BASE_URL}/ruler-3000.html`);
  await page.bringToFront();
  const windowId = await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab for ${url}`);
    return tab.windowId;
  }, page.url());
  await sw.evaluate(async (winId) => {
    // @ts-expect-error test-only global
    await globalThis.__test.captureVisibleOnly(winId);
  }, windowId);
  const [editorPage] = await Promise.all([
    context.waitForEvent("page"),
    // @ts-expect-error test-only global
    sw.evaluate(async () => globalThis.__test.openEditor()),
  ]);
  await editorPage.waitForLoadState();
  await editorPage.waitForFunction(() => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    const stack = document.getElementById("canvasStack");
    return c.width > 0 && c.height > 0 && !!stack && !stack.classList.contains("loading");
  });
  return editorPage;
}

/** The visible scrolling area, the bar, and which side the bar chose. */
async function layout(editorPage: Page): Promise<{ view: Box; bar: Box; side: string }> {
  return editorPage.evaluate(() => {
    const wrap = document.getElementById("canvasWrap")!;
    const w = wrap.getBoundingClientRect();
    const b = document.getElementById("cropBar")!;
    const r = b.getBoundingClientRect();
    return {
      view: { left: w.left, top: w.top, right: w.left + wrap.clientWidth, bottom: w.top + wrap.clientHeight },
      bar: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      side: b.dataset.side ?? "",
    };
  });
}

/**
 * The bar must be just outside the frame (or inside it, when there is no
 * room around it), and wholly on screen. `frame` is in client px.
 */
async function expectBarNextTo(editorPage: Page, frame: Box, expectedSide?: string): Promise<string> {
  await expect(editorPage.locator("#cropBar")).toBeVisible();
  const { view, bar, side } = await layout(editorPage);
  if (expectedSide) expect(side).toBe(expectedSide);
  // On screen.
  expect(bar.left).toBeGreaterThanOrEqual(view.left - 1);
  expect(bar.right).toBeLessThanOrEqual(view.right + 1);
  expect(bar.top).toBeGreaterThanOrEqual(view.top - 1);
  expect(bar.bottom).toBeLessThanOrEqual(view.bottom + 1);
  // Adjacent: within a short reach of the frame line, never across it.
  const NEAR = 40;
  if (side === "below") {
    expect(bar.top).toBeGreaterThanOrEqual(frame.bottom);
    expect(bar.top - frame.bottom).toBeLessThanOrEqual(NEAR);
  } else if (side === "above") {
    expect(bar.bottom).toBeLessThanOrEqual(frame.top);
    expect(frame.top - bar.bottom).toBeLessThanOrEqual(NEAR);
  } else if (side === "right") {
    expect(bar.left).toBeGreaterThanOrEqual(frame.right);
    expect(bar.left - frame.right).toBeLessThanOrEqual(NEAR);
  } else if (side === "left") {
    expect(bar.right).toBeLessThanOrEqual(frame.left);
    expect(frame.left - bar.right).toBeLessThanOrEqual(NEAR);
  } else {
    expect(side).toBe("inside");
    expect(bar.left).toBeGreaterThanOrEqual(Math.max(frame.left, view.left) - 1);
    expect(bar.right).toBeLessThanOrEqual(Math.min(frame.right, view.right) + 1);
    expect(bar.bottom).toBeLessThanOrEqual(Math.min(frame.bottom, view.bottom) + 1);
  }
  return side;
}

function frameOf(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

test("the crop bar follows the marquee: below it, above it near the bottom, inside it when it fills the view", async ({
  context,
  serviceWorker,
}) => {
  test.setTimeout(180_000);
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  const editorPage = await openEditorOn(context, serviceWorker, page);
  await editorPage.setViewportSize({ width: 1000, height: 720 });
  const c = (await editorPage.locator("#canvas").boundingBox())!;
  const at = (x: number, y: number) => ({ x: c.x + x, y: c.y + y });
  await editorPage.click("#toolCrop");

  // Drawn in the upper half: the bar goes just below the frame.
  let a = at(100, 100);
  let b = at(400, 300);
  await editorPage.mouse.move(a.x, a.y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(b.x, b.y, { steps: 5 });
  await editorPage.mouse.up();
  await expectBarNextTo(editorPage, frameOf(a, b), "below");

  // Moved down by dragging from inside: the bar follows during the drag,
  // before the button is released, and flips above once below runs out.
  const grab = at(250, 200);
  await editorPage.mouse.move(grab.x, grab.y);
  await editorPage.mouse.down();
  await editorPage.mouse.move(grab.x, grab.y + 150, { steps: 5 });
  await expectBarNextTo(editorPage, frameOf(at(100, 250), at(400, 450)));
  await editorPage.mouse.move(grab.x, grab.y + 290, { steps: 5 });
  await expectBarNextTo(editorPage, frameOf(at(100, 390), at(400, 590)), "above");
  await editorPage.mouse.up();
  await expectBarNextTo(editorPage, frameOf(at(100, 390), at(400, 590)), "above");

  // The whole image: no room on any side, so the bar sits inside the frame.
  await editorPage.click("#cropCancel");
  a = at(0, 0);
  b = at(c.width, c.height);
  await editorPage.mouse.move(a.x + 1, a.y + 1);
  await editorPage.mouse.down();
  await editorPage.mouse.move(b.x - 1, b.y - 1, { steps: 5 });
  await editorPage.mouse.up();
  await expectBarNextTo(editorPage, frameOf(a, b), "inside");

  // A narrower window moves the frame; the bar moves with it.
  await editorPage.setViewportSize({ width: 860, height: 720 });
  const c2 = (await editorPage.locator("#canvas").boundingBox())!;
  await expectBarNextTo(editorPage, { left: c2.x, top: c2.y, right: c2.x + c2.width, bottom: c2.y + c2.height });

  // And the button still does its job from where it now is.
  await editorPage.click("#cropApply");
  await expect(editorPage.locator("#cropBar")).toBeHidden();

  await editorPage.close();
  await page.close();
});

test("on a phone, the crop bar follows a touch drag and its buttons are finger-sized", async () => {
  test.setTimeout(180_000);
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      // hasTouch alone does not make (pointer: coarse) match in headless
      // Chromium; Playwright pins a fine pointer by default. A phone reports
      // a coarse one, and the editor sizes its handles and buttons by it.
      "--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2",
    ],
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  try {
    let [sw] = context.serviceWorkers();
    sw ??= await context.waitForEvent("serviceworker", { timeout: 20_000 });
    const page = await context.newPage();
    const editorPage = await openEditorOn(context, sw, page);
    const cdp = await context.newCDPSession(editorPage);
    const touch = async (type: "touchStart" | "touchMove" | "touchEnd", x?: number, y?: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x: x!, y: y! }],
      });
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, release = true) => {
      await touch("touchStart", from.x, from.y);
      for (let i = 1; i <= 6; i++) {
        await touch("touchMove", from.x + ((to.x - from.x) * i) / 6, from.y + ((to.y - from.y) * i) / 6);
      }
      if (release) await touch("touchEnd");
    };

    expect(await editorPage.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await editorPage.locator("#toolCrop").tap();
    const c = (await editorPage.locator("#canvas").boundingBox())!;
    const at = (fx: number, fy: number) => ({ x: c.x + c.width * fx, y: c.y + c.height * fy });

    // A box in the upper part of the image.
    const a = at(0.15, 0.1);
    const b = at(0.85, 0.35);
    await drag(a, b);
    await expectBarNextTo(editorPage, frameOf(a, b), "below");
    const barBefore = (await layout(editorPage)).bar;

    // Mid-drag, finger still down: the bar has already moved with the box.
    const grab = at(0.5, 0.22);
    const dy = c.height * 0.25;
    await drag(grab, { x: grab.x, y: grab.y + dy }, false);
    // Touch moves are delivered on animation frames, so the last one can
    // land a frame after the CDP call returns.
    await expect
      .poll(async () => Math.abs((await layout(editorPage)).bar.top - barBefore.top - dy))
      .toBeLessThanOrEqual(3);
    await expectBarNextTo(editorPage, frameOf({ x: a.x, y: a.y + dy }, { x: b.x, y: b.y + dy }), "below");
    await touch("touchEnd");

    // Zoomed in so the image runs past the bottom of the screen, a box drawn
    // down to near that edge gets its bar above it rather than off-screen.
    // (The screen here is the editor's layout viewport, which is what the
    // bar is placed against.)
    const { view } = await layout(editorPage);
    for (let i = 0; i < 6; i++) {
      const cz = (await editorPage.locator("#canvas").boundingBox())!;
      if (cz.y + cz.height > view.bottom + 100) break;
      await editorPage.locator("#zoomIn").tap();
    }
    await editorPage.locator("#cropCancel").tap();
    const cz = (await editorPage.locator("#canvas").boundingBox())!;
    // 40px off the edge: closer and the drag would auto-scroll the image.
    const low1 = { x: Math.max(cz.x, view.left) + 40, y: view.bottom - 260 };
    const low2 = { x: Math.min(cz.x + cz.width, view.right) - 40, y: view.bottom - 40 };
    await drag(low1, low2);
    await expectBarNextTo(editorPage, frameOf(low1, low2), "above");

    // Finger-sized.
    const apply = (await editorPage.locator("#cropApply").boundingBox())!;
    expect(Math.round(apply.height)).toBeGreaterThanOrEqual(44);

    // A tap on Apply crops.
    const before = await editorPage.evaluate(() => (document.getElementById("canvas") as HTMLCanvasElement).height);
    await editorPage.locator("#cropApply").tap();
    await expect(editorPage.locator("#cropBar")).toBeHidden();
    const after = await editorPage.evaluate(() => (document.getElementById("canvas") as HTMLCanvasElement).height);
    expect(after).toBeLessThan(before);
  } finally {
    await context.close();
  }
});
