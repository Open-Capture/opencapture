import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("../platform/webext");
});

/** A page with just enough DOM for a download link, recording what was clicked. */
function fakePage(pathname: string) {
  const clicked: { href: string; download: string }[] = [];
  const doc = {
    body: { appendChild: () => {} },
    createElement: () => {
      const link = {
        href: "",
        download: "",
        hidden: false,
        click: () => clicked.push({ href: link.href, download: link.download }),
        remove: () => {},
      };
      return link;
    },
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", { pathname });
  vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: () => "blob:moz-extension://x/1", revokeObjectURL: () => {} }));
  return clicked;
}

async function load(android: boolean, download = vi.fn()) {
  vi.doMock("../platform/webext", () => ({
    detectAndroid: async () => android,
    ext: { downloads: { download, onChanged: { addListener: () => {}, removeListener: () => {} } } },
  }));
  return { ...(await import("./downloads")), download };
}

describe("downloadBytes", () => {
  it("saves through a download link on Android, never through downloads.download", async () => {
    const clicked = fakePage("/popup.html");
    const { downloadBytes, download } = await load(true);
    await downloadBytes(new Uint8Array([1, 2, 3]), "OpenCapture/page.pdf", "application/pdf");
    expect(download).not.toHaveBeenCalled();
    // A link cannot pick a subfolder of Downloads: the name is the last segment.
    expect(clicked).toEqual([{ href: "blob:moz-extension://x/1", download: "page.pdf" }]);
  });

  it("refuses in the background on Android instead of saving nothing", async () => {
    const clicked = fakePage("/_generated_background_page.html");
    const { downloadBytes } = await load(true);
    await expect(downloadBytes(new Uint8Array([1]), "page.png", "image/png")).rejects.toThrow(/from a page/);
    expect(clicked).toEqual([]);
  });

  it("still uses downloads.download off Android", async () => {
    const clicked = fakePage("/editor.html");
    const download = vi.fn(async () => 7);
    const { downloadBytes } = await load(false, download);
    await downloadBytes(new Uint8Array([1]), "page.png", "image/png");
    expect(download).toHaveBeenCalledTimes(1);
    expect(clicked).toEqual([]);
  });
});
