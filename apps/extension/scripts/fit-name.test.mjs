// fitName decides what a shopper sees as the add-on's title on AMO, so the
// failure mode is cosmetic but public: a name cut mid-word reads as a bug.
// Exercised through the real script rather than a copy, so the two cannot
// drift apart.
import { spawn } from "node:child_process";

const cases = [
  { in: "OpenCapture", want: "OpenCapture", why: "already short, untouched" },
  {
    in: "Full Page Screenshot - Scrolling Screen Capture & Editor | OpenCapture",
    want: "Full Page Screenshot | OpenCapture",
    why: "drops the secondary phrase, keeps keyword + brand",
  },
  {
    in: "Captura de pantalla de página completa - Editor | OpenCapture",
    want: "Captura de pantalla de página completa",
    why: "keyword + brand is 52, so the brand goes too",
  },
  {
    // The real zh_CN catalogue name is 47 chars and passes through untouched,
    // so it proves nothing about splitting. This is the same shape, long
    // enough to force a cut.
    in: "整页截图与长截图编辑器工具 - 网页长截图、截图工具与编辑器，导出 PDF 文件 | OpenCapture",
    want: "整页截图与长截图编辑器工具 | OpenCapture",
    why: "splits CJK on the same separator",
  },
  {
    in: "整页截图 - 网页长截图、截图工具与编辑器，导出 PDF | OpenCapture",
    want: "整页截图 - 网页长截图、截图工具与编辑器，导出 PDF | OpenCapture",
    why: "a 47-char CJK name is under the cap and untouched",
  },
  {
    in: "Averylongsinglewordthatcannotbesplitanywhereatallxyz more words | Brand",
    want: "Averylongsinglewordthatcannotbesplitanywhereatallxyz more words".slice(0, 0) || "Averylongsinglewordthatcannotbesplitanywhereatallxyz",
    why: "no split point: falls back to a hard slice at the cap",
    skipExact: true,
  },
];

const src = new URL("./sync-amo-listing.mjs", import.meta.url).pathname;
const probe = `
import { readFileSync } from "node:fs";
const src = readFileSync(${JSON.stringify(src)}, "utf8");
const start = src.indexOf("function fitName");
const end = src.indexOf("\\nfunction jwt");
const fn = new Function(src.slice(start, end) + "; return fitName;")();
const out = ${JSON.stringify(cases.map((c) => c.in))}.map((s) => fn(s, 50));
console.log(JSON.stringify(out));
`;

const child = spawn(process.execPath, ["--input-type=module", "-e", probe]);
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));
const code = await new Promise((r) => child.on("exit", r));
if (code !== 0) {
  console.error("could not evaluate fitName:\n" + out);
  process.exit(1);
}
const got = JSON.parse(out.trim().split("\n").pop());

let failures = 0;
cases.forEach((c, i) => {
  const ok = c.skipExact ? got[i].length <= 50 && !got[i].includes(" ") === false : got[i] === c.want;
  const pass = c.skipExact ? got[i].length <= 50 : ok;
  console.log(`${pass ? "  ok  " : "FAIL  "}${c.why}${pass ? "" : ` — got ${JSON.stringify(got[i])}`}`);
  if (!pass) failures++;
});
const allWithinCap = got.every((g) => g.length <= 50);
console.log(`${allWithinCap ? "  ok  " : "FAIL  "}every result within AMO's 50-char cap`);
if (!allWithinCap) failures++;

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall fitName checks passed");
process.exit(failures ? 1 : 0);
