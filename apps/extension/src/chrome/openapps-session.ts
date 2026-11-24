// Session storage for the OpenApps account/credits integration.
//
// There is no `localStorage` in a service worker, and the worker is killed
// and restarted at Chrome's discretion, so the session cannot live in a
// module variable either. `chrome.storage` survives both, but it is async,
// which is why the SDK's `asyncBackedStore` exists: it keeps a synchronous
// in-memory copy for the client and writes through.
//
// `local` rather than `session`, so signing in survives a browser restart.
// This used to be `session` — memory-backed, cleared when the browser closes,
// so refresh tokens never touched disk — and the cost turned out to be every
// Supporter signing in again each morning before the watermark tool would
// open. storage.local is what extensions normally keep tokens in, and the
// SDK's own default on the web is localStorage: it is private to this
// extension, unreadable by web pages and by other extensions. Unlike
// storage.session it is also visible to this extension's own content
// scripts — none of which read it. The access token is short-lived; Sign out
// revokes the refresh token server-side and removes it here.
//
// A session from an older version still sitting in storage.session is moved
// across on first load, so updating doesn't sign anyone out.
import { OpenApps, asyncBackedStore } from "@openapps/sdk";
import type { AsyncTokenBackend, Session } from "@openapps/sdk";
import { ext } from "../platform/webext";
import { clearSupporterCache } from "./supporter-entitlement";

// A CNAME'd custom domain, not the shared OpenApps backend's own — same
// server, same account/credits database (sessions are bearer tokens, not
// cookies, so there's no domain-scoped identity to fragment), reached this
// way purely so sign-in never shows a foreign-looking domain in the
// address bar. See PLAN.md's custom-domain entry for what this does and
// doesn't change server-side.
export const OPENAPPS_BASE_URL = "https://auth.opencapture.app";
// openapps-gateway holds the app key for paid features (see editor.ts's
// Supporter watermark unlock) — never reachable with just the user token this
// extension holds, only through this service.
//
// A CNAME to gateway.openapps.network, for the same reason auth.opencapture.app
// exists: the permission prompt names whichever host the extension asks for,
// and "gateway.openapps.network" means nothing to someone who installed
// OpenCapture. Same box, same service, same certificate — only the name the
// user is shown changes. The old host stays in nginx's server_name, so an
// install that already granted it keeps working.
export const OPENAPPS_GATEWAY_URL = "https://gateway.opencapture.app";
export const SESSION_KEY = "openapps.session";
const KEY = SESSION_KEY;

/** The two storage areas the session can be in; `session` only for migration. */
export interface SessionAreas {
  local: Pick<chrome.storage.StorageArea, "get" | "set" | "remove">;
  session?: Pick<chrome.storage.StorageArea, "get" | "remove"> | undefined;
}

export function sessionBackend(areas: SessionAreas): AsyncTokenBackend {
  return {
    async load() {
      const local = (await areas.local.get(KEY))[KEY] as Session | undefined;
      if (local) return local;
      if (!areas.session) return null;
      const legacy = (await areas.session.get(KEY))[KEY] as Session | undefined;
      if (!legacy) return null;
      await areas.local.set({ [KEY]: legacy });
      await areas.session.remove(KEY);
      return legacy;
    },
    async save(session) {
      if (session) {
        await areas.local.set({ [KEY]: session });
        return;
      }
      await areas.local.remove(KEY);
      // Signed out — whatever the server last said about this account's
      // Supporter unlock no longer applies to whoever signs in next.
      await clearSupporterCache(areas.local);
      if (areas.session) await areas.session.remove(KEY);
    },
  };
}

export const store = asyncBackedStore(
  sessionBackend({ local: ext.storage.local, session: ext.storage.session }),
  (error) => console.warn("[openapps] session storage failed", error),
);

export const client = new OpenApps({
  baseUrl: OPENAPPS_BASE_URL,
  store,
});

/** Await before the first authenticated call in any extension context. */
export const ready = store.ready;
