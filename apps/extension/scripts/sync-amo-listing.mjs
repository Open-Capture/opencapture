// Pushes the localized store copy to the add-on's AMO listing.
//
// Publishing a localized package is not enough for Firefox. The manifest's
// __MSG_name__ controls what Firefox shows in about:addons, but the AMO
// *store page* reads separate listing metadata held in Mozilla's database —
// which is why opencapture's listing stayed English-only (name.zh-CN was
// null) even after 0.1.3 shipped 34 catalogues. Chrome and Edge behave the
// same way; the difference is that AMO exposes an API for it, so this one
// can be automated instead of pasted by hand.
//
// Dry run by default: this writes to a live, public store listing, so
// --apply is required to actually PATCH.
//
// Usage:
//   node scripts/sync-amo-listing.mjs            # report planned changes
//   node scripts/sync-amo-listing.mjs --apply    # write them

import { createHmac, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(extDir));
const localesDir = join(extDir, "public", "_locales");
const listingDir = join(repoRoot, "store-listing");

const API_ROOT = process.env.AMO_API_ROOT || "https://addons.mozilla.org";
const SLUG = process.env.AMO_ADDON_SLUG || "opencapture-full-page-capture";
const KEY = (process.env.WEB_EXT_API_KEY || "").trim();
const SECRET = (process.env.WEB_EXT_API_SECRET || "").trim();
const apply = process.argv.includes("--apply");

// AMO's own locale codes, which are not Chrome's. Anything not in this map
// is reported as skipped rather than dropped silently — a language quietly
// missing from the store page is the exact failure this script exists to fix.
const TO_AMO = {
  ar: "ar", bs: "bs", ca: "ca", cs: "cs", da: "da", de: "de",
  en: "en-US", en_GB: "en-GB", en_US: "en-US",
  es: "es-ES", es_419: "es-MX", et: "et", fi: "fi", fr: "fr", hr: "hr",
  it: "it", ja: "ja", ko: "ko", lt: "lt", ms: "ms", nb: "nb-NO", nl: "nl",
  pt: "pt-BR", pt_BR: "pt-BR", pt_PT: "pt-PT", ro: "ro", sv: "sv-SE",
  ta: "ta", te: "te", th: "th", tr: "tr", zh_CN: "zh-CN",
};

// The set AMO actually offers translations for. Not every language it knows
// about: addons-server keeps ALL_LANGUAGES (155) for display purposes but
// only PROD_LANGUAGES may carry translated fields, and submitting anything
// outside it is rejected with `The language code "xx" is invalid`.
//
// Discovering this by trial and error is not viable — AMO names one offending
// code per response and rate-limits writes, so the first live attempt burned
// three round trips and then hit HTTP 429 without writing anything. Filtering
// up front means one request.
//
// Source: mozilla/addons-server src/olympia/core/languages.py (PROD_LANGUAGES).
// The adaptive retry below still stands as a backstop if that list drifts.
const AMO_TRANSLATABLE = new Set([
  "cs", "de", "dsb", "el", "en-CA", "en-GB", "en-US", "es-AR", "es-CL", "es-ES",
  "es-MX", "fi", "fr", "fur", "fy-NL", "he", "hr", "hsb", "hu", "ia", "it", "ja",
  "ka", "kab", "ko", "nb-NO", "nl", "nn-NO", "pl", "pt-BR", "pt-PT", "ro", "ru",
  "sk", "sl", "sq", "sr", "sv-SE", "tr", "uk", "vi", "zh-CN", "zh-TW",
]);

// Deliberately no hardcoded name-length cap. Mozilla's API reference states
// no limit for `name`, so any constant here would be a guess — and guessing
// 50 silently drops 29 of the 34 localized names, which is precisely the SEO
// value this script exists to deliver. Instead send everything and let AMO
// arbitrate: a rejected PATCH is atomic, so attempting costs nothing, and the
// 400 names the offending locales exactly. Those get dropped and the rest
// retried, so the real limit is discovered rather than assumed.

function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "HS256", typ: "JWT" });
  // AMO rejects tokens with a long life; 5 minutes is the documented ceiling.
  const body = enc({ iss: KEY, jti: randomUUID(), iat: now, exp: now + 300 });
  const sig = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** Pull the OVERVIEW block out of a store-listing/<lang>.txt file. */
function overviewFrom(file) {
  const text = readFileSync(file, "utf8");
  const marker = text.indexOf("===== OVERVIEW");
  if (marker < 0) return null;
  const afterHeading = text.indexOf("\n", text.indexOf("=====", marker + 5));
  return text.slice(afterHeading + 1).trim() || null;
}

const missing = [];
if (!KEY) missing.push("WEB_EXT_API_KEY");
if (!SECRET) missing.push("WEB_EXT_API_SECRET");
if (missing.length) {
  console.error(`sync-amo-listing: missing required env: ${missing.join(", ")}`);
  process.exit(1);
}

const name = {};
const description = {};
const skippedLocale = [];

for (const dir of readdirSync(localesDir).filter((d) => !d.startsWith("."))) {
  const amo = TO_AMO[dir];
  if (!amo || !AMO_TRANSLATABLE.has(amo)) {
    skippedLocale.push(dir);
    continue;
  }
  name[amo] = JSON.parse(readFileSync(join(localesDir, dir, "messages.json"), "utf8")).name.message;

  const listingFile = join(listingDir, `${dir}.txt`);
  if (existsSync(listingFile)) {
    const overview = overviewFrom(listingFile);
    if (overview) description[amo] = overview;
  }
}

console.log(`sync-amo-listing: ${SLUG}`);
console.log(`  name         : ${Object.keys(name).length} locales`);
console.log(`  description  : ${Object.keys(description).length} locales from store-listing/`);
if (skippedLocale.length)
  console.log(`  AMO offers no translations for: ${skippedLocale.join(", ")}`);

if (!apply) {
  console.log("\ndry run — pass --apply to write these to the live listing");
  process.exit(0);
}

const payload = {};
if (Object.keys(name).length) payload.name = name;
if (Object.keys(description).length) payload.description = description;

async function patch(body) {
  // AMO rate-limits writes and answers 429 with Retry-After. Honour it rather
  // than failing the run — a sync that gives up on a throttle just has to be
  // repeated by hand.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API_ROOT}/api/v5/addons/addon/${SLUG}/`, {
      method: "PATCH",
      headers: { Authorization: `JWT ${jwt()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status !== 429 || attempt >= 4) {
      return { ok: res.ok, status: res.status, text: await res.text() };
    }
    const wait = Number(res.headers.get("retry-after")) || 30 * (attempt + 1);
    console.log(`sync-amo-listing: rate limited, waiting ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

let result = await patch(payload);

// AMO validates the locale set and answers, per field, with an array of
// message strings — e.g. { "name": ["The language code \"ar\" is invalid."] },
// NOT an object keyed by locale. It also reports only the codes it reached
// before giving up, so one pass is not enough to learn the whole rejected
// set. Loop: pull the quoted codes out of the messages, drop them from every
// field, retry. A rejected PATCH is atomic, so no partial state accumulates
// across attempts and the accepted locale set gets discovered rather than
// hardcoded from a list that would rot.
const rejectedLocales = [];
for (let attempt = 0; !result.ok && result.status === 400 && attempt < 12; attempt++) {
  let errors;
  try {
    errors = JSON.parse(result.text);
  } catch {
    break;
  }
  const messages = Object.values(errors)
    .flat()
    .filter((m) => typeof m === "string");
  const codes = [...new Set(messages.flatMap((m) => [...m.matchAll(/"([\w-]+)" is invalid/g)].map((x) => x[1])))];
  if (!codes.length) break;

  for (const code of codes) {
    rejectedLocales.push(code);
    delete payload.name?.[code];
    delete payload.description?.[code];
  }
  if (payload.name && !Object.keys(payload.name).length) delete payload.name;
  if (payload.description && !Object.keys(payload.description).length) delete payload.description;
  if (!Object.keys(payload).length) {
    console.error("sync-amo-listing: AMO rejected every locale; nothing left to send");
    process.exit(1);
  }
  console.log(`sync-amo-listing: AMO rejects ${codes.join(", ")} — retrying without them`);
  result = await patch(payload);
}
if (rejectedLocales.length) {
  console.log(`sync-amo-listing: locales AMO does not accept: ${rejectedLocales.join(", ")}`);
}

if (!result.ok) {
  console.error(`sync-amo-listing: PATCH failed (HTTP ${result.status}):\n${result.text}`);
  process.exit(1);
}
const updated = JSON.parse(result.text);
console.log(
  `sync-amo-listing: updated — name in ${Object.keys(updated.name ?? {}).length} locales, ` +
    `description in ${Object.keys(updated.description ?? {}).length}`,
);
