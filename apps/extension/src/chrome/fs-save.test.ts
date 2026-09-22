import { describe, expect, it } from "vitest";

import { saveToDirectory } from "./fs-save";

/**
 * Just enough of FileSystemDirectoryHandle to behave the way Chromium's does
 * where APP-113 lives: getFileHandle without `create` rejects NotFoundError
 * for a missing name, with `create` it opens whatever is already there, and
 * createWritable starts from empty — which is exactly what turned "save" into
 * "replace".
 */
function fakeDirectory(initial: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([name, text]) => [name, new TextEncoder().encode(text)]),
  );
  const handle = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException(`${name} not found`, "NotFoundError");
        files.set(name, new Uint8Array());
      }
      return {
        async createWritable() {
          const chunks: Uint8Array[] = [];
          return {
            async write(data: Uint8Array) {
              chunks.push(new Uint8Array(data));
            },
            async close() {
              files.set(name, new Uint8Array(chunks.flatMap((c) => [...c])));
            },
          };
        },
      };
    },
  };
  const read = (name: string) => (files.has(name) ? new TextDecoder().decode(files.get(name)) : undefined);
  return { handle: handle as unknown as FileSystemDirectoryHandle, files, read };
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("saveToDirectory (APP-113)", () => {
  it("writes the name it was given when nothing is there yet", async () => {
    const dir = fakeDirectory();
    expect(await saveToDirectory(dir.handle, "opencapture.png", bytes("first"))).toBe("opencapture.png");
    expect(dir.read("opencapture.png")).toBe("first");
  });

  it("never replaces an existing capture — the next one is numbered instead", async () => {
    const dir = fakeDirectory({ "opencapture.png": "yesterday's capture" });
    const used = await saveToDirectory(dir.handle, "opencapture.png", bytes("today's capture"));
    expect(used).toBe("opencapture (1).png");
    expect(dir.read("opencapture.png")).toBe("yesterday's capture");
    expect(dir.read("opencapture (1).png")).toBe("today's capture");
  });

  it("keeps counting past every name already taken", async () => {
    const dir = fakeDirectory({
      "opencapture.png": "a",
      "opencapture (1).png": "b",
      "opencapture (2).png": "c",
    });
    expect(await saveToDirectory(dir.handle, "opencapture.png", bytes("d"))).toBe("opencapture (3).png");
    expect([...dir.files.keys()].sort()).toEqual([
      "opencapture (1).png",
      "opencapture (2).png",
      "opencapture (3).png",
      "opencapture.png",
    ]);
  });

  it("numbers before the extension, and copes with a name that has none", async () => {
    const dir = fakeDirectory({ "report.annotated.pdf": "x", notes: "y" });
    expect(await saveToDirectory(dir.handle, "report.annotated.pdf", bytes("z"))).toBe("report.annotated (1).pdf");
    expect(await saveToDirectory(dir.handle, "notes", bytes("z"))).toBe("notes (1)");
  });

  it("five saves in a row leave five files, not one", async () => {
    const dir = fakeDirectory();
    for (let i = 0; i < 5; i++) await saveToDirectory(dir.handle, "opencapture.png", bytes(`capture ${i}`));
    expect(dir.files.size).toBe(5);
    expect(dir.read("opencapture.png")).toBe("capture 0");
    expect(dir.read("opencapture (4).png")).toBe("capture 4");
  });
});
