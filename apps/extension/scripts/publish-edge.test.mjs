// Exercises publish-edge.mjs end to end against a stand-in for the Edge
// Add-ons API. Covers the parts that are easy to get wrong and impossible
// to check against the real service without burning a submission: reading
// the operation ID out of the Location header, polling until a terminal
// status, and failing loudly on a rejected package.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRODUCT = "d34f98f5-f9b7-42b1-bebb-98707202b21d";
// Client ID is a GUID too — publish-edge.mjs validates its shape before
// making any request, so a placeholder like "client-abc" would be rejected.
const CLIENT = "6f1b0c22-9a4e-4d13-8f7a-2c5e91ab4477";

function startMock({ uploadStatuses, publishStatuses, locationStyle, blockPublishTimes = 0 }) {
  const seen = { auth: null, clientId: null, contentType: null, bodyBytes: 0, notes: null };
  const counters = { upload: 0, publish: 0 };
  const state = { publishAttempts: 0 };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const json = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "POST" && req.url.endsWith("/submissions/draft/package")) {
        seen.auth = req.headers.authorization;
        seen.clientId = req.headers["x-clientid"];
        seen.contentType = req.headers["content-type"];
        seen.bodyBytes = body.length;
        const loc = locationStyle === "path" ? `/v1/products/${PRODUCT}/operations/upload-op-1` : "upload-op-1";
        res.writeHead(202, { Location: loc });
        return res.end();
      }
      if (req.method === "GET" && req.url.includes("/draft/package/operations/")) {
        return json(200, { status: uploadStatuses[Math.min(counters.upload++, uploadStatuses.length - 1)], errors: ["manifest rejected"] });
      }
      if (req.method === "POST" && req.url.endsWith("/submissions")) {
        state.publishAttempts++;
        seen.notes = JSON.parse(body.toString()).notes;
        res.writeHead(202, { Location: "publish-op-9" });
        return res.end();
      }
      if (req.method === "GET" && req.url.includes("/submissions/operations/")) {
        // Edge reports "an earlier submission is still in certification" as a
        // Failed operation, indistinguishable in shape from a real rejection.
        if (state.publishAttempts <= blockPublishTimes) {
          return json(200, { status: "Failed", message: "Can't publish extension as your extension submission is in progress. Please try again later." });
        }
        return json(200, { status: publishStatuses[Math.min(counters.publish++, publishStatuses.length - 1)] });
      }
      json(404, { error: `unexpected ${req.method} ${req.url}` });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen, state }));
  });
}

function run(root, zip, notes, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL("./publish-edge.mjs", import.meta.url).pathname, zip], {
      env: { ...process.env, EDGE_API_ROOT: root, EDGE_PRODUCT_ID: PRODUCT, EDGE_CLIENT_ID: CLIENT, EDGE_API_KEY: "key-xyz", EDGE_PUBLISH_NOTES: notes, ...extraEnv },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

const dir = await mkdtemp(join(tmpdir(), "edge-pub-"));
const zip = join(dir, "pkg.zip");
await writeFile(zip, Buffer.alloc(2048, 7));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${ok ? "" : " — " + detail}`);
  if (!ok) failures++;
};

// 1. happy path, bare Location value, status flips InProgress -> Succeeded
{
  const { server, port, seen } = await startMock({ uploadStatuses: ["InProgress", "Succeeded"], publishStatuses: ["Succeeded"] });
  const { code, out } = await run(`http://127.0.0.1:${port}`, zip, "release notes here");
  server.close();
  check("happy path exits 0", code === 0, out);
  check("sends ApiKey auth header", seen.auth === "ApiKey key-xyz", seen.auth);
  check("sends X-ClientID header", seen.clientId === CLIENT, seen.clientId);
  check("sends application/zip", seen.contentType === "application/zip", seen.contentType);
  check("uploads the real bytes", seen.bodyBytes === 2048, String(seen.bodyBytes));
  check("forwards certification notes", seen.notes === "release notes here", seen.notes);
  check("polls until Succeeded", /upload: InProgress/.test(out), out);
  check("reports submission", /submitted to Edge certification/.test(out), out);
}

// 2. Location returned as a full path — operation ID is the last segment
{
  const { server, port } = await startMock({ uploadStatuses: ["Succeeded"], publishStatuses: ["Succeeded"], locationStyle: "path" });
  const { code, out } = await run(`http://127.0.0.1:${port}`, zip, "n");
  server.close();
  check("handles path-style Location header", code === 0, out);
}

// 3. a rejected package must fail the job, surfacing the errors array
{
  const { server, port } = await startMock({ uploadStatuses: ["Failed"], publishStatuses: ["Succeeded"] });
  const { code, out } = await run(`http://127.0.0.1:${port}`, zip, "n");
  server.close();
  check("failed upload exits non-zero", code !== 0, String(code));
  check("failed upload surfaces errors", /manifest rejected/.test(out), out);
}

// 4. missing credentials must fail before any network call
{
  const child = spawn(process.execPath, [new URL("./publish-edge.mjs", import.meta.url).pathname, zip], {
    env: { ...process.env, EDGE_PRODUCT_ID: "", EDGE_CLIENT_ID: "", EDGE_API_KEY: "" },
  });
  let out = "";
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("exit", r));
  check("missing credentials exits non-zero", code !== 0, String(code));
  check("names the missing vars", /EDGE_PRODUCT_ID.*EDGE_CLIENT_ID.*EDGE_API_KEY/.test(out), out);
}

// 5. credential shape is validated before any network call — the service's
//    own 400 ("must be a valid GUID") never says which value it read.
{
  const spawnWith = (env) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [new URL("./publish-edge.mjs", import.meta.url).pathname, zip], {
        env: { ...process.env, EDGE_API_ROOT: "http://127.0.0.1:1", EDGE_PRODUCT_ID: PRODUCT, EDGE_CLIENT_ID: CLIENT, EDGE_API_KEY: "key-xyz", ...env },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("exit", (code) => resolve({ code, out }));
    });

  // The exact failure that hit CI: the API key pasted into EDGE_CLIENT_ID.
  const swapped = await spawnWith({ EDGE_CLIENT_ID: "rq2xn7O5MpP-not-a-guid" });
  check("non-GUID client id exits non-zero", swapped.code !== 0, String(swapped.code));
  check("names EDGE_CLIENT_ID", /EDGE_CLIENT_ID is not a GUID/.test(swapped.out), swapped.out);
  check("points at Publish API page", /Publish API > Client ID/.test(swapped.out), swapped.out);
  check("never echoes the bad value", !/rq2xn7O5MpP/.test(swapped.out), "value leaked into output");

  const badProduct = await spawnWith({ EDGE_PRODUCT_ID: "nbblbelngcbfijhifmbjcoehocngplpc" });
  check("storefront id rejected as product id", badProduct.code !== 0, String(badProduct.code));
  check("names EDGE_PRODUCT_ID", /EDGE_PRODUCT_ID is not a GUID/.test(badProduct.out), badProduct.out);

  // A trailing newline from the secrets UI must not break an otherwise good GUID.
  const padded = await spawnWith({ EDGE_CLIENT_ID: `  ${PRODUCT}\n`, EDGE_PRODUCT_ID: `${PRODUCT}\n` });
  check("trims whitespace around GUIDs", !/is not a GUID/.test(padded.out), padded.out);
}

// A release cut soon after the previous one hits Edge while the earlier
// submission is still certifying. That is expected, not a fault, and the job
// should wait it out rather than fail on something that clears itself.
{
  const { server, port, state } = await startMock({
    uploadStatuses: ["Succeeded"], publishStatuses: ["Succeeded"], blockPublishTimes: 2,
  });
  const { code, out } = await run(`http://127.0.0.1:${port}`, zip, "n", { EDGE_PUBLISH_RETRY_MS: "10", EDGE_PUBLISH_ATTEMPTS: "5" });
  server.close();
  check("waits out an in-progress submission", code === 0, out);
  check("retried the publish", state.publishAttempts === 3, `attempts=${state.publishAttempts}`);
  check("says why it is waiting", /still in certification/.test(out), out);
}

// Still blocked after every attempt: fail, but explain rather than dumping a
// raw operation error, and say the upload is not lost.
{
  const { server, port } = await startMock({
    uploadStatuses: ["Succeeded"], publishStatuses: ["Succeeded"], blockPublishTimes: 99,
  });
  const { code, out } = await run(`http://127.0.0.1:${port}`, zip, "n", { EDGE_PUBLISH_RETRY_MS: "10", EDGE_PUBLISH_ATTEMPTS: "2" });
  server.close();
  check("gives up non-zero when never clears", code !== 0, String(code));
  check("reassures the upload survived", /package IS uploaded/.test(out), out);
  check("no raw stack trace", !/at .*publish-edge\.mjs:/.test(out), out);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall publish-edge checks passed");
process.exit(failures ? 1 : 0);
