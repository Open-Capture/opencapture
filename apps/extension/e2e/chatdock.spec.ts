import { expect, test } from "./fixtures";

const BASE_URL = "http://localhost:8934";

test("chat docks that collapse or force visibility stay out of the capture", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  // Sized to match the real environment this reproduces: the dock measured
  // on a live LinkedIn feed was 304x408 in a 1166x1229 viewport — 26% of the
  // width and 33% of the height. In an 800x600 window the same dock would be
  // 68% of the viewport height, which is a different kind of object entirely
  // and not what any of this is about.
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.goto(`${BASE_URL}/chat-dock-linkedin.html`);

  // Docks are only dropped outright when asked for — the default shows each
  // pinned element once. See chrome/capture-prefs.ts.
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ capturePrefs: { sticky: "hide-overlays" } });
  });

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  const result = await serviceWorker.evaluate(
    // @ts-expect-error test-only global
    async (t) => globalThis.__test.captureFullPage(t.tabId, t.windowId),
    tabInfo,
  );

  // Count exact colours over the whole image. band-sample only reads a few
  // rows and reported "clean" once while a dock was smeared over a fifth of
  // the picture, so this decodes and counts every pixel instead.
  const counts = await page.evaluate(async (b64: string) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d")!;
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let magenta = 0, cyan = 0, green = 0, orange = 0, blue = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], bl = d[i + 2];
      if (r === 255 && g === 0 && bl === 255) magenta++;
      else if (r === 0 && g === 255 && bl === 255) cyan++;
      else if (r === 0 && g === 255 && bl === 0) green++;
      else if (r === 255 && g === 128 && bl === 0) orange++;
      else if (r === 0 && g === 0 && bl === 255) blue++;
    }
    return { magenta, cyan, green, orange, blue, w: c.width, h: c.height };
  }, result.imagesBase64[0]);

  console.log("DOCK PIXELS:", JSON.stringify(counts));

  // The collapsed-container dock (LinkedIn's shape).
  expect(counts.magenta).toBe(0);
  // The dock whose child forces visibility:visible back on.
  expect(counts.cyan).toBe(0);
  // The anonymous wrapper whose *child* carries the chat name — LinkedIn's
  // actual shape, and the one that survived two previous fixes.
  expect(counts.orange).toBe(0);
  // Hashed class names, exactly as LinkedIn ships today: no name to match
  // on at all, so only its shape identifies it as a dock.
  expect(counts.blue).toBe(0);
  // The wide+tall sticky is real content and must survive.
  expect(counts.green).toBeGreaterThan(0);

  await page.close();
});

test("a dock inside a shadow root, outside the scrolling container, stays out too", async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.goto(`${BASE_URL}/shadow-dock-inner-scroll.html`);

  // Docks are only dropped outright when asked for — the default shows each
  // pinned element once. See chrome/capture-prefs.ts.
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ capturePrefs: { sticky: "hide-overlays" } });
  });

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  const result = await serviceWorker.evaluate(
    // @ts-expect-error test-only global
    async (t) => globalThis.__test.captureFullPage(t.tabId, t.windowId),
    tabInfo,
  );

  const counts = await page.evaluate(async (b64: string) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d")!;
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let magenta = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) magenta++;
    }
    return { magenta, w: c.width, h: c.height };
  }, result.imagesBase64[0]);

  console.log("SHADOW DOCK PIXELS:", JSON.stringify(counts));
  // Measured on a real logged-in LinkedIn feed, this dock tiled down the
  // whole right-hand side of the capture. `querySelectorAll` does not cross
  // a shadow boundary, so the sweep never saw it; and its host is `absolute`
  // rather than fixed, which on an app shell is enough to stay put.
  expect(counts.magenta).toBe(0);

  await page.close();
});

test("by default every sticky element is captured once — not dropped, not repeated", async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.goto(`${BASE_URL}/chat-dock-linkedin.html`);

  // The shipped default, set explicitly so a pref left behind by another test
  // cannot make this pass for the wrong reason.
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ capturePrefs: { sticky: "once" } });
  });

  const tabInfo = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab?.id) throw new Error(`no tab for ${url}`);
    return { tabId: tab.id, windowId: tab.windowId };
  }, page.url());

  const result = await serviceWorker.evaluate(
    // @ts-expect-error test-only global
    async (t) => globalThis.__test.captureFullPage(t.tabId, t.windowId),
    tabInfo,
  );

  // Count the dock's rows rather than its pixels: "appears once" is a
  // statement about how many bands of the image it occupies, and a row count
  // survives the dock being clipped at the edge of a slice.
  const rows = await page.evaluate(async (b64: string) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d")!;
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    const hit: boolean[] = [];
    for (let y = 0; y < c.height; y++) {
      let found = false;
      for (let x = 0; x < c.width && !found; x++) {
        const i = (y * c.width + x) * 4;
        // the hashed-class dock's blue
        if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 255) found = true;
      }
      hit.push(found);
    }
    let runs = 0;
    for (let y = 0; y < hit.length; y++) if (hit[y] && !hit[y - 1]) runs++;
    return { runs, rows: hit.filter(Boolean).length, height: c.height };
  }, result.imagesBase64[0]);

  console.log("DEFAULT MODE DOCK:", JSON.stringify(rows));
  // Present...
  expect(rows.rows).toBeGreaterThan(0);
  // ...exactly once, in one contiguous band, rather than repeated down the page.
  expect(rows.runs).toBe(1);
  // And no taller than the dock itself (408px), so it is one copy, not several
  // that happen to touch.
  expect(rows.rows).toBeLessThanOrEqual(420);

  await page.close();
});
