// Both message catalogues, checked against the cap each store actually
// enforces.
//
// There are two catalogues because `name` and `description` are the listing
// title and blurb, and the stores disagree about how long those may be: AMO
// refuses a name over 50 characters, the Chrome Web Store allows 75. They are
// written to each cap by hand rather than machine-trimmed, which is the whole
// reason for keeping two — and also the reason this test exists. A name edited
// three characters too long is not visible in review or in a build; it comes
// back as a rejected submission, at the point where somebody is waiting on it.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = dirname(dirname(fileURLToPath(import.meta.url)));

const CATALOGUES = [
  // https://developer.chrome.com/docs/webstore/cws-dashboard-listing
  { dir: "_locales", store: "Chrome Web Store", nameMax: 75, descriptionMax: 132 },
  // AMO caps the add-on name at 50 and the summary at 250.
  { dir: "_locales.firefox", store: "AMO", nameMax: 50, descriptionMax: 250 },
];

let failures = 0;
const check = (label, ok, detail = "") => {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const localeSets = [];
for (const { dir, store, nameMax, descriptionMax } of CATALOGUES) {
  const root = join(extDir, "public", dir);
  const locales = readdirSync(root).filter((d) => !d.startsWith("."));
  localeSets.push({ dir, locales: new Set(locales) });
  console.log(`\n${dir} (${store}, name <= ${nameMax}, description <= ${descriptionMax}) — ${locales.length} locales`);

  const tooLongName = [];
  const tooLongDescription = [];
  const malformed = [];
  for (const locale of locales) {
    const messages = JSON.parse(readFileSync(join(root, locale, "messages.json"), "utf8"));
    const name = messages.name?.message;
    const description = messages.description?.message;
    if (typeof name !== "string" || !name.trim() || typeof description !== "string" || !description.trim()) {
      malformed.push(locale);
      continue;
    }
    if (name.length > nameMax) tooLongName.push(`${locale}:${name.length}`);
    if (description.length > descriptionMax) tooLongDescription.push(`${locale}:${description.length}`);
  }

  check(`every catalogue has a name and a description`, malformed.length === 0, malformed.join(", "));
  check(`every name within ${store}'s ${nameMax}-char cap`, tooLongName.length === 0, tooLongName.join(", "));
  check(`every description within ${store}'s ${descriptionMax}-char cap`, tooLongDescription.length === 0, tooLongDescription.join(", "));
}

// A locale present in one catalogue and missing from the other ships that
// language a default_locale listing in one store and a translated one in the
// other, which nobody would notice until a user in that language did.
const [chromium, firefox] = localeSets;
const onlyChromium = [...chromium.locales].filter((l) => !firefox.locales.has(l));
const onlyFirefox = [...firefox.locales].filter((l) => !chromium.locales.has(l));
console.log("\nboth catalogues");
check("cover the same locales", onlyChromium.length === 0 && onlyFirefox.length === 0,
  `only in _locales: ${onlyChromium.join(",") || "none"}; only in _locales.firefox: ${onlyFirefox.join(",") || "none"}`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall locale-cap checks passed");
process.exit(failures ? 1 : 0);
