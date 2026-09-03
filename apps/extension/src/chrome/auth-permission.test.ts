import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The whole point of these tests is call *order*.
 *
 * `permissions.request` only prompts while the click that triggered it is
 * still the current user gesture, and Firefox discards that gesture at the
 * first await. So anything awaited before the request — a `permissions.contains`
 * check, say — makes the request resolve false without a prompt ever
 * appearing. That is not a failure any type or return value catches, which is
 * why the sequence is asserted here.
 */
const calls: string[] = [];
const permissions = {
  contains: vi.fn(async () => {
    calls.push("contains");
    // Granted, because by the time anything checks, the request above has
    // already succeeded.
    return true;
  }),
  request: vi.fn(async () => {
    calls.push("request");
    return true;
  }),
};
const scripting = {
  getRegisteredContentScripts: vi.fn(async () => {
    calls.push("getRegistered");
    return [] as unknown[];
  }),
  registerContentScripts: vi.fn(async () => {
    calls.push("register");
  }),
};

vi.mock("./openapps-session", () => ({ OPENAPPS_BASE_URL: "https://auth.example.test" }));
vi.mock("../platform/webext", () => ({ ext: { permissions, scripting } }));

const { ensureAuthAccess } = await import("./auth-permission");

describe("ensureAuthAccess", () => {
  beforeEach(() => {
    calls.length = 0;
    permissions.request.mockClear();
    permissions.contains.mockClear();
  });

  it("asks for the permission before awaiting anything else", () => {
    void ensureAuthAccess();
    // Synchronously after the call, the only thing that can have been reached
    // is the request itself — nothing may be awaited ahead of it.
    expect(calls[0]).toBe("request");
  });

  it("never checks whether the permission is already held before asking", async () => {
    await ensureAuthAccess();
    // Checking afterwards is fine — the gesture has already been spent on the
    // request by then. Checking *first* is what broke it.
    expect(calls.indexOf("request")).toBe(0);
    const containsAt = calls.indexOf("contains");
    if (containsAt !== -1) expect(containsAt).toBeGreaterThan(0);
  });

  it("registers the relay script only once the permission exists", async () => {
    await ensureAuthAccess();
    expect(calls).toContain("register");
    expect(calls.indexOf("request")).toBeLessThan(calls.indexOf("register"));
  });

  it("reports refusal without registering anything", async () => {
    permissions.request.mockImplementationOnce(async () => {
      calls.push("request");
      return false;
    });
    expect(await ensureAuthAccess()).toBe(false);
    expect(calls).not.toContain("register");
  });

  it("treats a rejected request as a refusal rather than throwing", async () => {
    permissions.request.mockImplementationOnce(async () => {
      calls.push("request");
      throw new Error("no gesture");
    });
    expect(await ensureAuthAccess()).toBe(false);
  });
});
