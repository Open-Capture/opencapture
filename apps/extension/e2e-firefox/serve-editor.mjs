// Serve the real built editor to a real browser, with the extension APIs
// stubbed by an inline script injected into editor.html itself — so stock
// Firefox can load it with no automation harness attached.
//
// This exists because Playwright bundles its own Firefox build, which is
// several versions behind stock. Testing the editor there proves nothing
// about the Firefox a user actually runs (155.0.1 on this machine).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import zlib from "node:zlib";

const DIST = resolve(process.argv[2] ?? "dist-firefox");
const PORT = Number(process.env.PORT ?? 8942);
const W = Number(process.env.IMG_W ?? 1200);
const H = Number(process.env.IMG_H ?? 800);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
               ".json": "application/json", ".png": "image/png", ".wasm": "application/wasm",
               ".woff2": "font/woff2", ".svg": "image/svg+xml" };

function png(w, h) {
  const raw = Buffer.concat(Array.from({ length: h },
    () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).fill(Buffer.from([245, 245, 240]))])));
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
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG_B64 = png(W, H).toString("base64");

const STUB = `<script>
(function () {
  var PNG = "${PNG_B64}";
  var api = {
    runtime: {
      connect: function () {
        var ls = [];
        setTimeout(function () { ls.forEach(function (f) { f({ chunk: PNG }); }); ls.forEach(function (f) { f({ done: true }); }); }, 10);
        return { onMessage: { addListener: function (f) { ls.push(f); } }, disconnect: function () {}, postMessage: function () {} };
      },
      sendMessage: function () { return Promise.resolve({}); },
      onMessage: { addListener: function () {} },
      getURL: function (p) { return p; },
      getBrowserInfo: function () { return Promise.resolve({ name: "Firefox", version: "155.0" }); }
    },
    storage: {
      session: {
        get: function (keys) {
          var all = { editorImageWidth: ${W}, editorImageHeight: ${H}, editorDpr: 1,
                      editorImageCount: 1, editorPageUrl: "https://example.com/", editorCapturedAt: Date.now() };
          var ks = [].concat(keys), out = {};
          ks.forEach(function (k) { out[k] = all[k]; });
          return Promise.resolve(out);
        },
        set: function () { return Promise.resolve(); }
      },
      local: { get: function () { return Promise.resolve({}); }, set: function () { return Promise.resolve(); } },
      sync:  { get: function () { return Promise.resolve({}); }, set: function () { return Promise.resolve(); } },
      onChanged: { addListener: function () {} }
    },
    tabs: { query: function () { return Promise.resolve([]); } },
    downloads: { download: function () { return Promise.resolve(1); } },
    permissions: { contains: function () { return Promise.resolve(false); }, request: function () { return Promise.resolve(false); } }
  };
  window.browser = api; window.chrome = api;
})();
</script>`;

createServer(async (req, res) => {
  try {
    const rel = decodeURIComponent(req.url.split("?")[0]);
    const p = join(DIST, rel);
    let body = await readFile(p);
    if (extname(p) === ".html") {
      body = Buffer.from(String(body).replace(/<head>/i, "<head>" + STUB));
    }
    res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("nope");
  }
}).listen(PORT, () => console.log(`editor on http://127.0.0.1:${PORT}/editor.html  (${W}x${H} capture)`));
