// Uploads a packaged Chromium build to the Microsoft Edge Add-ons store and
// publishes it, via the Update REST API v1.1.
//
// v1.1 authenticates with a Client ID + API key pair straight from Partner
// Center's "Publish API" page. (v1 used an Azure AD access token exchanged
// at login.microsoftonline.com; Microsoft ended support for it on
// 2024-12-31, so there is no token-fetch step here.)
//
// Both write calls are asynchronous: they answer 202 Accepted with a
// `Location` header carrying an operation ID, and the real outcome only
// shows up by polling that operation until its status leaves InProgress.
// Nothing about the request tells you how long that takes, so each poll
// loop is bounded by wall-clock time rather than a retry count.
//
// Scope note: this API only replaces the *package*. Listing metadata —
// the per-language Overview and the Edge search terms in store-listing/ —
// has no REST endpoint and must be edited by hand in Partner Center.
// See store-listing/README.md.

// Overridable so the publish flow can be exercised against a local mock
// (see publish-edge.test.mjs); CI never sets it.
const API_ROOT = process.env.EDGE_API_ROOT || "https://api.addons.microsoftedge.microsoft.com";

// Trimmed because these arrive from repository secrets, and a value pasted
// into the GitHub UI or piped into `gh secret set` easily carries a trailing
// newline. Untrimmed, that reaches the API as part of the header value and
// comes back as an opaque 400.
const EDGE_PRODUCT_ID = (process.env.EDGE_PRODUCT_ID || "").trim();
const EDGE_CLIENT_ID = (process.env.EDGE_CLIENT_ID || "").trim();
const EDGE_API_KEY = (process.env.EDGE_API_KEY || "").trim();
const zipPath = process.argv[2];
const notes = process.env.EDGE_PUBLISH_NOTES || "Automated publish from CI.";

const missing = Object.entries({ EDGE_PRODUCT_ID, EDGE_CLIENT_ID, EDGE_API_KEY })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`publish-edge: missing required env: ${missing.join(", ")}`);
  process.exit(1);
}

/**
 * Product ID and Client ID are both GUIDs; the API key is not. Getting them
 * into the wrong secrets is easy and the service's own answer for it —
 * "The value of X-ClientID must be a valid GUID" — does not say which value
 * it read or where that value should have come from. Check the shape here
 * so the failure names the secret and the fix.
 *
 * Never echo the values: one of these three is a live credential and this
 * output goes to CI logs.
 */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guidChecks = [
  ["EDGE_PRODUCT_ID", EDGE_PRODUCT_ID, "Partner Center > Microsoft Edge > Overview > (your extension) > Extension identity. Not the id in the public store URL."],
  ["EDGE_CLIENT_ID", EDGE_CLIENT_ID, "Partner Center > Microsoft Edge > Publish API > Client ID. Not the API key, which is not a GUID."],
];
const malformed = guidChecks.filter(([, value]) => !GUID.test(value));
if (malformed.length) {
  for (const [name, value, where] of malformed) {
    console.error(
      `publish-edge: ${name} is not a GUID (got ${value.length} chars, expected 36 as 8-4-4-4-12 hex).\n` +
        `  Expected source: ${where}`,
    );
  }
  console.error("publish-edge: fix the secret at Settings > Secrets and variables > Actions, then re-run.");
  process.exit(1);
}
if (!zipPath) {
  console.error("publish-edge: usage: node publish-edge.mjs <package.zip>");
  process.exit(1);
}

const authHeaders = {
  Authorization: `ApiKey ${EDGE_API_KEY}`,
  "X-ClientID": EDGE_CLIENT_ID,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The operation ID comes back in the `Location` header. Partner Center has
 * been observed returning it both bare and as a trailing path segment, so
 * take the last segment either way rather than trusting one shape.
 */
function operationIdFrom(response) {
  const location = response.headers.get("location");
  if (!location) throw new Error("no Location header on the 202 response");
  return location.trim().split("/").filter(Boolean).pop();
}

async function poll(url, label, { timeoutMs = 20 * 60 * 1000, intervalMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(url, { headers: authHeaders });
    const body = await res.text();
    if (!res.ok) throw new Error(`${label}: status check returned HTTP ${res.status}: ${body}`);

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`${label}: status check returned non-JSON: ${body}`);
    }

    const status = parsed.status;
    if (status === "Succeeded") return parsed;
    if (status === "Failed" || status === "Cancelled") {
      // `errors` carries the actionable per-file detail; `message` alone is
      // usually just "Failed", which is not enough to debug a rejection.
      throw new Error(`${label}: ${status} — ${JSON.stringify(parsed.errors ?? parsed.message ?? parsed)}`);
    }

    if (Date.now() > deadline) {
      throw new Error(`${label}: still ${status} after ${Math.round(timeoutMs / 60000)} minutes; giving up`);
    }
    console.log(`  ${label}: ${status}…`);
    await sleep(intervalMs);
  }
}

const { readFile } = await import("node:fs/promises");
const pkg = await readFile(zipPath);
console.log(`publish-edge: uploading ${zipPath} (${(pkg.length / 1024).toFixed(0)} KiB) to product ${EDGE_PRODUCT_ID}`);

const upload = await fetch(`${API_ROOT}/v1/products/${EDGE_PRODUCT_ID}/submissions/draft/package`, {
  method: "POST",
  headers: { ...authHeaders, "Content-Type": "application/zip" },
  body: pkg,
});
if (upload.status !== 202) {
  throw new Error(`upload: expected 202, got HTTP ${upload.status}: ${await upload.text()}`);
}
const uploadOp = operationIdFrom(upload);
console.log(`publish-edge: upload accepted, operation ${uploadOp}`);

await poll(
  `${API_ROOT}/v1/products/${EDGE_PRODUCT_ID}/submissions/draft/package/operations/${uploadOp}`,
  "upload",
);
console.log("publish-edge: package accepted into the draft submission");

const publish = await fetch(`${API_ROOT}/v1/products/${EDGE_PRODUCT_ID}/submissions`, {
  method: "POST",
  headers: { ...authHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({ notes }),
});
if (publish.status !== 202) {
  throw new Error(`publish: expected 202, got HTTP ${publish.status}: ${await publish.text()}`);
}
const publishOp = operationIdFrom(publish);
console.log(`publish-edge: publish accepted, operation ${publishOp}`);

await poll(`${API_ROOT}/v1/products/${EDGE_PRODUCT_ID}/submissions/operations/${publishOp}`, "publish");
console.log("publish-edge: submitted to Edge certification — review typically takes up to a few days");
