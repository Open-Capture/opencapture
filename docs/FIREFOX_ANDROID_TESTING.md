# Testing the Firefox-for-Android build

Same build as desktop Firefox (`npm run build:firefox`, outputs to
`dist-firefox/`) — Android isn't a separate build target, only a separate
*run* target, since the compiled JS is identical and only
`browser_specific_settings.gecko_android` in the manifest differs.

## Install (temporary, over ADB)

Requires `adb` and a connected/emulated Android device with Firefox
installed (Nightly recommended for the newest WebExtensions API parity;
Beta/Release also work).

1. `cd apps/extension && npm run android:run` (runs
   `web-ext run --source-dir=dist-firefox -t firefox-android`)
2. `web-ext` auto-detects a single connected device; pass
   `--adb-device=<id>` if more than one is attached, or
   `--firefox-apk=org.mozilla.fenix` (or `org.mozilla.firefox`,
   `org.mozilla.fennec_aurora` for Nightly) to target a specific Firefox
   build already installed on the device
3. OpenCapture installs as a temporary add-on and Firefox launches — no
   manual `about:debugging` steps needed, unlike the desktop flow in
   `FIREFOX_TESTING.md`

This uninstalls when the `web-ext run` process is killed or the device
disconnects; re-run for each session.

## What to check

Everything in `FIREFOX_TESTING.md`'s desktop checklist still applies. Beyond
that, Android-specific things that can't be proven from the Chrome e2e suite
or from a desktop Firefox pass:

- **Popup renders without clipping.** Firefox Android shows the extension
  popup as a full-width panel, not an anchored 380px box — confirm nothing
  is cut off or squeezed.
- **Selected-area capture works entirely by touch**: drag out a selection
  with a finger, drag a resize handle without it "letting go" mid-drag
  (this is what pointer capture is for), then tap the on-screen ✓/✕
  buttons — there's no keyboard for Enter/Esc on a typical Android device,
  so these buttons are the only way to confirm or reselect.
- **Editor tools work by touch**: crop, arrow, rect, blur, text, select —
  drag-to-draw and drag-to-resize/move all need to track a finger reliably.
  Double-tap an existing pending text shape to re-enter edit mode (the
  touch replacement for desktop's double-click).
- **`#canvasWrap` still pans/scrolls natively with a finger when no tool is
  mid-drag** — only `#canvas` itself suppresses touch scrolling, and only
  while actively dragging a tool.
- **Sign-in's tab-based OAuth handoff** (`auth.opencapture.app`) — tap
  through a real sign-in method and confirm the session lands back in the
  extension. This is the least-proven part of this milestone: nothing here
  changed sign-in code, and Android's tab-opening/content-script-matching
  behavior for the OIDC callback hasn't been verified on-device.
- **Full-page and visible-tab capture actually produce an image** —
  `scripting.executeScript`, `tabs.captureVisibleTab`, and `downloads` API
  parity on Android isn't something that can be confirmed from
  documentation alone.
- **A very long page** — a long Wikipedia article, or a feed scrolled far
  enough to run to several tens of thousands of pixels. Check *both*
  halves separately, because they fail independently: the **saved PNG/PDF**
  (produced entirely in Rust/wasm, no canvas involved, so device graphics
  limits don't apply — but the stitch does hold every decoded slice in
  memory at once, which a phone may simply refuse), and the **editor**
  (a real DOM `<canvas>`, which *is* subject to the device's limits).
  Shot-core's `MAX_CANVAS_DIMENSION_PX` / `MAX_CANVAS_AREA_PX` are desktop
  Chrome's measured ceilings, compiled in and never probed at runtime, and
  a phone's are typically lower. The editor is guarded — if the canvas
  silently refuses the draw it says so and points at the popup's save
  (`src/editor/canvas-limit.ts`) — so what needs confirming here is that
  the guard *fires* rather than showing a blank canvas, and that the saved
  file is intact either way. This is the one path where an Android-only
  limit could otherwise cost the user their capture without saying
  anything.
- History thumbnails load and delete correctly.
- No console errors — inspect via `about:debugging` on a desktop Firefox
  pointed at the connected Android device (**Setup** → enable USB
  debugging → the Android device's OpenCapture appears in **This Firefox**
  equivalent for remote devices).

## Known, deliberate differences from desktop

- No custom save-folder picker — same reason as desktop Firefox (no File
  System Access API), already handled by the existing feature-detect.
- No automated e2e coverage at all, not even the manual-but-repeatable kind
  desktop Firefox gets — Playwright cannot drive real or emulated Firefox
  for Android. Every check above is manual, every session.
