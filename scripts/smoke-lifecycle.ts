/**
 * Phase 1 localnet smoke: create → buy → sell → freeze → resolve → redeem.
 *
 * Usage:
 *   USDC_MINT=... npx tsx scripts/smoke-lifecycle.ts
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import idl from "../apps/indexer/src/idl/veridex.json" with { type: "json" };

function loadKeypair(filePath: string): Keypair {
  const resolved = filePath.replace(/^~/, process.env.HOME || "");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(resolved, "utf8")) as number[])
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
  const authority = loadKeypair(
    process.env.AUTHORITY_KEYPAIR ||
      path.join(process.env.HOME || "", ".config/solana/id.json")
  );
  const oracle = loadKeypair(
    process.env.ORACLE_KEYPAIR ||
      process.env.AUTHORITY_KEYPAIR ||
      path.join(process.env.HOME || "", ".config/solana/id.json")
  );

  let usdcMintStr = process.env.USDC_MINT;
  if (!usdcMintStr && fs.existsSync("data/local-mint.json")) {
    usdcMintStr = (
      JSON.parse(fs.readFileSync("data/local-mint.json", "utf8")) as {
        usdcMint: string;
      }
    ).usdcMint;
  }
  if (!usdcMintStr) throw new Error("Set USDC_MINT or run setup-local.ts first");

  const usdcMint = new PublicKey(usdcMintStr);
  const connection = new Connection(rpc, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(authority), {
    commitment: "confirmed",
  });
  const program = new Program(idl as anchor.Idl, provider);
  const programId = new PublicKey((idl as { address: string }).address);

  const polymarketId = `smoke-${Date.now()}`;
  const question = "Smoke: will this lifecycle complete?";
  const endTs = Math.floor(Date.now() / 1000) + 8; // short window to trade
  const priceYesBps = 6000;

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId
  );
  const [market] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), Buffer.from(polymarketId)],
    programId
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()],
    programId
  );
  const [position] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), authority.publicKey.toBuffer()],
    programId
  );
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, authority.publicKey);

  const before = Number((await getAccount(connection, userUsdc)).amount);
  console.log("USDC before:", before / 1e6);
  console.log("Creating market", polymarketId, "endTs", endTs);

  await program.methods
    .createMarket(polymarketId, question, new BN(endTs), priceYesBps)
    .accounts({
      authority: authority.publicKey,
      config,
      usdcMint,
      market,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log("✓ create_market", market.toBase58());

  const buyShares = 2_000_000; // 2 shares
  await program.methods
    .buy(0, new BN(buyShares))
    .accounts({
      user: authority.publicKey,
      market,
      position,
      vault,
      userUsdc,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("✓ buy YES 2 shares");

  const sellShares = 500_000; // 0.5 shares
  await program.methods
    .sell(0, new BN(sellShares))
    .accounts({
      user: authority.publicKey,
      market,
      position,
      vault,
      userUsdc,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("✓ sell YES 0.5 shares");

  const waitMs = Math.max(0, endTs * 1000 - Date.now()) + 1500;
  console.log(`Waiting ${waitMs}ms for end_ts…`);
  await sleep(waitMs);

  await program.methods
    .freeze()
    .accounts({ oracle: oracle.publicKey, market })
    .rpc();
  console.log("✓ freeze");

  await program.methods
    .resolve(0) // YES wins
    .accounts({ oracle: oracle.publicKey, market })
    .rpc();
  console.log("✓ resolve YES");

  await program.methods
    .redeem()
    .accounts({
      user: authority.publicKey,
      market,
      position,
      vault,
      userUsdc,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("✓ redeem");

  const after = Number((await getAccount(connection, userUsdc)).amount);
  const pos = await (program.account as { position: { fetch: (k: PublicKey) => Promise<{ yesShares: BN; noShares: BN }> } }).position.fetch(position);
  console.log("USDC after:", after / 1e6, "delta:", (after - before) / 1e6);
  console.log("Position after redeem:", {
    yes: Number(pos.yesShares),
    no: Number(pos.noShares),
  });

  if (Number(pos.yesShares) !== 0 || Number(pos.noShares) !== 0) {
    throw new Error("expected empty position after redeem");
  }
  // Bought 2 @ 1.0 = 2 USDC, sold 0.5 @ 1.0 = 0.5, redeemed 1.5 @ 1.0 = 1.5
  // net = -2 + 0.5 + 1.5 = 0
  const expectedDelta = 0;
  if (after - before !== expectedDelta) {
    throw new Error(
      `USDC delta ${after - before} != expected ${expectedDelta}`
    );
  }
  console.log("✓ USDC delta matches expected 0 (fully collateralized stub)");

  console.log("\nSMOKE OK — full lifecycle passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
