import { expect, test } from "./fixtures";

/**
 * Selecting an area is the one action carried out on the page rather than in
 * the popup, and a popup is dismissed by the first click anywhere outside it.
 * That click was being spent closing the popup instead of starting the
 * selection — the crosshair appeared only on the click after the one the user
 * meant as their first.
 */
test("choosing 'capture selected area' closes the popup itself, so the next click starts the selection", async ({
  context,
  extensionId,
}) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  // window.close() does nothing for a page opened as a tab, so record it.
  await popup.evaluate(() => {
    (window as unknown as { __closed: boolean }).__closed = false;
    window.close = () => {
      (window as unknown as { __closed: boolean }).__closed = true;
    };
  });

  await popup.click("#captureSelectedArea");

  // Asynchronously now, not by the time click() returns: the popup waits for
  // the worker to answer a ping before destroying itself (see below).
  await expect
    .poll(() => popup.evaluate(() => (window as unknown as { __closed: boolean }).__closed), {
      timeout: 5_000,
    })
    .toBe(true);

  // And it does not sit there looking busy: it is gone, so there is nothing
  // to report progress into.
  await popup.close();
});

test("the other capture actions keep the popup open to show their result", async ({
  context,
  extensionId,
}) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(() => {
    (window as unknown as { __closed: boolean }).__closed = false;
    window.close = () => {
      (window as unknown as { __closed: boolean }).__closed = true;
    };
  });

  await popup.click("#captureVisible");
  // Full-page and visible-area captures finish without the user touching the
  // page, so the popup stays to show the preview and the result buttons.
  expect(await popup.evaluate(() => (window as unknown as { __closed: boolean }).__closed)).toBe(false);

  await popup.close();
});

/**
 * APP-88: "the first click does nothing, the second works".
 *
 * The popup closes itself the moment it has sent the request. If the MV3
 * service worker is asleep — which it is whenever the extension has been idle
 * for around thirty seconds — the message is only delivered once the worker
 * has started, and starting it takes a few hundred milliseconds. The popup was
 * gone well before that, and a message whose sender no longer exists is
 * dropped. Nothing ran, and with the popup already closed there was nowhere
 * for an error to appear, so the click looked ignored. The second click worked
 * because the first had left the worker running; a while later it idles out
 * and the next first click fails again.
 *
 * So the order below is the fix, and each step of it matters: ask, wait for an
 * answer, only then send the real request and close.
 */
test("it waits for the worker to answer before closing, so a cold start cannot swallow the request", async ({
  context,
  extensionId,
}) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  // A worker that takes 400ms to come up, which is what this is about. The
  // real request is left unanswered on purpose: the popup must not be waiting
  // on it, only on the ping.
  await popup.evaluate(() => {
    const w = window as unknown as { __order: string[]; __closed: boolean };
    w.__order = [];
    w.__closed = false;
    window.close = () => {
      w.__order.push("close");
      w.__closed = true;
    };
    chrome.runtime.sendMessage = ((message: { action: string }) => {
      w.__order.push(`send:${message.action}`);
      if (message.action === "ping") {
        return new Promise<unknown>((resolve) =>
          setTimeout(() => {
            w.__order.push("worker-awake");
            resolve({ ok: true });
          }, 400),
        );
      }
      return new Promise<unknown>(() => {});
    }) as unknown as typeof chrome.runtime.sendMessage;
  });

  await popup.click("#captureSelectedArea");

  // Still open while the worker starts — this is the window in which the old
  // code had already destroyed itself.
  expect(await popup.evaluate(() => (window as unknown as { __closed: boolean }).__closed)).toBe(false);

  await expect
    .poll(() => popup.evaluate(() => (window as unknown as { __closed: boolean }).__closed), {
      timeout: 5_000,
    })
    .toBe(true);

  expect(await popup.evaluate(() => (window as unknown as { __order: string[] }).__order)).toEqual([
    "send:ping",
    "worker-awake",
    "send:captureSelectedArea",
    "close",
  ]);

  await popup.close();
});
