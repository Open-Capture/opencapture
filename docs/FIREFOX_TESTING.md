# Testing the Firefox build

OpenCapture's Firefox build is produced by `npm run build:firefox` (see
`apps/extension/`), which outputs to `dist-firefox/` instead of `dist/`.
It is not yet signed or published — load it as a temporary add-on for
testing.

## Install (temporary, until Firefox restarts)

1. `cd apps/extension && npm run build:firefox`
2. Open `about:debugging#/runtime/this-firefox` in Firefox
3. Click **Load Temporary Add-on…**
4. Select `dist-firefox/manifest.json` directly (not the folder — Firefox
   wants the manifest file itself, unlike Chrome's "Load unpacked")
5. OpenCapture's icon appears in the toolbar

This is removed when Firefox restarts; repeat steps 2-4 each session. A
permanent install without a real Mozilla-signed release requires Firefox
Developer Edition, Nightly, or ESR with
`about:config` → `xpinstall.signatures.required` → `false`.

## What to check

Everything in the Chrome flow, since the same source and the same compiled
JS logic drive both builds:

- Capture full page / visible area / selected area
- Export as PDF, Copy to clipboard, Open in editor
- Editor: crop, arrow, rectangle, text, blur, undo, select tool
- Popup reopen after close — last capture should still be shown
- Filename preference (the text field under "Save to")

Firefox-specific things worth double-checking, since they can't be proven
from Chrome's e2e suite:

- **The "Browse…" custom-folder button must not appear at all** under
  "Save to" — Firefox has no File System Access API, so this is
  deliberately hidden (see Task 5 of the Firefox port plan). If it does
  appear, that's a real bug.
- **Download PNG / Download PDF (editor) and Export as PDF (popup)
  actually produce a file in Downloads** — no `Access denied for URL` in
  the console. This exercises a Chrome/Firefox difference in how the
  downloads API accepts URLs (see `src/chrome/downloads.ts`).
- **A capture actually completes without a console error.** Open the
  background page's console via `about:debugging#/runtime/this-firefox` →
  OpenCapture → **Inspect**, and the popup's own console via
  right-click the popup → **Inspect**, while running through the flows
  above.
- **`storage.session` works** — reopening the popup after a capture, or
  reopening the editor tab, should still show the last capture (this
  depends on Firefox 115+; note `browser_specific_settings.gecko.strict_min_version`
  in the manifest if testing on an older Firefox).

## Automated coverage

`npm run e2e:firefox` drives the real `dist-firefox/editor.html` in both
Playwright's Firefox and Chromium and compares them. It stubs only the
extension APIs the editor needs at boot (storage.session for the capture
dimensions, the runtime.connect port that streams the PNG), so the editor code
under test is the shipped bundle.

It does **not** run inside a `moz-extension://` page, and that gap is not
academic: APP-37 was a text-tool failure that reproduced only there. The
editor's floating text `<input>` was created, blurred by the browser and removed
by its own blur handler within 1 ms — `preventDefault()` on the cancelable
`pointerdown` did not stop focus moving to `<body>` — while the same bundle
served over `http://` kept focus and worked. To reproduce that class of bug,
load the extension with `web-ext run` and exercise the page for real.

## Known, deliberate differences from Chrome

- No custom save-folder picker (see above) — Downloads-folder saving via
  the Filename field still works.
