// Every page carries the GA4 tag, exactly once.
//
// The failure this exists for is invisible: a page with no tag opens
// normally, renders normally and works normally — its traffic simply does
// not exist in GA, and nobody finds out until someone reads a report weeks
// later and sees a flat zero. Pasting the snippet twice is the same kind of
// silent: the page is fine, the numbers are quietly doubled.
//
// opencapture.app is hand-written static HTML across three subdirectories
// with no build step and no shared layout, which is the arrangement where
// this goes wrong — a new page is a new file, and the tag is a thing to
// remember. So this is a check rather than a convention.
//
//   node scripts/check-analytics.mjs                 # the live site
//   node scripts/check-analytics.mjs --dir ./out     # a directory, before deploying it
//
// Run it before publishing. It exits non-zero if any page is wrong.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const MEASUREMENT_ID = "G-DZTJF4QYC7";
const SITE = "https://opencapture.app";

// The snippet names the ID twice — once in the loader's `src`, once in the
// `config` call — and both have to be the same one. Only replacing the
// first is the single most common way this is got wrong, and it half-works:
// the library loads, and nothing is ever recorded.
const EXPECTED_OCCURRENCES = 2;

/**
 * Not a page. Google Search Console's verification file is a single line of
 * text that happens to be served with an .html name; a tag in it would be a
 * tag nobody ever loads.
 */
const NOT_A_PAGE = /^google[0-9a-f]+\.html$/;

const args = process.argv.slice(2);
const dirIndex = args.indexOf("--dir");
const dir = dirIndex >= 0 ? args[dirIndex + 1] : null;

let failures = 0;
const report = (name, count, extra = "") => {
  const ok = count === EXPECTED_OCCURRENCES;
  if (!ok) failures++;
  const verdict = count === 0 ? "NO TAG" : ok ? "ok" : `${count} occurrences`;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(54)} ${verdict}${extra}`);
};

function walk(root) {
  const out = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(".")) continue; // ._ AppleDouble files and dotfiles
    const full = join(root, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".html") && !NOT_A_PAGE.test(entry)) out.push(full);
  }
  return out;
}

if (dir) {
  console.log(`Checking ${dir} for ${MEASUREMENT_ID}\n`);
  const files = walk(dir);
  if (files.length === 0) {
    console.error(`check-analytics: no .html files under ${dir} — wrong directory?`);
    process.exit(1);
  }
  for (const file of files) {
    const html = readFileSync(file, "utf8");
    report(relative(dir, file), html.split(MEASUREMENT_ID).length - 1);
  }
} else {
  // The live site, read the way a visitor reads it. Stronger than checking
  // the files: it is the only version that proves what actually shipped,
  // and it catches a deploy that dropped a page as well as one that dropped
  // a tag. The page list comes from the sitemap, which is what search
  // engines are told exists.
  console.log(`Checking ${SITE} for ${MEASUREMENT_ID}, per its sitemap\n`);
  const sitemap = await fetch(`${SITE}/sitemap.xml`).then((r) => r.text());
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (urls.length === 0) {
    console.error("check-analytics: the sitemap listed no URLs");
    process.exit(1);
  }
  for (const url of urls) {
    const response = await fetch(url);
    if (!response.ok) {
      failures++;
      console.log(`  FAIL ${url.replace(SITE, "").padEnd(54)} HTTP ${response.status}`);
      continue;
    }
    const html = await response.text();
    report(url.replace(SITE, "") || "/", html.split(MEASUREMENT_ID).length - 1);
  }
}

console.log(
  failures
    ? `\n${failures} page(s) wrong — a page with no tag is invisible in GA, and a doubled tag doubles its numbers.`
    : `\nAll pages carry ${MEASUREMENT_ID} exactly ${EXPECTED_OCCURRENCES}×.`,
);
process.exit(failures ? 1 : 0);
