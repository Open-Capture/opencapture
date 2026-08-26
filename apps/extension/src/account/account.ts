// Full OpenApps account page: sign-in, balance, connected identities, and
// buying credits. Opened in its own tab from the popup (see popup.ts) —
// popups are torn down on blur, so a real sign-in redirect or a checkout
// flow can't live inside one; this mirrors editor.html's own reason for
// being a separate tab rather than living inside the popup.
import "@openapps/tokens/tokens.css";
import { configure } from "@openapps/ui";
import { OPENAPPS_BASE_URL, client as openappsClient, ready as openappsReady, store as openappsStore } from "../chrome/openapps-session";
import { ensureAuthAccess } from "../chrome/auth-permission";
import { ext } from "../platform/webext";

// Shares the same chrome.storage.session-backed store as background.ts's
// own client (see openapps-session.ts) rather than letting configure()
// build a fresh one — otherwise this page and the background service
// worker would each think the other was signed out.
//
// Called synchronously, not behind an `await ready` — the elements can
// upgrade and call into the client the instant they connect, and
// `configure()` is documented as "call once, before the elements render".
// The store itself is safe to hand over before it finishes hydrating from
// chrome.storage (that's the whole point of asyncBackedStore): it starts
// as "no session", then updates and notifies once the persisted one loads.
configure({ baseUrl: OPENAPPS_BASE_URL, store: openappsStore });

// background.ts adopts a session into this same store from a completely
// different tab (the OAuth callback one — see openapps-callback/index.ts),
// with no way to tell *this* page's already-constructed client that
// happened. A full reload is blunt but correct: it re-reads the
// now-updated store from scratch, for both the hand-rolled bits below and
// every <openapps-*> element on the page. (Change events live on the
// top-level chrome.storage.onChanged, not per-area — filter by areaName.)
ext.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "session" && "openapps.session" in changes) location.reload();
});

const signInCard = document.getElementById("signInCard")!;
const historyCard = document.getElementById("historyCard")!;
const buyEl = document.querySelector("openapps-buy")!;
const signOutBtn = document.getElementById("signOut") as HTMLButtonElement;

document.getElementById("signIn")!.addEventListener("click", async () => {
  // The origin is an optional permission, so it has to be granted before the
  // tab is worth opening — without it the relay content script cannot be
  // registered and the session would never make it back. ensureAuthAccess is
  // first, before any other await, because permissions.request needs the
  // click's gesture.
  if (!(await ensureAuthAccess())) {
    showAuthDenied();
    return;
  }
  // The server's own sign-in page, in its own tab. It is an https origin,
  // so a wallet or Nostr extension actually injects into it — neither will
  // ever appear in this window — and it hands the session back through
  // openapps-callback/index.ts. See background/index.ts's
  // "openapps:session" listener for the rest of the handoff.
  ext.tabs.create({ url: new URL("/signin", openappsClient.baseUrl).toString() });
});

/** Declining the prompt leaves sign-in impossible, so say so rather than
 *  opening a tab that can never complete. */
function showAuthDenied(): void {
  const el = document.getElementById("authDenied");
  if (el) el.hidden = false;
}

// <openapps-buy> would navigate this window to Stripe, which for an
// extension page means destroying it mid-purchase. Taking the event over
// keeps the account page and puts checkout in its own tab; the balance
// updates on <openapps-credits>'s next poll once the payment settles.
buyEl.addEventListener("openapps-checkout", (event) => {
  const { url } = (event as CustomEvent<{ url: string }>).detail;
  event.preventDefault();
  ext.tabs.create({ url });
});

// The session lives in chrome.storage.session, shared with the background
// worker, so signing out has to clear it there rather than just in this
// page's memory — which is what the SDK's logout does via the store passed
// to configure(). The storage change then reloads this page through the
// listener above, so there is no separate re-render here.
//
// The SDK revokes server-side and clears locally in a `finally`, so a
// failed request still ends with this device signed out; the catch is only
// so the button recovers instead of leaving a rejected promise behind.
signOutBtn.addEventListener("click", async () => {
  signOutBtn.disabled = true;
  try {
    await openappsClient.auth.logout();
  } catch (err) {
    console.warn("[openapps] sign-out request failed; cleared locally anyway", err);
  } finally {
    signOutBtn.disabled = false;
    render();
  }
});

// <openapps-account>'s own "Connect Google/Wallet/Nostr" buttons (for
// linking a *second* identity to an already-signed-in account) assume a
// normal https page where a signer can inject — exactly the assumption
// this page itself can never satisfy, for the same reason the sign-in
// card above doesn't use <openapps-login>'s own Google button either. That
// makes every one of those buttons fail the same way "no wallet/signer
// found" does on a genuinely bare browser, except here it's never
// recoverable no matter what's installed.
//
// Unlike <openapps-buy>'s checkout flow, there's no "openapps-connect"
// event to intercept before the doomed attempt runs — so this catches the
// click in the capture phase (before the component's own bubble-phase
// handler) and redirects to /link instead. `composedPath()` is what makes
// this possible from outside the element's shadow root at all; a plain
// `event.target` would be retargeted to <openapps-account> itself.
// Matching on button text is fragile to an @openapps/ui copy change —
// accepted for now since the component exposes no better hook.
const CONNECT_LABELS = ["Connect Google", "Connect Wallet", "Connect Nostr"];
document.querySelector("openapps-account")!.addEventListener(
  "click",
  (event) => {
    const button = event.composedPath().find((el): el is HTMLButtonElement => el instanceof HTMLButtonElement);
    if (!button || !CONNECT_LABELS.includes(button.textContent?.trim() ?? "")) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    void (async () => {
      if (!(await ensureAuthAccess())) {
        showAuthDenied();
        return;
      }
      ext.tabs.create({ url: new URL("/link", openappsClient.baseUrl).toString() });
    })();
  },
  true,
);

function render(): void {
  signInCard.hidden = openappsClient.isLoggedIn;
  signOutBtn.hidden = !openappsClient.isLoggedIn;
  // The element says "sign in to see where your credits went" on its own,
  // but a heading over that reads as a broken panel. Hiding the whole card
  // is the honest version of the same message.
  historyCard.hidden = !openappsClient.isLoggedIn;
}

(async () => {
  await openappsReady;
  render();
})();

document.getElementById("closeAccount")!.addEventListener("click", async () => {
  // Same reasoning as editor.ts's closeEditor handler: this tab was opened
  // via ext.tabs.create(), not window.open(), so window.close() alone can
  // silently no-op.
  const tab = await ext.tabs.getCurrent();
  if (tab?.id !== undefined) {
    await ext.tabs.remove(tab.id);
  } else {
    window.close();
  }
});
