# OpenCapture — Local Testing & Deployment Guide

This walks through building `opencapture` from a clean checkout and
loading it as an unpacked extension in Chrome, plus running the full
automated test suite. There is no "deployment" in the server sense — this
is a browser extension, so "deploying" means building `dist/` and pointing
Chrome at it. Chrome Web Store publishing is a separate, not-yet-automated
process (see the bottom of this doc).

## 1. Prerequisites

| Tool | Version used in this repo | Check |
|---|---|---|
| Rust (stable) | via `rustup`, `wasm32-unknown-unknown` target | `rustup show` |
| `wasm-bindgen-cli` | **exactly** `0.2.100` — must match the `wasm-bindgen = "=0.2.100"` pin in `Cargo.toml` | `wasm-bindgen --version` |
| Node.js | 22.x | `node --version` |
| npm | 10.x | `npm --version` |
| Chrome or Chromium | 116+ (manifest's `minimum_chrome_version`) | `chrome://version` |
| `wasm-opt` (optional) | any recent `binaryen` release | `wasm-opt --version` |

Install what's missing:

```bash
# Rust target (rust-toolchain.toml already pins components + this target,
# so a plain `cargo build` in this repo auto-installs it via rustup)
rustup target add wasm32-unknown-unknown

# wasm-bindgen CLI — version MUST match Cargo.toml's pin exactly, or the
# extension will fail at runtime with a JS-glue schema mismatch
cargo install wasm-bindgen-cli --version 0.2.100 --locked

# optional: shrinks the .wasm and speeds it up; build-wasm.sh skips this
# step gracefully if it's not on PATH
brew install binaryen   # macOS
```

### Known environment gotcha: shared/network mounts

If this checkout lives on a network or VM-shared mount (e.g. a
`/Volumes/...` share on macOS), building Rust **directly on that mount**
can fail with errors like `failed to build archive: memory map must have a
non-zero length`. `scripts/build-wasm.sh` already works around this by
defaulting `CARGO_TARGET_DIR` to `/tmp/opencapture-target` (genuinely
local disk) unless you override it. If you run `cargo build`/`cargo test`
directly (not through the script), export the same variable first:

```bash
export CARGO_TARGET_DIR=/tmp/opencapture-target
```

## 2. Clone and install JS dependencies

```bash
cd opencapture/apps/extension
npm install
```

## 3. Build the extension

One command does everything: builds `shot-core` to `wasm32-unknown-unknown`,
runs `wasm-bindgen` to generate JS/TS glue into `src/wasm-gen/`, then runs
Vite to bundle the service worker/popup/editor/offscreen pages and copy
static assets into `dist/`.

```bash
npm run build
```

Under the hood (`package.json`):

```bash
npm run build:wasm   # scripts/build-wasm.sh — cargo build + wasm-bindgen (+ wasm-opt if present)
vite build            # bundles background.js, popup, editor, offscreen, content
node scripts/copy-static.mjs   # flattens Vite's nested HTML output, copies manifest+icons
```

You should end up with `apps/extension/dist/` containing at least:

```
dist/
  manifest.json
  background.js
  content.js
  popup.html
  editor.html
  offscreen.html
  icons/icon16.png icon48.png icon128.png
  ...
```

If the build fails on the wasm step with a version/schema error, re-check
`wasm-bindgen --version` against the `wasm-bindgen = "=X.Y.Z"` pin in
`../../Cargo.toml` — they must match exactly.

## 4. Load it into Chrome as an unpacked extension

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked**
4. Select `opencapture/apps/extension/dist`
5. OpenCapture's icon appears in the toolbar (pin it via the puzzle-piece menu
   if it's hidden)

### Manual smoke test

1. Open any real webpage (e.g. a long article or `test-pages/ruler-3000.html`
   served locally — see §6).
2. Click the OpenCapture toolbar icon.
3. Try each button:
   - **Capture Full Page** — scrolls and stitches, then offers download/copy.
   - **Capture Visible Area** — single-viewport screenshot.
   - **Select Area** — a drag overlay appears on the page; drag a rectangle,
     release to capture just that region. Press `Escape` to cancel.
   - **Export as PDF** — turns the last capture into a PDF.
   - **Copy to Clipboard** — copies the last capture as an image.
   - **Open Editor** — opens `editor.html` in a new tab with the last
     capture loaded; try arrow, rectangle, text, mosaic-blur, and undo.
4. Confirm nothing errors in:
   - the popup's own DevTools (right-click the popup → Inspect)
   - the service worker's console (`chrome://extensions` → OpenCapture →
     "service worker" link → Inspect)

### Re-testing after a code change

Re-run `npm run build`, then in `chrome://extensions` click the reload
icon (↻) on OpenCapture's card. No need to remove/re-add it.

## 5. Run the automated test suites

### Rust tests (shot-core + shot-qa), from `opencapture/`

```bash
cd opencapture
export CARGO_TARGET_DIR=/tmp/opencapture-target   # see §1 gotcha
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check
```

Expect 36 passing tests (29 in `shot-core` incl. `plan`/`stitch`/`crop`
proptests, 7 CLI integration tests in `shot-qa`).

### TypeScript typecheck, from `apps/extension/`

```bash
npm run typecheck
```

### End-to-end tests (real headless Chromium via Playwright)

The e2e suite drives a real browser with the extension loaded, so it needs
a special build with a test-only hook enabled (`OPENCAPTURE_E2E=1`) that
also relaxes host permissions to `<all_urls>` for the local static test
server — **never** use this build for manual testing or publishing, only
for the e2e run itself:

```bash
cd opencapture/apps/extension

# one-time: install the Playwright-managed Chromium build
npx playwright install --with-deps chromium

# build with the E2E hook + relaxed permissions
OPENCAPTURE_E2E=1 npm run build

# run the suite (playwright.config.ts auto-starts the static test-page
# server from ../../test-pages on port 8934)
npx playwright test
```

Expect **8/8 passing**: extension-loads, popup-renders, full-page-capture
(exact ruler-band pixel assertions), sticky/fixed-element handling,
lazy-load forcing, selected-area crop, selected-area cancel, and the
annotation-editor test (real mouse drags, exact pixel assertions for
rectangle/undo/mosaic-blur).

`shot-qa` (the native golden-assertion CLI) is invoked by the e2e tests as
a subprocess — build it once beforehand if you're not going through
`cargo test` first:

```bash
cargo build -p shot-qa
```

**After running e2e tests, rebuild production-mode before loading into
Chrome for real use:**

```bash
npm run build   # no OPENCAPTURE_E2E flag — restores minimal permissions
```

To sanity-check no test-only code leaked into a production build:

```bash
grep -r "__test\|all_urls\|E2E-TEST-BUILD" dist/manifest.json dist/background.js || echo "clean"
```

### View the Playwright HTML report after a run

```bash
npx playwright show-report
```

## 6. Serving test pages standalone (optional)

If you want to poke at the fixture pages outside of Playwright (e.g. to
manually verify sticky/fixed or lazy-load behavior):

```bash
cd opencapture/apps/extension
node e2e/static-server.mjs   # serves ../../test-pages on http://localhost:8934
```

Then open `http://localhost:8934/ruler-3000.html`,
`http://localhost:8934/sticky-fixed.html`, or
`http://localhost:8934/lazy-native.html` in the Chrome instance where
OpenCapture is loaded unpacked, and run captures against them manually.

## 7. Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `WebAssembly.instantiate` CSP error in service worker console | Missing `'wasm-unsafe-eval'` in manifest CSP | Already present in `public/manifest.json`'s `content_security_policy.extension_pages` — if you regenerate the manifest, keep this |
| `import() is disallowed on ServiceWorkerGlobalScope` | Something reintroduced a dynamic `import()` in background code | `src/background/wasm-loader.ts` must use a **static** `import init, * as ShotCore from "../wasm-gen/shot_core.js"` |
| Playwright never finds a service worker / times out | Wrong `channel` option | `e2e/fixtures.ts` must use the literal `channel: "chromium"` (not `"chrome"`, not omitted) with `headless: true` |
| wasm build fails with a glue/schema-looking error | `wasm-bindgen` crate/CLI version mismatch | `wasm-bindgen --version` must exactly equal the `wasm-bindgen = "=X.Y.Z"` pin in `Cargo.toml` |
| `cargo build` fails with `memory map must have a non-zero length` | Building directly on a shared/network mount | `export CARGO_TARGET_DIR=/tmp/opencapture-target` (see §1) |
| Popup shows buttons but capture silently does nothing | Loaded the `OPENCAPTURE_E2E=1` build outside Playwright, or a stale `dist/` | Rebuild with plain `npm run build` and reload the extension |

## 8. Publishing (not covered here)

Publishing to the Chrome Web Store, Edge Add-ons and Firefox Add-ons is done
by the workflows in `.github/workflows/` (`publish-chrome.yml`,
`publish-edge.yml`, `publish-firefox.yml`), which need the store
credentials as repository secrets.
