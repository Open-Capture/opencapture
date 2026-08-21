// Read-only status probe for the Edge Add-ons submission pipeline.
//
// "publish: Succeeded" from publish-edge.mjs means Microsoft *accepted* the
// submission, not that anything is live: certification runs afterwards and
// the store keeps serving the previous version until it clears. That gap is
// invisible from the store page, which renders its version client-side, so
// without this the only way to tell "queued" from "silently rejected" is to
// wait and refresh.
//
// Makes no writes — safe to run against a submission that is mid-review.
//
// Usage: node scripts/check-edge-status.mjs [publishOperationId]

const API_ROOT = process.env.EDGE_API_ROOT || "https://api.addons.microsoftedge.microsoft.com";
const EDGE_PRODUCT_ID = (process.env.EDGE_PRODUCT_ID || "").trim();
const EDGE_CLIENT_ID = (process.env.EDGE_CLIENT_ID || "").trim();
const EDGE_API_KEY = (process.env.EDGE_API_KEY || "").trim();
const operationId = (process.argv[2] || process.env.EDGE_OPERATION_ID || "").trim();

const missing = Object.entries({ EDGE_PRODUCT_ID, EDGE_CLIENT_ID, EDGE_API_KEY })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`check-edge-status: missing required env: ${missing.join(", ")}`);
  process.exit(1);
}

const headers = { Authorization: `ApiKey ${EDGE_API_KEY}`, "X-ClientID": EDGE_CLIENT_ID };

async function show(label, url) {
  const res = await fetch(url, { headers });
  const body = await res.text();
  console.log(`\n${label}  (HTTP ${res.status})`);
  try {
    console.log(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    console.log(body || "(empty body)");
  }
  return res;
}

if (operationId) {
  await show(
    `publish operation ${operationId}`,
    `${API_ROOT}/v1/products/${EDGE_PRODUCT_ID}/submissions/operations/${operationId}`,
  );
}

// The draft endpoint reports what is staged for the product right now, which
// is what distinguishes "still in certification" from "nothing was ever
// submitted".
await show("current draft submission", `${API_ROOT}/v1/products/${EDGE_PRODUCT_ID}/submissions/draft`);

// What the public store is actually serving, for comparison. No auth needed.
const store = await fetch(
  "https://microsoftedge.microsoft.com/addons/getproductdetailsbycrxid/nbblbelngcbfijhifmbjcoehocngplpc",
  { headers: { "User-Agent": "Mozilla/5.0" } },
);
if (store.ok) {
  const d = await store.json();
  console.log(`\nlive on the Edge store: version ${d.version} — "${d.name}"`);
}
