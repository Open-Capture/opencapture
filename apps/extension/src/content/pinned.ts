/**
 * Deciding what to do with a pinned (fixed/sticky) element during a
 * scrolling capture.
 *
 * Split out of the content script and kept pure so it can be checked against
 * geometry taken from real pages. Three rounds of fixing a repeating chat
 * dock were argued from reasoning and synthetic fixtures; the numbers below
 * come from the actual site.
 */

export type PinnedKind = "top" | "bottom" | "always";

/** Mirrors StickyMode in chrome/capture-prefs.ts; duplicated rather than
 * imported because this module is bundled into the content script, which
 * must stay free of anything pulling in the extension APIs. */
export type StickyMode = "keep" | "remove";

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Cookie/consent overlays, by the naming every consent platform uses.
 *
 * Matching on id/class is crude in general, but safe here because only
 * pinned elements are ever tested — an article *about* cookies is static
 * content and never reaches this check.
 */
export const CONSENT_PATTERN =
  /cookie|consent|gdpr|ccpa|cmplz|onetrust|cookiebot|didomi|osano|truste|usercentrics|klaro|termly|quantcast|privacy-?(banner|notice|bar)/i;

/** Chat and messaging docks, by the names the common widgets ship with. */
export const CHAT_PATTERN =
  /msg-overlay|intercom|drift-|drift_|crisp-client|zendesk|zopim|tawk|livechat|live-chat|hubspot-messages|freshchat|helpscout|olark|smartsupp|chat-?(widget|bubble|launcher|window)/i;

/** Smaller than this in either axis and there is nothing worth hiding. */
const MIN_WIDTH = 40;
const MIN_HEIGHT = 8;

/**
 * Decide what a pinned element is, and therefore when it may be seen.
 *
 * `null` means "leave it alone" — it is either too small to matter, outside
 * the band being captured, or large enough to be the page's own content.
 */
export function classifyPinned(opts: {
  box: Box;
  view: Box;
  signature: string;
  mode: StickyMode;
  /**
   * Whether the element belongs to the page's own layout — sticky inside the
   * thing that scrolls — as opposed to floating over it.
   *
   * This is what tells a sidebar from a chat dock, without knowing either
   * one's name. Both are tall, narrow and pinned to an edge; the difference
   * is that a sidebar is part of the document being scrolled and a dock is
   * parked on top of it. Names were doing this job and could not keep doing
   * it: sites ship hashed class names now.
   */
  inFlow: boolean;
  /**
   * An empty container that exists for an overlay to be rendered into later —
   * a shadow host, floating over the page, with no box of its own.
   *
   * These have to be judged on what they are for rather than on what they
   * currently show. A page keeps several of them standing by, all identical
   * and all measuring nothing, and renders a panel into one of them when it
   * feels like it. Measured at the moment of a sweep they look like empty
   * slivers and get dropped; a moment later one of them is a messaging dock,
   * and the screenshot has it. Hiding whichever one happened to be occupied
   * is no good either — the next render can pick a different one.
   */
  isOverlayHost: boolean;
}): PinnedKind | null {
  const { box, view, signature, mode, inFlow, isOverlayHost } = opts;
  const viewBottom = view.top + view.height;
  const viewRight = view.left + view.width;

  // An overlay skips the geometry checks below: a consent modal is often
  // paired with a full-screen scrim, and its own box is regularly a collapsed
  // anchor rather than the thing anyone can see.
  const overlay = CONSENT_PATTERN.test(signature) || CHAT_PATTERN.test(signature) || isOverlayHost;

  if (!overlay) {
    if (box.width < MIN_WIDTH || box.height < MIN_HEIGHT) return null;

    // Must actually intrude on the band being captured.
    if (box.top + box.height <= view.top || box.top >= viewBottom) return null;
    if (box.left + box.width <= view.left || box.left >= viewRight) return null;
  }

  if (mode === "remove") return "always";

  const floating = overlay || !inFlow || isFloatingWidget(box, view);

  // An empty overlay container is nothing to look at yet, so nothing decides
  // where it belongs except what it is going to hold: a panel, at the end.
  if (isOverlayHost) return "bottom";

  // Page furniture holding real content — a sticky column or nav rail — is
  // left exactly where it is, on every slice. Hiding it after the first one
  // leaves a blank column down the rest of the capture, which reads as a bug
  // rather than as tidying up.
  const tall = box.height > view.height * 0.5;
  const wide = box.width > view.width * 0.4;
  if (!floating && tall && wide) return null;
  if (!floating && isSideRail(box, view)) return null;

  // A floating *panel* goes at the bottom whatever its midpoint says: a dock
  // spans most of the window, so its midpoint lands a hair either side of
  // centre depending on the screen, and deciding by it put the same dock at
  // the top on one machine and the bottom on another.
  //
  // A floating *bar* is a different thing and keeps the midpoint rule. Sending
  // everything floating to the bottom moved a site's top navigation there —
  // fifteen buttons and links that belong at the top of the capture, dropped
  // at the end of it.
  if (floating && box.height > view.height * 0.4) return "bottom";
  return box.top + box.height / 2 < view.top + view.height / 2 ? "top" : "bottom";
}

/**
 * A sidebar: tall, narrow, and hugging one side of the band.
 *
 * Only ever reached for elements that are part of the page's own scrolling
 * layout, which is what stops a chat dock — the same shape, but parked on top
 * of the page rather than inside it — from qualifying.
 */
function isSideRail(box: Box, view: Box): boolean {
  // Nearly the full height of the band, not merely tall.
  //
  // A navigation rail runs the height of the window — that is what makes
  // hiding it after the first slice leave a blank column, and what this
  // exemption is for. At a third of the height the test also caught things
  // that are not rails at all: Wikipedia's appearance panel is 476 of 900,
  // narrow, and pinned to the right edge, so it was exempted and repeated
  // down every slice of the capture.
  const fullHeight = box.height > view.height * 0.7;
  const narrowEnough = box.width < view.width * 0.35;
  const margin = view.width * 0.15;
  const hugsLeft = box.left - view.left < margin;
  const hugsRight = view.left + view.width - (box.left + box.width) < margin;
  return fullHeight && narrowEnough && (hugsLeft || hugsRight);
}

/**
 * A panel parked in a bottom corner: a chat dock, a cookie bar's cousin, a
 * "we use AI" nag.
 *
 * This exists because names stopped being reliable. LinkedIn's messaging
 * dock now ships with hashed class names — `_6116e3cc fe61ecd8` and so on —
 * so nothing in its markup says "chat", and any list of known widget names
 * misses it completely. Every site built with CSS modules has the same
 * property, so this will keep happening.
 *
 * Shape is what survives the hashing. A dock is small on both axes, sits
 * below the halfway line, and is parked against the bottom of the viewport.
 * Page furniture fails at least one of those: a sticky sidebar starts near
 * the top, a sticky footer or header spans the width, and a content column
 * is wide.
 *
 * Without this the dock is merely classified `bottom`, which shows it once
 * on the final slice — better than repeating down the whole capture, but
 * still someone's inbox in a screenshot they meant to share.
 */
function isFloatingWidget(box: Box, view: Box): boolean {
  const narrow = box.width < view.width * 0.4;
  const short = box.height < view.height * 0.6;
  const belowMidline = box.top > view.top + view.height / 2;
  const gapBelow = view.top + view.height - (box.top + box.height);
  const parkedAtBottom = gapBelow < view.height * 0.12;
  return narrow && short && belowMidline && parkedAtBottom;
}
