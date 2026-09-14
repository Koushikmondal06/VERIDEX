import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectBinaryMarkets,
  marketsFromFixtures,
  type StoredMarket,
  type GammaMarket,
} from "@veridex/shared";
import { loadConfig, createMarketOnChain, ensureInitialized } from "./solana.js";
import {
  marketExists,
  storeMarket,
  getAllMarkets,
  getMarketById,
  updateMarketStatus,
  getMarketCount,
} from "./db.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DATA_DIR = path.resolve(process.env.VERIDEX_DATA_DIR || path.join(REPO_ROOT, "data"));
const STORE_PATH = path.join(DATA_DIR, "markets.json");
const WEB_MIRROR = path.resolve(
  process.env.WEB_MARKETS_PATH || path.join(REPO_ROOT, "apps/web/public/markets.json")
);
const FIXTURES = path.resolve(
  process.env.GAMMA_FIXTURES || path.join(REPO_ROOT, "data/fixtures/gamma-markets.json")
);
const POLL_MS = Number(process.env.INDEXER_POLL_MS || 60_000);
const MAX_CREATE = Number(process.env.INDEXER_MAX_CREATE_PER_TICK || 5);
const LIMIT_EVENTS = Number(process.env.INDEXER_EVENT_LIMIT || 20);
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const USE_FIXTURES =
  process.env.USE_FIXTURES === "1" ||
  process.env.USE_FIXTURES === "true" ||
  process.argv.includes("--fixtures");

async function loadMarkets() {
  if (USE_FIXTURES) {
    console.log(`[indexer] using fixtures: ${FIXTURES}`);
    const raw = JSON.parse(fs.readFileSync(FIXTURES, "utf8")) as GammaMarket[];
    return marketsFromFixtures(raw);
  }
  try {
    return await collectBinaryMarkets(LIMIT_EVENTS);
  } catch (err) {
    console.warn("[indexer] Gamma unreachable, falling back to fixtures:", err);
    const raw = JSON.parse(fs.readFileSync(FIXTURES, "utf8")) as GammaMarket[];
    return marketsFromFixtures(raw);
  }
}

function loadStore(): Record<string, StoredMarket> {
  if (!fs.existsSync(STORE_PATH)) return {};
  return JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as Record<string, StoredMarket>;
}

function saveStore(store: Record<string, StoredMarket>) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const json = JSON.stringify(store, null, 2);
  fs.writeFileSync(STORE_PATH, json);
  try {
    fs.mkdirSync(path.dirname(WEB_MIRROR), { recursive: true });
    fs.writeFileSync(WEB_MIRROR, json);
  } catch (err) {
    console.warn("[indexer] could not mirror markets.json to web public:", err);
  }
}

async function tick() {
  console.log(`[indexer] polling Gamma (limit=${LIMIT_EVENTS})…`);
  
  // Check which markets already exist in database to reduce Gamma calls
  const markets = await loadMarkets();
  console.log(`[indexer] found ${markets.length} binary markets from Gamma`);

  const store = loadStore();
  let created = 0;

  const cfg = DRY_RUN ? null : await loadConfig();
  if (cfg && !DRY_RUN) {
    await ensureInitialized(cfg);
  }

  for (const m of markets) {
    // Skip if market already exists in database (reduces Gamma API dependency)
    if (await marketExists(m.polymarketId)) {
      console.log(`[indexer] skipping ${m.polymarketId} - already in DB`);
      continue;
    }
    
    if (store[m.polymarketId]) continue;
    if (created >= MAX_CREATE) break;

    // Skip markets already past end
    if (m.endTs <= Math.floor(Date.now() / 1000)) continue;

    // Phase 4: AI curation filter — skip markets with low AI score
    const aiScore = m.aiScore ?? 50; // default neutral if no AI data
    const aiReason = m.aiReason ?? "Auto-accepted (no AI data)";
    if (aiScore < Number(process.env.AI_SCORE_THRESHOLD || 30)) {
      console.log(`[indexer] AI filter: skipping ${m.polymarketId} (score=${aiScore}, reason=${aiReason})`);
      continue;
    }

    let pubkey: string | undefined;
    if (!DRY_RUN && cfg) {
      try {
        pubkey = await createMarketOnChain(cfg, m);
        console.log(`[indexer] created on-chain ${m.polymarketId} → ${pubkey}`);
        
        // Store in database to reduce future Gamma calls
        const storedMarket: StoredMarket = {
          polymarketId: m.polymarketId,
          question: m.question,
          endTs: m.endTs,
          priceYesBps: m.priceYesBps,
          lmsr_b: m.lmsr_b,
          closed: false,
          winningOutcome: null,
          aiScore: m.aiScore,
          aiReason: m.aiReason,
          aiTitle: m.aiTitle,
          aiTags: m.aiTags,
          aiSummary: m.aiSummary,
          raw: m as any,
          pubkey,
          status: "open",
          createdAt: new Date().toISOString(),
        };
        await storeMarket(storedMarket);
        console.log(`[indexer] stored ${m.polymarketId} in database`);
      } catch (err) {
        console.error(`[indexer] create failed for ${m.polymarketId}:`, err);
        continue;
      }
    } else {
      console.log(`[indexer] DRY_RUN would create: ${m.question.slice(0, 80)}`);
    }

    store[m.polymarketId] = {
      ...m,
      pubkey,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    created += 1;
  }

  // Sync database with web store
  const dbMarkets = await getAllMarkets();
  for (const dbMarket of dbMarkets) {
    if (!store[dbMarket.polymarketId]) {
      store[dbMarket.polymarketId] = {
        ...dbMarket,
        status: dbMarket.status as any,
        pubkey: dbMarket.pubkey,
        createdAt: dbMarket.createdAt,
      };
    }
  }

  saveStore(store);
  console.log(`[indexer] tick done (new=${created}, tracked=${Object.keys(store).length})`);
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const once = process.argv.includes("--once");

  await tick();
  if (once) return;

  console.log(`[indexer] polling every ${POLL_MS}ms`);
  setInterval(() => {
    tick().catch((err) => console.error("[indexer] tick error", err));
  }, POLL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
