import { describe, expect, it } from "vitest";
import { classifyPinned, type Box } from "./pinned";

/**
 * Geometry taken from a real, logged-in LinkedIn feed with the messaging
 * dock open — read out of the page rather than imagined. Every element there
 * carries hashed class names (`_6116e3cc fe61ecd8`), so none of them match
 * any widget-name pattern; the signature is deliberately empty here to keep
 * that honest.
 *
 * The viewport width is known from a full-width fixed bar the page reported
 * at 1166px. The height is only known to be greater than 1205 (a fixed bar
 * sits at that y), so the cases below sweep a range of plausible heights
 * rather than pretending to a single number.
 */
const HEIGHTS = [1210, 1229, 1280, 1360, 1440];
const VIEW = (height: number): Box => ({ top: 0, left: 0, width: 1166, height });

// Observed at 304x408 with its top at y=770. It is anchored to the bottom of
// the viewport, so its `top` is a function of the viewport height rather than
// a constant — modelling it as fixed while growing the viewport describes a
// dock that detaches from the bottom edge, which is not a thing that happens.
const DOCK_GAP_BELOW = 51; // 1229 - (770 + 408), at the height the page reported
const dockAt = (viewportHeight: number, gap = DOCK_GAP_BELOW): Box => ({
  left: 753,
  top: viewportHeight - gap - 408,
  width: 304,
  height: 408,
});
const SIDEBAR: Box = { left: 97, top: 76, width: 222, height: 625 };
const FULL_WIDTH_BAR: Box = { left: 0, top: 1205, width: 1166, height: 0 };

describe("classifyPinned, against real LinkedIn geometry", () => {
  it("hides the messaging dock on every slice, despite it having no usable name", () => {
    for (const height of HEIGHTS) {
      // The exact gap the page reported is an inference from a fixed bar's
      // position, so sweep the plausible range rather than trusting one number.
      for (const gap of [16, 32, 51, 72, 96]) {
        expect(classifyPinned({ box: dockAt(height, gap), view: VIEW(height), signature: "" })).toBe(
          "always",
        );
      }
    }
  });

  it("keeps the sticky sidebar, which is content and not a widget", () => {
    for (const height of HEIGHTS) {
      // "top" = shown once, on the first slice. Not hidden outright.
      expect(classifyPinned({ box: SIDEBAR, view: VIEW(height), signature: "" })).toBe("top");
    }
  });

  it("ignores the zero-height full-width bar entirely", () => {
    expect(classifyPinned({ box: FULL_WIDTH_BAR, view: VIEW(1229), signature: "" })).toBeNull();
  });
});

describe("classifyPinned", () => {
  const view = VIEW(1000);

  it("hides anything named like a chat or consent widget, whatever its shape", () => {
    const huge: Box = { left: 0, top: 0, width: 1166, height: 1000 };
    expect(classifyPinned({ box: huge, view, signature: "onetrust-consent-sdk" })).toBe("always");
    expect(classifyPinned({ box: huge, view, signature: "msg-overlay-bubble" })).toBe("always");
  });

  it("leaves a wide, tall pinned column alone — that is content", () => {
    const column: Box = { left: 0, top: 0, width: 800, height: 900 };
    expect(classifyPinned({ box: column, view, signature: "" })).toBeNull();
  });

  it("shows a sticky header on the first slice and a footer bar on the last", () => {
    const header: Box = { left: 0, top: 0, width: 1166, height: 60 };
    const footer: Box = { left: 0, top: 940, width: 1166, height: 60 };
    expect(classifyPinned({ box: header, view, signature: "" })).toBe("top");
    // Full width, so not a floating widget — it is the page's own footer.
    expect(classifyPinned({ box: footer, view, signature: "" })).toBe("bottom");
  });

  it("does not mistake a bottom-left cookie-shaped panel for content", () => {
    const panel: Box = { left: 20, top: 700, width: 380, height: 260 };
    expect(classifyPinned({ box: panel, view, signature: "" })).toBe("always");
  });

  it("ignores anything that misses the captured band", () => {
    const offscreen: Box = { left: 0, top: -400, width: 300, height: 100 };
    expect(classifyPinned({ box: offscreen, view, signature: "" })).toBeNull();
  });

  it("ignores slivers too small to be worth hiding", () => {
    expect(classifyPinned({ box: { left: 0, top: 500, width: 20, height: 300 }, view, signature: "" })).toBeNull();
    expect(classifyPinned({ box: { left: 0, top: 500, width: 300, height: 4 }, view, signature: "" })).toBeNull();
  });

  it("keeps a mid-height floating panel that is not parked at the bottom", () => {
    // Sits below the midline but well clear of the bottom edge: more likely a
    // dialog than a dock, and hiding a dialog on every slice would be wrong.
    const dialog: Box = { left: 700, top: 520, width: 300, height: 200 };
    expect(classifyPinned({ box: dialog, view, signature: "" })).toBe("bottom");
  });
});
