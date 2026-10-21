// Drive the real built editor's crop tool in Firefox AND Chromium: the crop
// bar (Apply crop, Cancel, the size readout) must sit just outside the crop
// frame and follow it, and Apply crop must crop to the frame, in both engines.
//
// The Playwright suite in e2e/ covers this in Chromium only, because it loads
// the extension through --load-extension. Here the editor page is served on
// its own with the extension APIs stubbed (as in text-tool.mjs), which Gecko
// can load too.
//
//   node e2e-firefox/crop-bar.mjs dist-firefox            # exit 0 = all pass
//   SHOTS=/some/dir node e2e-firefox/crop-bar.mjs dist-firefox
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import zlib from "node:zlib";
import { chromium, firefox } from "playwright";

const DIST = resolve(process.argv[2] ?? "dist-firefox");
const PORT = Number(process.env.PORT ?? 8943);
const SHOTS = process.env.SHOTS;
const W = 1400;
// Tall enough to run past the bottom of the view even at phone width, so a
// frame can be drawn down to the view's bottom edge.
const H = 4200;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
               ".json": "application/json", ".png": "image/png", ".wasm": "application/wasm",
               ".woff2": "font/woff2", ".svg": "image/svg+xml" };

/** A capture with horizontal bands, so a screenshot shows where the frame is. */
function png(w, h) {
  const rows = Array.from({ length: h }, (_, y) => {
    const band = Math.floor(y / 100) % 2 ? [214, 222, 232] : [244, 244, 238];
    return Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).fill(Buffer.from(band))]);
  });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 1 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG_B64 = png(W, H).toString("base64");

function stub({ pngB64, W, H }) {
  const api = {
    runtime: {
      connect() {
        const ls = [];
        setTimeout(() => { ls.forEach((f) => f({ chunk: pngB64 })); ls.forEach((f) => f({ done: true })); }, 10);
        return { onMessage: { addListener: (f) => ls.push(f) }, disconnect() {}, postMessage() {} };
      },
      sendMessage: async () => ({}),
      onMessage: { addListener() {} },
      getURL: (p) => p,
      getBrowserInfo: async () => ({ name: "Firefox", version: "142.0" }),
      lastError: undefined,
    },
    storage: {
      session: {
        get: async (keys) => {
          const all = { editorImageWidth: W, editorImageHeight: H, editorDpr: 1, editorImageCount: 1,
                        editorPageUrl: "https://example.com/", editorCapturedAt: Date.now() };
          return Object.fromEntries([].concat(keys).map((k) => [k, all[k]]));
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
  globalThis.browser = api;
  globalThis.chrome = api;
}

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
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/** Where the frame, the bar and the visible scroll area are, in CSS pixels. */
const layout = (page) => page.evaluate(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
  const wrap = document.getElementById("canvasWrap");
  const w = wrap.getBoundingClientRect();
  return {
    bar: box(document.getElementById("cropBar")),
    side: document.getElementById("cropBar").dataset.side,
    hidden: document.getElementById("cropBar").hidden,
    view: { left: Math.max(0, w.left), top: Math.max(0, w.top),
            right: Math.min(innerWidth, w.left + wrap.clientWidth), bottom: Math.min(innerHeight, w.top + wrap.clientHeight) },
    canvas: box(document.getElementById("canvas")),
    size: document.getElementById("cropSize").textContent,
    buffer: { w: document.getElementById("canvas").width, h: document.getElementById("canvas").height },
  };
});

const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
};
const inside = (bar, view) => bar.left >= view.left - 0.5 && bar.top >= view.top - 0.5 &&
                              bar.right <= view.right + 0.5 && bar.bottom <= view.bottom + 0.5;

for (const [engine, type] of [["chromium", chromium], ["firefox", firefox]]) {
  for (const [form, viewport, touch] of [["desktop", { width: 1280, height: 900 }, false],
                                          ["phone", { width: 390, height: 844 }, true]]) {
    const label = `${engine} ${form} ${viewport.width}x${viewport.height}`;
    console.log(`\n=== ${label} ===`);
    const b = await type.launch();
    const page = await b.newPage({ viewport, hasTouch: touch });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await page.addInitScript(stub, { pngB64: PNG_B64, W, H });
    await page.goto(`http://127.0.0.1:${PORT}/editor.html`);
    await page.waitForFunction(() => {
      const c = document.getElementById("canvas");
      const s = document.getElementById("canvasStack");
      return c && c.width > 300 && s && !s.classList.contains("loading");
    }, null, { timeout: 20000 });

    await (touch ? page.locator("#toolCrop").tap() : page.locator("#toolCrop").click());
    const c = (await layout(page)).canvas;
    const at = (fx, fy) => ({ x: c.left + (c.right - c.left) * fx, y: Math.max(c.top, 0) + fy });
    const drag = async (from, to) => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
      await page.mouse.up();
    };

    // A frame in the upper part of the view: the bar goes below it.
    const a = at(0.2, 80), z = at(0.7, 300);
    await drag(a, z);
    let l = await layout(page);
    check("bar shown after drawing a frame", !l.hidden);
    check("bar below the frame", l.side === "below" && l.bar.top >= z.y, `side=${l.side} barTop=${l.bar.top.toFixed(1)} frameBottom=${z.y.toFixed(1)}`);
    check("bar right edge aligned with the frame (or clamped on screen)",
      Math.abs(l.bar.right - z.x) < 2 || l.bar.right <= l.view.right + 0.5, `barRight=${l.bar.right.toFixed(1)} frameRight=${z.x.toFixed(1)}`);
    check("bar inside the visible area", inside(l.bar, l.view));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${engine}-${form}-below.png`) });

    // Move the frame's bottom edge to the bottom of the view: no room below, so above.
    await page.locator("#cropCancel").click();
    const vb = l.view.bottom;
    const a2 = { x: a.x, y: vb - 260 }, z2 = { x: z.x, y: vb - 6 };
    await drag(a2, z2);
    l = await layout(page);
    check("bar above a frame that reaches the bottom of the view", l.side === "above" && l.bar.bottom <= a2.y,
      `side=${l.side} barBottom=${l.bar.bottom.toFixed(1)} frameTop=${a2.y.toFixed(1)}`);
    check("bar still inside the visible area", inside(l.bar, l.view));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${engine}-${form}-above.png`) });

    // Apply crop, from where the bar now is: the canvas becomes the frame.
    const m = l.size.match(/^(\d+) × (\d+)/);
    const want = m ? { w: Number(m[1]), h: Number(m[2]) } : null;
    await (touch ? page.locator("#cropApply").tap() : page.locator("#cropApply").click());
    await page.waitForTimeout(300);
    l = await layout(page);
    check("Apply crop hides the bar", l.hidden);
    check("canvas cropped to the frame", !!want && Math.abs(l.buffer.w - want.w) <= 1 && Math.abs(l.buffer.h - want.h) <= 1,
      `canvas ${l.buffer.w}x${l.buffer.h}, readout ${want ? `${want.w}x${want.h}` : l.size}`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${engine}-${form}-applied.png`) });
    check("no page errors", errors.length === 0, errors.join(" | "));
    await b.close();
  }
}
server.close();
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exit(failures.length ? 1 : 0);
