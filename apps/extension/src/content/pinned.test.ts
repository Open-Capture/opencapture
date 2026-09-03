import { describe, expect, it } from "vitest";
import { classifyPinned, type Box, type StickyMode } from "./pinned";

/**
 * Geometry measured on a real, logged-in LinkedIn feed with the messaging dock
 * open. Every element there carries hashed class names (`_6116e3cc fe61ecd8`),
 * so none match any widget-name pattern; the signatures here are empty to keep
 * that honest, which is also what forces the classification to work on shape
 * and structure rather than on names.
 */
const BAND: Box = { top: 52, left: 0, width: 1192, height: 1410 };

// Sticky, and inside the element that scrolls: the page's own left rail.
const SIDEBAR: Box = { left: 109, top: 76, width: 222, height: 545 };
// The messaging dock: same tall-narrow-edge shape, but parked on top of the
// page rather than inside it.
const DOCK: Box = { left: 880, top: 100, width: 288, height: 1362 };

const classify = (box: Box, mode: StickyMode, inFlow: boolean, signature = "", view: Box = BAND) =>
  classifyPinned({ box, view, signature, mode, inFlow });

describe("classifyPinned: keep (the default)", () => {
  it("leaves a sidebar in place on every slice", () => {
    // Hiding it after the first slice leaves a blank column down the rest of
    // the capture, which is what the sidebar complaint was about.
    expect(classify(SIDEBAR, "keep", true)).toBeNull();
  });

  it("shows the messaging dock once, even though it is the same shape as the sidebar", () => {
    // Identical geometry class — tall, narrow, hugging an edge. Only its
    // relationship to the scrolling element separates them.
    expect(classify(DOCK, "keep", false)).toBe("bottom");
  });

  it("does not need a name to tell them apart", () => {
    // Both signatures empty: this is the case hashed class names create.
    expect(classify(SIDEBAR, "keep", true)).toBeNull();
    expect(classify(DOCK, "keep", false)).not.toBeNull();
  });

  it("still shows a named chat widget once, wherever it sits", () => {
    expect(classify(DOCK, "keep", true, "msg-overlay-list-bubble")).toBe("bottom");
  });

  it("shows a sticky header once, at the top", () => {
    expect(classify({ left: 0, top: 52, width: 1192, height: 60 }, "keep", true)).toBe("top");
  });

  it("shows a sticky footer once, at the bottom", () => {
    expect(classify({ left: 0, top: 1400, width: 1192, height: 60 }, "keep", true)).toBe("bottom");
  });

  it("leaves a wide, tall pinned column alone — that is the page itself", () => {
    expect(classify({ left: 0, top: 52, width: 900, height: 1300 }, "keep", true)).toBeNull();
  });

  it("shows a consent scrim once rather than tinting every slice", () => {
    const scrim: Box = { left: 0, top: 52, width: 1192, height: 1410 };
    expect(classify(scrim, "keep", true, "onetrust-consent-sdk")).not.toBeNull();
  });

  it("shows a corner bubble once, even inside the scrolling element", () => {
    const bubble: Box = { left: 900, top: 1150, width: 260, height: 260 };
    expect(classify(bubble, "keep", true)).toBe("bottom");
  });
});

describe("classifyPinned: remove", () => {
  it("drops everything pinned, sidebar included", () => {
    expect(classify(SIDEBAR, "remove", true)).toBe("always");
    expect(classify(DOCK, "remove", false)).toBe("always");
    expect(classify({ left: 0, top: 52, width: 1192, height: 60 }, "remove", true)).toBe("always");
  });
});

describe("classifyPinned: guards that hold in both modes", () => {
  for (const mode of ["keep", "remove"] as const) {
    it(`ignores slivers and off-band elements in ${mode}`, () => {
      expect(classify({ left: 0, top: 500, width: 20, height: 300 }, mode, true)).toBeNull();
      expect(classify({ left: 0, top: 500, width: 300, height: 4 }, mode, true)).toBeNull();
      expect(classify({ left: 0, top: -900, width: 300, height: 100 }, mode, true)).toBeNull();
    });
  }
});
