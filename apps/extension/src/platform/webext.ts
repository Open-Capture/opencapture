// The single place shared source code reads the WebExtension API from,
// instead of calling `chrome.*` directly. Chrome doesn't define a
// `browser` global; Firefox does (natively, promise-based, and has since
// before Chrome's own promise support existed). Detecting it at runtime
// means the exact same compiled bundle works unmodified on both browsers
// — only the manifest (background model, browser_specific_settings) needs
// a separate build; see vite.config.ts / copy-static.mjs.
//
// Typed as `typeof chrome` on both branches: the WebExtensions API
// surface this extension actually uses (tabs, storage, scripting,
// downloads, runtime messaging) is common to both browsers, so reusing
// @types/chrome's shapes avoids pulling in a second types package for a
// nearly-identical API.
export const ext: typeof chrome = (globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome;

/**
 * True on Firefox.
 *
 * Not `"browser" in globalThis`, which is the obvious test and is wrong:
 * Chromium ships a `browser` alias of its own, so that check reports Firefox
 * everywhere. Verified in the E2E Chromium, which answers `true` to it — and
 * getting this backwards would have defaulted a Firefox-only save behaviour
 * on for Chrome users too.
 *
 * `runtime.getBrowserInfo` is genuinely Firefox-only and exists both in the
 * background context and in extension pages, which matters because callers
 * include save-prefs running in the worker, where there is no `window`.
 */
export const isFirefox: boolean =
  // Optional-chained because this is evaluated at module load, and webext's
  // own unit tests substitute an `ext` with no `runtime` at all.
  typeof (ext.runtime as { getBrowserInfo?: unknown } | undefined)?.getBrowserInfo === "function";

/**
 * How many `tabs.captureVisibleTab` calls a second the browser allows, or
 * null when it does not say.
 *
 * Chromium has been hard-capped at 2 since Chrome 92 with no override, and
 * declares it as `chrome.tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` —
 * undeclared in @types/chrome, hence the cast.
 *
 * Firefox declares nothing, and this used to assume that meant "2 as well".
 * It does not: Firefox has no such quota, and pacing to Chromium's cost half
 * a second per slice on every Firefox capture for a limit that was never
 * there. A browser that declares no limit is now paced by nothing, and the
 * retry in chrome/capture.ts covers the case where one turns out to exist
 * after all — a wrong guess costs one retry, not half a second a slice.
 */
export function captureRateLimit(): number | null {
  const tabsApi = ext.tabs as typeof chrome.tabs & { MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND?: number };
  const declared = tabsApi.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND;
  // A declared 0 is not a rate; treat it as "unspecified" rather than
  // dividing by it.
  return typeof declared === "number" && declared > 0 ? declared : null;
}
