# VERIDEX — Solana Prediction Market (Polymarket Mirror)

A prediction market platform on Solana that mirrors Polymarket's markets, trades against your own liquidity, and settles payouts based on Polymarket's real-world resolutions — with an AI layer (later phases) handling curation and resolution QA.

**Core idea:** Polymarket is your data + truth source, Solana is your trading venue, AI is your curation/QA layer in between.

**Status:** Phase 1 scaffold in progress (stub pricing, full lifecycle instructions). See [PLAN.md](./PLAN.md).

Program id: `6cD9BZG2bddZZ1xoNReLVEvdYVaxpxY97F7MfZyov7XW`

---

## Quick start (localnet)

```bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$HOME/.cargo/bin:$PATH"

npm install

# Terminal A
solana-test-validator --reset

# Terminal B — Agave localnet requires SBPFv3 (SIMD-0500)
./scripts/build-program.sh
solana program deploy target/deploy/veridex.so \
  --program-id target/deploy/veridex-keypair.json

cp .env.example .env
npx tsx scripts/setup-local.ts   # writes data/local-mint.json — set USDC_MINT / VITE_USDC_MINT

# Indexer (fixtures work offline; omit USE_FIXTURES to hit Gamma)
DRY_RUN=1 USE_FIXTURES=1 VERIDEX_DATA_DIR=./data npm run once -w @veridex/indexer
DRY_RUN=0 USE_FIXTURES=1 VERIDEX_DATA_DIR=./data USDC_MINT=<mint> npm run once -w @veridex/indexer

DRY_RUN=0 VERIDEX_DATA_DIR=./data npm run once -w @veridex/oracle
npm run dev -w @veridex/web
```

> **Note:** Current Agave localnet disables SBPF v0/v1/v2 deployment. Always build with `./scripts/build-program.sh` (`--arch v3`), not plain `anchor build` alone.

Workspace: `programs/veridex` · `apps/indexer` · `apps/oracle` · `apps/web` · `packages/shared`

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Pipeline](#pipeline)
- [Components](#components)
- [Data Source: Polymarket Gamma API](#data-source-polymarket-gamma-api)
- [Liquidity: LMSR Market Maker](#liquidity-lmsr-market-maker)
- [AI Fetchers](#ai-fetchers)
- [Oracle & Settlement](#oracle--settlement)
- [Trust Boundaries & Risks](#trust-boundaries--risks)
- [Suggested Build Order](#suggested-build-order)
- [Open Decisions](#open-decisions)
- [Feature Backlog](#feature-backlog)

---

## Architecture Overview

```
Polymarket Gamma API
        │
        ▼
   Indexer (poller)
        │
        ▼
 AI Curation Fetcher ──► reject low-quality/ambiguous markets
        │
        ▼
 AI Enrichment Fetcher ──► better titles, summaries, tags
        │
        ▼
 Market Creation (Anchor program on Solana)
        │
        ▼
   Trading (LMSR bonding curve, your liquidity)
        │
        ▼
   Freeze (halt trading at Polymarket end_date)
        │
        ▼
   Oracle (detects Polymarket resolution)
        │
        ▼
 AI Resolution Sanity-Check ──► confidence gate
        │
        ▼
 On-chain Settlement (Anchor program)
        │
        ▼
      Payout (redeem winning shares 1:1 for USDC)
```

---

## Pipeline

1. **Indexer** polls the Gamma API for active events/markets.
2. **AI curation fetcher** scores each market (quality, ambiguity, risk) and filters out ones not worth mirroring.
3. **AI enrichment fetcher** rewrites titles/descriptions and assigns categories, cached per market.
4. **Market creation** — an Anchor instruction creates the on-chain market account and outcome tokens, optionally seeding the LMSR curve to match Polymarket's current live odds.
5. **Trading** — users buy/sell outcome shares against your LMSR bonding curve.
6. **Freeze** — trading halts at Polymarket's `end_date`, *before* resolution is known, to prevent front-running the outcome.
7. **Oracle** detects Polymarket's resolution (`closed=true` + outcome) and passes it to the AI sanity-check.
8. **AI resolution sanity-check** — a web-search-backed confidence check on the claimed outcome. High confidence auto-submits; low confidence routes to human review.
9. **On-chain settlement** — the oracle signs and submits the outcome; the program marks the market resolved.
10. **Payout** — winning shares redeem 1:1 for USDC; losing shares burn to zero.

---

## Components

| Layer | What it is | Tech |
|---|---|---|
| Indexer | Cron/worker polling Gamma API | Node service (`apps/indexer`) |
| AI curation | LLM scoring + filtering | Claude API, batched (Phase 4) |
| AI enrichment | LLM rewriting copy | Claude API, cached (Phase 6) |
| Market creation | On-chain program instruction | Anchor (Rust) |
| Liquidity/pricing | Stub prices now → LMSR later | On-chain |
| Trading UI | Frontend for buy/sell | React + wallet adapter (`apps/web`) |
| Freeze logic | Time-based trading halt | On-chain, keyed to `end_date` |
| Oracle | Backend service + signer | Node (`apps/oracle`) |
| AI resolution check | LLM + web search verification | Phase 5 |
| Settlement/payout | On-chain redemption logic | Anchor (Rust) |

---

## Data Source: Polymarket Gamma API

Public REST API, no key or wallet required. Base URL: `https://gamma-api.polymarket.com`

Key endpoints:

```
GET /events?active=true&closed=false&limit=100      # all active events
GET /events?tag_id=100381                            # filter by category
GET /events/slug/{slug}                              # fetch by slug
GET /markets?slug={slug}                              # fetch a specific market
GET /tags                                             # discover categories
```

Data model:
- **Event** — top-level question (e.g. "Who will win the election?"), contains one or more markets.
- **Market** — a specific tradable binary outcome within an event, with `outcomes` and `outcomePrices` arrays mapping 1:1 (these are implied probabilities).

Always filter with `active=true&closed=false` unless you specifically need historical/resolved data.

---

## Liquidity: LMSR Market Maker

LMSR (Logarithmic Market Scoring Rule) — the classic Hanson automated market maker for prediction markets.

**Phase 1** uses fully collateralized 1 USDC/share buy/sell (odds stored on-chain for UI). LMSR lands in Phase 2.

**Cost function:**
```
C(q) = b * ln(e^(q_yes/b) + e^(q_no/b))
```

**Price of an outcome:**
```
price_yes = e^(q_yes/b) / (e^(q_yes/b) + e^(q_no/b))
```

**Cost to buy Δ shares of YES:**
```
cost = C(q_yes + Δ, q_no) - C(q_yes, q_no)
```

**Liquidity parameter `b`:** controls slippage/depth. Also bounds your maximum possible loss to `b * ln(n)` (for binary markets, `≈ 0.693 * b`). Set `b` based on how much capital you're willing to risk per market.

**On-chain implementation notes:**
- `exp`/`ln` are expensive and numerically unstable in fixed-point — use the log-sum-exp trick to keep exponents near zero: subtract `max(q_yes, q_no)/b` before exponentiating.
- Consider precomputing an exponential lookup table for a fixed `b`, since `b` rarely changes per market.
- Optionally bias the curve at creation time toward Polymarket's live odds so a new market doesn't start at a stale 50/50 while Polymarket already shows 90/10.

---

## AI Fetchers

Three distinct jobs, not one generic "AI fetcher":

### 1. Curation Fetcher
Scores incoming markets for quality/ambiguity/risk before you bother creating them on-chain.
```python
def score_market(market: dict) -> dict:
    # Returns { "score": 0-100, "reason": str, "flags": [...] }
    # Only create a Solana market if score > threshold and no blocking flags
```

### 2. Enrichment Fetcher
Rewrites Polymarket's question/description into punchier UI copy, assigns a category tag. Runs once per market, cached — not on every poll cycle.

### 3. Resolution Sanity-Check Fetcher
Runs when the oracle detects a Polymarket resolution, **before** payout triggers. Uses web search to independently verify the claimed outcome against current news.
```python
def verify_resolution(market: dict, claimed_outcome: str) -> dict:
    # Returns { "confidence": 0-100, "note": str }
    # High confidence -> auto-submit on-chain
    # Low confidence  -> human review queue, payout stays frozen
```

**Rules of thumb:**
- Batch and queue LLM calls — never call synchronously inside the indexer's poll loop.
- Cache curation/enrichment results per `polymarket_market_id`; only re-score if the underlying data changed materially.
- Always request raw JSON output with no preamble; treat parse failures as "needs manual review," never as "auto-approve."
- Keep the AI out of the trust-critical path for money movement — it gates/delays payout, it never directly triggers one. The deterministic oracle backend still makes the actual on-chain call.

---

## Oracle & Settlement

- Oracle service polls Polymarket for `closed=true` + resolved outcome on markets you're tracking.
- Passes the claimed outcome through the AI sanity-check.
- Signs and submits the outcome to your Anchor program using a Solana keypair.
- Program marks the market resolved and opens redemption.
- Users redeem winning shares 1:1 for USDC; losing shares burn to zero.

**Critical timing rule:** freeze trading on your market at Polymarket's `end_date`, *not* when resolution is confirmed. There's a real gap between "market should be closed" and "outcome is known" — anyone with early knowledge of the real-world outcome can trade against your stale price in that window if you don't freeze early.

---

## Trust Boundaries & Risks

1. **Indexer misreads** — AI curation/enrichment reduce noise but aren't money-critical. Worst case: a bad title, not a bad payout.
2. **Oracle centralization** — a single backend signer submitting truth on-chain is a single point of failure. Fine for an MVP; longer-term, move to a multisig oracle committee or a dispute/challenge window before payout finalizes.
3. **Freeze-timing gap** — front-running risk between market end and resolution submission. Mitigated by freezing early (see above).
4. **Legal/derivative risk** — you're building a derivative product on top of another platform's markets without their involvement. Worth legal review before scaling beyond a testnet/MVP.

---

## Suggested Build Order

1. Indexer + basic market creation (fixed-price stub, no LMSR, no AI) — prove the pipeline end to end. **← current**
2. LMSR bonding curve with proper fixed-point math on-chain.
3. Oracle + freeze + payout — get one full market lifecycle working manually.
4. AI curation fetcher — stop mirroring everything.
5. AI resolution sanity-check — once real money is at stake.
6. AI enrichment — cosmetic layer, lowest risk, do it last.

---

## Open Decisions

- Binary-only markets first, or multi-outcome from day one (multi-outcome LMSR generalizes but costs more compute per trade). **Locked for MVP: binary-only.**
- How much capital backs your LMSR pools, and across how many concurrent markets — this is your real risk budget.
- Single backend oracle key (fast to ship, centralized) vs. multisig/committee oracle (slower, more trustworthy). **Locked for MVP: single key.**

---

## Feature Backlog

- Category curation instead of mirroring everything (sports/crypto/politics only)
- Liquidity/volume threshold for which Polymarket markets get mirrored
- Cross-venue arbitrage bot between your market and Polymarket's live price
- Dispute/challenge window before final payout
- Multi-outcome markets (not just binary)
- Leaderboards / social layer for top traders
- Natural-language market creation ("will X happen by Y" → auto-search/create)
- AI trading assistant / chat interface over your markets + live news
