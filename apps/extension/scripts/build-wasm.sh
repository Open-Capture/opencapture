#!/usr/bin/env bash
# Builds crates/shot-core for wasm32-unknown-unknown and generates the
# wasm-bindgen JS/TS glue into src/wasm-gen/. Run before `vite build` (see
# package.json's `build` script) — Vite never touches Rust, it only copies
# the already-generated output as a static asset (scripts/copy-static.mjs).
set -euo pipefail

# Appended, not prepended: the CLI version must match the `wasm-bindgen` crate
# version pinned in Cargo.toml exactly (the JS-glue schema is versioned), so a
# caller who puts a matching build on PATH has to win over whatever happens to
# be in ~/.cargo/bin. Prepending here meant a globally-installed newer CLI
# silently shadowed the right one and the build died deep inside bindgen with
# a schema-mismatch wall of text.
export PATH="$PATH:$HOME/.cargo/bin:/opt/homebrew/bin"

# The repo lives on a shared VM mount, which produces spurious archive/GC
# errors when used as the cargo target dir directly (see
# opencapture/docs/build-environment.md). Build off-mount, then only the
# final .wasm crosses back onto the mount via wasm-bindgen's --out-dir.
: "${CARGO_TARGET_DIR:=/tmp/opencapture-target}"
export CARGO_TARGET_DIR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
WORKSPACE_DIR="$(dirname "$(dirname "$EXT_DIR")")"
OUT_DIR="$EXT_DIR/src/wasm-gen"

# Fail early and legibly on the version skew rather than after a full Rust
# build. `cargo install wasm-bindgen-cli --version <pinned> --root <dir>` and
# put <dir>/bin on PATH, or set WASM_BINDGEN to the binary directly.
WASM_BINDGEN="${WASM_BINDGEN:-wasm-bindgen}"
PINNED="$(sed -n 's/^wasm-bindgen = "=\(.*\)"$/\1/p' "$WORKSPACE_DIR/Cargo.toml" | head -1)"
HAVE="$("$WASM_BINDGEN" --version 2>/dev/null | awk '{print $2}')"
if [ -n "$PINNED" ] && [ "$HAVE" != "$PINNED" ]; then
  echo "build-wasm: wasm-bindgen CLI is ${HAVE:-missing}, but Cargo.toml pins $PINNED." >&2
  echo "build-wasm: the two must match exactly. Install the pinned CLI and put it on PATH:" >&2
  echo "  cargo install wasm-bindgen-cli --version $PINNED --root /tmp/wb$PINNED" >&2
  echo "  PATH=/tmp/wb$PINNED/bin:\$PATH npm run build" >&2
  exit 1
fi

cargo build -p shot-core --target wasm32-unknown-unknown --profile wasm-release --manifest-path "$WORKSPACE_DIR/Cargo.toml"

"$WASM_BINDGEN" \
  --target web \
  --out-dir "$OUT_DIR" \
  --out-name shot_core \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/wasm-release/shot_core.wasm"

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -O3 -o "$OUT_DIR/shot_core_bg.wasm" "$OUT_DIR/shot_core_bg.wasm"
  echo "wasm-opt: optimized shot_core_bg.wasm"
else
  echo "wasm-opt not found on PATH — skipping (glue still works, just larger/slower than optimal)"
fi

echo "wasm build complete: $OUT_DIR"
