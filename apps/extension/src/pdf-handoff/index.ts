// Delivers an exported PDF into an openpdfedit.com/app tab.
//
// Import-free and IIFE-sealed like content/index.ts — see that file's module
// doc and scripts/seal-content-scripts.mjs. A content script is a classic
// script, so an `import` here fails on the page, where CI never looks.
//
// The protocol is openpdfedit's, defined in its lib/handoff.ts: the page
// announces `openpdfedit:handoff-ready` on a timer while it waits, and takes
// delivery of `openpdfedit:handoff-file`. Announcing repeatedly is what makes
// the ordering safe — this script may be injected before the page mounts or
// after it has already started asking, and neither side can tell which.
//
// Why a content script at all, rather than a URL or an upload: that app opens
// PDFs only through a native file picker, which nothing outside the page can
// fill, and it has no server to post to by design. Sharing the page's window
// is the one route left.
(() => {
  const READY = "openpdfedit:handoff-ready";
  const FILE = "openpdfedit:handoff-file";
  const PORT = "opencapture-pdf-handoff";
  const MARKER = "opencapture";

  interface Loaded {
    __opencapturePdfHandoffLoaded?: boolean;
  }
  const scope = window as unknown as Loaded;
  if (scope.__opencapturePdfHandoffLoaded) return;
  scope.__opencapturePdfHandoffLoaded = true;

  // Registered for the whole site, because a match pattern cannot address a
  // query string. Every other page here is none of this script's business.
  if (new URLSearchParams(window.location.search).get("handoff") !== MARKER) return;

  let pending: { name: string; bytes: Uint8Array } | null = null;
  let pageReady = false;
  let delivered = false;

  function deliver(): void {
    if (delivered || !pending || !pageReady) return;
    delivered = true;
    window.postMessage(
      { type: FILE, name: pending.name, bytes: pending.bytes },
      window.location.origin,
    );
    window.removeEventListener("message", onMessage);
  }

  function onMessage(event: MessageEvent): void {
    // The page's own announcement, in the window this script was injected
    // into. Anything from a frame or another origin is not it.
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data as { type?: unknown } | null;
    if (!data || data.type !== READY) return;
    pageReady = true;
    deliver();
  }

  window.addEventListener("message", onMessage);

  // Base64 chunks over a Port, not one sendMessage: a PDF of a long capture
  // can pass the ~64MiB structured-clone cap that broke the editor handoff
  // before it was chunked, and base64 because a Uint8Array posted over a Port
  // arrives from the worker stripped of its prototype. Same shape as the
  // editor image port in background/index.ts.
  const chunks: Uint8Array[] = [];
  let name = "capture.pdf";
  const port = chrome.runtime.connect({ name: PORT });
  port.onMessage.addListener((message: { chunk?: string; name?: string; done?: boolean }) => {
    if (typeof message.name === "string") name = message.name;
    if (typeof message.chunk === "string") {
      const binary = atob(message.chunk);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      chunks.push(bytes);
      return;
    }
    if (!message.done) return;
    port.disconnect();
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    // Nothing waiting: the tab was opened by hand, or the export this was
    // meant to carry has already been delivered once.
    if (total === 0) {
      window.removeEventListener("message", onMessage);
      return;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    pending = { name, bytes: merged };
    deliver();
  });
})();
