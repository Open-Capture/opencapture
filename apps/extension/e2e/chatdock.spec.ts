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
