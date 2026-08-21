// Exercises publish-chrome.mjs against a stand-in for Google's endpoints.
// A real submission can't be used as a test, and the failures that matter
// here are all in the response handling: a 200 that still means failure
// (uploadState: FAILURE), a publish status that looks alarming but is
// normal (ITEM_PENDING_REVIEW), and a revoked refresh token.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ITEM = "ikhhoggnlncjhpdbnneekifbnmojpjph";

function startMock({ tokenStatus = 200, uploadState = "SUCCESS", itemError, publishStatus = ["OK"] }) {
  const seen = { auth: null, apiVersion: null, bodyBytes: 0, uploadQuery: null, grant: null };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const json = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.url.startsWith("/token")) {
        seen.grant = new URLSearchParams(body.toString()).get("grant_type");
        if (tokenStatus !== 200) return json(tokenStatus, { error: "invalid_grant" });
        return json(200, { access_token: "ya29.mock", expires_in: 3599 });
      }
      if (req.method === "PUT" && req.url.includes("/upload/chromewebstore/v1.1/items/")) {
        seen.auth = req.headers.authorization;
        seen.apiVersion = req.headers["x-goog-api-version"];
        seen.bodyBytes = body.length;
        seen.uploadQuery = req.url.split("?")[1] ?? "";
        return json(200, { kind: "chromewebstore#item", id: ITEM, uploadState, itemError });
      }
      if (req.method === "POST" && req.url.endsWith("/publish")) {
        return json(200, { kind: "chromewebstore#item", item_id: ITEM, status: publishStatus, statusDetail: ["detail"] });
      }
      json(404, { error: `unexpected ${req.method} ${req.url}` });
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port, seen })));
}

function run(port, zip, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL("./publish-chrome.mjs", import.meta.url).pathname, zip], {
      env: {
        ...process.env,
        CHROME_API_ROOT: `http://127.0.0.1:${port}`,
        CHROME_TOKEN_URL: `http://127.0.0.1:${port}/token`,
        CHROME_EXTENSION_ID: ITEM,
        CHROME_CLIENT_ID: "cid.apps.googleusercontent.com",
        CHROME_CLIENT_SECRET: "secret",
        CHROME_REFRESH_TOKEN: "1//refresh",
        ...env,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

const dir = await mkdtemp(join(tmpdir(), "chrome-pub-"));
const zip = join(dir, "pkg.zip");
await writeFile(zip, Buffer.alloc(4096, 3));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${ok ? "" : " — " + detail}`);
  if (!ok) failures++;
};

{
  const { server, port, seen } = await startMock({});
  const { code, out } = await run(port, zip);
  server.close();
  check("happy path exits 0", code === 0, out);
  check("uses refresh_token grant", seen.grant === "refresh_token", seen.grant);
  check("sends bearer access token", seen.auth === "Bearer ya29.mock", seen.auth);
  check("sends x-goog-api-version", seen.apiVersion === "2", seen.apiVersion);
  check("uploads with uploadType=media", seen.uploadQuery === "uploadType=media", seen.uploadQuery);
  check("uploads the real bytes", seen.bodyBytes === 4096, String(seen.bodyBytes));
}

// A 200 whose uploadState is FAILURE must not be mistaken for success.
{
  const { server, port } = await startMock({ uploadState: "FAILURE", itemError: [{ error_detail: "Version already exists" }] });
  const { code, out } = await run(port, zip);
  server.close();
  check("HTTP 200 + FAILURE exits non-zero", code !== 0, String(code));
  check("surfaces itemError detail", /Version already exists/.test(out), out);
}

// ITEM_PENDING_REVIEW is the normal outcome of a release, not a failure.
{
  const { server, port } = await startMock({ publishStatus: ["ITEM_PENDING_REVIEW"] });
  const { code, out } = await run(port, zip);
  server.close();
  check("pending review is treated as success", code === 0, out);
}

{
  const { server, port } = await startMock({ publishStatus: ["NOT_AUTHORIZED"] });
  const { code, out } = await run(port, zip);
  server.close();
  check("NOT_AUTHORIZED exits non-zero", code !== 0, String(code));
}

// A revoked refresh token is the most likely months-later failure.
{
  const { server, port } = await startMock({ tokenStatus: 400 });
  const { code, out } = await run(port, zip);
  server.close();
  check("revoked refresh token exits non-zero", code !== 0, String(code));
  check("explains invalid_grant", /revoked or expired/.test(out), out);
}

// Wrong-shaped item id fails before any network call.
{
  const { server, port } = await startMock({});
  const { code, out } = await run(port, zip, { CHROME_EXTENSION_ID: "nbblbelngcbfijhifmbjcoehocngplpc-x" });
  server.close();
  check("bad item id exits non-zero", code !== 0, String(code));
  check("names the store URL as the source", /store URL/.test(out), out);
}

{
  const { server, port } = await startMock({});
  const { code, out } = await run(port, zip, { CHROME_REFRESH_TOKEN: "" });
  server.close();
  check("missing credential exits non-zero", code !== 0, String(code));
  check("names the missing var", /CHROME_REFRESH_TOKEN/.test(out), out);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall publish-chrome checks passed");
process.exit(failures ? 1 : 0);
