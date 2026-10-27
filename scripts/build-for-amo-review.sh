#!/usr/bin/env bash
# One script, every step, from a clean checkout to the exact
# apps/extension/dist-firefox/ that gets zipped and submitted to AMO.
# See docs/SOURCE_CODE_SUBMISSION.md for prerequisites and what each
# step below actually does.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> checking prerequisites"
command -v cargo >/dev/null || { echo "cargo not found — install Rust via https://rustup.rs first" >&2; exit 1; }
command -v node  >/dev/null || { echo "node not found — install Node.js 22+ first" >&2; exit 1; }
command -v npm   >/dev/null || { echo "npm not found — comes with Node.js" >&2; exit 1; }

WASM_BINDGEN_VERSION="0.2.100"
if ! command -v wasm-bindgen >/dev/null || [[ "$(wasm-bindgen --version)" != *"$WASM_BINDGEN_VERSION"* ]]; then
  echo "==> installing wasm-bindgen-cli $WASM_BINDGEN_VERSION (pinned — must match the wasm-bindgen crate version exactly)"
  cargo install wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION" --locked
fi

echo "==> rebuilding @openapps/sdk and @openapps/ui from their real source (vendor-src/)"
bash apps/extension/scripts/build-vendor.sh

echo "==> installing extension dependencies"
(cd apps/extension && npm ci)

echo "==> building the Firefox extension (Rust/WASM core, then the extension itself)"
(cd apps/extension && npm run build:firefox)

echo ""
echo "done — apps/extension/dist-firefox/ is what gets zipped and submitted:"
echo "  cd apps/extension && node scripts/store-zip.mjs dist-firefox opencapture-firefox.zip"
