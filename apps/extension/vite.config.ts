import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// A build's own name, shown in the popup.
//
// Every release candidate carries the same manifest version — 1.0.0 — so a
// tester who has just reloaded has no way to tell rc.4 from rc.7, and several
// rounds of "this is still broken" turned out to be a build without the fix
// in it. `git describe` names the commit against the nearest tag, which is
// exactly the question being asked: is what I am running newer than the fix?
function buildLabel(): string {
  if (process.env.OPENCAPTURE_BUILD) return process.env.OPENCAPTURE_BUILD;
  try {
    return execSync("git describe --tags --always --dirty", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// Multi-entry build: popup.html/editor.html/account.html/history.html (Vite's native
// HTML-entry handling), plus raw TS entries (background service worker,
// content script, openapps-callback content script). background/index.ts
// imports freely (the manifest declares it `"type": "module"`, so that's
// fine), but content/index.ts and openapps-callback/index.ts are written
// with zero imports of their own — MV3 content scripts are always loaded
// as classic scripts, never modules, so their bundles must contain no
// import/export syntax.
//
// OPENCAPTURE_E2E gates a test-only hook (background/index.ts) that
// lets Playwright drive captures directly by tabId instead of needing to
// simulate a toolbar-icon click for the activeTab permission grant. Unset,
// `if (false)` dead-code-eliminates the hook out of the shipped bundle
// entirely — see scripts/copy-static.mjs for the matching manifest change.
//
// TARGET_BROWSER switches the output directory only — every JS entry is
// compiled identically for both browsers (see src/platform/webext.ts for
// how the shared bundle picks the right runtime API at load time). Unset,
// this defaults to "chrome" and produces byte-identical output to before
// TARGET_BROWSER existed.
const targetBrowser = process.env.TARGET_BROWSER === "firefox" ? "firefox" : "chrome";

export default defineConfig({
  root: resolve(__dirname),
  define: {
    __OPENCAPTURE_E2E__: JSON.stringify(process.env.OPENCAPTURE_E2E === "1"),
    __OPENCAPTURE_BUILD__: JSON.stringify(buildLabel()),
  },
  build: {
    outDir: targetBrowser === "firefox" ? "dist-firefox" : "dist",
    emptyOutDir: true,
    target: "es2022",
    // Extension pages (popup/editor) each live in their own
    // isolated JS world with no shared module cache between them, unlike
    // navigations in a normal tab — Vite's injected modulepreload polyfill
    // (for browsers lacking native support) is meaningless there and
    // Chrome logs a "cross-world extension resource mismatch" warning for
    // the unused <link rel="modulepreload">. Every target browser here
    // (Chrome 116+, Firefox 115+) has native modulepreload support anyway.
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "src/popup/popup.html"),
        editor: resolve(__dirname, "src/editor/editor.html"),
        account: resolve(__dirname, "src/account/account.html"),
        history: resolve(__dirname, "src/history/history.html"),
        background: resolve(__dirname, "src/background/index.ts"),
        content: resolve(__dirname, "src/content/index.ts"),
        "openapps-callback": resolve(__dirname, "src/openapps-callback/index.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
