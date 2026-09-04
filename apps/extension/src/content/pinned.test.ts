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
  classifyPinned({ box, view, signature, mode, inFlow, isOverlayHost: false });

describe("classifyPinned: keep (the default)", () => {
  it("shows a partial-height sticky column once, at the top", () => {
    // 545 of 1506. Only a rail that runs the height of the window is left in
    // place on every slice; anything shorter is shown once, which is what this
    // one does on the real page and what it is expected to do.
    expect(classify(SIDEBAR, "keep", true)).toBe("top");
  });

  it("leaves a full-height navigation rail in place on every slice", () => {
    // Hiding one of these after the first slice leaves a blank column down the
    // rest of the capture, which is the complaint the exemption exists for.
    const rail: Box = { left: 0, top: 52, width: 260, height: 1440 };
    expect(classify(rail, "keep", true)).toBeNull();
  });

  it("shows the messaging dock once, even though it is the same shape as the sidebar", () => {
    // Identical geometry class — tall, narrow, hugging an edge. Only its
    // relationship to the scrolling element separates them.
    expect(classify(DOCK, "keep", false)).toBe("bottom");
  });

  it("does not need a name to tell them apart", () => {
    // Both signatures empty: this is the case hashed class names create. The
    // page's own column is shown once; the dock floating over it is not
    // treated as part of the page.
    expect(classify(SIDEBAR, "keep", true)).toBe("top");
    expect(classify(DOCK, "keep", false)).toBe("bottom");
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

describe("classifyPinned: where a floating thing lands", () => {
  // Measured on a real feed: the window's own top navigation, which is not
  // part of what scrolls and so counts as floating.
  const view: Box = { top: 0, left: 0, width: 2191, height: 1506 };
  const navButton: Box = { left: 532, top: 0, width: 140, height: 32 };
  const dock: Box = { left: 1840, top: 80, width: 360, height: 1440 };

  it("puts a floating panel at the bottom regardless of its midpoint", () => {
    // 1440 of 1506 puts its centre a hair either side of the middle depending
    // on the window; the answer must not depend on that.
    expect(classifyPinned({ box: dock, view, signature: "", mode: "keep", inFlow: false, isOverlayHost: false })).toBe("bottom");
  });

  it("leaves a floating bar where its midpoint says", () => {
    // Sending every floating thing to the bottom moved a site's top
    // navigation there — fifteen buttons and links, at the end of the capture.
    expect(classifyPinned({ box: navButton, view, signature: "", mode: "keep", inFlow: false, isOverlayHost: false })).toBe("top");
  });

  it("puts a bar pinned to the foot of the window at the bottom", () => {
    const footer: Box = { left: 0, top: 1460, width: 2191, height: 46 };
    expect(classifyPinned({ box: footer, view, signature: "", mode: "keep", inFlow: false, isOverlayHost: false })).toBe("bottom");
  });
});

describe("classifyPinned: containers standing by for an overlay", () => {
  // Measured on a real feed: seven identical shadow hosts, each floating over
  // the page with no box of its own, any one of which the page may render a
  // messaging panel into — after the sweep has already looked at them.
  const view: Box = { top: 0, left: 0, width: 2191, height: 1506 };
  const emptyHost: Box = { left: 0, top: 1506, width: 2191, height: 0 };

  it("keeps an empty overlay container instead of dropping it as a sliver", () => {
    // Measuring it gives 2191x0 — nothing. Judged on that it is discarded, and
    // whatever renders into it a moment later is photographed.
    expect(
      classifyPinned({ box: emptyHost, view, signature: "", mode: "keep", inFlow: false, isOverlayHost: false }),
    ).toBeNull();
    expect(
      classifyPinned({ box: emptyHost, view, signature: "", mode: "keep", inFlow: false, isOverlayHost: true }),
    ).toBe("bottom");
  });

  it("drops it outright when floating things are not wanted", () => {
    expect(
      classifyPinned({ box: emptyHost, view, signature: "", mode: "remove", inFlow: false, isOverlayHost: true }),
    ).toBe("always");
  });

  it("does not treat the page's own sticky furniture as one", () => {
    const rail: Box = { left: 109, top: 76, width: 222, height: 545 };
    // Shown once rather than dropped: it is the page, not an overlay.
    expect(
      classifyPinned({ box: rail, view, signature: "", mode: "keep", inFlow: true, isOverlayHost: false }),
    ).toBe("top");
  });
});

describe("classifyPinned: a panel pinned to the side is not a rail", () => {
  // Measured on Wikipedia's main page: its appearance panel, which expands
  // once the page has been scrolled. Tall, narrow and against the right edge —
  // the same shape as a navigation rail, and repeated down every slice of a
  // capture because it was exempted as one.
  const view: Box = { top: 0, left: 0, width: 1400, height: 900 };
  const appearancePanel: Box = { left: 1160, top: 40, width: 196, height: 476 };

  it("shows it once instead of leaving it on every slice", () => {
    expect(
      classifyPinned({ box: appearancePanel, view, signature: "", mode: "keep", inFlow: true, isOverlayHost: false }),
    ).toBe("top");
  });

  it("still drops it when floating things are not wanted", () => {
    expect(
      classifyPinned({ box: appearancePanel, view, signature: "", mode: "remove", inFlow: true, isOverlayHost: false }),
    ).toBe("always");
  });
});
