import fs from "node:fs";
import path from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { LMSR_B_DEFAULT } from "@veridex/shared";
import type { CuratedMarket } from "@veridex/shared";
import idl from "./idl/veridex.json" with { type: "json" };

export type IndexerConfig = {
  connection: Connection;
  provider: AnchorProvider;
  program: Program;
  authority: Keypair;
  usdcMint: PublicKey;
  programId: PublicKey;
};

function loadKeypair(filePath: string): Keypair {
  const resolved = filePath.replace(/^~/, process.env.HOME || "");
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export async function loadConfig(): Promise<IndexerConfig> {
  const rpc = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
  const authorityPath =
    process.env.AUTHORITY_KEYPAIR ||
    path.join(process.env.HOME || "", ".config/solana/id.json");
  const usdcMint = new PublicKey(
    process.env.USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );
  const programId = new PublicKey(
    process.env.PROGRAM_ID || (idl as { address: string }).address
  );

  const authority = loadKeypair(authorityPath);
  const connection = new Connection(rpc, "confirmed");
  const wallet = new Wallet(authority);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = new Program(idl as anchor.Idl, provider);

  return { connection, provider, program, authority, usdcMint, programId };
}

export function configPda(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
}

export function marketPda(programId: PublicKey, polymarketId: string) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), Buffer.from(polymarketId)],
    programId
  );
}

export function vaultPda(programId: PublicKey, market: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()],
    programId
  );
}

export async function ensureInitialized(cfg: IndexerConfig) {
  const [config] = configPda(cfg.programId);
  const info = await cfg.connection.getAccountInfo(config);
  if (info) return;

  const oraclePath =
    process.env.ORACLE_KEYPAIR ||
    process.env.AUTHORITY_KEYPAIR ||
    path.join(process.env.HOME || "", ".config/solana/id.json");
  const oracle = loadKeypair(oraclePath);

  console.log("[indexer] initializing on-chain config…");
  await cfg.program.methods
    .initialize()
    .accounts({
      authority: cfg.authority.publicKey,
      oracle: oracle.publicKey,
      usdcMint: cfg.usdcMint,
      config,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("[indexer] config initialized at", config.toBase58());
}

export async function createMarketOnChain(
  cfg: IndexerConfig,
  market: CuratedMarket
): Promise<string> {
  const [marketKey] = marketPda(cfg.programId, market.polymarketId);
  const existing = await cfg.connection.getAccountInfo(marketKey);
  if (existing) return marketKey.toBase58();

  const [vault] = vaultPda(cfg.programId, marketKey);
  const [config] = configPda(cfg.programId);

  await cfg.program.methods
    .createMarket(
      market.polymarketId,
      market.question,
      new anchor.BN(market.endTs),
      market.priceYesBps
    )
    .accounts({
      authority: cfg.authority.publicKey,
      config,
      usdcMint: cfg.usdcMint,
      market: marketKey,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  return marketKey.toBase58();
}

// re-export helper for ATA if needed later
export { getAssociatedTokenAddressSync };
