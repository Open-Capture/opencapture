// Exercises the locale-discovery loop against a stand-in for AMO.
//
// This writes to a live public store page with no review in front of it, so
// the retry logic must not be shipped on the strength of one production run.
// The shape being handled is easy to get wrong and was: AMO reports field
// errors as an array of message strings, not an object keyed by locale, and
// it names only the codes it reached before giving up — so a single pass
// cannot learn the whole rejected set.
import { createServer } from "node:http";
import { spawn } from "node:child_process";

// Must be codes that actually reach the request, or the retry loop under test
// is never entered. They have to survive the PROD_LANGUAGES filter, and the
// mock keys off `summary` rather than `name` because the 50-char name cap
// leaves only the CJK locales in that field.
const REJECT = ["hr", "ro", "fi"];

function startMock() {
  const state = { attempts: 0, finalPayload: null, auth: null };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      state.attempts++;
      state.auth = req.headers.authorization;
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const offender = REJECT.find((l) => payload.summary && l in payload.summary);
      if (offender) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ summary: [`The language code "${offender}" is invalid.`] }));
      }
      state.finalPayload = payload;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: payload.name ?? {}, summary: payload.summary ?? {}, description: payload.description ?? {} }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port, state })));
}

const { server, port, state } = await startMock();
const child = spawn(
  process.execPath,
  [new URL("./sync-amo-listing.mjs", import.meta.url).pathname, "--apply"],
  {
    env: { ...process.env, AMO_API_ROOT: `http://127.0.0.1:${port}`, WEB_EXT_API_KEY: "key", WEB_EXT_API_SECRET: "secret" },
  },
);
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));
const code = await new Promise((r) => child.on("exit", r));
server.close();

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${ok ? "" : " — " + detail}`);
  if (!ok) failures++;
};

check("succeeds after dropping rejected locales", code === 0, out);
check("retried once per rejected locale", state.attempts === REJECT.length + 1, `attempts=${state.attempts}`);
check("sends JWT auth", /^JWT /.test(state.auth ?? ""), state.auth);
check(
  "rejected locales absent from final payload",
  REJECT.every((l) => state.finalPayload && !(l in (state.finalPayload.summary ?? {}))),
  JSON.stringify(Object.keys(state.finalPayload?.summary ?? {})),
);
check(
  "rejected locales also dropped from description",
  REJECT.every((l) => state.finalPayload && !(l in (state.finalPayload.description ?? {}))),
  "description still carried a rejected locale",
);
check("kept the locales AMO accepts", Object.keys(state.finalPayload?.summary ?? {}).includes("zh-CN"), out);
// Assert the invariant, not a frozen locale list: before fitName only the CJK
// names fit, and hardcoding that set meant this check failed the moment the
// shortening started doing its job.
{
  const names = Object.values(state.finalPayload?.name ?? {});
  check("every name within AMO's 50-char cap", names.length > 0 && names.every((n) => n.length <= 50),
    JSON.stringify(names.filter((n) => n.length > 50)));
}
check("reports what AMO refused", REJECT.every((l) => out.includes(l)), out);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall sync-amo-listing checks passed");
process.exit(failures ? 1 : 0);
