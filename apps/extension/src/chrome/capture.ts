// Wraps tabs.captureVisibleTab with quota pacing. See
// ../platform/webext.ts's captureRateLimit() for why the rate itself is
// read defensively rather than hardcoded.
import { captureRateLimit, ext } from "../platform/webext";

let lastCallAtMs = 0;

function quotaIntervalMs(): number {
  const perSecond = captureRateLimit();
  // No declared limit means no waiting. If the browser turns out to enforce
  // one anyway, the retry below absorbs it.
  return perSecond === null ? 0 : Math.ceil(1000 / perSecond);
}

/** Extra wait after actually being throttled, before trying that slice again. */
const THROTTLED_BACKOFF_MS = 250;
const MAX_ATTEMPTS = 3;

/**
 * The browser refusing a screenshot for going too fast, as opposed to any
 * other failure — a discarded tab, a page that cannot be captured.
 */
function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(message);
}

/**
 * The browser saying it has no access to this tab.
 *
 * `activeTab` is granted for the tab that was showing when the extension was
 * invoked, and it is revoked the moment that tab navigates — a reload, a
 * link, a redirect. A capture runs for seconds, so a page that reloads part
 * way through takes the permission with it and the next screenshot is
 * refused. The raw message says "Missing host permission for the tab", which
 * reads like a broken install rather than something that just happened.
 */
function isPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /missing host permission|cannot access|not allowed to access/i.test(message);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Captures the currently visible viewport of `windowId` as a PNG, waiting
 * as needed to respect the capture-rate quota.
 */
export async function captureVisibleTabPaced(
  windowId: number,
  /**
   * Run after the quota wait and immediately before the screenshot.
   *
   * The wait is the whole point: it is up to half a second long, and anything
   * the page does in it — re-rendering a panel that was hidden, say — lands in
   * the picture. A caller that needs the page in a particular state needs it
   * *here*, not before the wait.
   */
  beforeShot?: () => Promise<void>,
): Promise<Uint8Array> {
  // Paced at exactly the quota, not a little under it.
  //
  // This used to add 50ms of slack to every single call so as never to ride
  // the edge. That slack is the dominant cost of a long capture — the quota
  // wait is the whole per-slice budget, everything else fits inside it, so
  // 50ms a slice is 50ms of the total per slice, on every page anyone
  // captures. Paying it up front on the chance of being throttled is the
  // wrong trade when being throttled is both detectable and recoverable:
  // ask at the real rate, and on the rare refusal, wait and ask again.
  for (let attempt = 1; ; attempt++) {
    const wait = quotaIntervalMs() - (Date.now() - lastCallAtMs);
    if (wait > 0) await sleep(wait);

    try {
      if (beforeShot) await beforeShot();
      const dataUrl = await ext.tabs.captureVisibleTab(windowId, { format: "png" });
      lastCallAtMs = Date.now();
      return dataUrlToBytes(dataUrl);
    } catch (error) {
      if (isPermissionError(error)) {
        throw new Error(
          "OpenCapture lost access to this tab, which happens when the page reloads or navigates while a capture is running. Open OpenCapture again and retry.",
        );
      }
      if (attempt >= MAX_ATTEMPTS || !isQuotaError(error)) throw error;
      // Count the refusal as a call: whatever the browser's clock thinks, it
      // has just told us we are early.
      lastCallAtMs = Date.now();
      await sleep(THROTTLED_BACKOFF_MS);
    }
  }
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
