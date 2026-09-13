import { useCallback, useEffect, useMemo, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import type { StoredMarket } from "@veridex/shared";
import idl from "./idl/veridex.json";

const PROGRAM_ID = new PublicKey(
  import.meta.env.VITE_PROGRAM_ID || idl.address
);
const USDC_MINT = new PublicKey(
  import.meta.env.VITE_USDC_MINT || "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"
);

function marketPda(polymarketId: string) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), Buffer.from(polymarketId)],
    PROGRAM_ID
  );
}

function vaultPda(market: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()],
    PROGRAM_ID
  );
}

function positionPda(market: PublicKey, user: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), user.toBuffer()],
    PROGRAM_ID
  );
}

function formatUsd(micro: number) {
  return (micro / 1_000_000).toFixed(2);
}

export default function App() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [markets, setMarkets] = useState<StoredMarket[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [shares, setShares] = useState("1");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [position, setPosition] = useState<{ yes: number; no: number } | null>(
    null
  );

  const loadMarkets = useCallback(async () => {
    try {
      const res = await fetch("/markets.json", { cache: "no-store" });
      if (!res.ok) {
        setMarkets([]);
        return;
      }
      const data = (await res.json()) as Record<string, StoredMarket>;
      const list = Object.values(data).sort((a, b) => b.endTs - a.endTs);
      setMarkets(list);
      if (!selected && list[0]) setSelected(list[0].polymarketId);
    } catch {
      setMarkets([]);
    }
  }, [selected]);

  useEffect(() => {
    loadMarkets();
    const t = setInterval(loadMarkets, 15_000);
    return () => clearInterval(t);
  }, [loadMarkets]);

  const active = useMemo(
    () => markets.find((m) => m.polymarketId === selected) ?? null,
    [markets, selected]
  );

  const program = useMemo(() => {
    if (!wallet.publicKey || !wallet.signTransaction) return null;
    const provider = new AnchorProvider(
      connection,
      wallet as unknown as AnchorProvider["wallet"],
      { commitment: "confirmed" }
    );
    return new Program(idl as never, provider);
  }, [connection, wallet]);

  const refreshPosition = useCallback(async () => {
    if (!wallet.publicKey || !active?.pubkey) {
      setPosition(null);
      return;
    }
    const market = new PublicKey(active.pubkey);
    const [pos] = positionPda(market, wallet.publicKey);
    const info = await connection.getAccountInfo(pos);
    if (!info || !program) {
      setPosition({ yes: 0, no: 0 });
      return;
    }
    try {
      const decoded = await (program.account as any).position.fetch(pos);
      setPosition({
        yes: Number(decoded.yesShares),
        no: Number(decoded.noShares),
      });
    } catch {
      setPosition({ yes: 0, no: 0 });
    }
  }, [wallet.publicKey, active, connection, program]);

  useEffect(() => {
    refreshPosition();
  }, [refreshPosition]);

  async function ensureUsdcAta(owner: PublicKey) {
    const ata = getAssociatedTokenAddressSync(USDC_MINT, owner);
    try {
      await getAccount(connection, ata);
      return ata;
    } catch {
      if (!wallet.sendTransaction) throw new Error("Wallet cannot send");
      const ix = createAssociatedTokenAccountInstruction(
        owner,
        ata,
        owner,
        USDC_MINT
      );
      const tx = new Transaction().add(ix);
      await wallet.sendTransaction(tx, connection);
      return ata;
    }
  }

  async function trade(side: "buy" | "sell", outcome: 0 | 1) {
    if (!program || !wallet.publicKey || !active) {
      setMsg("Connect wallet and select a market");
      return;
    }
    const shareAmount = Math.round(Number(shares) * 1_000_000);
    if (!Number.isFinite(shareAmount) || shareAmount <= 0) {
      setMsg("Enter a valid share amount");
      return;
    }

    setBusy(true);
    setMsg(null);
    try {
      const [market] = active.pubkey
        ? [new PublicKey(active.pubkey)]
        : marketPda(active.polymarketId);
      const [vault] = vaultPda(market);
      const [positionKey] = positionPda(market, wallet.publicKey);
      const userUsdc = await ensureUsdcAta(wallet.publicKey);

      const method =
        side === "buy"
          ? program.methods.buy(outcome, new BN(shareAmount))
          : program.methods.sell(outcome, new BN(shareAmount));

      await method
        .accounts({
          user: wallet.publicKey,
          market,
          position: positionKey,
          vault,
          userUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      setMsg(`${side.toUpperCase()} ${outcome === 0 ? "YES" : "NO"} confirmed`);
      await refreshPosition();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function redeem() {
    if (!program || !wallet.publicKey || !active?.pubkey) return;
    setBusy(true);
    setMsg(null);
    try {
      const market = new PublicKey(active.pubkey);
      const [vault] = vaultPda(market);
      const [positionKey] = positionPda(market, wallet.publicKey);
      const userUsdc = await ensureUsdcAta(wallet.publicKey);
      await program.methods
        .redeem()
        .accounts({
          user: wallet.publicKey,
          market,
          position: positionKey,
          vault,
          userUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      setMsg("Redeemed winning shares");
      await refreshPosition();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const yesPrice = active ? active.priceYesBps / 100 : 50;
  const noPrice = active ? (10_000 - active.priceYesBps) / 100 : 50;

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <span className="mark">VERIDEX</span>
          <span className="tag">Polymarket → Solana</span>
        </div>
        <WalletMultiButton />
      </header>

      <main className="layout">
        <section className="rail">
          <div className="rail-head">
            <h2>Markets</h2>
            <button type="button" className="ghost" onClick={loadMarkets}>
              Refresh
            </button>
          </div>
          {markets.length === 0 ? (
            <p className="empty">
              No markets yet. Run the indexer (`DRY_RUN=1 npm run once -w
              @veridex/indexer`) then copy `data/markets.json` to
              `apps/web/public/markets.json`.
            </p>
          ) : (
            <ul className="market-list">
              {markets.map((m) => (
                <li key={m.polymarketId}>
                  <button
                    type="button"
                    className={
                      m.polymarketId === selected ? "market active" : "market"
                    }
                    onClick={() => setSelected(m.polymarketId)}
                  >
                    <span className="q">{m.question}</span>
                    <span className={`st ${m.status}`}>{m.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="stage">
          {active ? (
            <>
              <p className="eyebrow">Phase 1 · 1:1 collateral stub</p>
              <h1>{active.question}</h1>
              <p className="meta">
                Ends {new Date(active.endTs * 1000).toLocaleString()} · displayed
                odds YES {yesPrice.toFixed(1)}¢ / NO {noPrice.toFixed(1)}¢ · trade
                cost 1 USDC per share until LMSR
              </p>

              <div className="trade">
                <label>
                  Shares
                  <input
                    value={shares}
                    onChange={(e) => setShares(e.target.value)}
                    inputMode="decimal"
                  />
                </label>
                <div className="actions">
                  <button
                    type="button"
                    className="yes"
                    disabled={busy || active.status !== "open"}
                    onClick={() => trade("buy", 0)}
                  >
                    Buy YES
                  </button>
                  <button
                    type="button"
                    className="no"
                    disabled={busy || active.status !== "open"}
                    onClick={() => trade("buy", 1)}
                  >
                    Buy NO
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy || active.status !== "open"}
                    onClick={() => trade("sell", 0)}
                  >
                    Sell YES
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy || active.status !== "open"}
                    onClick={() => trade("sell", 1)}
                  >
                    Sell NO
                  </button>
                  {active.status === "resolved" && (
                    <button
                      type="button"
                      className="yes"
                      disabled={busy}
                      onClick={redeem}
                    >
                      Redeem
                    </button>
                  )}
                </div>
              </div>

              {position && (
                <p className="pos">
                  Your position — YES {formatUsd(position.yes)} · NO{" "}
                  {formatUsd(position.no)}
                </p>
              )}
              {msg && <p className="msg">{msg}</p>}
            </>
          ) : (
            <div className="placeholder">
              <h1>VERIDEX</h1>
              <p>Select a mirrored market to trade against stub liquidity.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
