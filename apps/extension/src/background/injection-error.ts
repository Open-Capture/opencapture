// Turning a browser's refusal to inject into something the user can act on.
//
// Chromium's message for all of these is the same and is written for an
// extension developer, not a person trying to take a screenshot:
//
//   "Cannot access contents of the page. Extension manifest must request
//    permission to access the respective host."
//
// It reads as a bug in the extension. Usually it is a setting the user can
// change in about ten seconds, or a page nothing can ever capture.

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
export function explainInjectionFailure(ctx: InjectionContext): string {
  if (ctx.url.startsWith("file://") && ctx.fileAccessAllowed === false) {
    return (
      "Local files need one extra permission in this browser. Open the extension's " +
      'details page, turn on "Allow access to file URLs", then try again. ' +
      "(Firefox doesn't require this, which is why the same file works there.)"
    );
  }
  if (BLOCKED_PREFIXES.some((prefix) => ctx.url.startsWith(prefix))) {
    return "This browser doesn't let extensions run on this page, so it can't be captured.";
  }
  return ctx.rawMessage;
}
