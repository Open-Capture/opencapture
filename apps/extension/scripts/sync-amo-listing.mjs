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
  if (!amo) {
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
if (skippedLocale.length) console.log(`  no AMO locale: ${skippedLocale.join(", ")}`);

if (!apply) {
  console.log("\ndry run — pass --apply to write these to the live listing");
  process.exit(0);
}

const payload = {};
if (Object.keys(name).length) payload.name = name;
if (Object.keys(description).length) payload.description = description;

async function patch(body) {
  const res = await fetch(`${API_ROOT}/api/v5/addons/addon/${SLUG}/`, {
    method: "PATCH",
    headers: { Authorization: `JWT ${jwt()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

let result = await patch(payload);

if (!result.ok && result.status === 400) {
  // AMO reports field errors as { name: { de: ["Ensure this field has no
  // more than N characters."] } }. Drop exactly those locales and retry, so
  // one over-long name does not cost every other translation.
  let errors;
  try {
    errors = JSON.parse(result.text);
  } catch {
    errors = null;
  }
  const rejected = errors && typeof errors.name === "object" ? Object.keys(errors.name) : [];
  if (rejected.length) {
    console.log(`sync-amo-listing: AMO rejected name for ${rejected.length} locale(s): ${rejected.join(", ")}`);
    console.log(`  reason: ${JSON.stringify(errors.name[rejected[0]])}`);
    for (const locale of rejected) delete payload.name[locale];
    if (!Object.keys(payload.name).length) delete payload.name;
    console.log("sync-amo-listing: retrying without them…");
    result = await patch(payload);
  }
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
