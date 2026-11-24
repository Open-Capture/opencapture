// Whether this account has the Supporter (watermark) unlock — answered from
// the server when it can be, and from the last answer it gave when it can't.
//
// The entitlement check used to have two outcomes, so every failure — offline,
// a timeout, a 5xx — read as "not unlocked", and someone who had already paid
// 1000 credits was shown "Unlock for 1000 credits". The gateway does refuse a
// second charge (one idempotency key per account), but the offer itself is
// wrong, and a person offline has no way to tell it apart from a lost unlock.
//
// So there are four outcomes, and only a definite answer from the server can
// produce "locked". A failure falls back to the last "unlocked" the server
// gave this device, and without one it is "unknown" — which the editor shows
// as "couldn't check", with a retry and no purchase button.
//
// What is cached is a single boolean the server already told us, in
// storage.local. It unlocks nothing the extension couldn't already be patched
// to do — the renderer runs locally either way — and it is only ever read
// while signed in. It is removed on a definite "locked", on sign-out, and on
// any new sign-in (which may be a different account).

export type SupporterStatus = "unlocked" | "locked" | "signed-out" | "unknown";

export const SUPPORTER_CACHE_KEY = "opencapture.supporterUnlocked";

interface CachedEntitlement {
  unlocked: true;
  checkedAt: number;
}

/** The slice of `chrome.storage.StorageArea` this needs. */
export interface EntitlementStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface EntitlementDeps {
  /** The authenticated entitlement request; null when there is no token. */
  fetchEntitlement(): Promise<Response | null>;
  /** Read after a 401, by which point a dead session has cleared itself. */
  isLoggedIn(): boolean;
  storage: EntitlementStorage;
  now?: () => number;
}

async function readCache(storage: EntitlementStorage): Promise<boolean> {
  try {
    const stored = (await storage.get(SUPPORTER_CACHE_KEY))[SUPPORTER_CACHE_KEY] as
      | Partial<CachedEntitlement>
      | undefined;
    return stored?.unlocked === true;
  } catch {
    return false;
  }
}

async function writeCache(storage: EntitlementStorage, now: number): Promise<void> {
  try {
    const value: CachedEntitlement = { unlocked: true, checkedAt: now };
    await storage.set({ [SUPPORTER_CACHE_KEY]: value });
  } catch {
    // A cache that fails to write costs an offline open later, nothing more.
  }
}

export async function clearSupporterCache(storage: EntitlementStorage): Promise<void> {
  try {
    await storage.remove(SUPPORTER_CACHE_KEY);
  } catch {
    // Nothing to recover: the next definite answer overwrites it anyway.
  }
}

/** Record an unlock the gateway just confirmed, without waiting for a re-check. */
export async function rememberSupporterUnlocked(storage: EntitlementStorage, now = Date.now()): Promise<void> {
  await writeCache(storage, now);
}

export async function resolveSupporterStatus(deps: EntitlementDeps): Promise<SupporterStatus> {
  const now = deps.now ?? Date.now;
  const fallback = async (): Promise<SupporterStatus> =>
    (await readCache(deps.storage)) ? "unlocked" : "unknown";

  let res: Response | null;
  try {
    res = await deps.fetchEntitlement();
  } catch {
    return fallback();
  }
  if (!res) return "signed-out";

  if (res.status === 401) {
    // authedFetch already tried the refresh token. If that cleared the
    // session, this really is signed out; if the session survived, the
    // refresh itself failed to reach the server — treat it as a failure.
    if (!deps.isLoggedIn()) {
      await clearSupporterCache(deps.storage);
      return "signed-out";
    }
    return fallback();
  }
  if (!res.ok) return fallback();

  let body: { unlocked?: unknown };
  try {
    body = (await res.json()) as { unlocked?: unknown };
  } catch {
    return fallback();
  }
  if (body.unlocked === true) {
    await writeCache(deps.storage, now());
    return "unlocked";
  }
  if (body.unlocked === false) {
    await clearSupporterCache(deps.storage);
    return "locked";
  }
  return fallback();
}
