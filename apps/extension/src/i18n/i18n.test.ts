/**
 * The checks that stop a half-translated interface shipping.
 *
 * A missing entry is invisible at runtime *by design* — `t()` falls back
 * to the English it was written in, which is what keeps the product
 * usable when a translation is late. These are what stop that fallback
 * hiding a gap for a release or two.
 */
import { describe, expect, it } from "vitest";
import { CATALOGUES, LOCALES, missing, resolveLocale, setLocale, t } from "./index";

/** English is implicit — the keys *are* the English — so a written
 * catalogue is the reference for what the key set is. */
const REFERENCE = "zh-Hans";
const KEYS = Object.keys(CATALOGUES[REFERENCE]!);

/**
 * Cells that are legitimately identical to their English source.
 *
 * Allowlisted one by one rather than by loosening the check: "Text" and
 * "Downloads" really are the German words, "Zoom" is the loanword three
 * of these languages use, and "Error" is Spanish. Anything else matching
 * English is a row somebody pasted and never came back to.
 */
const SAME_AS_ENGLISH = new Set([
  "de Text",
  "de Zoom",
  "es Zoom",
  "pt Zoom",
  "de Downloads",
  "pt Downloads",
  "de OpenCapture Editor",
  "es Error: {error}",
]);

describe("catalogues", () => {
  it("has one for every language the picker offers", () => {
    const offered = LOCALES.map((l) => l.code);
    expect(offered.filter((code) => !(code in CATALOGUES))).toEqual([]);
    // And nothing shipped that the picker never lists, which would be a
    // catalogue nobody can reach.
    expect(Object.keys(CATALOGUES).filter((c) => !offered.includes(c))).toEqual([]);
  });

  it("covers the same keys in every language", () => {
    expect(KEYS.length).toBeGreaterThan(100);
    for (const { code } of LOCALES) {
      expect({ code, missing: missing(code, KEYS) }).toEqual({ code, missing: [] });
    }
  });

  it("has no key a catalogue carries that the others do not", () => {
    for (const { code } of LOCALES) {
      if (code === "en") continue;
      const extra = Object.keys(CATALOGUES[code]!).filter((k) => !KEYS.includes(k));
      expect({ code, extra }).toEqual({ code, extra: [] });
    }
  });

  it("never leaves a value sitting at its English source", () => {
    const untranslated: string[] = [];
    for (const { code } of LOCALES) {
      if (code === "en") continue;
      for (const [key, value] of Object.entries(CATALOGUES[code]!)) {
        if (value === key && !SAME_AS_ENGLISH.has(`${code} ${key}`)) {
          untranslated.push(`${code}: ${key}`);
        }
      }
    }
    expect(untranslated).toEqual([]);
  });

  it("keeps every placeholder the English string had", () => {
    const placeholders = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(",");
    const broken: string[] = [];
    for (const { code } of LOCALES) {
      if (code === "en") continue;
      for (const [key, value] of Object.entries(CATALOGUES[code]!)) {
        // A dropped {filename} renders a sentence that promises a name and
        // never says one; a renamed one interpolates nothing at all.
        if (placeholders(key) !== placeholders(value)) broken.push(`${code}: ${key}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("t()", () => {
  it("falls back to English for a key no catalogue has", () => {
    setLocale("ja", { persist: false });
    expect(t("Some string nobody has translated")).toBe("Some string nobody has translated");
    setLocale("en", { persist: false });
  });

  it("interpolates vars in every language", () => {
    for (const { code } of LOCALES) {
      setLocale(code, { persist: false });
      const out = t("Saved as {filename}.", { filename: "shot.pdf" });
      expect(out).toContain("shot.pdf");
      expect(out).not.toContain("{filename}");
    }
    setLocale("en", { persist: false });
  });
});

describe("resolveLocale", () => {
  it("takes an exact tag", () => {
    expect(resolveLocale(["ja"])).toBe("ja");
    expect(resolveLocale(["zh-Hant"])).toBe("zh-Hant");
  });

  it("widens a region to its base language", () => {
    expect(resolveLocale(["de-AT"])).toBe("de");
    expect(resolveLocale(["pt-BR"])).toBe("pt");
  });

  it("sends Traditional regions to Hant, not to Hans", () => {
    // The step that matters: without it zh-TW falls through to `zh`, gets
    // Simplified, and a Taiwanese reader is handed the wrong script —
    // which is worse than being handed English.
    for (const tag of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant-TW"]) {
      expect(resolveLocale([tag])).toBe("zh-Hant");
    }
    for (const tag of ["zh", "zh-CN", "zh-SG", "zh-Hans-CN"]) {
      expect(resolveLocale([tag])).toBe("zh-Hans");
    }
  });

  it("skips languages we do not ship and keeps looking", () => {
    expect(resolveLocale(["fi", "nb", "ko"])).toBe("ko");
  });

  it("falls back to English when nothing matches", () => {
    expect(resolveLocale(["fi", "is"])).toBe("en");
    expect(resolveLocale([])).toBe("en");
  });
});
