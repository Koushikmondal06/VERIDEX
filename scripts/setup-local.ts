/**
 * Localnet helper: airdrop SOL, create a fake USDC mint, mint to authority ATA.
 * Usage: npx tsx scripts/setup-local.ts
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

function loadKeypair(filePath: string): Keypair {
  const resolved = filePath.replace(/^~/, process.env.HOME || "");
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
  const connection = new Connection(rpc, "confirmed");
  const payer = loadKeypair(
    process.env.AUTHORITY_KEYPAIR ||
      path.join(process.env.HOME || "", ".config/solana/id.json")
  );

  const bal = await connection.getBalance(payer.publicKey);
  if (bal < 2 * LAMPORTS_PER_SOL) {
    console.log("Airdropping 5 SOL…");
    const sig = await connection.requestAirdrop(
      payer.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(sig, "confirmed");
  }

  console.log("Creating local USDC mint (6 decimals)…");
  const mint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    6,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    payer.publicKey
  );

  const amount = 1_000_000n * 1_000_000n; // 1,000,000 USDC
  await mintTo(connection, payer, mint, ata.address, payer, amount);

  const out = {
    usdcMint: mint.toBase58(),
    authority: payer.publicKey.toBase58(),
    authorityAta: ata.address.toBase58(),
  };
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/local-mint.json", JSON.stringify(out, null, 2));
  console.log(out);
  console.log("\nSet USDC_MINT=" + out.usdcMint);
  console.log("Set VITE_USDC_MINT=" + out.usdcMint);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
