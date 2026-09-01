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
//   {action:"selectArea"}              -> {rect: {x,y,width,height} | null, dpr, target: {width,height} | null}
//                                        (rect null = user cancelled; target = exact output size, if asked for)
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

  interface PinnedStyle {
    value: string;
    priority: string;
  }
  let pinnedElements: Array<{
    el: HTMLElement;
    kind: PinnedKind;
    originalVisibility: PinnedStyle;
    originalOpacity: PinnedStyle;
  }> = [];

  function inlineStyle(el: HTMLElement, prop: string): PinnedStyle {
    return { value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) };
  }

  function restoreStyle(el: HTMLElement, prop: string, saved: PinnedStyle): void {
    if (saved.value) el.style.setProperty(prop, saved.value, saved.priority);
    else el.style.removeProperty(prop);
  }
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

      const alwaysHide = looksLikeConsentOverlay(el) || looksLikeChatOverlay(el);
      const rect = el.getBoundingClientRect();

      // Consent and chat widgets skip the geometry guards entirely.
      //
      // Measuring the pinned element assumes it is the thing you can see, and
      // for these widgets it frequently is not: the pinned node is a container
      // whose own box collapses to nothing while the bubble people actually
      // see is an absolutely-positioned child of it. LinkedIn's messaging dock
      // is exactly that shape — a 0x0 `#msg-overlay` holding a 300x400 bubble
      // — so the minimum-size check dropped it and the dock was re-photographed
      // into every slice. Hiding it regardless is safe: to get here an element
      // must already be fixed/sticky *and* carry a consent/chat name, and
      // hiding a container hides the descendants that render outside its box.
      if (!alwaysHide) {
        if (rect.width < 40 || rect.height < 8) continue;

        // Must actually intrude on the band being captured. In inner-scroll
        // mode this drops the page's own sidebar chrome, which the
        // orchestrator crops away anyway.
        if (rect.bottom <= view.top || rect.top >= viewBottom) continue;
        if (rect.right <= view.left || rect.left >= viewRight) continue;
      }

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
      pinnedElements.push({
        el,
        kind,
        originalVisibility: inlineStyle(el, "visibility"),
        originalOpacity: inlineStyle(el, "opacity"),
      });
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
      if (shouldShow) {
        restoreStyle(p.el, "visibility", p.originalVisibility);
        restoreStyle(p.el, "opacity", p.originalOpacity);
        continue;
      }
      // Both properties, both !important.
      //
      // `visibility` alone is not enough to hide a subtree: it is an inherited
      // property, so any descendant that sets `visibility: visible` re-shows
      // itself inside a hidden ancestor — and chat widgets do exactly that to
      // animate their launcher. `opacity` has no such escape hatch: it applies
      // to the element's whole rendered group, so a descendant cannot opt back
      // in. `important` because a stylesheet rule marked `!important` would
      // otherwise outrank a plain inline declaration.
      //
      // Neither property affects layout, so nothing reflows and the slice
      // still lines up with the ones around it.
      p.el.style.setProperty("visibility", "hidden", "important");
      p.el.style.setProperty("opacity", "0", "important");
    }
  }

  function restorePinnedElements(): void {
    for (const p of pinnedElements) {
      restoreStyle(p.el, "visibility", p.originalVisibility);
      restoreStyle(p.el, "opacity", p.originalOpacity);
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

  function handleSelectArea(): Promise<{
    rect: SelectedRect | null;
    dpr: number;
    target: { width: number; height: number } | null;
  }> {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.15);touch-action:none;";
      const selBox = document.createElement("div");
      selBox.style.cssText =
        "position:fixed;border:2px solid #4f7cff;background:rgba(79,124,255,0.15);display:none;z-index:2147483647;pointer-events:none;touch-action:none;";
      // The hint is a control bar rather than a label: it carries the live
      // size readout and the target-size box. `pointer-events:auto` because
      // the input has to be typeable — every child that can be clicked stops
      // its own pointerdown so the overlay does not read it as "start a new
      // selection underneath".
      const hint = document.createElement("div");
      hint.style.cssText =
        "position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#222;color:#fff;" +
        "padding:6px 12px;border-radius:6px;font:13px system-ui, sans-serif;z-index:2147483647;" +
        "pointer-events:auto;white-space:nowrap;display:flex;align-items:center;gap:10px;";
      const hintText = document.createElement("span");
      const sizeReadout = document.createElement("span");
      // A live region: the size changes continuously during a drag, and a
      // screen-reader user adjusting a selection has no other way to know
      // what it currently is. Also the handle the tests read it by.
      sizeReadout.setAttribute("role", "status");
      sizeReadout.setAttribute("data-oc-size", "");
      // Tabular figures so the number does not jitter the bar's width as it
      // counts up during a drag.
      sizeReadout.style.cssText =
        "font-variant-numeric:tabular-nums;font-weight:600;color:#8fd0ff;white-space:nowrap;";
      const targetGroup = document.createElement("span");
      targetGroup.style.cssText = "display:flex;align-items:center;gap:6px;color:#bbb;";
      const targetGroupLabel = document.createElement("span");
      targetGroupLabel.textContent = "Output";
      // Two boxes with a × between them, rather than one field wanting
      // "640x360" typed into it: a resolution is two numbers, and making
      // someone type the separator makes them think about the format
      // instead of the numbers.
      function makeSizeInput(labelText: string, placeholder: string): HTMLInputElement {
        const input = document.createElement("input");
        // `inputmode` gets a numeric keypad on touch; the type stays "text"
        // so a spinner does not appear and paste of an odd value is not
        // silently swallowed by the browser's own number validation.
        input.type = "text";
        input.inputMode = "numeric";
        input.placeholder = placeholder;
        input.setAttribute("aria-label", labelText);
        // `all:unset` first so the page's own input styling cannot leak in
        // and make this unreadable; everything it needs is set explicitly.
        input.style.cssText =
          "all:unset;box-sizing:border-box;width:52px;padding:2px 6px;border:1px solid #666;border-radius:4px;" +
          "background:#111;color:#fff;font:12px system-ui, sans-serif;text-align:center;";
        return input;
      }
      const targetWidthInput = makeSizeInput("Output width in pixels", "640");
      const targetHeightInput = makeSizeInput("Output height in pixels", "360");
      const targetTimes = document.createElement("span");
      targetTimes.textContent = "×";
      targetTimes.style.cssText = "color:#888;";
      targetGroup.append(targetGroupLabel, targetWidthInput, targetTimes, targetHeightInput);
      hint.append(hintText, sizeReadout, targetGroup);
      hint.addEventListener("pointerdown", (e) => e.stopPropagation());

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
        hintText.textContent = text;
      }

      /**
       * The target size, once both boxes hold a usable number.
       *
       * Both or neither: a width with no height says nothing about what the
       * output should be, so a half-filled pair is treated as still being
       * typed rather than guessed at.
       */
      function parsedTarget(): { width: number; height: number } | null {
        const width = Number(targetWidthInput.value.trim());
        const height = Number(targetHeightInput.value.trim());
        if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
        if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
        if (width < 1 || height < 1) return null;
        return { width, height };
      }

      /** Width/height the selection is constrained to, if any. */
      function lockedRatio(): number | null {
        const target = parsedTarget();
        return target ? target.width / target.height : null;
      }

      /**
       * Build a rect from a fixed anchor to the moving pointer, honouring the
       * ratio lock. Both drawing a new box and dragging a corner reduce to
       * this, which is what keeps the lock behaving identically in each.
       */
      function boxFrom(anchorX: number, anchorY: number, pointerX: number, pointerY: number): SelectedRect {
        let width = Math.abs(pointerX - anchorX);
        let height = Math.abs(pointerY - anchorY);
        const ratio = lockedRatio();
        if (ratio) {
          // Grow to whichever axis the pointer has taken furthest, so the box
          // follows the drag rather than fighting it.
          if (height === 0 || width / height > ratio) height = width / ratio;
          else width = height * ratio;
        }
        return {
          x: pointerX < anchorX ? anchorX - width : anchorX,
          y: pointerY < anchorY ? anchorY - height : anchorY,
          width,
          height,
        };
      }

      /**
       * Show what the capture will actually be, in output pixels.
       *
       * CSS pixels are the wrong number to show: the crop happens in device
       * pixels, so on a 2x display a 320x180 drag already produces a 640x360
       * file. Showing the CSS size would have people hunting for a number
       * that never matches the image they get.
       */
      function updateReadout(r: SelectedRect | null): void {
        if (!r) {
          sizeReadout.textContent = "";
          return;
        }
        const dpr = window.devicePixelRatio || 1;
        const actual = `${Math.round(r.width * dpr)} × ${Math.round(r.height * dpr)}`;
        const target = parsedTarget();
        sizeReadout.textContent = target
          ? `${actual} → ${target.width} × ${target.height}`
          : `${actual}`;
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
        updateReadout(null);
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
        updateReadout(r);
      }

      // Typing a size after the box is already drawn re-shapes what is on
      // screen instead of only affecting the next drag — otherwise the lock
      // appears to do nothing until you start over.
      for (const input of [targetWidthInput, targetHeightInput]) {
        input.addEventListener("input", () => {
          if (rect) {
            rect = boxFrom(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
            positionSelBox(rect);
          }
          updateReadout(rect);
        });
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
        // Read the target before cleanup(): the input is about to be removed
        // from the document, and a detached input's value is not worth
        // gambling on.
        const target = parsedTarget();
        cleanup();
        // One repaint cycle so the overlay/handles are actually gone from
        // the frame captureVisibleTab reads a moment later.
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            resolve({ rect: finalRect, dpr: window.devicePixelRatio || 1, target }),
          ),
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
        // While the size box has focus the keyboard belongs to it. Enter
        // means "I have finished typing" (and confirms if a box is ready);
        // Escape gives the page back its keyboard without cancelling the
        // capture, which would be a harsh punishment for a typo.
        if (e.target === targetWidthInput || e.target === targetHeightInput) {
          if (e.key === "Enter" || e.key === "Escape") {
            e.stopPropagation();
            (e.target as HTMLInputElement).blur();
            if (e.key === "Enter" && phase === "adjusting" && rect) finish(rect);
          }
          return;
        }
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
          // Tracked on `rect` while drawing (it used to only move the box's
          // styles) so the readout and the pointerup both read one value
          // instead of each recomputing the geometry their own way.
          rect = boxFrom(dragStartX, dragStartY, e.clientX, e.clientY);
          selBox.style.left = `${rect.x}px`;
          selBox.style.top = `${rect.y}px`;
          selBox.style.width = `${rect.width}px`;
          selBox.style.height = `${rect.height}px`;
          updateReadout(rect);
          return;
        }
        if (!dragStartRect) return;
        if (dragMode === "move") {
          const dx = e.clientX - dragStartX;
          const dy = e.clientY - dragStartY;
          rect = { ...dragStartRect, x: dragStartRect.x + dx, y: dragStartRect.y + dy };
          positionSelBox(rect);
          updateReadout(rect);
          return;
        }
        if (dragMode && typeof dragMode === "object") {
          const dx = e.clientX - dragStartX;
          const dy = e.clientY - dragStartY;
          const corner = dragMode.corner;
          // Resizing is the same gesture as drawing, anchored at the corner
          // opposite the one being dragged — which is what lets the ratio
          // lock apply to both without a second implementation of it. The
          // moving corner is offset by the drag delta rather than snapped to
          // the pointer, so grabbing a handle slightly off-centre does not
          // make the box jump.
          const anchorX = corner.includes("w") ? dragStartRect.x + dragStartRect.width : dragStartRect.x;
          const anchorY = corner.includes("n") ? dragStartRect.y + dragStartRect.height : dragStartRect.y;
          const movingX = (corner.includes("w") ? dragStartRect.x : dragStartRect.x + dragStartRect.width) + dx;
          const movingY = (corner.includes("n") ? dragStartRect.y : dragStartRect.y + dragStartRect.height) + dy;
          rect = normalizeRect(boxFrom(anchorX, anchorY, movingX, movingY));
          positionSelBox(rect);
          updateReadout(rect);
        }
      }
      document.addEventListener("pointermove", onMove);

      function onUp(e: PointerEvent): void {
        if (dragMode === "new") {
          const drawn = rect ?? boxFrom(dragStartX, dragStartY, e.clientX, e.clientY);
          dragMode = null;
          if (drawn.width < 3 || drawn.height < 3) {
            finish(null);
            return;
          }
          enterAdjusting(drawn);
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
