// Nudges an engaged user toward a store rating, without ever requiring
// them to leave the popup to give the initial signal — there's no API on
// either store that lets an extension submit a rating on the user's
// behalf, so a 4-5 star tap still opens the real review page in a new
// tab, but the popup itself is where the ask, the star input, and (for a
// low rating) the feedback route all happen.
import { ext } from "../platform/webext";
import { RATING_PROMPT_THRESHOLDS, DEFAULT_RATING_PROMPT_STATE, type RatingPromptState } from "./rating-prompt-threshold";

export { shouldShowRatingPrompt, type RatingPromptState } from "./rating-prompt-threshold";

const USAGE_COUNT_KEY = "usageCount";
const RATING_PROMPT_STATE_KEY = "ratingPromptState";

export async function bumpUsageCount(): Promise<number> {
  const stored = await ext.storage.local.get(USAGE_COUNT_KEY);
  const count = ((stored[USAGE_COUNT_KEY] as number | undefined) ?? 0) + 1;
  await ext.storage.local.set({ [USAGE_COUNT_KEY]: count });
  return count;
}

export async function getUsageCount(): Promise<number> {
  const stored = await ext.storage.local.get(USAGE_COUNT_KEY);
  return (stored[USAGE_COUNT_KEY] as number | undefined) ?? 0;
}

export async function getRatingPromptState(): Promise<RatingPromptState> {
  const stored = await ext.storage.local.get(RATING_PROMPT_STATE_KEY);
  return { ...DEFAULT_RATING_PROMPT_STATE, ...(stored[RATING_PROMPT_STATE_KEY] as Partial<RatingPromptState> | undefined) };
}

async function setRatingPromptState(state: RatingPromptState): Promise<void> {
  await ext.storage.local.set({ [RATING_PROMPT_STATE_KEY]: state });
}

/** "Not now" — may be asked again later, up to RATING_PROMPT_THRESHOLDS.length times total. */
export async function recordPromptDismissed(): Promise<void> {
  const state = await getRatingPromptState();
  const timesShown = state.timesShown + 1;
  await setRatingPromptState({ timesShown, respondedForever: timesShown >= RATING_PROMPT_THRESHOLDS.length });
}

/** A star was tapped (whichever rating) — a real response, never ask again. */
export async function recordPromptResponded(): Promise<void> {
  const state = await getRatingPromptState();
  await setRatingPromptState({ timesShown: state.timesShown + 1, respondedForever: true });
}

const CHROME_REVIEW_URL = "https://chromewebstore.google.com/detail/ikhhoggnlncjhpdbnneekifbnmojpjph/reviews";
const FIREFOX_REVIEW_URL = "https://addons.mozilla.org/firefox/addon/opencapture-full-page-capture/reviews/";
const FEEDBACK_EMAIL = "hello@opencapture.app";

/** NOT the same check as webext.ts's `ext` alias (`browser ?? chrome`) —
 * that one only needs *a* promise-based API surface to call, so either
 * global will do. This one needs to know which browser it's actually
 * running in, and `globalThis.browser` alone can't answer that: recent
 * Chrome versions also expose a `browser` global (part of the WebExtensions
 * cross-browser standardization effort), so its mere presence no longer
 * implies Firefox. The UA string is what actually distinguishes them. */
function isFirefox(): boolean {
  return navigator.userAgent.includes("Firefox");
}

export function getStoreReviewUrl(): string {
  return isFirefox() ? FIREFOX_REVIEW_URL : CHROME_REVIEW_URL;
}

export function getFeedbackMailto(): string {
  const subject = encodeURIComponent("OpenCapture feedback");
  return `mailto:${FEEDBACK_EMAIL}?subject=${subject}`;
}
