// Content script: injected on demand per capture (see
// background/orchestrator.ts — there is no static `content_scripts` entry
// in manifest.json, deliberately, so the extension never has standing
// access to pages the user hasn't asked it to capture). Runs as a classic
// script, not an ES module, so this file must import nothing — see
// docs/architecture.md.
//
// Message protocol (background -> content, request/response):
//   {action:"prep"}                    -> {metrics, innerScrollRect, pinnedElementsHandled, lazyImagesForced, warnings}
//   {action:"scrollTo", targetCss}     -> {actualScrollCss}
//   {action:"restore"}                 -> {ok:true}
//   {action:"selectArea"}              -> {rect: {x,y,width,height} | null, dpr}  (null = user cancelled)
//
// chrome.scripting.executeScript's isolated world persists across repeated
// injections into the same tab/frame — it's only torn down on navigation —
// so a second capture on a page the user never reloaded re-runs this exact
// file's top-level `const`/`let` declarations into a scope that already
// has them, throwing "Uncaught SyntaxError: Identifier '...' has already
// been declared" and silently breaking that capture. Guard the whole body
// so re-injection is a no-op: the message listener registered by the first
// injection is still alive in that persisted world and keeps handling
// subsequent captures fine without needing to run any of this again.
if (!(window as unknown as { __opencaptureContentLoaded?: boolean }).__opencaptureContentLoaded) {
  (window as unknown as { __opencaptureContentLoaded: boolean }).__opencaptureContentLoaded = true;

  // Mirrors src/platform/webext.ts's ext alias, duplicated inline rather
  // than imported: this file must compile to zero import/export syntax
  // (MV3 content scripts load as classic scripts, not modules) — see the
  // file-top comment and vite.config.ts.
  const ext: typeof chrome = (globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome;

  const STYLE_ID = "__opencapture_freeze_style__";
  const PINNED_ATTR = "data-opencapture-pinned";

  // "always" is for overlays nobody wants in a screenshot at all — a consent
  // banner is not page furniture the way a header or a footer bar is, so
  // showing it even once is showing it once too often.
  type PinnedKind = "top" | "bottom" | "always";

  let pinnedElements: Array<{ el: HTMLElement; kind: PinnedKind; originalVisibility: string }> = [];
  let totalHeightCss = 0;
  // Set for the duration of one capture (prep -> scrollTo* -> restore) when
  // detectDominantScroller finds a container worth driving instead of the
  // window — see that function and handlePrep's use of it.
  let innerScroller: HTMLElement | null = null;

  // Finds the single scrollable descendant most likely to be "the real
  // content" on a page with double scrollbars — a big inner pane (a
  // dashboard's main column, a docs site's content frame) that scrolls
  // independently of the outer page, which itself barely moves. Full-page
  // capture normally drives the outer page scroll only, so on a page like
  // this it only ever shows whatever that inner pane happened to display
  // at the top — the rest of its content is never brought into view at all.
  //
  // Deliberately narrow: picks at most one container, the largest by
  // on-screen area among elements that (a) actually overflow
  // (scrollHeight - clientHeight is more than a rounding error) and
  // (b) are set to scroll (overflow-y auto/scroll) and (c) cover a
  // substantial share of the viewport, so a small scrolling widget (a
  // code block, a chat sidebar) never gets mistaken for the main content.
  // Multiple independent scrollers, or a scroller nested inside another,
  // aren't handled — the largest single match wins, everything else is
  // left exactly as window-only capture already treats it.
  function detectDominantScroller(): HTMLElement | null {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let best: HTMLElement | null = null;
    let bestArea = 0;
    for (const el of document.body?.querySelectorAll("*") ?? []) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.scrollHeight - el.clientHeight < 50) continue;
      const style = window.getComputedStyle(el);
      if (style.overflowY !== "auto" && style.overflowY !== "scroll") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < vw * 0.5 || rect.height < vh * 0.5) continue;
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best;
  }

  // Same idea as primingScrollPass, for the inner container instead of the
  // window — without this, lazy-loaded content further down the inner
  // scroller's own content never gets a chance to load before capture.
  async function primeInnerScroller(el: HTMLElement): Promise<void> {
    const step = el.clientHeight;
    const original = el.scrollTop;
    for (let y = el.scrollHeight; y >= 0; y -= step) {
      el.scrollTo({ top: y, behavior: "instant" });
      await sleep(60);
    }
    el.scrollTo({ top: original, behavior: "instant" });
    await sleep(60);
  }

  function forceEagerLoading(): number {
    let count = 0;
    document.querySelectorAll("img[loading='lazy'], iframe[loading='lazy']").forEach((el) => {
      (el as HTMLImageElement | HTMLIFrameElement).loading = "eager";
      count++;
    });
    document.querySelectorAll<HTMLImageElement>("img[data-src]:not([src])").forEach((img) => {
      const src = img.getAttribute("data-src");
      if (src) {
        img.src = src;
        count++;
      }
    });
    document.querySelectorAll<HTMLImageElement>("img[data-srcset]:not([srcset])").forEach((img) => {
      const srcset = img.getAttribute("data-srcset");
      if (srcset) img.srcset = srcset;
    });
    return count;
  }

  async function primingScrollPass(): Promise<void> {
    const doc = document.scrollingElement ?? document.documentElement;
    const step = window.innerHeight;
    const original = doc.scrollTop;

    for (let y = doc.scrollHeight; y >= 0; y -= step) {
      window.scrollTo({ top: y, behavior: "instant" });
      await sleep(60);
    }
    window.scrollTo({ top: original, behavior: "instant" });
    await sleep(60);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForImagesAndQuiet(): Promise<void> {
    const deadline = Date.now() + 8000;

    const pendingImages = Array.from(document.images).filter((img) => !img.complete);
    await Promise.race([
      Promise.allSettled(pendingImages.map((img) => img.decode().catch(() => undefined))),
      sleep(Math.max(0, deadline - Date.now())),
    ]);

    let lastMutationAt = Date.now();
    const observer = new MutationObserver(() => {
      lastMutationAt = Date.now();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });

    while (Date.now() < deadline) {
      if (Date.now() - lastMutationAt > 300) break;
      await sleep(50);
    }
    observer.disconnect();
  }

  interface CaptureRect {
    top: number;
    left: number;
    width: number;
    height: number;
  }

  /**
   * Cookie/consent overlays, by the naming every consent platform uses.
   *
   * Matching on id/class is crude in general, but safe here because only
   * position:fixed/sticky elements are ever tested — an article *about*
   * cookies is static content and never reaches this check.
   *
   * These are hidden on every slice rather than shown once, and they are also
   * allowed past the half-viewport size guard: a consent modal is frequently
   * paired with a full-screen scrim, and a scrim left visible would tint the
   * entire stitched capture.
   */
  const CONSENT_PATTERN =
    /cookie|consent|gdpr|ccpa|cmplz|onetrust|cookiebot|didomi|osano|truste|usercentrics|klaro|termly|quantcast|privacy-?(banner|notice|bar)/i;

  /**
   * Chat and messaging docks. Like a consent banner, nobody wants their own
   * inbox in a screenshot of a page — and unlike a header, it is not part of
   * the page being captured at all.
   *
   * `msg-overlay` is LinkedIn's, which is what prompted this; the rest are the
   * widgets that show up on other people's sites.
   */
  const CHAT_PATTERN =
    /msg-overlay|intercom|drift-|drift_|crisp-client|zendesk|zopim|tawk|livechat|live-chat|hubspot-messages|freshchat|helpscout|olark|smartsupp|chat-?(widget|bubble|launcher|window)/i;

  function looksLikeConsentOverlay(el: HTMLElement): boolean {
    return CONSENT_PATTERN.test(signature(el));
  }

  function looksLikeChatOverlay(el: HTMLElement): boolean {
    return CHAT_PATTERN.test(signature(el));
  }

  /** id + class + a couple of labels — what these widgets are recognisable by. */
  function signature(el: HTMLElement): string {
    const className = typeof el.className === "string" ? el.className : "";
    return `${el.id} ${className} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("data-testid") ?? ""}`;
  }

  /** The band being captured: the window viewport, or the inner scroller's box. */
  function captureRect(): CaptureRect {
    if (innerScroller) {
      const r = innerScroller.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height };
    }
    return { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
  }

  /**
   * Find the fixed/sticky bars that would otherwise be re-photographed into
   * every slice.
   *
   * This sweeps the DOM rather than hit-testing a few points. Hit-testing was
   * the obvious approach and it silently fails on the pages that need this
   * most: `elementsFromPoint` is a pointer API, so it skips anything with
   * `pointer-events: none` — the exact trick a transparent overlay header uses
   * to let clicks through to the content beneath. On chatgpt.com four sample
   * points found 1 of 7 pinned bars, and the one they found was in the
   * sidebar, not the header and composer that were actually repeating.
   *
   * A sweep costs ~1-2ms for ~550 elements, which is why it can also run per
   * slice — see handleScrollTo. That matters for headers that only become
   * sticky *after* the user scrolls, which no single pass at scroll-position 0
   * can ever see.
   */
  function classifyPinnedElements(): void {
    pinnedElements = [];
    const view = captureRect();
    const viewBottom = view.top + view.height;
    const viewRight = view.left + view.width;
    const midline = view.top + view.height / 2;

    for (const el of document.body?.querySelectorAll("*") ?? []) {
      if (!(el instanceof HTMLElement)) continue;
      const style = window.getComputedStyle(el);
      if (style.position !== "fixed" && style.position !== "sticky") continue;
      if (style.display === "none" || style.visibility === "hidden") continue;

      // Hiding the scroll container — or anything wrapping it — would blank
      // the capture instead of cleaning it up.
      if (innerScroller && (el === innerScroller || el.contains(innerScroller))) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 8) continue;

      // Must actually intrude on the band being captured. In inner-scroll mode
      // this drops the page's own sidebar chrome, which the orchestrator crops
      // away anyway.
      if (rect.bottom <= view.top || rect.top >= viewBottom) continue;
      if (rect.right <= view.left || rect.left >= viewRight) continue;

      const alwaysHide = looksLikeConsentOverlay(el) || looksLikeChatOverlay(el);

      // A tall sticky element is usually page furniture holding real content —
      // a sticky column, a nav rail — and hiding it would remove content
      // rather than clean it up. But height alone was the wrong test: a chat
      // dock or side drawer is tall *and narrow*, and LinkedIn's messaging
      // overlay sailed through this guard and was re-photographed into every
      // slice. Content columns are wide; widgets cling to an edge. Require
      // both before deciding something is content worth keeping.
      const tall = rect.height > view.height * 0.5;
      const wide = rect.width > view.width * 0.4;
      if (!alwaysHide && tall && wide) continue;

      const kind: PinnedKind = alwaysHide
        ? "always"
        : rect.top + rect.height / 2 < midline
          ? "top"
          : "bottom";
      pinnedElements.push({ el, kind, originalVisibility: el.style.visibility });
      el.setAttribute(PINNED_ATTR, kind);
    }
  }

  /**
   * Re-run classification for a slice. Restores first: a hidden element reads
   * as `visibility: hidden` and would be skipped by the sweep, dropping it
   * from the list and stranding it hidden after the capture finished.
   */
  function reclassifyPinnedElements(): void {
    restorePinnedElements();
    classifyPinnedElements();
  }

  function injectFreezeStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      html { scroll-behavior: auto !important; }
      *, *::before, *::after { animation-play-state: paused !important; transition: none !important; }
      html::-webkit-scrollbar { display: none; }
    `;
    document.documentElement.appendChild(style);
    document.querySelectorAll("video").forEach((v) => v.pause());
  }

  function removeFreezeStyle(): void {
    document.getElementById(STYLE_ID)?.remove();
  }

  function applyPinnedVisibility(isFirstSlice: boolean, isLastSlice: boolean): void {
    for (const p of pinnedElements) {
      const shouldShow =
        p.kind === "always" ? false : (p.kind === "top" && isFirstSlice) || (p.kind === "bottom" && isLastSlice);
      p.el.style.visibility = shouldShow ? p.originalVisibility : "hidden";
    }
  }

  function restorePinnedElements(): void {
    for (const p of pinnedElements) {
      p.el.style.visibility = p.originalVisibility;
      p.el.removeAttribute(PINNED_ATTR);
    }
    pinnedElements = [];
  }

  async function handlePrep() {
    const lazyImagesForced = forceEagerLoading();
    await primingScrollPass();

    innerScroller = detectDominantScroller();
    if (innerScroller) await primeInnerScroller(innerScroller);

    await waitForImagesAndQuiet();
    injectFreezeStyle();

    // Pinned elements are hidden on every slice but the one they belong to,
    // in both scroll modes. Inner-scroll used to skip this entirely, which is
    // why sticky headers repeated down the whole capture on app-shell layouts
    // like chatgpt.com: the window never scrolls there, but the bars pinned
    // over the scrolling container get re-photographed into every slice.
    let metrics: { viewportWidthCss: number; viewportHeightCss: number; totalHeightCss: number; dpr: number };
    let innerScrollRect: { x: number; y: number; width: number; height: number } | null = null;
    const dpr = window.devicePixelRatio || 1;
    if (innerScroller) {
      totalHeightCss = innerScroller.scrollHeight;
      const rect = innerScroller.getBoundingClientRect();
      innerScrollRect = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      metrics = { viewportWidthCss: rect.width, viewportHeightCss: innerScroller.clientHeight, totalHeightCss, dpr };
      classifyPinnedElements();
      applyPinnedVisibility(true, totalHeightCss <= innerScroller.clientHeight);
    } else {
      const doc = document.scrollingElement ?? document.documentElement;
      totalHeightCss = doc.scrollHeight;
      metrics = { viewportWidthCss: window.innerWidth, viewportHeightCss: window.innerHeight, totalHeightCss, dpr };
      classifyPinnedElements();
      applyPinnedVisibility(true, totalHeightCss <= window.innerHeight);
    }

    return {
      metrics,
      innerScrollRect,
      pinnedElementsHandled: pinnedElements.length,
      lazyImagesForced,
      warnings: innerScroller ? ["Captured an inner scrolling area on this page instead of the full window."] : ([] as string[]),
    };
  }

  async function handleScrollTo(targetCss: number) {
    let actualScrollCss: number;
    let viewportHeight: number;

    if (innerScroller) {
      innerScroller.scrollTo({ top: targetCss, behavior: "instant" });
      await sleep(2 * 16 + 150);
      actualScrollCss = innerScroller.scrollTop;
      viewportHeight = innerScroller.clientHeight;
    } else {
      window.scrollTo({ top: targetCss, behavior: "instant" });
      await sleep(2 * 16 + 150);
      actualScrollCss = (document.scrollingElement ?? document.documentElement).scrollTop;
      viewportHeight = window.innerHeight;
    }

    // Re-classify rather than reuse the prep-time list: plenty of sites only
    // promote a header to sticky once scrolling starts, so a list built at
    // scroll-position 0 misses exactly the bars that go on to repeat. The
    // sweep is ~1-2ms, cheap enough to repeat per slice.
    reclassifyPinnedElements();

    const isFirstSlice = targetCss <= 0;
    const isLastSlice = actualScrollCss + viewportHeight >= totalHeightCss - 1;
    applyPinnedVisibility(isFirstSlice, isLastSlice);
    // Re-settle after visibility toggles so the capture doesn't race a
    // layout/paint that's still catching up.
    await sleep(2 * 16);

    return { actualScrollCss };
  }

  function handleRestore() {
    restorePinnedElements();
    if (innerScroller) {
      innerScroller.scrollTop = 0;
      innerScroller = null;
    }
    removeFreezeStyle();
    return { ok: true as const };
  }

  interface SelectedRect {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  // Selected-area capture is deliberately viewport-only (no scrolling
  // involved) — the user drags a rect over what's currently on screen, we
  // capture the visible tab once, and crop. A scrollable-page selection tool
  // is a distinct, more complex feature (has to reconcile the selection with
  // the scroll/stitch pipeline) and isn't in this MVP's scope.
  //
  // Two phases, not one straight-through drag: "drawing" (no rect yet, or
  // actively dragging one out) and "adjusting" (a rect exists, idle,
  // waiting for Enter/Esc/a further drag). Finalizing on mouseup used to
  // mean one imprecise drag was the only chance to get the rect right —
  // this lets that first drag be a rough pass, then fine-tune corners or
  // reposition the whole box before committing.
  const HANDLE_CORNERS = ["nw", "ne", "sw", "se"] as const;
  type Corner = (typeof HANDLE_CORNERS)[number];

  function handleSelectArea(): Promise<{ rect: SelectedRect | null; dpr: number }> {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.15);touch-action:none;";
      const selBox = document.createElement("div");
      selBox.style.cssText =
        "position:fixed;border:2px solid #4f7cff;background:rgba(79,124,255,0.15);display:none;z-index:2147483647;pointer-events:none;touch-action:none;";
      const hint = document.createElement("div");
      hint.style.cssText =
        "position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#222;color:#fff;" +
        "padding:6px 12px;border-radius:6px;font:13px system-ui, sans-serif;z-index:2147483647;pointer-events:none;white-space:nowrap;";

      // Touch fingertips are far less precise than a mouse cursor — a 10px
      // handle that's comfortable to grab with a pointer is nearly
      // untappable with a finger, so coarse pointers (touch) get a larger
      // target. Desktop mouse UX (the far more common case) stays pixel-
      // identical to before.
      const isCoarsePointer = matchMedia("(pointer: coarse)").matches;
      const HANDLE_SIZE = isCoarsePointer ? 20 : 10;
      const HANDLE_CURSORS: Record<Corner, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize" };
      const handles = {} as Record<Corner, HTMLDivElement>;
      for (const corner of HANDLE_CORNERS) {
        const h = document.createElement("div");
        h.style.cssText =
          `position:fixed;width:${HANDLE_SIZE}px;height:${HANDLE_SIZE}px;border-radius:50%;` +
          `background:#fff;border:2px solid #4f7cff;z-index:2147483647;display:none;cursor:${HANDLE_CURSORS[corner]};touch-action:none;`;
        handles[corner] = h;
      }

      // Mobile has no Enter/Esc — these two buttons are the touch
      // equivalent of the keyboard shortcuts below, calling the exact same
      // finish()/enterDrawing() functions. Shown on both platforms (not
      // gated behind isCoarsePointer) so they're purely additive: desktop's
      // keyboard shortcuts keep working completely unchanged.
      const confirmBtn = document.createElement("div");
      confirmBtn.style.cssText =
        "position:fixed;width:44px;height:44px;border-radius:50%;display:none;z-index:2147483647;" +
        "background:#2e7d32;color:#fff;align-items:center;justify-content:center;font:20px/1 system-ui, sans-serif;" +
        "cursor:pointer;touch-action:none;box-shadow:0 2px 6px rgba(0,0,0,0.35);";
      confirmBtn.textContent = "✓";
      confirmBtn.setAttribute("aria-label", "Confirm selection");
      const cancelBtn = document.createElement("div");
      cancelBtn.style.cssText =
        "position:fixed;width:44px;height:44px;border-radius:50%;display:none;z-index:2147483647;" +
        "background:#444;color:#fff;align-items:center;justify-content:center;font:20px/1 system-ui, sans-serif;" +
        "cursor:pointer;touch-action:none;box-shadow:0 2px 6px rgba(0,0,0,0.35);";
      cancelBtn.textContent = "✕";
      cancelBtn.setAttribute("aria-label", "Reselect");

      document.documentElement.append(overlay, selBox, ...HANDLE_CORNERS.map((c) => handles[c]), confirmBtn, cancelBtn, hint);

      type DragMode = "new" | "move" | { corner: Corner } | null;
      let phase: "drawing" | "adjusting" = "drawing";
      let rect: SelectedRect | null = null;
      let dragMode: DragMode = null;
      let dragStartX = 0;
      let dragStartY = 0;
      let dragStartRect: SelectedRect | null = null;
      let settled = false;

      function setHint(text: string): void {
        hint.textContent = text;
      }

      const ACTION_BTN_SIZE = 44;
      const ACTION_BTN_GAP = 8;

      function positionSelBox(r: SelectedRect): void {
        selBox.style.left = `${r.x}px`;
        selBox.style.top = `${r.y}px`;
        selBox.style.width = `${r.width}px`;
        selBox.style.height = `${r.height}px`;
        const half = HANDLE_SIZE / 2;
        handles.nw.style.left = `${r.x - half}px`;
        handles.nw.style.top = `${r.y - half}px`;
        handles.ne.style.left = `${r.x + r.width - half}px`;
        handles.ne.style.top = `${r.y - half}px`;
        handles.sw.style.left = `${r.x - half}px`;
        handles.sw.style.top = `${r.y + r.height - half}px`;
        handles.se.style.left = `${r.x + r.width - half}px`;
        handles.se.style.top = `${r.y + r.height - half}px`;

        // Anchored just outside the box's bottom-right corner, clamped so a
        // selection near a viewport edge doesn't push either button off-screen.
        const clampedLeft = Math.min(
          Math.max(0, r.x + r.width - ACTION_BTN_SIZE),
          window.innerWidth - ACTION_BTN_SIZE * 2 - ACTION_BTN_GAP,
        );
        const clampedTop = Math.min(Math.max(0, r.y + r.height + ACTION_BTN_GAP), window.innerHeight - ACTION_BTN_SIZE);
        confirmBtn.style.left = `${clampedLeft}px`;
        confirmBtn.style.top = `${clampedTop}px`;
        cancelBtn.style.left = `${clampedLeft + ACTION_BTN_SIZE + ACTION_BTN_GAP}px`;
        cancelBtn.style.top = `${clampedTop}px`;
      }

      function showHandles(show: boolean): void {
        for (const corner of HANDLE_CORNERS) handles[corner].style.display = show ? "block" : "none";
        confirmBtn.style.display = show ? "flex" : "none";
        cancelBtn.style.display = show ? "flex" : "none";
      }

      function enterDrawing(): void {
        phase = "drawing";
        rect = null;
        selBox.style.display = "none";
        selBox.style.pointerEvents = "none";
        showHandles(false);
        setHint("Drag to select an area — Esc to cancel");
      }

      function enterAdjusting(r: SelectedRect): void {
        phase = "adjusting";
        rect = r;
        positionSelBox(r);
        selBox.style.display = "block";
        selBox.style.pointerEvents = "auto";
        selBox.style.cursor = "move";
        showHandles(true);
        setHint("Drag to adjust, or use the buttons below");
      }

      confirmBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
      confirmBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (rect) finish(rect);
      });
      cancelBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
      cancelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        enterDrawing();
      });

      function cleanup(): void {
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        overlay.remove();
        selBox.remove();
        hint.remove();
        confirmBtn.remove();
        cancelBtn.remove();
        for (const corner of HANDLE_CORNERS) handles[corner].remove();
      }

      function finish(finalRect: SelectedRect | null): void {
        if (settled) return;
        settled = true;
        cleanup();
        // One repaint cycle so the overlay/handles are actually gone from
        // the frame captureVisibleTab reads a moment later.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve({ rect: finalRect, dpr: window.devicePixelRatio || 1 })),
        );
      }

      // Drag deltas can push a corner past the opposite one (dragging the
      // top edge below the bottom edge, etc.) — normalize rather than
      // clamp, so the box flips through zero cleanly instead of sticking.
      function normalizeRect(r: SelectedRect): SelectedRect {
        let { x, y, width, height } = r;
        if (width < 0) {
          x += width;
          width = -width;
        }
        if (height < 0) {
          y += height;
          height = -height;
        }
        return { x, y, width, height };
      }

      function onKeyDown(e: KeyboardEvent): void {
        if (e.key === "Escape") {
          if (phase === "adjusting") {
            enterDrawing();
            return;
          }
          finish(null);
          return;
        }
        if (e.key === "Enter" && phase === "adjusting" && rect) {
          finish(rect);
        }
      }
      document.addEventListener("keydown", onKeyDown, true);

      // Starting a fresh drag always wins, even mid-adjust — discards
      // whatever was being fine-tuned and draws a new box from scratch.
      //
      // Pointer Events (not Mouse Events) throughout this tool: they unify
      // mouse and touch input behind one API, so the exact same handlers
      // drive both without forking any drag logic. setPointerCapture keeps
      // move/up events targeted correctly even if a finger drifts off a
      // small element mid-drag — a real risk for the 10-20px resize
      // handles, which are far below a fingertip's contact precision.
      overlay.addEventListener("pointerdown", (e) => {
        overlay.setPointerCapture(e.pointerId);
        dragMode = "new";
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        enterDrawing();
        selBox.style.display = "block";
        selBox.style.left = `${dragStartX}px`;
        selBox.style.top = `${dragStartY}px`;
        selBox.style.width = "0px";
        selBox.style.height = "0px";
      });

      for (const corner of HANDLE_CORNERS) {
        handles[corner].addEventListener("pointerdown", (e) => {
          e.stopPropagation(); // don't also trigger overlay's "start a new box"
          handles[corner].setPointerCapture(e.pointerId);
          dragMode = { corner };
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          dragStartRect = rect;
        });
      }
      selBox.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        selBox.setPointerCapture(e.pointerId);
        dragMode = "move";
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragStartRect = rect;
      });

      function onMove(e: PointerEvent): void {
        if (dragMode === "new") {
          const x = Math.min(dragStartX, e.clientX);
          const y = Math.min(dragStartY, e.clientY);
          const width = Math.abs(e.clientX - dragStartX);
          const height = Math.abs(e.clientY - dragStartY);
          selBox.style.left = `${x}px`;
          selBox.style.top = `${y}px`;
          selBox.style.width = `${width}px`;
          selBox.style.height = `${height}px`;
          return;
        }
        if (!dragStartRect) return;
        if (dragMode === "move") {
          const dx = e.clientX - dragStartX;
          const dy = e.clientY - dragStartY;
          rect = { ...dragStartRect, x: dragStartRect.x + dx, y: dragStartRect.y + dy };
          positionSelBox(rect);
          return;
        }
        if (dragMode && typeof dragMode === "object") {
          const dx = e.clientX - dragStartX;
          const dy = e.clientY - dragStartY;
          let { x, y, width, height } = dragStartRect;
          if (dragMode.corner.includes("n")) {
            y += dy;
            height -= dy;
          }
          if (dragMode.corner.includes("s")) height += dy;
          if (dragMode.corner.includes("w")) {
            x += dx;
            width -= dx;
          }
          if (dragMode.corner.includes("e")) width += dx;
          rect = normalizeRect({ x, y, width, height });
          positionSelBox(rect);
        }
      }
      document.addEventListener("pointermove", onMove);

      function onUp(e: PointerEvent): void {
        if (dragMode === "new") {
          const x = Math.min(dragStartX, e.clientX);
          const y = Math.min(dragStartY, e.clientY);
          const width = Math.abs(e.clientX - dragStartX);
          const height = Math.abs(e.clientY - dragStartY);
          dragMode = null;
          if (width < 3 || height < 3) {
            finish(null);
            return;
          }
          enterAdjusting({ x, y, width, height });
          return;
        }
        dragMode = null;
        dragStartRect = null;
      }
      document.addEventListener("pointerup", onUp);

      enterDrawing();
    });
  }

  ext.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const request = message as { action?: string; targetCss?: number };

    if (request.action === "prep") {
      handlePrep().then(sendResponse);
      return true;
    }
    if (request.action === "scrollTo" && typeof request.targetCss === "number") {
      handleScrollTo(request.targetCss).then(sendResponse);
      return true;
    }
    if (request.action === "restore") {
      sendResponse(handleRestore());
      return false;
    }
    if (request.action === "selectArea") {
      handleSelectArea().then(sendResponse);
      return true;
    }
    return false;
  });
} // end re-injection guard
