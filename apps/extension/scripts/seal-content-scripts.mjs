// Content-script bundles get two things done to them here, both of which
// exist because MV3 injects these files into a page that may already have
// run them.
//
// 1. They must contain no import/export syntax: a content script is loaded
//    as a classic script, never a module. Rollup splits a shared chunk the
//    moment a second entry imports the same module, and the resulting
//    `import` fails at runtime, on the page, where CI would never see it.
//
// 2. They are wrapped in an IIFE. Injecting the same file twice into one
//    page re-executes it in the same realm, and a top-level `const` that
//    already exists is a SyntaxError that kills the whole script. The
//    source guards against this with a `window.__opencaptureContentLoaded`
//    check, but that only protects declarations *inside* the guard — when a
//    module is inlined into the entry, Rollup hoists its declarations above
//    the guard, out of its reach. Function scope has no such gap: nothing
//    leaks to the realm, so re-injection cannot collide no matter how the
//    bundler arranges things.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const arg = process.argv[2] ?? "dist";
const dist = isAbsolute(arg) ? arg : join(dirname(fileURLToPath(import.meta.url)), "..", arg);
const entries = ["content.js", "openapps-callback.js"];
const SEAL_MARK = "/*sealed*/";
// Top-level module syntax, not the word "import" in a string or a dynamic
// import() call.
const MODULE_SYNTAX = /(^|[;}\s])(import\s*[{*'"a-zA-Z_$]|export\s*[{*]|export\s+(default|const|function|class))/;

let failed = false;
for (const entry of entries) {
  const path = join(dist, entry);
  if (!existsSync(path)) {
    console.error(`seal-content-scripts: ${entry} not found in ${dist} — build first`);
    failed = true;
    continue;
  }
  const source = readFileSync(path, "utf8");
  const match = source.match(MODULE_SYNTAX);
  if (match) {
    console.error(`seal-content-scripts: ${entry} contains module syntax (${JSON.stringify(match[0])}).`);
    console.error("  A content script is loaded as a classic script; this would fail on the page.");
    console.error("  Usually means a module it imports is now shared with another entry and got split into chunks/.");
    failed = true;
    continue;
  }
  if (source.startsWith(SEAL_MARK)) {
    console.log(`  ok  ${entry} already sealed`);
    continue;
  }
  writeFileSync(path, `${SEAL_MARK}(()=>{${source}\n})();\n`);
  console.log(`  ok  ${entry} sealed (${source.length} bytes)`);
}
if (failed) process.exit(1);
console.log("content-script bundles are import-free and re-injection safe");
