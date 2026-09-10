import { HISTORY_LIST_PORT_NAME, type HistoryEntryMeta } from "../chrome/capture-history";
import { initPageLocale, t } from "../i18n";
import { ext } from "../platform/webext";

const gridEl = document.getElementById("historyGrid")!;
const emptyEl = document.getElementById("historyEmpty")!;
const clearBtn = document.getElementById("clearHistory") as HTMLButtonElement;
const closeBtn = document.getElementById("closeHistory") as HTMLButtonElement;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function relativeTime(timestamp: number): string {
  const sec = Math.round((Date.now() - timestamp) / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return new Date(timestamp).toLocaleDateString();
}

let entryCount = 0;

function icon(name: string, size: 14 | 16 = 14): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = `oa-icon oa-icon-${size} icon-${name}`;
  return span;
}

function addTile(meta: HistoryEntryMeta, bytes: Uint8Array): void {
  entryCount++;
  emptyEl.hidden = true;
  clearBtn.hidden = false;

  const blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));

  const tile = document.createElement("div");
  tile.className = "history-tile";
  tile.dataset.id = String(meta.id);

  const openBtn = document.createElement("button");
  openBtn.className = "history-tile-open";
  openBtn.type = "button";
  openBtn.title = t("Open in editor");
  const img = document.createElement("img");
  img.src = blobUrl;
  img.alt = meta.title || meta.url;
  openBtn.appendChild(img);
  openBtn.addEventListener("click", () => void openInEditor(meta.id));

  const metaRow = document.createElement("div");
  metaRow.className = "history-tile-meta";

  const text = document.createElement("div");
  text.className = "history-tile-text";
  const titleEl = document.createElement("span");
  titleEl.className = "history-tile-title";
  titleEl.textContent = meta.title || hostFromUrl(meta.url) || "Untitled page";
  const subEl = document.createElement("span");
  subEl.className = "history-tile-sub";
  subEl.textContent = `${hostFromUrl(meta.url)} · ${relativeTime(meta.timestamp)} · ${meta.width}×${meta.height}`;
  text.append(titleEl, subEl);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "icon-btn history-tile-delete";
  deleteBtn.type = "button";
  deleteBtn.title = t("Delete");
  deleteBtn.appendChild(icon("trash-2"));
  deleteBtn.addEventListener("click", () => void deleteEntry(meta.id, tile, blobUrl));

  metaRow.append(text, deleteBtn);
  tile.append(openBtn, metaRow);
  gridEl.appendChild(tile);
}

async function openInEditor(id: number): Promise<void> {
  const response = (await ext.runtime.sendMessage({ type: "history:openInEditor", id })) as { ok: boolean; error?: string };
  if (!response.ok) alert(response.error ?? "Couldn't open that capture.");
}

async function deleteEntry(id: number, tile: HTMLElement, blobUrl: string): Promise<void> {
  const response = (await ext.runtime.sendMessage({ type: "history:delete", id })) as { ok: boolean; error?: string };
  if (!response.ok) {
    alert(response.error ?? "Couldn't delete that capture.");
    return;
  }
  tile.remove();
  URL.revokeObjectURL(blobUrl);
  entryCount--;
  if (entryCount === 0) {
    emptyEl.hidden = false;
    clearBtn.hidden = true;
  }
}

clearBtn.addEventListener("click", async () => {
  if (!confirm(t("Delete all capture history? This can't be undone."))) return;
  const response = (await ext.runtime.sendMessage({ type: "history:clear" })) as { ok: boolean; error?: string };
  if (!response.ok) {
    alert(response.error ?? "Couldn't clear history.");
    return;
  }
  gridEl.replaceChildren();
  entryCount = 0;
  emptyEl.hidden = false;
  clearBtn.hidden = true;
});

closeBtn.addEventListener("click", async () => {
  // Same reasoning as editor.ts/account.ts's own close handlers: this tab
  // was opened via ext.tabs.create(), not window.open(), so window.close()
  // alone can silently no-op.
  const tab = await ext.tabs.getCurrent();
  if (tab?.id !== undefined) {
    await ext.tabs.remove(tab.id);
  } else {
    window.close();
  }
});

// Streamed from the background context rather than read directly from
// this document's own IndexedDB connection — see HISTORY_LIST_PORT_NAME's
// comment in chrome/capture-history.ts for why (Firefox private-browsing
// storage partitioning, same reasoning as editor.ts's own image fetch).
// One entryStart/chunk*/entryDone sequence per capture, newest first, so
// tiles render as each entry arrives instead of waiting for the whole log.
(function streamHistory(): void {
  const port = ext.runtime.connect({ name: HISTORY_LIST_PORT_NAME });
  let currentMeta: HistoryEntryMeta | null = null;
  let currentChunks: Uint8Array[] = [];

  port.onMessage.addListener((msg: { entryStart?: HistoryEntryMeta; chunk?: string; entryDone?: true; allDone?: true }) => {
    if (msg.entryStart) {
      currentMeta = msg.entryStart;
      currentChunks = [];
      return;
    }
    if (msg.chunk) {
      currentChunks.push(base64ToBytes(msg.chunk));
      return;
    }
    if (msg.entryDone) {
      if (currentMeta) {
        const total = currentChunks.reduce((sum, c) => sum + c.length, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of currentChunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        addTile(currentMeta, merged);
      }
      currentMeta = null;
      currentChunks = [];
      return;
    }
    if (msg.allDone) {
      port.disconnect();
      if (entryCount === 0) emptyEl.hidden = false;
    }
  });
})();

// Translate the page. Last, so every element this file created exists by
// the time the walk runs; see i18n/index.ts's localizeDom.
initPageLocale();
