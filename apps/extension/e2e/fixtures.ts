import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, test as base, type BrowserContext, type Worker } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
// DIST_OVERRIDE runs the suite against a different build directory. It is
// how a fix is shown to be one: build the current tree, copy it, revert the
// change inside the copy, and run the new test against that — a test that
// passes on the code it was written to catch is not a regression test, and
// this repo has shipped one before.
const extensionDist = process.env.DIST_OVERRIDE ?? join(here, "..", "dist");

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
}>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    if (!existsSync(join(extensionDist, "manifest.json"))) {
      throw new Error(
        `${extensionDist}/manifest.json not found — run "OPENCAPTURE_E2E=1 npm run build" before the e2e suite.`,
      );
    }

    // channel: 'chromium' is required (not just "omit channel") — it's
    // the specific literal value that opts into the extension-capable
    // headless implementation. Real Chrome's plain `headless: true` uses
    // "old" headless, which has never supported extensions at all, and
    // Playwright's default bundled-Chromium launch (no channel) doesn't
    // get the same treatment either — only channel: 'chromium' does.
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`],
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker", { timeout: 20_000 });
    await use(worker);
  },

  extensionId: async ({ serviceWorker }, use) => {
    const id = new URL(serviceWorker.url()).host;
    await use(id);
  },
});

export const expect = test.expect;
