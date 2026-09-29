// Turning a browser's refusal into something the user can act on.
//
// The browser writes these for an extension developer, not for a person
// trying to take a screenshot:
//
//   "Cannot access a chrome:// URL"
//   "Either the '<all_urls>' or 'activeTab' permission is required."
//   "Cannot access contents of the page. Extension manifest must request
//    permission to access the respective host."
//
// Every one of them reads as a bug in this extension — the middle one reads
// as a missing permission, which sends people into their extension settings
// looking for a switch that does not exist. Usually it is a page nothing can
// ever capture, or a setting the user can change in about ten seconds.
//
// This classifies by what the browser SAID, not by the tab's URL. Reading the
// URL needs the "tabs" permission or an activeTab grant, and on exactly the
// pages this is about there is neither: chrome://settings reports a tab whose
// url and title are both empty, so a URL-driven check never fires and the raw
// text goes straight to the user. That was the whole defect.

/** Pages a browser will not let any extension touch, whatever it asks for. */
const BLOCKED_PREFIXES = [
  "chrome://",
  "edge://",
  "about:",
  "chrome-extension://",
  "moz-extension://",
  "devtools://",
  "view-source:",
  // The stores are ordinary https pages but are blocked all the same, so that
  // an extension cannot drive the page that installs or removes extensions.
  "https://chromewebstore.google.com",
  "https://chrome.google.com/webstore",
  "https://microsoftedge.microsoft.com/addons",
  "https://addons.mozilla.org",
];

export interface InjectionContext {
  /** The tab's URL, or "" when it could not be read. */
  url: string;
  /**
   * chrome.extension.isAllowedFileSchemeAccess(). Undefined when the API is
   * absent or threw — treated as "no reason to blame file access", so an
   * unrelated failure is not mislabelled as one.
   */
  fileAccessAllowed: boolean | undefined;
  /** Whatever the browser actually said. */
  rawMessage: string;
}

/**
 * Chromium does not extend activeTab to file:// pages: the user has to turn on
 * "Allow access to file URLs" per extension, and it is off by default for
 * anything installed from a store. Firefox has no such switch, which is why a
 * local file captures there and fails here — and why the same person can
 * reasonably conclude the Chrome build is broken.
 */
/**
 * What went wrong, in terms the user interface can translate.
 *
 * `raw` means nothing here recognised it: the popup shows the browser's own
 * words, which is still better than inventing a cause.
 */
export type CaptureErrorReason = "restricted-page" | "needs-refresh" | "file-access" | "raw";

/** The browser refusing because the page is one no extension may touch. */
const RESTRICTED_MESSAGES = [
  /cannot access a chrome:\/\/ url/i,
  /cannot access a chrome-extension:\/\/ url/i,
  /the extensions gallery cannot be scripted/i,
  /cannot be scripted/i,
  /^(?=.*cannot access contents of)(?=.*\b(chrome|edge|about|moz-extension|chrome-extension|devtools|view-source):)/i,
];

/**
 * Said when the extension has no grant for the tab. Two very different causes
 * share this one sentence, and they need opposite advice:
 *
 *   - a built-in page, where no grant is possible and never will be;
 *   - an ordinary page that navigated after the toolbar click, which spends
 *     the activeTab grant — a refresh and another click fixes it.
 *
 * The URL tells them apart when it can be read. On a built-in page it cannot,
 * but a built-in page is also where the message above is used instead, so the
 * ambiguity resolves the right way round: unknown URL here means an ordinary
 * page whose grant went stale, not a chrome:// page.
 */
const NO_GRANT_MESSAGES = [
  /either the '<all_urls>' or 'activetab' permission is required/i,
  /cannot access contents of the page\. extension manifest must request permission/i,
  // Firefox's wording for the same thing, and equally ambiguous there:
  // about: pages and a lapsed grant both produce it. See capture.ts, which
  // matches it for a different reason (deciding whether to retry).
  /missing host permission for the tab/i,
];

function looksBlocked(url: string): boolean {
  return url !== "" && BLOCKED_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/** Classify a failed capture. Same answer whichever of the three buttons
 * produced it, because all three now come through here. */
export function classifyCaptureFailure(ctx: InjectionContext): CaptureErrorReason {
  if (ctx.url.startsWith("file://") && ctx.fileAccessAllowed === false) return "file-access";
  if (looksBlocked(ctx.url)) return "restricted-page";
  if (RESTRICTED_MESSAGES.some((re) => re.test(ctx.rawMessage))) return "restricted-page";
  if (NO_GRANT_MESSAGES.some((re) => re.test(ctx.rawMessage))) return "needs-refresh";
  return "raw";
}

/**
 * The English text for a reason.
 *
 * The popup translates these through the catalogues and only falls back to
 * this copy; it exists so the background has something readable to throw,
 * and so a surface without the i18n runtime still says something useful.
 */
export function explainCaptureFailure(reason: CaptureErrorReason, rawMessage: string): string {
  switch (reason) {
    case "file-access":
      return (
        "Local files need one extra permission in this browser. Open the extension's " +
        'details page, turn on "Allow access to file URLs", then try again. ' +
        "(Firefox doesn't require this, which is why the same file works there.)"
      );
    case "restricted-page":
      return (
        "Your browser doesn't let extensions run on its own pages (settings, the new " +
        "tab, the extension store), so this page can't be captured. Open an ordinary " +
        "web page and try again."
      );
    case "needs-refresh":
      return "This page has moved on since the extension was opened. Reload it, then click the icon again.";
    case "raw":
      return rawMessage;
  }
}

export function explainInjectionFailure(ctx: InjectionContext): string {
  return explainCaptureFailure(classifyCaptureFailure(ctx), ctx.rawMessage);
}

/**
 * A capture failure that already knows what kind it is.
 *
 * Thrown wherever a browser refuses, so the reason survives the trip to the
 * popup instead of being re-derived from a string there. `message` is the
 * English explanation; the popup prefers its own translation of `reason` and
 * falls back to this.
 */
export class CaptureFailureError extends Error {
  readonly reason: CaptureErrorReason;
  readonly rawMessage: string;

  constructor(reason: CaptureErrorReason, rawMessage: string) {
    super(explainCaptureFailure(reason, rawMessage));
    this.name = "CaptureFailureError";
    this.reason = reason;
    this.rawMessage = rawMessage;
  }

  /** Build one from whatever a browser API threw. */
  static from(ctx: InjectionContext): CaptureFailureError {
    return new CaptureFailureError(classifyCaptureFailure(ctx), ctx.rawMessage);
  }
}
