import { afterEach, describe, expect, it, vi } from "vitest";

const OWN = "moz-extension://4b1c0f3e-uuid/";

/** Tabs as Firefox for Android reported them: the popup's own page
 * is the "current window", the page the user wanted sits behind it. */
const popupTab = { id: 7, windowId: 7, active: true, url: `${OWN}popup.html` } as chrome.tabs.Tab;
const pageTab = { id: 3, windowId: 3, active: true, url: "https://en.wikipedia.org/wiki/Screenshot" } as chrome.tabs.Tab;
const ungrantedTab = { id: 9, windowId: 9, active: true } as chrome.tabs.Tab;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function load(query: (q: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>) {
  vi.stubGlobal("browser", undefined);
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `${OWN}${path}`, onConnect: { addListener: () => {} } },
    tabs: { query },
  } as unknown as typeof chrome);
  return import("./target-tab");
}

describe("isCapturablePage", () => {
  it("refuses this extension's own pages, which is what the popup is on Android", async () => {
    const { isCapturablePage } = await load(async () => []);
    expect(isCapturablePage(popupTab, OWN)).toBe(false);
    expect(isCapturablePage({ ...popupTab, url: `${OWN}editor.html` }, OWN)).toBe(false);
  });

  it("refuses a tab whose URL it cannot read — no activeTab grant there", async () => {
    const { isCapturablePage } = await load(async () => []);
    expect(isCapturablePage(ungrantedTab, OWN)).toBe(false);
    expect(isCapturablePage(undefined, OWN)).toBe(false);
    expect(isCapturablePage({ ...pageTab, id: -1 }, OWN)).toBe(false);
  });

  it("accepts the page the user opened OpenCapture on", async () => {
    const { isCapturablePage, pickCapturablePage } = await load(async () => []);
    expect(isCapturablePage(pageTab, OWN)).toBe(true);
    expect(pickCapturablePage([popupTab, ungrantedTab, pageTab], OWN)).toBe(pageTab);
  });
});

describe("waitForPageInFront", () => {
  it("returns at once when the page is already the current window's tab (desktop shape)", async () => {
    const { waitForPageInFront } = await load(async () => [pageTab]);
    await expect(waitForPageInFront(1000, async () => {})).resolves.toBe(pageTab);
  });

  it("looks past a current window that is the popup's", async () => {
    const { waitForPageInFront } = await load(async (q) => (q.currentWindow ? [popupTab] : [popupTab, pageTab]));
    await expect(waitForPageInFront(1000, async () => {})).resolves.toBe(pageTab);
  });

  it("waits for the popup to give way, then takes the page", async () => {
    let rounds = 0;
    const { waitForPageInFront } = await load(async () => (rounds++ < 6 ? [popupTab] : [pageTab]));
    await expect(waitForPageInFront(10_000, async () => {})).resolves.toBe(pageTab);
  });

  it("gives up with a reason the popup can translate when the page never returns", async () => {
    let clock = 0;
    const { waitForPageInFront, PageNotInFrontError } = await load(async () => [popupTab]);
    await expect(
      waitForPageInFront(
        500,
        async (ms) => {
          clock += ms;
        },
        () => clock,
      ),
    ).rejects.toBeInstanceOf(PageNotInFrontError);
  });
});

describe("waitForPopupClosed", () => {
  function presence() {
    let onConnect: ((port: chrome.runtime.Port) => void) | undefined;
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", {
      runtime: { getURL: (p: string) => `${OWN}${p}`, onConnect: { addListener: (fn: typeof onConnect) => (onConnect = fn) } },
      tabs: { query: async () => [] },
    } as unknown as typeof chrome);
    const openPort = (name: string) => {
      let onDisconnect: (() => void) | undefined;
      onConnect!({ name, onDisconnect: { addListener: (fn: () => void) => (onDisconnect = fn) } } as unknown as chrome.runtime.Port);
      return () => onDisconnect!();
    };
    return { openPort };
  }

  it("resolves straight away with no popup open", async () => {
    presence();
    const { trackPopupPresence, waitForPopupClosed } = await import("./target-tab");
    trackPopupPresence();
    await expect(waitForPopupClosed(10)).resolves.toBeUndefined();
  });

  it("resolves when the popup's port disconnects", async () => {
    const { openPort } = presence();
    const { trackPopupPresence, waitForPopupClosed, POPUP_PRESENCE_PORT_NAME } = await import("./target-tab");
    trackPopupPresence();
    const close = openPort(POPUP_PRESENCE_PORT_NAME);
    const waiting = waitForPopupClosed(5000);
    close();
    await expect(waiting).resolves.toBeUndefined();
  });

  it("fails when the browser keeps the popup open", async () => {
    const { openPort } = presence();
    const { trackPopupPresence, waitForPopupClosed, POPUP_PRESENCE_PORT_NAME, PageNotInFrontError } = await import("./target-tab");
    trackPopupPresence();
    openPort(POPUP_PRESENCE_PORT_NAME);
    await expect(waitForPopupClosed(10)).rejects.toBeInstanceOf(PageNotInFrontError);
  });

  it("ignores other ports", async () => {
    const { openPort } = presence();
    const { trackPopupPresence, waitForPopupClosed } = await import("./target-tab");
    trackPopupPresence();
    openPort("editorImage");
    await expect(waitForPopupClosed(10)).resolves.toBeUndefined();
  });
});
