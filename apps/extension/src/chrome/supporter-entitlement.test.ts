import { describe, expect, it } from "vitest";
import {
  SUPPORTER_CACHE_KEY,
  clearSupporterCache,
  rememberSupporterUnlocked,
  resolveSupporterStatus,
  type EntitlementStorage,
} from "./supporter-entitlement";

function memoryStorage(initial: Record<string, unknown> = {}): EntitlementStorage & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      return key in data ? { [key]: data[key] } : {};
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(key) {
      delete data[key];
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const cached = () => ({ [SUPPORTER_CACHE_KEY]: { unlocked: true, checkedAt: 1 } });

function deps(
  fetchEntitlement: () => Promise<Response | null>,
  storage = memoryStorage(),
  loggedIn = true,
) {
  return { fetchEntitlement, isLoggedIn: () => loggedIn, storage, now: () => 42 };
}

describe("resolveSupporterStatus", () => {
  it("unlocked from the server is remembered", async () => {
    const storage = memoryStorage();
    expect(await resolveSupporterStatus(deps(async () => json(200, { unlocked: true }), storage))).toBe("unlocked");
    expect(storage.data[SUPPORTER_CACHE_KEY]).toEqual({ unlocked: true, checkedAt: 42 });
  });

  it("a definite locked clears any earlier unlocked", async () => {
    const storage = memoryStorage(cached());
    expect(await resolveSupporterStatus(deps(async () => json(200, { unlocked: false }), storage))).toBe("locked");
    expect(storage.data[SUPPORTER_CACHE_KEY]).toBeUndefined();
  });

  it("offline with an earlier unlocked opens the tool", async () => {
    const storage = memoryStorage(cached());
    const offline = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await resolveSupporterStatus(deps(offline, storage))).toBe("unlocked");
  });

  it("offline with nothing cached is unknown, never locked", async () => {
    const offline = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await resolveSupporterStatus(deps(offline))).toBe("unknown");
  });

  it.each([500, 502, 503, 404, 429])("HTTP %i is a failed check, not locked", async (status) => {
    expect(await resolveSupporterStatus(deps(async () => json(status, { error: "x" })))).toBe("unknown");
    expect(await resolveSupporterStatus(deps(async () => json(status, {}), memoryStorage(cached())))).toBe("unlocked");
  });

  it("a malformed body is a failed check", async () => {
    expect(await resolveSupporterStatus(deps(async () => new Response("<html>", { status: 200 })))).toBe("unknown");
    expect(await resolveSupporterStatus(deps(async () => json(200, {})))).toBe("unknown");
  });

  it("no token is signed out", async () => {
    expect(await resolveSupporterStatus(deps(async () => null))).toBe("signed-out");
  });

  it("a 401 that ended the session is signed out and forgets the cache", async () => {
    const storage = memoryStorage(cached());
    expect(await resolveSupporterStatus(deps(async () => json(401, {}), storage, false))).toBe("signed-out");
    expect(storage.data[SUPPORTER_CACHE_KEY]).toBeUndefined();
  });

  it("a 401 while the session survived (refresh unreachable) falls back to the cache", async () => {
    expect(await resolveSupporterStatus(deps(async () => json(401, {}), memoryStorage(cached()), true))).toBe("unlocked");
    expect(await resolveSupporterStatus(deps(async () => json(401, {}), memoryStorage(), true))).toBe("unknown");
  });

  it("a storage failure degrades to unknown rather than throwing", async () => {
    const broken: EntitlementStorage = {
      get: async () => {
        throw new Error("quota");
      },
      set: async () => {
        throw new Error("quota");
      },
      remove: async () => {
        throw new Error("quota");
      },
    };
    expect(await resolveSupporterStatus(deps(async () => json(503, {}), broken as never))).toBe("unknown");
    expect(await resolveSupporterStatus(deps(async () => json(200, { unlocked: true }), broken as never))).toBe("unlocked");
  });
});

describe("cache helpers", () => {
  it("remember then clear", async () => {
    const storage = memoryStorage();
    await rememberSupporterUnlocked(storage, 7);
    expect(storage.data[SUPPORTER_CACHE_KEY]).toEqual({ unlocked: true, checkedAt: 7 });
    await clearSupporterCache(storage);
    expect(storage.data[SUPPORTER_CACHE_KEY]).toBeUndefined();
  });
});
