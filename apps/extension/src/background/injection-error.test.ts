import { describe, expect, it } from "vitest";
import { explainInjectionFailure } from "./injection-error";

const RAW = "Cannot access contents of the page. Extension manifest must request permission to access the respective host.";

describe("explainInjectionFailure", () => {
  it("tells a local-file user which setting to turn on", () => {
    const msg = explainInjectionFailure({ url: "file:///Users/me/page.html", fileAccessAllowed: false, rawMessage: RAW });
    expect(msg).toContain("Allow access to file URLs");
    // Naming Firefox matters: this is nearly always reported as "it works in
    // Firefox but not Chrome", and the difference is real rather than a bug.
    expect(msg).toContain("Firefox");
  });

  it("keeps the raw message for a file URL when access is already allowed", () => {
    // Something else went wrong; blaming file access would send them to a
    // switch that is already on.
    expect(explainInjectionFailure({ url: "file:///tmp/a.html", fileAccessAllowed: true, rawMessage: RAW })).toBe(RAW);
  });

  it("keeps the raw message when the file-access state is unknown", () => {
    expect(explainInjectionFailure({ url: "file:///tmp/a.html", fileAccessAllowed: undefined, rawMessage: RAW })).toBe(RAW);
  });

  it.each([
    "chrome://extensions",
    "edge://settings",
    "about:addons",
    "view-source:https://example.com",
    "https://chromewebstore.google.com/detail/abc",
    "https://addons.mozilla.org/en-US/firefox/",
  ])("explains that %s can never be captured", (url) => {
    const msg = explainInjectionFailure({ url, fileAccessAllowed: true, rawMessage: RAW });
    expect(msg).toContain("doesn't let extensions run on this page");
  });

  it("passes an ordinary page's failure through untouched", () => {
    expect(explainInjectionFailure({ url: "https://example.com", fileAccessAllowed: true, rawMessage: "network error" })).toBe("network error");
  });

  it("passes through when the URL could not be read", () => {
    expect(explainInjectionFailure({ url: "", fileAccessAllowed: false, rawMessage: RAW })).toBe(RAW);
  });
});
