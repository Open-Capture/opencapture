/**
 * A translated string is no use if the code writes English over it.
 *
 * APP-63: "Downloads" in the editor's save panel stayed English in every
 * language. Not a missing translation — the catalogues all had it — but a
 * line that assigned the literal instead of calling `t()`. `localizeDom`
 * cannot save it either: the walk translates what the markup shipped with,
 * and this runs afterwards, overwriting the result.
 *
 * tisha found the one that shows on the busiest screen. There were ten more
 * exactly like it, which is what this test is for: it reads the source and
 * fails on any user-facing literal that is also a key we hold.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOGUES } from "./index";

const src = join(dirname(dirname(fileURLToPath(import.meta.url))));

/** Every page that renders to a person. Not the service worker, which has
 * no UI, and not the content script, which is import-free by design. */
const PAGES = [
  "popup/popup.ts",
  "editor/editor.ts",
  "account/account.ts",
  "history/history.ts",
];

/** Assignments a person reads the result of. */
const SINK = /(?:textContent|\.title|placeholder|ariaLabel|alt)\s*=\s*(?:.*?\?\s*)?[^;]*?"((?:[^"\\]|\\.)+)"/g;

describe("no user-facing literal escapes translation", () => {
  const keys = new Set(Object.keys(CATALOGUES["zh-Hans"]!));

  it("has a catalogue to check against", () => {
    expect(keys.size).toBeGreaterThan(100);
  });

  for (const page of PAGES) {
    it(`${page} calls t() for every string it has a translation for`, () => {
      const text = readFileSync(join(src, page), "utf8");
      const unwrapped: string[] = [];
      text.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(SINK)) {
          const literal = m[1]!;
          const value = literal.replace(/\\"/g, '"');
          if (!keys.has(value)) continue;
          // `t("…` immediately before the literal is the wrapped form. The
          // opening quote sits between the call and the text, so it has to
          // be allowed for — without it every wrapped call reads as a bare
          // literal and the check flags the whole file.
          const before = line.slice(0, m.index! + m[0].lastIndexOf(literal));
          if (/t\(\s*["'`]$/.test(before)) continue;
          unwrapped.push(`${page}:${i + 1}  ${JSON.stringify(value)}`);
        }
      });
      expect(unwrapped).toEqual([]);
    });
  }
});
