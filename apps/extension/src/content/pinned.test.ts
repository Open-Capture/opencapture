import { describe, expect, it } from "vitest";
import { classifyPinned, type Box, type StickyMode } from "./pinned";

/**
 * Geometry taken from a real, logged-in LinkedIn feed with the messaging dock
 * open — read out of the page rather than imagined. Every element there
 * carries hashed class names (`_6116e3cc fe61ecd8`), so none of them match any
 * widget-name pattern; the signature is deliberately empty here to keep that
 * honest.
 *
 * The viewport width is known from a full-width fixed bar the page reported at
 * 1166px. The height is only known to be greater than 1205 (a fixed bar sits at
 * that y), so the cases below sweep a range of plausible heights.
 */
const HEIGHTS = [1210, 1229, 1280, 1360, 1440];
const VIEW = (height: number): Box => ({ top: 0, left: 0, width: 1166, height });

const SIDEBAR: Box = { left: 97, top: 76, width: 222, height: 625 };
const FULL_WIDTH_BAR: Box = { left: 0, top: 1205, width: 1166, height: 0 };

// Anchored to the bottom of the viewport, so its `top` is a function of the
// viewport height rather than a constant — modelling it as fixed while growing
// the viewport describes a dock detaching from the bottom edge, which is not a
// thing that happens.
const DOCK_GAP_BELOW = 51;
const dockAt = (viewportHeight: number, gap = DOCK_GAP_BELOW): Box => ({
  left: 753,
  top: viewportHeight - gap - 408,
  width: 304,
  height: 408,
});

const classify = (box: Box, view: Box, signature: string, mode: StickyMode) =>
  classifyPinned({ box, view, signature, mode });

describe("classifyPinned: the default, which shows everything once", () => {
  const view = VIEW(1000);

  it("shows a corner dock once at the bottom rather than dropping it", () => {
    for (const height of HEIGHTS) {
      expect(classify(dockAt(height), VIEW(height), "", "once")).toBe("bottom");
    }
  });

  it("shows a named chat widget once too — the name stops mattering", () => {
    const dock: Box = { left: 700, top: 700, width: 300, height: 260 };
    expect(classify(dock, view, "msg-overlay-bubble", "once")).toBe("bottom");
  });

  it("shows a sticky header once, at the top", () => {
    expect(classify({ left: 0, top: 0, width: 1166, height: 60 }, view, "", "once")).toBe("top");
  });

  it("shows a sticky footer once, at the bottom", () => {
    expect(classify({ left: 0, top: 940, width: 1166, height: 60 }, view, "", "once")).toBe("bottom");
  });

  it("still leaves a wide, tall pinned column alone — that is the page, not chrome", () => {
    expect(classify({ left: 0, top: 0, width: 800, height: 900 }, view, "", "once")).toBeNull();
  });

  it("shows a consent scrim once rather than tinting every slice", () => {
    // Full-screen, so the content test above would otherwise wave it through
    // and leave it over the whole capture.
    const scrim: Box = { left: 0, top: 0, width: 1166, height: 1000 };
    expect(classify(scrim, view, "onetrust-consent-sdk", "once")).not.toBeNull();
  });
});

describe("classifyPinned: hide-overlays", () => {
  const view = VIEW(1000);

  it("drops the dock entirely, by shape, with no usable name", () => {
    for (const height of HEIGHTS) {
      expect(classify(dockAt(height), VIEW(height), "", "hide-overlays")).toBe("always");
    }
  });

  it("drops anything named like a chat or consent widget, whatever its shape", () => {
    const huge: Box = { left: 0, top: 0, width: 1166, height: 1000 };
    expect(classify(huge, view, "onetrust-consent-sdk", "hide-overlays")).toBe("always");
    expect(classify(huge, view, "msg-overlay-bubble", "hide-overlays")).toBe("always");
  });

  it("keeps the sticky sidebar, which is content and not a widget", () => {
    for (const height of HEIGHTS) {
      expect(classify(SIDEBAR, VIEW(height), "", "hide-overlays")).toBe("top");
    }
  });

  it("keeps a plain header and footer, showing each once", () => {
    expect(classify({ left: 0, top: 0, width: 1166, height: 60 }, view, "", "hide-overlays")).toBe("top");
    expect(classify({ left: 0, top: 940, width: 1166, height: 60 }, view, "", "hide-overlays")).toBe("bottom");
  });
});

describe("classifyPinned: hide-all", () => {
  const view = VIEW(1000);

  it("drops every pinned element, header and dock alike", () => {
    expect(classify({ left: 0, top: 0, width: 1166, height: 60 }, view, "", "hide-all")).toBe("always");
    expect(classify(dockAt(1000), view, "", "hide-all")).toBe("always");
    expect(classify(SIDEBAR, view, "", "hide-all")).toBe("always");
  });

  it("still ignores things too small or too far away to be worth touching", () => {
    expect(classify({ left: 0, top: 500, width: 20, height: 300 }, view, "", "hide-all")).toBeNull();
    expect(classify({ left: 0, top: -400, width: 300, height: 100 }, view, "", "hide-all")).toBeNull();
  });
});

describe("classifyPinned: guards that hold in every mode", () => {
  const view = VIEW(1229);

  it("ignores the zero-height full-width bar entirely", () => {
    for (const mode of ["once", "hide-overlays", "hide-all"] as const) {
      expect(classify(FULL_WIDTH_BAR, view, "", mode)).toBeNull();
    }
  });

  it("ignores slivers too small to be worth hiding", () => {
    for (const mode of ["once", "hide-overlays", "hide-all"] as const) {
      expect(classify({ left: 0, top: 500, width: 20, height: 300 }, view, "", mode)).toBeNull();
      expect(classify({ left: 0, top: 500, width: 300, height: 4 }, view, "", mode)).toBeNull();
    }
  });

  it("ignores anything that misses the captured band", () => {
    for (const mode of ["once", "hide-overlays", "hide-all"] as const) {
      expect(classify({ left: 0, top: -400, width: 300, height: 100 }, view, "", mode)).toBeNull();
    }
  });
});
