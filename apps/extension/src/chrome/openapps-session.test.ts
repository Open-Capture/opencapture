import { describe, expect, it, vi } from "vitest";

// The module builds its real store from `ext` at import; give it an inert one
// so only sessionBackend() — the part under test — touches storage.
vi.mock("../platform/webext", () => {
  const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  return { ext: { storage: { local: area, session: area } } };
});

import { SESSION_KEY, sessionBackend } from "./openapps-session";
import { SUPPORTER_CACHE_KEY } from "./supporter-entitlement";

function area(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    }),
    remove: vi.fn(async (key: string) => {
      delete data[key];
    }),
  };
}

const session = { accessToken: "a", refreshToken: "r" };

describe("sessionBackend", () => {
  it("persists to storage.local, which survives a browser restart", async () => {
    const local = area();
    const backend = sessionBackend({ local: local as never, session: area() as never });
    await backend.save(session);
    expect(local.data[SESSION_KEY]).toEqual(session);
    // A new backend over the same local area — what the next browser start sees.
    expect(await sessionBackend({ local: local as never, session: area() as never }).load()).toEqual(session);
  });

  it("moves a session left in storage.session by an older version", async () => {
    const local = area();
    const legacy = area({ [SESSION_KEY]: session });
    expect(await sessionBackend({ local: local as never, session: legacy as never }).load()).toEqual(session);
    expect(local.data[SESSION_KEY]).toEqual(session);
    expect(legacy.data[SESSION_KEY]).toBeUndefined();
  });

  it("prefers storage.local over a stale storage.session copy", async () => {
    const fresh = { accessToken: "b", refreshToken: "s" };
    const backend = sessionBackend({
      local: area({ [SESSION_KEY]: fresh }) as never,
      session: area({ [SESSION_KEY]: session }) as never,
    });
    expect(await backend.load()).toEqual(fresh);
  });

  it("works without a storage.session area", async () => {
    expect(await sessionBackend({ local: area() as never }).load()).toBeNull();
  });

  it("sign-out clears the session everywhere and forgets the Supporter cache", async () => {
    const local = area({ [SESSION_KEY]: session, [SUPPORTER_CACHE_KEY]: { unlocked: true, checkedAt: 1 } });
    const legacy = area({ [SESSION_KEY]: session });
    await sessionBackend({ local: local as never, session: legacy as never }).save(null);
    expect(local.data).toEqual({});
    expect(legacy.data).toEqual({});
  });

  it("a token refresh keeps the Supporter cache", async () => {
    const local = area({ [SUPPORTER_CACHE_KEY]: { unlocked: true, checkedAt: 1 } });
    await sessionBackend({ local: local as never }).save(session);
    expect(local.data[SUPPORTER_CACHE_KEY]).toBeDefined();
  });
});
