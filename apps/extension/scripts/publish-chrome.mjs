// Uploads a packaged Chromium build to the Chrome Web Store and publishes it.
//
// Uses the v1.1 API. There is a newer v2 at chromewebstore.googleapis.com,
// but its paths are keyed by a publisher id that the current documentation
// never explains how to find, whereas v1.1 needs only the item id already
// visible in the store URL. Fewer values for a human to hunt down is worth
// more here than being on the newest endpoint; v1.1 remains documented and
// is what the ecosystem's tooling uses.
//
// Auth is OAuth2 refresh-token: the long-lived refresh token is exchanged
// for a short-lived access token on each run, so nothing durable is sent to
// the store API itself.
//
// Scope note: like Edge, this replaces the *package* only. Listing copy —
// the per-language Overview in store-listing/ — has no API and stays a
// manual Developer Dashboard step.

// Both overridable so the publish flow can be exercised against a local mock
// (see publish-chrome.test.mjs); CI never sets either. Without this the token
// exchange reaches the real Google endpoint even under test.
const TOKEN_URL = process.env.CHROME_TOKEN_URL || "https://oauth2.googleapis.com/token";
const API_ROOT = process.env.CHROME_API_ROOT || "https://www.googleapis.com";

const CHROME_EXTENSION_ID = (process.env.CHROME_EXTENSION_ID || "").trim();
const CHROME_CLIENT_ID = (process.env.CHROME_CLIENT_ID || "").trim();
const CHROME_CLIENT_SECRET = (process.env.CHROME_CLIENT_SECRET || "").trim();
const CHROME_REFRESH_TOKEN = (process.env.CHROME_REFRESH_TOKEN || "").trim();
const zipPath = process.argv[2];

const required = { CHROME_EXTENSION_ID, CHROME_CLIENT_ID, CHROME_CLIENT_SECRET, CHROME_REFRESH_TOKEN };
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`publish-chrome: missing required env: ${missing.join(", ")}`);
  process.exit(1);
}
if (!zipPath) {
  console.error("publish-chrome: usage: node publish-chrome.mjs <package.zip>");
  process.exit(1);
}

// The item id is the 32 lowercase letters in the store URL. Catching a wrong
// shape here turns an otherwise bare 404 into something actionable.
if (!/^[a-p]{32}$/.test(CHROME_EXTENSION_ID)) {
  console.error(
    `publish-chrome: CHROME_EXTENSION_ID does not look like an item id ` +
      `(got ${CHROME_EXTENSION_ID.length} chars, expected 32 letters a-p).\n` +
      `  It is the id in the store URL: chromewebstore.google.com/detail/<slug>/<THIS>`,
  );
  process.exit(1);
}

async function accessToken() {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CHROME_CLIENT_ID,
      client_secret: CHROME_CLIENT_SECRET,
      refresh_token: CHROME_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    // Google answers `invalid_grant` for a revoked or expired refresh token,
    // which is the failure most likely to appear months later out of nowhere.
    throw new Error(
      `token exchange failed (HTTP ${res.status}): ${body}\n` +
        `  invalid_grant usually means the refresh token was revoked or expired — mint a new one.`,
    );
  }
  const token = JSON.parse(body).access_token;
  if (!token) throw new Error(`token exchange returned no access_token: ${body}`);
  return token;
}

const { readFile } = await import("node:fs/promises");
const pkg = await readFile(zipPath);

const token = await accessToken();
const auth = { Authorization: `Bearer ${token}`, "x-goog-api-version": "2" };

console.log(`publish-chrome: uploading ${zipPath} (${(pkg.length / 1024).toFixed(0)} KiB) to ${CHROME_EXTENSION_ID}`);
const uploadRes = await fetch(
  `${API_ROOT}/upload/chromewebstore/v1.1/items/${CHROME_EXTENSION_ID}?uploadType=media`,
  { method: "PUT", headers: auth, body: pkg },
);
const uploadBody = await uploadRes.text();
if (!uploadRes.ok) throw new Error(`upload failed (HTTP ${uploadRes.status}): ${uploadBody}`);

const upload = JSON.parse(uploadBody);
if (upload.uploadState !== "SUCCESS") {
  // itemError carries the real reason (version not bumped, bad manifest,
  // oversized package); uploadState alone is just "FAILURE".
  throw new Error(
    `upload state ${upload.uploadState}: ${JSON.stringify(upload.itemError ?? upload, null, 2)}`,
  );
}
console.log("publish-chrome: package accepted");

const publishRes = await fetch(`${API_ROOT}/chromewebstore/v1.1/items/${CHROME_EXTENSION_ID}/publish`, {
  method: "POST",
  headers: { ...auth, "Content-Length": "0" },
});
const publishBody = await publishRes.text();
if (!publishRes.ok) throw new Error(`publish failed (HTTP ${publishRes.status}): ${publishBody}`);

const published = JSON.parse(publishBody);
const statuses = published.status ?? [];
// ITEM_PENDING_REVIEW is not an error: the store accepted the submission and
// queued it. Treating it as a failure would make every normal release red.
const benign = new Set(["OK", "ITEM_PENDING_REVIEW"]);
const bad = statuses.filter((s) => !benign.has(s));
if (bad.length) {
  throw new Error(`publish rejected: ${statuses.join(", ")} — ${JSON.stringify(published.statusDetail ?? [])}`);
}
console.log(`publish-chrome: ${statuses.join(", ") || "submitted"} — Chrome review typically takes hours to days`);
