# OpenCapture

**A privacy-first, 100% local full-page screenshot and annotation extension for Chrome, Edge and Firefox.**

![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)
[![Chrome Web Store](https://img.shields.io/badge/Chrome-install-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/opencapture-%E2%80%94-private-ful/ikhhoggnlncjhpdbnneekifbnmojpjph)
[![Microsoft Edge](https://img.shields.io/badge/Edge-install-0078D7?logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons/detail/opencapture-%E2%80%94-private-ful/nbblbelngcbfijhifmbjcoehocngplpc)
[![Firefox Add-ons](https://img.shields.io/badge/Firefox-install-FF7139?logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/en-US/firefox/addon/opencapture-full-page-capture/)
[![CI](https://github.com/Open-Capture/OpenCapture/actions/workflows/ci.yml/badge.svg)](https://github.com/Open-Capture/OpenCapture/actions/workflows/ci.yml)

Capture a full page, the visible viewport, or a hand-picked region — then
crop, arrow, rectangle, blur, or watermark it, and export as PNG or PDF.
Every pixel operation happens on your machine, in a Rust/WebAssembly core —
nothing is uploaded anywhere, no account is needed, and the capture
pipeline never has standing access to any page you haven't explicitly
asked it to capture. Screenshots, docs and install links are at
[opencapture.app, the OpenCapture website](https://opencapture.app).

## Why local matters

Most "free" screenshot tools fund themselves one of two ways: your images
pass through their servers (openly, for sync/sharing — or, historically,
less openly), or the free tier is a funnel toward a subscription. Neither
is inherently malicious, but it means your screenshots — which may contain
account numbers, internal dashboards, private conversations, anything
that happened to be on your screen — leave your machine by design.

Your screenshots have no server to go to. The manifest requests no
`host_permissions` and no static content script; capture code is injected
on demand, only into the tab you click the icon on, and every image stays
in the browser's own storage until you explicitly download, copy, or
annotate it.

The one request that can leave this extension goes to our own account
server, and only while you are signed in — see [Permissions](#permissions)
for which hosts those are and what asks for them. Signing in is optional
and nothing about capturing, editing or exporting depends on it.

## Features

- **Three capture modes** — full page (auto-scroll + stitch, pixel-exact
  across device pixel ratios), visible viewport only, or a hand-dragged
  region.
- **Annotate before you export** — crop, arrow, rectangle, text, and a
  genuinely irreversible mosaic blur (not a cosmetic CSS filter — the
  source pixels are gone), each with full undo.
- **Watermark tool** — tile your own text and/or logo across the top,
  bottom, both, or the entire page, at 0° or a 45° slant. This is a tool
  *you* apply to *your own* exports for your own branding — OpenCapture
  never stamps anything onto your screenshots itself. The one paid part of
  OpenCapture: a one-time, 1000-credit Supporter unlock. Every other
  feature — capture, crop, arrow, rectangle, text, blur, PNG/PDF export —
  is free with no account at all.
- **Export PNG or PDF** — PDF pages are sized in points to match CSS
  pixels, so they print at true 1:1 physical size.
- **Copy to clipboard**, configurable save folder/filename, and a capture
  that survives the background service worker being evicted mid-flow.
- **Chrome, Edge and Firefox**, same source tree, two build targets.

## How it compares

|  | **OpenCapture** | GoFullPage | FireShot | Awesome Screenshot |
|---|---|---|---|---|
| Free tier covers | Everything but watermarking | Capture and export only<br>editing needs Premium | Capture and export only<br>editing needs a Pro licence | 100 captures<br>basic annotation |
| Blur private details | Free | Paid | Paid | Free |
| Watermarking | Paid | No | Paid | Beta |
| Billing | One-time | Subscription | Annual or one-time | Subscription |
| Price | US$5 once, never expires | From $1/month<br>billed annually | $39.95/year<br>or $99.95 once | From $6/month<br>Basic plan |
| Firefox | Yes | No | Yes | Yes |
| Open source | Yes<br>AGPL-3.0-or-later | MIT up to 2018<br>private branch since | No | No |

Every figure is checked against that product's own site or store listing.
Last reviewed August 2026 — [tell us if something is out of date](https://github.com/Open-Capture/OpenCapture/issues).

[Full comparison, including where each one is the better pick →](https://opencapture.app/alternatives.html?utm_source=github&utm_medium=readme&utm_campaign=comparison)

## Install

| Browser | |
| --- | --- |
| Chrome | [Chrome Web Store](https://chromewebstore.google.com/detail/opencapture-%E2%80%94-private-ful/ikhhoggnlncjhpdbnneekifbnmojpjph) |
| Edge | [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/opencapture-%E2%80%94-private-ful/nbblbelngcbfijhifmbjcoehocngplpc) |
| Firefox | [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/opencapture-full-page-capture/) |

Also on [opencapture.app](https://opencapture.app).

## Star us

If OpenCapture saved you time, a star helps other people find it.

[![Star OpenCapture](docs/star-us.gif)](https://github.com/Open-Capture/OpenCapture)

## Status

Published and feature-complete: full-page, visible-area and selected-region
capture, crop/annotate/watermark, and PNG/PDF export all work today, on all
three stores.

To run a local build instead — for development, or for Android —
see [docs/LOCAL_TESTING.md](docs/LOCAL_TESTING.md),
[docs/FIREFOX_TESTING.md](docs/FIREFOX_TESTING.md) and
[docs/MOBILE_TESTING.md](docs/MOBILE_TESTING.md).

## Permissions

Four permissions are requested at install, and they are the whole set:

- **`activeTab`** — read the page you are capturing, and only the tab whose
  toolbar icon you clicked, only after you click it.
- **`scripting`** — inject the capture script into that tab on demand. There
  is no static content script, so nothing runs on any page until you ask.
- **`downloads`** — write the PNG or PDF you asked to save.
- **`storage`** — remember your preferences and the local capture history.

Three more are declared in `optional_host_permissions`, which means the
browser does **not** grant them at install and never asks unless you take
the action that needs one:

- **`auth.opencapture.app`, `gateway.opencapture.app`** — our account server.
  Requested only if you choose to sign in, which is needed for the one paid
  tool and nothing else. Never signing in means never granting these.
- **`openpdfedit.com`** — requested only when you tick "Open the PDF in
  OpenPdfEdit" while exporting, and it exists so the finished PDF can be
  handed straight to that editor instead of going out through your downloads
  folder. Leave it unticked and the permission is never asked for.

## Build from source

```bash
# prerequisites: Rust (stable) + wasm32-unknown-unknown target, Node 22.x,
# wasm-bindgen-cli pinned to exactly 0.2.100 (must match Cargo.toml)
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.100 --locked

cd apps/extension
npm install
npm run build            # -> dist/          (load unpacked in Chrome)
npm run build:firefox    # -> dist-firefox/   (load temporarily in Firefox)
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select `dist/`. In Firefox: `about:debugging#/runtime/this-firefox`
→ **Load Temporary Add-on** → select any file inside `dist-firefox/`.

The tiled watermark is not part of this repository. It is a separate
private module, it is not covered by this repository's licence, and a clone
of this repository builds without it: the build substitutes a stub and says
so, every other tool works normally, and only the watermark tool does
nothing. Nothing else here depends on it.

Full walkthroughs, including the shared-mount build gotcha and what to
manually click through, are in [docs/LOCAL_TESTING.md](docs/LOCAL_TESTING.md),
[docs/FIREFOX_TESTING.md](docs/FIREFOX_TESTING.md),
[docs/MOBILE_TESTING.md](docs/MOBILE_TESTING.md), and
[docs/TESTING_GUIDE.md](docs/TESTING_GUIDE.md).

## Architecture

Rust does every pixel operation; TypeScript is the browser-API shell
around it.

- **`crates/shot-core`** — scroll-target planning, gap/overlap-free slice
  stitching, PNG decode/stitch/encode, multi-page PDF export, oversized-
  canvas splitting. Compiles natively and to `wasm32-unknown-unknown` via
  `wasm-bindgen`.
- **`crates/shot-qa`** — native CLI for PNG/PDF structural inspection,
  hashing, and pixel sampling/diffing.
- **`apps/extension`** — the MV3 shell (TypeScript, Vite): background
  service worker orchestrates capture, an on-demand content script
  handles DOM/lazy-load/sticky-element prep, and the popup/editor pages
  are plain canvas-based TypeScript.

Full milestone-by-milestone history and design rationale is in
[PLAN.md](PLAN.md).

## Optional account

OpenCapture never requires an account for any capture, annotation, or
export feature — everything above works fully offline. An optional sign-in
exists in the popup, and one tool — the tiled watermark — is unlocked
through it. Declining it changes nothing else: every capture mode, every
annotation tool and both export formats work without an account, offline.

## License

[AGPL-3.0-or-later](LICENSE). If you build on this code and offer it as a
network service, the AGPL requires you to make your source available to
that service's users too.
