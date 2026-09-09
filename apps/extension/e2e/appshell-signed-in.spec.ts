import { expect, test } from "./fixtures";

const BASE_URL = "http://localhost:8934";

// The shape APP-38 was reported against, and the one a signed-out capture
// cannot reach: a column beside the scrolling pane holding a conversation
// list that scrolls on its own and rebuilds itself wholesale, under a header
// spanning the window. `?overlay` is the slideover state the element is named
// for — the column fixed on top of a pane that fills the window, where
// nothing is wholly to one side of the scroller at all.
//
// Neither reproduced the reported repeat. They are here so that if the
// handling ever does drift on one of these shapes, the suite says so rather
// than a user.
for (const [label, query] of [
  ["beside the pane", ""],
  ["laid over the pane", "?overlay"],
] as const) {
  test(`a signed-in shaped sidebar ${label} is captured once`, async ({ context, serviceWorker }) => {
    test.setTimeout(120_000);
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(`${BASE_URL}/appshell-signed-in.html${query}`);
    await page.waitForLoadState("domcontentloaded");
    await page.bringToFront();

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ capturePrefs: { sticky: "keep" } });
    });
    const tabInfo = await serviceWorker.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url?.startsWith(url));
      if (!tab?.id) throw new Error(`no tab for ${url}`);
      return { tabId: tab.id, windowId: tab.windowId };
    }, `${BASE_URL}/appshell-signed-in.html`);
    const result = await serviceWorker.evaluate(
      // @ts-expect-error test-only global
      async (t) => globalThis.__test.captureFullPage(t.tabId, t.windowId),
      tabInfo,
    );

    const marker = await page.evaluate(async (b64) => {
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
          if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 0) found = true;
        }
        hit.push(found);
      }
      let runs = 0;
      for (let y = 0; y < hit.length; y++) if (hit[y] && !hit[y - 1]) runs++;
      const y = c.height - 4;
      const i = (y * c.width + 60) * 4;
      return { runs, height: c.height, bottomLeft: [d[i], d[i + 1], d[i + 2]] };
    }, result.imagesBase64[0]);
    console.log(`SIGNED-IN ${label}: ${JSON.stringify(marker)}`);

    // Its contents once, and its own colour all the way down.
    expect(marker.runs).toBe(1);
    expect(marker.bottomLeft).toEqual([20, 30, 40]);
  });
}
