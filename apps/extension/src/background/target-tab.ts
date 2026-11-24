// Which tab a capture is for, when the popup is not beside it but on top of it.
//
// Firefox for Android shows an extension popup as a full-screen page of its
// own (a back arrow, the popup's <title>, nothing else), opened over the tab
// the user picked OpenCapture for. Two things follow, and together they were
// the "capture full page" failure on Android:
//
//   - The browser's "current window" is the popup's. Firefox's Android
//     window tracker says so outright ("In GeckoView the popup is on a
//     separate window", ext-android.js), and `tabs.query({active: true,
//     currentWindow: true})` follows it — so the tab a capture resolved to
//     could be the popup's own moz-extension:// page. Injecting into that
//     either lands in a page `tabs.sendMessage` cannot reach ("Could not
//     establish connection. Receiving end does not exist.") or is refused as
//     a browser page ("…doesn't let extensions run on its own pages").
//   - Even with the right tab, a full-page capture scrolls the page and
//     photographs it a slice at a time. Done while the popup covers it, that
//     is scrolling a page nobody can see, in a background session the
//     browser has no reason to keep painting.
//
// So on Android a capture that has to work on the page runs *detached*: the
// popup closes itself first, and the background waits here for the page to be
// back in front before touching it. Desktop never takes this path — its popup
// is a panel beside a page that stays in front throughout.
import { ext } from "../platform/webext";

/**
 * Whether a tab is one a detached capture can start on.
 *
 * Needs an id and a window, and a URL this extension can read — which, without
 * the "tabs" permission, it can only for the tab its activeTab grant covers:
 * the page the user opened OpenCapture on. An unreadable URL is therefore the
 * popup itself, or some other tab there is no grant for, and neither is worth
 * starting on. This extension's own pages (the popup, the editor) are excluded
 * by name, since those URLs may well be readable.
 */
export function isCapturablePage(tab: chrome.tabs.Tab | undefined, ownBaseUrl: string): tab is chrome.tabs.Tab {
  if (!tab || tab.id === undefined || tab.id < 0 || tab.windowId === undefined) return false;
  if (!tab.url) return false;
  return !tab.url.startsWith(ownBaseUrl);
}

/** First capturable tab among candidates, the current window's tab first. */
export function pickCapturablePage(candidates: Array<chrome.tabs.Tab | undefined>, ownBaseUrl: string): chrome.tabs.Tab | undefined {
  return candidates.find((tab): tab is chrome.tabs.Tab => isCapturablePage(tab, ownBaseUrl));
}

/** How long a detached capture waits for the page to come back in front. */
export const PAGE_IN_FRONT_TIMEOUT_MS = 5000;
const PAGE_IN_FRONT_POLL_MS = 150;

/**
 * Thrown when the popup closed but the page never came back in front — the
 * browser kept the popup open, say, or the user moved to another tab.
 */
export class PageNotInFrontError extends Error {
  constructor() {
    super("The page didn't come back to the front after OpenCapture closed, so nothing was captured. Go back to the page and try again.");
    this.name = "PageNotInFrontError";
  }
}

/**
 * Wait until the page the popup was opened for is the active tab again.
 *
 * Asks twice each round: the current window's active tab, which is the right
 * answer once the popup has gone, and the active tab of every window, because
 * on Android each tab is a window of its own and "current" is only as good as
 * the browser's tracking of it.
 */
export async function waitForPageInFront(
  timeoutMs = PAGE_IN_FRONT_TIMEOUT_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => number = Date.now,
): Promise<chrome.tabs.Tab> {
  const ownBaseUrl = ext.runtime.getURL("");
  const deadline = now() + timeoutMs;
  for (;;) {
    const [current] = await ext.tabs.query({ active: true, currentWindow: true }).catch(() => [] as chrome.tabs.Tab[]);
    let found = pickCapturablePage([current], ownBaseUrl);
    if (!found) {
      const everywhere = await ext.tabs.query({ active: true }).catch(() => [] as chrome.tabs.Tab[]);
      found = pickCapturablePage(everywhere, ownBaseUrl);
    }
    if (found) return found;
    if (now() >= deadline) throw new PageNotInFrontError();
    await sleep(PAGE_IN_FRONT_POLL_MS);
  }
}

/**
 * The popup announces itself over this port while it is open, so a detached
 * capture can tell when it has really gone — rather than guessing at how long
 * a close takes, and starting to scroll a page the popup still covers.
 */
export const POPUP_PRESENCE_PORT_NAME = "popupPresence";

const openPopups = new Set<chrome.runtime.Port>();
const popupClosedWaiters = new Set<() => void>();

/** Register the port listener. Called once, from background/index.ts. */
export function trackPopupPresence(): void {
  ext.runtime.onConnect.addListener((port) => {
    if (port.name !== POPUP_PRESENCE_PORT_NAME) return;
    openPopups.add(port);
    port.onDisconnect.addListener(() => {
      openPopups.delete(port);
      if (openPopups.size > 0) return;
      for (const resolve of popupClosedWaiters) resolve();
      popupClosedWaiters.clear();
    });
  });
}

/**
 * Resolve once no popup is open; throw if one is still open after
 * `timeoutMs` — the browser kept it up, and whatever is behind it is not
 * something to scroll and photograph.
 */
export function waitForPopupClosed(timeoutMs = PAGE_IN_FRONT_TIMEOUT_MS): Promise<void> {
  if (openPopups.size === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      popupClosedWaiters.delete(done);
      if (openPopups.size > 0) reject(new PageNotInFrontError());
      else resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    popupClosedWaiters.add(done);
  });
}
