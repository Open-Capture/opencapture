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
export function classifyPinned(opts: { box: Box; view: Box; signature: string }): PinnedKind | null {
  const { box, view, signature } = opts;
  const viewBottom = view.top + view.height;
  const viewRight = view.left + view.width;

  // Named widgets are hidden on every slice, and skip the geometry checks:
  // a consent modal is often paired with a full-screen scrim, and a scrim
  // left visible would tint the entire stitched capture.
  if (CONSENT_PATTERN.test(signature) || CHAT_PATTERN.test(signature)) return "always";

  if (box.width < MIN_WIDTH || box.height < MIN_HEIGHT) return null;

  // Must actually intrude on the band being captured.
  if (box.top + box.height <= view.top || box.top >= viewBottom) return null;
  if (box.left + box.width <= view.left || box.left >= viewRight) return null;

  if (isFloatingWidget(box, view)) return "always";

  // A pinned element that is both tall and wide is page furniture holding
  // real content — a sticky column, a nav rail. Hiding it would remove
  // content rather than clean up chrome. Both are required: a chat dock is
  // tall and *narrow*, and height alone once let LinkedIn's messaging
  // overlay through.
  const tall = box.height > view.height * 0.5;
  const wide = box.width > view.width * 0.4;
  if (tall && wide) return null;

  return box.top + box.height / 2 < view.top + view.height / 2 ? "top" : "bottom";
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
