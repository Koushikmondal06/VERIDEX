# VERIDEX Build Plan

Solana prediction market that mirrors Polymarket. Polymarket = data + truth; Solana = venue; AI = curation/QA only.

## Phase 1 status (in progress)

Done:
- Monorepo scaffold (program, indexer, oracle, web, shared)
- Anchor program compiles + deploys on localnet (**SBPFv3**)
- Indexer creates markets from fixtures (Gamma blocked on this network)
- Oracle + web clients wired to IDL
- Local USDC mint helper

Still open for Phase 1:
- ~~End-to-end UI trade smoke test with wallet~~ → `scripts/smoke-lifecycle.ts`
- Oracle freeze/resolve against Gamma (blocked offline; freeze/resolve covered in smoke)

Phase 1 trading note: buy/sell are **1:1 USDC collateralized** so redeem cannot insolvent the vault. Polymarket odds are stored on-chain for display / LMSR seeding in Phase 2.

## MVP decisions (locked)

| Decision | Choice |
|---|---|
| Markets | Binary only |
| Pricing (Phase 1) | 1:1 USDC collateral per share (odds stored; LMSR in Phase 2) |
| Oracle | Single backend signer |
| AI | Deferred to Phase 4–6 |
| Network | Localnet / Solana Devnet |
| Collateral | USDC (devnet mint or local SPL) |

## Repo layout

```
VERIDEX/
├── PLAN.md
├── README.md
├── Anchor.toml
├── Cargo.toml
├── package.json                 # npm workspaces
├── programs/veridex/            # Anchor program
├── apps/
│   ├── indexer/                 # Gamma poller → create markets
│   ├── oracle/                  # resolution detect → resolve ix
│   └── web/                     # React trading UI
└── packages/shared/             # types + Gamma client
```

## Phases

### Phase 1 — End-to-end stub (current)
1. Anchor: `create_market`, `buy`, `sell`, `freeze`, `resolve`, `redeem`
2. Indexer polls Gamma, creates on-chain markets
3. Oracle freezes at `end_date`, resolves when Polymarket closes
4. Web: list markets, trade stub shares, redeem winners
5. **Done when:** one full lifecycle on localnet/devnet

### Phase 2 — LMSR
On-chain bonding curve, seed from Polymarket odds, tune `b`

### Phase 3 — Hardening freeze/oracle/payout
Production timing, vault accounting, better key management

### Phase 4 — AI curation
Batched LLM scoring; filter before create

### Phase 5 — AI resolution QA
Web-search confidence gate before payout

### Phase 6 — AI enrichment
Titles/tags/summaries (cosmetic)

## Phase 1 instruction sketch

| Instruction | Who calls | Effect |
|---|---|---|
| `create_market` | Indexer authority | PDA market + vault; stub 50/50 |
| `buy` | User | USDC in → YES or NO shares out @ stub price |
| `sell` | User | Shares in → USDC out @ stub price |
| `freeze` | Oracle (or crank) | Halt trading at/after `end_date` |
| `resolve` | Oracle | Set winning outcome; open redemption |
| `redeem` | User | Winning shares → 1 USDC each; losers burn |

## Trust rules (never violate)

- Freeze at Polymarket `end_date`, not at resolution time
- AI never signs money movement; oracle backend does
- Parse failures → manual review, never auto-approve
