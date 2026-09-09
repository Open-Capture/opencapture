// Drive the real built editor (dist-firefox/editor.html) in Firefox AND
// Chromium and compare, because the Playwright e2e suite cannot: it loads the
// extension through Chromium's --load-extension and asserts against a service
// worker, neither of which exists in Gecko. That gap is precisely why a
// text-tool regression could ship to the Firefox build unnoticed
// (docs/FIREFOX_TESTING.md: "No automated e2e coverage for this build").
//
// The extension APIs the editor touches at boot are stubbed just far enough to
// get a capture onto the canvas: storage.session for the dimensions, and the
// runtime.connect port that streams the PNG (see requestEditorImageBytes).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium, firefox } from "playwright";

const DIST = resolve(process.argv[2] ?? "dist-firefox");
const PORT = 8941;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
               ".json": "application/json", ".png": "image/png", ".wasm": "application/wasm" };

const server = createServer(async (req, res) => {
  try {
    const p = join(DIST, decodeURIComponent(req.url.split("?")[0]));
    const body = await readFile(p);
    res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("nope");
  }
});
await new Promise((r) => server.listen(PORT, r));

const PNG_B64 = process.env.PNG_B64;
const IMG_W = Number(process.env.IMG_W ?? 320);
const IMG_H = Number(process.env.IMG_H ?? 200);
const DPR = Number(process.env.DPR ?? 1);

function stub({ isFirefox, pngB64, W, H, D }) {
  const api = {
    runtime: {
      connect() {
        const listeners = [];
        setTimeout(() => {
          listeners.forEach((f) => f({ chunk: pngB64 }));
          listeners.forEach((f) => f({ done: true }));
        }, 10);
        return { onMessage: { addListener: (f) => listeners.push(f) }, disconnect() {}, postMessage() {} };
      },
      sendMessage: async () => ({}),
      onMessage: { addListener() {} },
      getURL: (p) => p,
      lastError: undefined,
    },
    storage: {
      session: {
        get: async (keys) => {
          const all = { editorImageWidth: W, editorImageHeight: H, editorDpr: D,
                        editorImageCount: 1, editorPageUrl: "https://example.com/",
                        editorCapturedAt: Date.now() };
          const ks = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(ks.map((k) => [k, all[k]]));
        },
        set: async () => {},
      },
      local: { get: async () => ({}), set: async () => {} },
      sync: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} },
    },
    tabs: { query: async () => [], captureVisibleTab: async () => "" },
    downloads: { download: async () => 1 },
    permissions: { contains: async () => false, request: async () => false },
  };
  if (isFirefox) api.runtime.getBrowserInfo = async () => ({ name: "Firefox", version: "142.0" });
  globalThis.browser = api;
  if (!isFirefox) globalThis.chrome = api;
  else globalThis.chrome = api;
}

const results = [];
for (const [name, type, ff] of [["chromium", chromium, false], ["firefox", firefox, true]]) {
  const b = await type.launch();
  const page = await b.newPage({ viewport: { width: Number(process.env.VW ?? 1280), height: Number(process.env.VH ?? 900) } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200)); });
  await page.addInitScript(stub, { isFirefox: ff, pngB64: PNG_B64, W: IMG_W, H: IMG_H, D: DPR });
  await page.goto(`http://127.0.0.1:${PORT}/editor.html`);

  // Wait for the capture to land on the canvas.
  await page.waitForFunction(() => {
    const c = document.getElementById("canvas");
    return c && c.width > 300;
  }, null, { timeout: 20000 }).catch(() => {});

  const toolBtn = page.locator("#toolText");
  const toolVisible = await toolBtn.isVisible().catch(() => false);
  await toolBtn.click().catch(() => {});
  await page.waitForTimeout(200);
  const toolActive = await page.evaluate(() =>
    document.getElementById("toolText")?.classList.contains("active") ??
    document.getElementById("toolText")?.getAttribute("aria-pressed"));

  // Scroll the canvas wrap first when asked. A real editor window is often
  // smaller than the capture, so the user scrolls down before annotating —
  // and startTextInput mixes viewport-space (getBoundingClientRect) with
  // layout-space (canvas.offsetTop) when placing the floating input.
  const SCROLL = Number(process.env.SCROLL ?? 0);
  if (SCROLL) {
    await page.evaluate((y) => {
      const w = document.getElementById("canvasWrap");
      w.scrollTop = y; w.scrollLeft = Math.round(y / 3);
    }, SCROLL);
    await page.waitForTimeout(250);
  }
  const scrolled = await page.evaluate(() => {
    const w = document.getElementById("canvasWrap");
    return { top: w.scrollTop, left: w.scrollLeft, canScroll: w.scrollHeight > w.clientHeight };
  });

  // Click the canvas where the text should go.
  // Pick a point that is actually visible: after scrolling, the canvas's
  // bounding box top is negative, so box.y + 60 can sit above the viewport.
  // Click inside the intersection of the canvas and its scroll container's
  // visible box. Clamping to the viewport alone is not enough: y=60 lands on
  // the editor toolbar, which is why an earlier run saw no input in *both*
  // browsers and looked like a product bug.
  const CLICK = await page.evaluate(() => {
    const c = document.getElementById("canvas").getBoundingClientRect();
    const w = document.getElementById("canvasWrap").getBoundingClientRect();
    const left = Math.max(c.left, w.left), right = Math.min(c.right, w.right);
    const top = Math.max(c.top, w.top), bottom = Math.min(c.bottom, w.bottom);
    return { x: Math.round(left + Math.min(80, (right - left) / 2)),
             y: Math.round(top + Math.min(60, (bottom - top) / 2)) };
  });
  const hit = await page.evaluate((c) => (document.elementFromPoint(c.x, c.y) || {}).id, CLICK);
  await page.mouse.click(CLICK.x, CLICK.y);
  await page.waitForTimeout(400);

  const scale = await page.evaluate(() => {
    const c = document.getElementById("canvas");
    const r = c.getBoundingClientRect();
    return { bufW: c.width, cssW: Math.round(r.width), scale: +(c.width / r.width).toFixed(2) };
  });

  const probe = await page.evaluate(() => {
    const inp = document.querySelector("#canvasStack input[type=text]");
    if (!inp) return { present: false };
    const cs = getComputedStyle(inp);
    const r = inp.getBoundingClientRect();
    return {
      present: true,
      focused: document.activeElement === inp,
      left: cs.left, top: cs.top, font: cs.font || cs.fontSize,
      w: Math.round(r.width), h: Math.round(r.height),
      onScreen: r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 &&
                r.bottom <= innerHeight && r.right <= innerWidth,
      viewportTop: Math.round(r.top), viewportLeft: Math.round(r.left),
    };
  });

  let typed = null, committed = null, baked = null;
  await page.screenshot({ path: `/tmp/ffopen-${name}.png` });
  if (probe.present) {
    await page.keyboard.type("HELLO");
    await page.waitForTimeout(150);
    typed = await page.evaluate(() => document.querySelector("#canvasStack input[type=text]")?.value ?? null);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    committed = await page.evaluate(() => {
      const c = document.getElementById("previewCanvas");
      const x = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < x.length; i += 4) if (x[i] > 0) n++;
      return n; // non-transparent pixels on the preview = the pending text shape
    });
    // Bake the pending shape into the real canvas the way the user does —
    // pressing Enter again (window-level keydown -> commitPendingShape).
    // Only this proves the text survives into the exported image; the
    // preview canvas is thrown away on every redraw.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    baked = await page.evaluate(() => {
      const c = document.getElementById("canvas");
      const g = c.getContext("2d", { willReadFrequently: true });
      const d = g.getImageData(0, 0, c.width, c.height).data;
      // the capture is a flat #c8d2dc; the text is #ff3b30 — count red pixels
      let red = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 180 && d[i + 1] < 120 && d[i + 2] < 120) {
          red++;
          const px = (i / 4) % c.width, py = Math.floor((i / 4) / c.width);
          if (px < minX) minX = px; if (px > maxX) maxX = px;
          if (py < minY) minY = py; if (py > maxY) maxY = py;
        }
      }
      return { red, box: red ? [minX, minY, maxX, maxY] : null };
    });
  }

  await page.screenshot({ path: `/tmp/ffshot-${name}.png` });
  results.push({ name, toolVisible, toolActive, ...scale, scrolled, hit, ...probe, typed, committed, baked, errors: errors.slice(0, 4) });
  await b.close();
}
server.close();
for (const r of results) {
  console.log(`\n=== ${r.name} ===`);
  console.log("  text tool button visible :", r.toolVisible, " active:", r.toolActive);
  console.log("  canvas buffer/css/scale  :", r.bufW, "/", r.cssW, "/", r.scale);
  console.log("  wrap scroll top/left     :", r.scrolled.top, "/", r.scrolled.left, " scrollable:", r.scrolled.canScroll);
  console.log("  element under click      :", r.hit);
  console.log("  input created            :", r.present);
  if (r.present) {
    console.log("  focused                  :", r.focused);
    console.log("  css left/top             :", r.left, r.top);
    console.log("  font                     :", r.font);
    console.log("  size (w x h)             :", r.w, "x", r.h, " onScreen:", r.onScreen);
    console.log("  input viewport pos       :", r.viewportLeft, ",", r.viewportTop, " (clicked near 80,60 inside canvas)");
    console.log("  typed value              :", JSON.stringify(r.typed));
    console.log("  pixels drawn on commit   :", r.committed);
    console.log("  BAKED into main canvas   :", r.baked && r.baked.red, " bbox:", r.baked && r.baked.box);
  }
  if (r.errors.length) console.log("  errors:", r.errors);
  const ok = r.present && r.typed === "HELLO" && r.committed > 0 && r.onScreen && r.baked && r.baked.red > 0;
  console.log("  VERDICT                  :", ok ? "TEXT TOOL WORKS" : "TEXT TOOL BROKEN");
}
