import { describe, expect, it } from "vitest";
import { classifyCaptureFailure, explainCaptureFailure, explainInjectionFailure } from "./injection-error";

/** The exact sentences the browsers produce, as measured on Chromium 2026-09-29. */
const RAW_HOST = "Cannot access contents of the page. Extension manifest must request permission to access the respective host.";
const RAW_CHROME_URL = "Cannot access a chrome:// URL";
const RAW_NO_PERMISSION = "Either the '<all_urls>' or 'activeTab' permission is required.";
const RAW_GALLERY = "The extensions gallery cannot be scripted.";

const on = (rawMessage: string, url = "", fileAccessAllowed: boolean | undefined = undefined) =>
  classifyCaptureFailure({ url, fileAccessAllowed, rawMessage });

describe("classifyCaptureFailure", () => {
  // The defect this whole module was rewritten for: the tab's URL is empty on
  // exactly the pages that need explaining, because reading it needs a
  // permission the extension does not hold. Classification must not depend on
  // it.
  it("recognises a browser page from the message alone, with no URL to go on", () => {
    expect(on(RAW_CHROME_URL)).toBe("restricted-page");
    expect(on(RAW_GALLERY)).toBe("restricted-page");
  });

  it("still recognises one from the URL when the URL happens to be readable", () => {
    for (const url of ["chrome://extensions", "edge://settings", "about:addons", "view-source:https://example.com", "https://addons.mozilla.org/en-US/firefox/"]) {
      expect(on(RAW_HOST, url, true)).toBe("restricted-page");
    }
  });

  // Two causes, one sentence. An ordinary page that navigated after the click
  // gets "reload and click again"; a chrome:// tab must not, which is why the
  // orchestrator probes by injecting before trusting this answer.
  it("treats a bare permission complaint as a grant that went stale", () => {
    expect(on(RAW_NO_PERMISSION)).toBe("needs-refresh");
    expect(on(RAW_HOST)).toBe("needs-refresh");
    // Firefox says it differently and is ambiguous in the same way.
    expect(on("Missing host permission for the tab")).toBe("needs-refresh");
  });

  it("tells a local-file user which setting to turn on", () => {
    expect(on(RAW_HOST, "file:///Users/me/page.html", false)).toBe("file-access");
  });

  it("does not blame file access when the switch is already on, or unknown", () => {
    expect(on(RAW_HOST, "file:///tmp/a.html", true)).not.toBe("file-access");
    expect(on(RAW_HOST, "file:///tmp/a.html", undefined)).not.toBe("file-access");
  });

  it("leaves an unrecognised failure alone", () => {
    expect(on("network error", "https://example.com", true)).toBe("raw");
  });
});

describe("explainCaptureFailure", () => {
  it("says what the reader can do about a browser page, without jargon", () => {
    const msg = explainCaptureFailure("restricted-page", RAW_CHROME_URL);
    expect(msg).toContain("ordinary web page");
    // The browser's own words must not survive into it: "Cannot access a
    // chrome:// URL" is the thing being replaced.
    expect(msg).not.toContain("chrome://");
  });

  it("names the file-URL switch, and Firefox", () => {
    const msg = explainCaptureFailure("file-access", RAW_HOST);
    expect(msg).toContain("Allow access to file URLs");
    // Nearly always reported as "it works in Firefox but not Chrome", and the
    // difference is real rather than a bug.
    expect(msg).toContain("Firefox");
  });

  it("passes the browser's own words through when nothing recognised them", () => {
    expect(explainCaptureFailure("raw", "network error")).toBe("network error");
  });
});

describe("explainInjectionFailure", () => {
  it("still explains a chrome:// page end to end", () => {
    expect(explainInjectionFailure({ url: "", fileAccessAllowed: undefined, rawMessage: RAW_CHROME_URL })).toContain("ordinary web page");
  });

  it("passes an ordinary page's unrelated failure through untouched", () => {
    expect(explainInjectionFailure({ url: "https://example.com", fileAccessAllowed: true, rawMessage: "network error" })).toBe("network error");
  });
});
