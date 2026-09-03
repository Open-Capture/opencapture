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
}): PinnedKind | null {
  const { box, view, signature, mode, inFlow } = opts;
  const viewBottom = view.top + view.height;
  const viewRight = view.left + view.width;

  // An overlay skips the geometry checks below: a consent modal is often
  // paired with a full-screen scrim, and its own box is regularly a collapsed
  // anchor rather than the thing anyone can see.
  const overlay = CONSENT_PATTERN.test(signature) || CHAT_PATTERN.test(signature);

  if (!overlay) {
    if (box.width < MIN_WIDTH || box.height < MIN_HEIGHT) return null;

    // Must actually intrude on the band being captured.
    if (box.top + box.height <= view.top || box.top >= viewBottom) return null;
    if (box.left + box.width <= view.left || box.left >= viewRight) return null;
  }

  if (mode === "remove") return "always";

  const floating = overlay || !inFlow || isFloatingWidget(box, view);

  // Page furniture holding real content — a sticky column or nav rail — is
  // left exactly where it is, on every slice. Hiding it after the first one
  // leaves a blank column down the rest of the capture, which reads as a bug
  // rather than as tidying up.
  const tall = box.height > view.height * 0.5;
  const wide = box.width > view.width * 0.4;
  if (!floating && tall && wide) return null;
  if (!floating && isSideRail(box, view)) return null;

  // Which end it appears at is its own midpoint, and deliberately not "docks
  // go at the bottom" however tempting that reads.
  //
  // The last slice contributes only the rows below the previous one — the
  // overlap is discarded — and on a long page that tail is a sliver. Forcing a
  // tall panel onto it made the panel disappear from the capture entirely
  // (measured: 640px of dock, 96px of tail, nothing left). Appearing once at
  // the wrong end beats not appearing at all.
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
  const tallEnough = box.height > view.height * 0.35;
  const narrowEnough = box.width < view.width * 0.35;
  const margin = view.width * 0.15;
  const hugsLeft = box.left - view.left < margin;
  const hugsRight = view.left + view.width - (box.left + box.width) < margin;
  return tallEnough && narrowEnough && (hugsLeft || hugsRight);
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
