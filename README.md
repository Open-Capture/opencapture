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
asked it to capture.

## Why local matters

Most "free" screenshot tools fund themselves one of two ways: your images
pass through their servers (openly, for sync/sharing — or, historically,
less openly), or the free tier is a funnel toward a subscription. Neither
is inherently malicious, but it means your screenshots — which may contain
account numbers, internal dashboards, private conversations, anything
that happened to be on your screen — leave your machine by design.

OpenCapture doesn't have a server to send anything to. The manifest
requests no `host_permissions` and no static content script; capture code
is injected on demand, only into the tab you click the icon on, and every
image stays in the browser's own storage until you explicitly download,
copy, or annotate it.

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

Researched against public pricing pages, privacy policies, and (where
relevant) documented incidents, as of mid-2026. Pricing and policies
change — verify directly with a vendor before relying on this table for a
purchase decision. `–` means not independently confirmed one way or the
other.

| Tool | Price | Processed locally, no cloud upload | Account required | Annotation tools | PDF export | Open source |
|---|---|---|---|---|---|---|
| **OpenCapture** | Free (watermark: 1000 credits, one-time) | ✅ Always | ❌ No for everything except watermark | Crop, arrow, rect, text, blur, tiled watermark¹ | ✅ | ✅ AGPL-3.0 |
| [GoFullPage](https://gofullpage.com) | Free | ✅ | ❌ No | ❌ None | ❌ | Partial — legacy core is MIT; the shipped build now runs from a private branch |
| [FireShot](https://getfireshot.com) | Free (Lite) / $60 lifetime or $7.95/mo (Pro) | – Unconfirmed | ❌ No (Lite) | Limited free, full set in Pro | Pro only | ❌ |
| [Lightshot](https://app.prntscr.com) | Free | ❌ — uploads to a public server; short guessable URLs have exposed other users' screenshots | ❌ No (optional gallery account) | Basic (arrow, text, box) | ❌ | ❌ |
| [Awesome Screenshot](https://www.awesomescreenshot.com) | Free tier / from ~$6/user/mo | ❌ Cloud-centric sync | Effectively yes, for cloud/team features | Arrow, text, shapes, blur, crop | – | ❌ |
| [Nimbus Screenshot](https://nimbusweb.me/screenshot.php) | Free tier / paid subscription | ⚠️ Optional cloud save, not local-only by design | Optional | Yes | – | ❌ |
| [Snagit](https://www.techsmith.com/screen-capture.html) (TechSmith) | $39/yr (subscription-only since 2025) | ✅ Local-first desktop app, optional cloud library | Yes (license) | Full suite | – (image-focused) | ❌ |
| [CloudApp / Zight](https://zight.com) | Free tier / ~$8–17/mo | ❌ Cloud-native by design | Yes | Basic | – | ❌ |
| [Loom](https://loom.com) | Free tier (capped) / paid | ❌ Cloud-native by design | Yes | Minimal (screenshots are secondary to video) | ❌ | ❌ |

¹ The only paid part of OpenCapture — a one-time, 1000-credit Supporter
unlock, not a subscription or a per-export charge. Crop/arrow/rect/text/
blur and PNG/PDF export are free with no account.

The pattern that stands out: **local-only and open source rarely coexist**
in this space. GoFullPage matches OpenCapture on "local, no account" but
has no annotation tools at all and its current build isn't verifiably
open; Lightshot's "no account needed" comes at the cost of a real,
documented privacy failure in its cloud upload. OpenCapture is, as far as
this research could confirm, the only option that's simultaneously fully
local, open source under a copyleft license, and free for every feature
except one optional, one-time watermark unlock — with no account needed
for anything else.

## Install

| Browser | |
| --- | --- |
| Chrome | [Chrome Web Store](https://chromewebstore.google.com/detail/opencapture-%E2%80%94-private-ful/ikhhoggnlncjhpdbnneekifbnmojpjph) |
| Edge | [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/opencapture-%E2%80%94-private-ful/nbblbelngcbfijhifmbjcoehocngplpc) |
| Firefox | [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/opencapture-full-page-capture/) |

Also on [opencapture.app](https://opencapture.app).

## Status

Published and feature-complete: full-page, visible-area and selected-region
capture, crop/annotate/watermark, and PNG/PDF export all work today, on all
three stores.

To run a local build instead — for development, or for Firefox on Android —
see [docs/LOCAL_TESTING.md](docs/LOCAL_TESTING.md),
[docs/FIREFOX_TESTING.md](docs/FIREFOX_TESTING.md) and
[docs/FIREFOX_ANDROID_TESTING.md](docs/FIREFOX_ANDROID_TESTING.md).

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

Full walkthroughs, including the shared-mount build gotcha and what to
manually click through, are in [docs/LOCAL_TESTING.md](docs/LOCAL_TESTING.md),
[docs/FIREFOX_TESTING.md](docs/FIREFOX_TESTING.md),
[docs/FIREFOX_ANDROID_TESTING.md](docs/FIREFOX_ANDROID_TESTING.md), and
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
export feature — everything above works fully offline. An optional
OpenApps sign-in exists in the popup for a possible future paid tier (a
larger/remote feature that isn't implemented yet); declining it changes
nothing about the extension's core functionality.

## License

[AGPL-3.0-or-later](LICENSE). If you build on this code and offer it as a
network service, the AGPL requires you to make your source available to
that service's users too.
