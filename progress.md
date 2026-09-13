# VERIDEX Progress Tracker

## Project Overview
Solana prediction market mirroring Polymarket. Phase 1 = end-to-end stub; Phase 2+ = LMSR + AI gates.

---

## Phase Status

| Phase | Status | Commit | Key Achievement |
|-------|--------|--------|-----------------|
| **Phase 1** | ✅ Complete | `9385821` | Full lifecycle on localnet: create → buy → sell → freeze → resolve → redeem. USDC delta = 0 (fully collateralized). |
| **Phase 2** | ✅ Complete | `b280978` | LMSR bonding curve implemented. `lmsr_b = 1_000_000` default. `buy`/`sell` use `b * ln()` formula with +1 smoothing for `ln(0)` edge cases. |
| **Phase 3** | ✅ Complete | `ce48d2b` | Freeze window `[end_ts, end_ts+48h]` with `TooLateToFreeze` error. `AlreadyFrozen` error prevents double-freeze. `freeze_timestamp` recorded on Market. `Config.total_fees: u64` for vault accounting. |
| **Phase 4** | ✅ Complete | `85766a5` | AI curation filter: `aiScore` (0-100) + `aiReason` on `CuratedMarket`. Indexer ticks skip markets with `aiScore < threshold` (default 30, env: `AI_SCORE_THRESHOLD`). |
| **Phase 5** | ✅ Complete | `aba0b35` | AI resolution QA: `ai_resolution_confidence` (u8, 0-100, default 100) on Market. Redeem requires `confidence >= 60` with `LowAiConfidence` error. Oracle sets confidence during resolve. |
| **Phase 6** | ✅ Complete | `469bc06` | AI enrichment: `aiTitle` (string, max 200 chars), `aiTags` (string[], capped at 5), `aiSummary` (string, max 500 chars). `parseAiEnrichment()` generates metadata from Gamma data (prices, volume, liquidity). |

---

## Build & Test

| Check | Result |
|-------|--------|
| `cargo build` | ✅ Passes |
| `npm run build:ts` | ✅ Passes |
| Smoke lifecycle test | ✅ Passes (create→buy→sell→freeze→resolve→redeem, USDC delta = 0) |

---

## Git

| Repository | Branch | Commits |
|------------|--------|---------|
| `github.com/Koushikmondal06/VERIDEX` | `main` | 6 phases, 7 commits |

---

## Quick Commands

```bash
# Build
cargo build          # Rust program
npm run build:ts     # TypeScript packages

# Test
npx tsx scripts/smoke-lifecycle.ts  # Full Phase 1 lifecycle

# Run with AI filter
AI_SCORE_THRESHOLD=70 npx tsx scripts/smoke-lifecycle.ts

# Check progress
cat progress.md
```