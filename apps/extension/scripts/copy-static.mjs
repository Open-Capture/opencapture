// Runs after `vite build`. Vite's HTML-entry output mirrors the input
// file's path relative to `root` (so src/popup/popup.html ->
// dist/src/popup/popup.html). The manifest references flat paths
// ("popup.html", "editor.html") to match how every other extension does
// it, so flatten those files up to dist/ root and drop the now-empty
// dist/src tree.
//
// (The wasm-bindgen glue in src/wasm-gen/ needs no such step — it's
// statically imported by background/wasm-loader.ts and bundled by Vite
// like any other module, with shot_core_bg.wasm emitted as a normal
// content-hashed asset.)
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = dirname(dirname(fileURLToPath(import.meta.url)));
const targetBrowser = process.env.TARGET_BROWSER === "firefox" ? "firefox" : "chrome";
const distDir = join(extDir, targetBrowser === "firefox" ? "dist-firefox" : "dist");

function flattenHtmlEntry(nestedRelPath, flatName) {
  const nested = join(distDir, nestedRelPath);
  const flat = join(distDir, flatName);
  if (!existsSync(nested)) {
    throw new Error(`expected Vite to emit ${nestedRelPath} — did the entry name or path change?`);
  }
  renameSync(nested, flat);
}

flattenHtmlEntry("src/popup/popup.html", "popup.html");
flattenHtmlEntry("src/editor/editor.html", "editor.html");
flattenHtmlEntry("src/account/account.html", "account.html");
flattenHtmlEntry("src/history/history.html", "history.html");
rmSync(join(distDir, "src"), { recursive: true, force: true });

console.log("copy-static: flattened popup.html/editor.html/account.html/history.html");

// Vite's `publicDir` copies the whole public/ folder verbatim into
// outDir, which means BOTH manifest.json (Chrome) and manifest.firefox.json
// (Firefox) land in every build's output regardless of target. Pick the
// right one for this target and remove the other's leftover copy, so each
// dist directory ends up with exactly one, correctly-shaped manifest.json.
const firefoxManifestPath = join(distDir, "manifest.firefox.json");
if (targetBrowser === "firefox") {
  const manifestPath = join(distDir, "manifest.json");
  rmSync(manifestPath, { force: true }); // Chrome's manifest.json, also auto-copied
  renameSync(firefoxManifestPath, manifestPath);
  console.log("copy-static: installed manifest.firefox.json as manifest.json");
} else {
  rmSync(firefoxManifestPath, { force: true }); // not used in a Chrome build
}

// Capture itself still needs no standing host access — activeTab only (see
// docs/architecture.md's "trust badge" rationale) — but
// `chrome.scripting.executeScript`/`captureVisibleTab` under activeTab
// require a real user gesture on the extension's toolbar action, which
// Playwright cannot simulate (there's no DOM element for the toolbar
// icon). E2E-only, gated on an explicit env var, we widen host access so
// the capture flow can be exercised by automation without a gesture. This
// must never run for a build that gets published. (The manifest's own
// narrow `host_permissions` — the OpenApps API origin only, for account
// sign-in/credits — stays as-is here; `<all_urls>` is a superset of it.)
if (process.env.OPENCAPTURE_E2E === "1") {
  const manifestPath = join(distDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  // And drop the optional hosts, which <all_urls> now covers. Chrome and
  // Firefox both warn on load that an optional permission already granted by
  // a required one "will be omitted" — true, harmless, and alarming to read
  // when the build is sitting unpacked in someone's browser.
  delete manifest.optional_host_permissions;
  manifest.name = `${manifest.name} (E2E TEST BUILD)`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log("copy-static: OPENCAPTURE_E2E=1 — added <all_urls> host_permissions for automated testing");
}
