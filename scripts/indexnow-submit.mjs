// Tell Bing a page changed, instead of waiting to be crawled.
//
// Bing had indexed nothing at all from opencapture.app (APP-55), and Bing is
// what Copilot searches and what ChatGPT's web search leans on — so being
// absent there is being absent from both. IndexNow is the push half of the
// fix: submit a URL and the engines fetch it rather than discovering it on
// their own schedule. Yandex, Seznam and Naver take the same feed.
//
// The key is deliberately not a secret. IndexNow's whole verification model
// is that the key is published at the site root — anyone can read it, and
// that is what proves whoever submitted the URL controls the domain. It is
// checked into this file for the same reason it is served publicly.
//
//   node scripts/indexnow-submit.mjs                    # everything in the sitemap
//   node scripts/indexnow-submit.mjs /blog/new-post.html # just what changed
//
// Run it after publishing. Submitting an unchanged page repeatedly is the
// one thing the protocol asks you not to do, so prefer naming the pages.
const KEY = "5d6eae47b701469f549c89d677adbecd";
const HOST = "opencapture.app";
const SITE = `https://${HOST}`;
const KEY_LOCATION = `${SITE}/${KEY}.txt`;

const args = process.argv.slice(2);

/** The key file has to be readable, and has to contain exactly the key.
 * If it is missing the whole submission is refused, and the failure looks
 * like a silent no-op rather than an error, so check it first. */
const served = await fetch(KEY_LOCATION).then((r) => (r.ok ? r.text() : null)).catch(() => null);
if (served?.trim() !== KEY) {
  console.error(`indexnow: ${KEY_LOCATION} does not serve the key — submissions would be rejected.`);
  console.error(`  got: ${served === null ? "no response" : JSON.stringify(served.trim().slice(0, 60))}`);
  process.exit(1);
}

let urlList;
if (args.length > 0) {
  urlList = args.map((a) => (a.startsWith("http") ? a : `${SITE}${a.startsWith("/") ? "" : "/"}${a}`));
} else {
  const sitemap = await fetch(`${SITE}/sitemap.xml`).then((r) => r.text());
  urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}
if (urlList.length === 0) {
  console.error("indexnow: nothing to submit");
  process.exit(1);
}

console.log(`Submitting ${urlList.length} URL(s) as ${HOST}`);
for (const u of urlList) console.log(`  ${u.replace(SITE, "") || "/"}`);

const response = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList }),
});

// 200 accepted, 202 accepted with key validation still pending — both mean
// the engines have the list. Anything else is a refusal worth reading.
const body = await response.text();
console.log(`\nHTTP ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
if (response.status !== 200 && response.status !== 202) {
  console.error("indexnow: submission refused");
  process.exit(1);
}
console.log("Accepted.");
