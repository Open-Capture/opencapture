#!/usr/bin/env node
// Assert the external URLs this extension is hardcoded against still resolve
// the way the manifest and the match patterns assume.
//
// Hardcoding them is not optional: `optional_host_permissions` and a content
// script's `matches` are static manifest entries with no dynamic form, and an
// extension that could be pointed at an arbitrary host would be a far worse
// idea than this. The problem is not the hardcoding, it is that when the other
// end moves, nothing here notices — the permission and the match then name an
// origin the tab no longer lands on, no error is raised anywhere, and the only
// symptom is a feature that quietly does nothing.
//
// That is what happened: OpenPdfEdit moved to `openpdfedit.com/app/`, the old
// `app.openpdfedit.com` began 301-ing, and the PDF handoff broke with no
// commit behind it. Push-triggered CI can never catch that — there is nothing
// to trigger on — which is why this runs on a schedule.
//
// Every value is read out of the source, so this cannot drift from what ships.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function read(rel) {
  return readFileSync(resolve(root, rel), "utf8");
}

function constFrom(src, name) {
  const m = src.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`));
  if (!m) throw new Error(`could not find ${name} in pdf-handoff.ts`);
  return m[1];
}

const handoffSrc = read("src/chrome/pdf-handoff.ts");
const HANDOFF_URL = constFrom(handoffSrc, "PDF_EDIT_HANDOFF_URL");
const APP_URL = constFrom(handoffSrc, "PDF_EDIT_APP_URL");
const ORIGIN = constFrom(handoffSrc, "PDF_EDIT_ORIGIN");

const failures = [];
const note = (m) => failures.push(m);

// 1. The permission the code requests must be exactly what the manifests
//    declare as optional. A request that is merely a *subset* of a declared
//    pattern is accepted by Chrome but is not worth relying on across engines,
//    and a rejected permission request fails silently.
for (const file of ["public/manifest.json", "public/manifest.firefox.json"]) {
  const declared = JSON.parse(read(file)).optional_host_permissions ?? [];
  const pdf = declared.filter((o) => o.includes("openpdfedit"));
  if (pdf.length !== 1 || pdf[0] !== ORIGIN) {
    note(`${file}: optional_host_permissions has ${JSON.stringify(pdf)}, but the code requests "${ORIGIN}"`);
  }
}

// 2. The URLs the extension opens must sit inside the origin it holds a grant
//    for, or the delivery script's match pattern will not fire on them.
const originPrefix = ORIGIN.replace(/\*$/, "");
for (const [name, url] of [["PDF_EDIT_HANDOFF_URL", HANDOFF_URL], ["PDF_EDIT_APP_URL", APP_URL]]) {
  if (!url.startsWith(originPrefix)) {
    note(`${name} (${url}) is outside PDF_EDIT_ORIGIN (${ORIGIN})`);
  }
}

// 3. And the destination must answer directly. A redirect crosses an origin,
//    and the grant and the match pattern have to name where the tab *lands* —
//    not where it was sent.
async function check(name, url) {
  let res;
  try {
    res = await fetch(url, { redirect: "manual" });
  } catch (e) {
    note(`${name} (${url}) could not be reached: ${e}`);
    return;
  }
  if (res.status >= 300 && res.status < 400) {
    note(
      `${name} (${url}) REDIRECTS ${res.status} -> ${res.headers.get("location")}. ` +
        `The permission and the content-script match name the origin the tab lands on, ` +
        `so the handoff will silently never be delivered. Point these constants at the destination.`,
    );
    return;
  }
  if (!res.ok) note(`${name} (${url}) returned HTTP ${res.status}`);
  console.log(`  ok  ${name} -> ${res.status} ${url}`);
}

await check("PDF_EDIT_HANDOFF_URL", HANDOFF_URL);
await check("PDF_EDIT_APP_URL", APP_URL);

if (failures.length) {
  console.error("\ncheck-external-urls: FAILED");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("check-external-urls: ok");
