/**
 * Translation, with no runtime dependency.
 *
 * ## Why the English text is the key
 *
 * `t("Save as PNG")` rather than `t("popup.savePng")`. That is gettext's
 * convention and Apple's, and it earns its place three times:
 *
 * - **A missing translation degrades to English**, not to `popup.savePng`
 *   on a button. With eight catalogues there is always a gap somewhere,
 *   and the failure has to be survivable.
 * - **The replacement is mechanical.** Wrapping a literal cannot change
 *   what the interface says — which is what lets `localizeDom` below
 *   translate four pages of markup without editing any of it.
 * - **The catalogue reads as prose**, so whoever revises a translation
 *   sees the sentence rather than an identifier to go and look up.
 *
 * The cost is that editing English copy orphans its translations. That is
 * the right trade: a changed sentence *should* be re-translated, and
 * `missing()` makes the gap loud in the test instead of silent on screen.
 *
 * ## Why no library
 *
 * i18next and its peers bring a store layer, an ICU parser and async
 * loading. This is a browser extension: the popup is opened and torn down
 * constantly, and it must paint immediately with no network. Eight
 * catalogues of ~160 short strings are a few KB gzipped, so they are
 * imported statically — no loading state, and no flash of untranslated
 * text on the popup's very first frame.
 *
 * ## Why not chrome.i18n
 *
 * The browser's own mechanism cannot do either half of what is wanted
 * here. Its keys must match `[A-Za-z0-9_]`, so an English sentence cannot
 * be one — the fallback above would be impossible. And it resolves
 * against the *browser's* UI language with no override, so a language
 * picker cannot exist. `public/_locales` still uses it for the store
 * listing, where both constraints are fine.
 */
import { DEFAULT_LOCALE, resolveLocale } from "./locales";
import de from "./de";
import es from "./es";
import ja from "./ja";
import ko from "./ko";
import pt from "./pt";
import zhHans from "./zh-Hans";
import zhHant from "./zh-Hant";

export { LOCALES, DEFAULT_LOCALE, resolveLocale } from "./locales";
export type { LocaleDef } from "./locales";

export type Catalogue = Record<string, string>;

export const CATALOGUES: Record<string, Catalogue> = {
  en: {}, // English is the key set; there is nothing to look up.
  de,
  es,
  ja,
  ko,
  pt,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
};

const STORAGE_KEY = "opencapture.locale";

let locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

export function getLocale(): string {
  return locale;
}

/**
 * Called when the locale changes, so a page can re-render what `t()`
 * already returned. Plain DOM has no reactivity of its own, and a
 * language picker that needs a reload is not a language picker.
 */
export function onLocaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setLocale(next: string, options: { persist?: boolean } = {}): void {
  if (!(next in CATALOGUES)) return;
  locale = next;
  if (typeof document !== "undefined") {
    // Not cosmetic: `lang` is what picks the right glyphs for Han
    // characters — the same codepoint is drawn differently in Japanese and
    // Chinese — and what a screen reader switches voice on.
    document.documentElement.lang = next;
  }
  if (options.persist !== false) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private browsing, or storage disabled. The choice still applies
      // for as long as this page is open, which is the best available.
    }
  }
  for (const fn of listeners) fn();
}

/**
 * Reads the stored choice, else what the browser asks for.
 *
 * Called from each page rather than at module scope: this module is
 * reachable from the service worker, which has neither `window` nor
 * `localStorage`.
 */
export function initLocale(): void {
  if (typeof window === "undefined") return;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // See setLocale — the browser's own preference is a good enough answer.
  }
  const preferred = stored ? [stored] : [...(navigator.languages ?? [navigator.language])];
  setLocale(resolveLocale(preferred), { persist: false });
}

/**
 * Translate `text`, falling back to the English it was written in.
 *
 * `vars` interpolates `{name}` placeholders. Deliberately small — no
 * plural rules, no date formats — because nothing in this interface needs
 * them yet, and `Intl.PluralRules` is there for the day it does.
 */
export function t(text: string, vars?: Record<string, string | number>): string {
  const table = CATALOGUES[locale];
  let out = (table && table[text]) || text;
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      out = out.replaceAll(`{${key}}`, String(value));
    }
  }
  return out;
}

/**
 * Which keys a locale has no translation for. Used by the i18n test, so a
 * new English string cannot quietly ship untranslated in seven languages.
 */
export function missing(code: string, keys: readonly string[]): string[] {
  if (code === "en") return [];
  const table = CATALOGUES[code];
  if (!table) return [...keys];
  return keys.filter((k) => !(k in table));
}

// --- translating markup that was written in English ---------------------
//
// The four pages are plain HTML with their English text inline, and it
// stays that way: the markup is the fallback, and leaving it alone means
// no `data-i18n` bookkeeping to forget on a new element. This walks the
// tree instead and swaps anything whose exact text is a key we hold.
//
// Conservative on purpose. A wrong swap changes what the interface says,
// so an unrecognised string is left exactly as it is rather than guessed
// at — see the skill's note on wrapping only what is already a key.

/** Attributes that carry prose a person reads or hears. */
const LOCALIZED_ATTRS = ["title", "placeholder", "aria-label", "alt"] as const;

/**
 * The English a node started with.
 *
 * Once a node has been translated its text is no longer the key, so a
 * second pass in another language would find nothing. Remembering the
 * original keeps every later switch working from the same source. A
 * WeakMap rather than a data attribute: nothing is added to the DOM, and
 * the entries go when the nodes do.
 */
const originalText = new WeakMap<Node, string>();
const originalAttrs = new WeakMap<Element, Record<string, string>>();

/** Never translated: the wordmark is a name, not a word. */
function isExcluded(el: Element | null): boolean {
  for (let node = el; node; node = node.parentElement) {
    if (node.hasAttribute?.("data-i18n-skip")) return true;
  }
  return false;
}

/**
 * Translate every recognised string under `root`, in place.
 *
 * Safe to call repeatedly — that is how switching language works — and
 * safe to call on a subtree that was just built, which is what the
 * history list and the account panel do after rendering.
 */
export function localizeDom(root: ParentNode = document.body): void {
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") return NodeFilter.FILTER_REJECT;
      if (isExcluded(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);

  for (const node of texts) {
    let source = originalText.get(node);
    if (source === undefined) {
      source = (node.textContent ?? "").trim();
      if (!source) continue;
      originalText.set(node, source);
    }
    const translated = t(source);
    if (translated === node.textContent) continue;
    // Whitespace around the text is layout, not content: a label written
    // across three indented lines must not collapse onto one when it is
    // translated, or the spacing shifts on every non-English locale.
    const raw = node.textContent ?? "";
    const lead = raw.slice(0, raw.length - raw.trimStart().length);
    const tail = raw.slice(raw.trimEnd().length);
    node.textContent = `${lead}${translated}${tail}`;
  }

  const elements = [
    ...(root instanceof Element ? [root] : []),
    ...Array.from(root.querySelectorAll("*")),
  ];
  for (const el of elements) {
    if (isExcluded(el)) continue;
    let sources = originalAttrs.get(el);
    if (sources === undefined) {
      sources = {};
      for (const attr of LOCALIZED_ATTRS) {
        const value = el.getAttribute(attr);
        if (value && value.trim()) sources[attr] = value.trim();
      }
      originalAttrs.set(el, sources);
    }
    for (const [attr, source] of Object.entries(sources)) {
      const translated = t(source);
      if (el.getAttribute(attr) !== translated) el.setAttribute(attr, translated);
    }
  }
}

/**
 * The tab title, which the walk above cannot reach.
 *
 * `<title>` lives in `<head>`, and `localizeDom` starts at `<body>` — so
 * the editor and history tabs kept an English name in every language
 * until this was added. It is the label on the tab strip and what a
 * window switcher shows, so it is worth having.
 */
let originalTitle: string | null = null;

function localizeTitle(): void {
  if (typeof document === "undefined") return;
  if (originalTitle === null) originalTitle = document.title.trim();
  if (originalTitle) document.title = t(originalTitle);
}

/**
 * Wire a page up: pick the locale, translate what is on screen, and keep
 * translating it whenever the locale changes.
 */
export function initPageLocale(root: ParentNode = document.body): void {
  initLocale();
  localizeDom(root);
  localizeTitle();
  onLocaleChange(() => {
    localizeDom(root);
    localizeTitle();
  });
}
