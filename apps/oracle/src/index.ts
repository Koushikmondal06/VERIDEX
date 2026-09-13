import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { GAMMA_BASE, normalizeMarket, type StoredMarket } from "@veridex/shared";
import idl from "./idl/veridex.json" with { type: "json" };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DATA_DIR = path.resolve(process.env.VERIDEX_DATA_DIR || path.join(REPO_ROOT, "data"));
const STORE_PATH = path.join(DATA_DIR, "markets.json");
const POLL_MS = Number(process.env.ORACLE_POLL_MS || 30_000);
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

function loadKeypair(filePath: string): Keypair {
  const resolved = filePath.replace(/^~/, process.env.HOME || "");
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function loadStore(): Record<string, StoredMarket> {
  if (!fs.existsSync(STORE_PATH)) return {};
  return JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as Record<string, StoredMarket>;
}

function saveStore(store: Record<string, StoredMarket>) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

async function fetchGammaMarket(id: string) {
  // Gamma supports filtering; fall back to markets list by id query when available
  const url = `${GAMMA_BASE}/markets?id=${encodeURIComponent(id)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const data = (await res.json()) as unknown;
  if (Array.isArray(data)) return data[0] ?? null;
  return data;
}

async function loadProgram() {
  const rpc = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
  const oraclePath =
    process.env.ORACLE_KEYPAIR ||
    process.env.AUTHORITY_KEYPAIR ||
    path.join(process.env.HOME || "", ".config/solana/id.json");
  const oracle = loadKeypair(oraclePath);
  const connection = new Connection(rpc, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(oracle), {
    commitment: "confirmed",
  });
  const program = new Program(idl as anchor.Idl, provider);
  const programId = new PublicKey((idl as { address: string }).address);
  return { program, oracle, programId, connection };
}

function marketPda(programId: PublicKey, polymarketId: string) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), Buffer.from(polymarketId)],
    programId
  );
}

async function tick() {
  const store = loadStore();
  const ids = Object.keys(store);
  console.log(`[oracle] checking ${ids.length} tracked markets…`);

  const now = Math.floor(Date.now() / 1000);
  const chain = DRY_RUN ? null : await loadProgram();

  for (const id of ids) {
    const entry = store[id];
    if (entry.status === "resolved") continue;

    // Freeze at end_ts (before resolution known)
    if (entry.status === "open" && now >= entry.endTs) {
      console.log(`[oracle] freeze due: ${entry.question.slice(0, 60)}`);
      if (!DRY_RUN && chain && entry.pubkey) {
        const [market] = marketPda(chain.programId, id);
        try {
          await chain.program.methods
            .freeze()
            .accounts({ oracle: chain.oracle.publicKey, market })
            .rpc();
          entry.status = "frozen";
          console.log(`[oracle] frozen ${id}`);
        } catch (err) {
          console.error(`[oracle] freeze failed ${id}:`, err);
        }
      } else {
        entry.status = "frozen";
      }
    }

    // Poll Polymarket for resolution
    try {
      const raw = await fetchGammaMarket(id);
      if (!raw) continue;
      const normalized = normalizeMarket(raw as Parameters<typeof normalizeMarket>[0]);
      if (!normalized?.closed || normalized.winningOutcome === null) continue;

      console.log(
        `[oracle] resolved on Polymarket: ${id} → ${normalized.winningOutcome === 0 ? "YES" : "NO"}`
      );

      if (!DRY_RUN && chain) {
        const [market] = marketPda(chain.programId, id);
        try {
          await chain.program.methods
            .resolve(normalized.winningOutcome)
            .accounts({ oracle: chain.oracle.publicKey, market })
            .rpc();
          entry.status = "resolved";
          entry.winningOutcome = normalized.winningOutcome;
          entry.closed = true;
          console.log(`[oracle] on-chain resolve ok ${id}`);
        } catch (err) {
          console.error(`[oracle] resolve failed ${id}:`, err);
        }
      } else {
        entry.status = "resolved";
        entry.winningOutcome = normalized.winningOutcome;
        entry.closed = true;
      }
    } catch (err) {
      console.error(`[oracle] gamma fetch failed ${id}:`, err);
    }
  }

  saveStore(store);
}

async function main() {
  const once = process.argv.includes("--once");
  await tick();
  if (once) return;
  console.log(`[oracle] polling every ${POLL_MS}ms`);
  setInterval(() => {
    tick().catch((err) => console.error("[oracle] tick error", err));
  }, POLL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
