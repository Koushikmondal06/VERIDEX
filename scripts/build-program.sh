#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.avm/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Agave localnet enables SIMD-0500 (disable v0/v1/v2 deploy) — build SBPFv3
cargo-build-sbf --manifest-path "$ROOT/programs/veridex/Cargo.toml" --arch v3 --sbf-out-dir "$ROOT/target/deploy"
# Keep Anchor's expected IDL path happy
anchor idl build -p veridex 2>/dev/null || true
echo "Built $ROOT/target/deploy/veridex.so"
