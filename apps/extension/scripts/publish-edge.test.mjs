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

function startMock({ uploadStatuses, publishStatuses, locationStyle }) {
  const seen = { auth: null, clientId: null, contentType: null, bodyBytes: 0, notes: null };
  const counters = { upload: 0, publish: 0 };
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
        seen.notes = JSON.parse(body.toString()).notes;
        res.writeHead(202, { Location: "publish-op-9" });
        return res.end();
      }
      if (req.method === "GET" && req.url.includes("/submissions/operations/")) {
        return json(200, { status: publishStatuses[Math.min(counters.publish++, publishStatuses.length - 1)] });
      }
      json(404, { error: `unexpected ${req.method} ${req.url}` });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen }));
  });
}

function run(root, zip, notes) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL("./publish-edge.mjs", import.meta.url).pathname, zip], {
      env: { ...process.env, EDGE_API_ROOT: root, EDGE_PRODUCT_ID: PRODUCT, EDGE_CLIENT_ID: "client-abc", EDGE_API_KEY: "key-xyz", EDGE_PUBLISH_NOTES: notes },
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
  check("sends X-ClientID header", seen.clientId === "client-abc", seen.clientId);
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

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall publish-edge checks passed");
process.exit(failures ? 1 : 0);
