// Loads the built Chromium extension in a real browser once per locale and
// reports which of the _locales catalogues the browser actually selects.
//
// Why a real browser: a catalogue being present and valid says nothing about
// whether it is reachable. Chromium picks an extension locale from the
// *application* locale, and it only has application locales for the languages
// it ships UI for. A catalogue for a language Chromium cannot run in is inert
// — no error, no warning, it just silently serves the default_locale instead.
// The only way to tell the two apart is to ask a browser.
//
// macOS ignores --lang, so the locale is forced through AppleLanguages there
// and --lang elsewhere. Getting this wrong is silent: every locale appears to
// "work" because the browser stays in its default language and the assertion
// trivially passes, so the run below verifies the harness against a control
// before trusting any result.
//
// Usage: node scripts/verify-locales.mjs [--browser edge|chrome] [--only a,b,c]

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(extDir, "dist");
const localesDir = join(extDir, "public", "_locales");

const args = process.argv.slice(2);
const argVal = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const browserName = argVal("--browser", "edge");
const only = argVal("--only", null)?.split(",").map((s) => s.trim());

const BROWSERS = {
  edge: { darwin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", linux: "microsoft-edge" },
  chrome: { darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", linux: "google-chrome" },
};
const binary = BROWSERS[browserName]?.[process.platform] ?? BROWSERS[browserName]?.linux;
if (!binary || (process.platform === "darwin" && !existsSync(binary))) {
  console.error(`verify-locales: ${browserName} not found at ${binary}`);
  process.exit(1);
}
if (!existsSync(join(distDir, "manifest.json"))) {
  console.error("verify-locales: dist/ not built — run `npm run build` first");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `pt_BR` in _locales is `pt-BR` as a language tag. */
const toTag = (dir) => dir.replace("_", "-");

async function resolveIn(localeDir) {
  const tag = toTag(localeDir);
  const profile = mkdtempSync(join(tmpdir(), `verify-locale-${localeDir}-`));
  const port = 9700 + Math.floor(Math.random() * 200);
  const localeArgs =
    process.platform === "darwin" ? ["-AppleLanguages", `(${tag})`] : [`--lang=${tag}`];
  const child = spawn(
    binary,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      ...localeArgs,
      `--load-extension=${distDir}`,
      `--disable-extensions-except=${distDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { stdio: "ignore" },
  );

  try {
    let targets = [];
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        targets = (await res.json()).filter(
          (t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"),
        );
        if (targets.length) break;
      } catch {
        /* browser still starting */
      }
    }
    for (const t of targets) {
      const got = await new Promise((resolve) => {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        ws.onopen = () =>
          ws.send(
            JSON.stringify({
              id: 1,
              method: "Runtime.evaluate",
              params: {
                expression: `JSON.stringify({name: chrome.i18n.getMessage('name'), ui: chrome.i18n.getUILanguage()})`,
                returnByValue: true,
              },
            }),
          );
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.id) {
            resolve(m.result?.result?.value ?? null);
            ws.close();
          }
        };
        ws.onerror = () => resolve(null);
        setTimeout(() => resolve(null), 8000);
      });
      if (!got) continue;
      const parsed = JSON.parse(got);
      if (!parsed.name) continue;
      return parsed;
    }
    return null;
  } finally {
    child.kill("SIGKILL");
    // The browser keeps flushing profile files for a moment after the signal,
    // so an immediate recursive delete races it and throws ENOTEMPTY. A stale
    // temp dir is not worth failing a verification run over — retry briefly,
    // then leave it to the OS.
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(300);
      }
    }
  }
}

const catalogues = Object.fromEntries(
  readdirSync(localesDir)
    .filter((d) => !d.startsWith("."))
    .map((d) => [d, JSON.parse(readFileSync(join(localesDir, d, "messages.json"), "utf8")).name.message]),
);
const defaultName = catalogues.en;

// Harness check: a locale Chromium certainly ships must come back localized.
// If the control fails, every subsequent "unreachable" would be a lie.
process.stdout.write("verify-locales: checking harness against zh_CN control… ");
const control = await resolveIn("zh_CN");
if (!control || control.name !== catalogues.zh_CN) {
  console.error(
    `FAILED\n  Expected the zh_CN catalogue, got ${JSON.stringify(control)}.\n` +
      "  The browser is not honouring the locale switch, so results would be meaningless. Aborting.",
  );
  process.exit(1);
}
console.log(`ok (ui=${control.ui})`);

const dirs = (only ?? Object.keys(catalogues)).sort();
const reachable = [];
const unreachable = [];

for (const d of dirs) {
  const got = await resolveIn(d);
  const expected = catalogues[d];
  if (got && got.name === expected) {
    reachable.push(d);
    console.log(`  ok         ${d.padEnd(7)} ui=${(got.ui ?? "?").padEnd(6)} ${expected.slice(0, 46)}`);
  } else if (got && got.name === defaultName) {
    unreachable.push(d);
    console.log(`  FALLBACK   ${d.padEnd(7)} ui=${(got.ui ?? "?").padEnd(6)} served the en catalogue instead`);
  } else {
    unreachable.push(d);
    console.log(`  UNKNOWN    ${d.padEnd(7)} ${JSON.stringify(got)}`);
  }
}

console.log(
  `\n${browserName}: ${reachable.length}/${dirs.length} catalogues reachable.` +
    (unreachable.length
      ? `\nFalls back to en (no ${browserName} UI locale, so these can never be shown): ${unreachable.join(", ")}`
      : ""),
);
