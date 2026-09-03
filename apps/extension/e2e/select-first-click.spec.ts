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

  const closed = await popup.evaluate(() => (window as unknown as { __closed: boolean }).__closed);
  expect(closed).toBe(true);

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
