export const GAMMA_BASE = "https://gamma-api.polymarket.com";

export const LMSR_B_DEFAULT = 1_000_000;

export type GammaMarket = {
  id: string;
  question?: string;
  conditionId?: string;
  slug?: string;
  endDate?: string;
  endDateIso?: string;
  closed?: boolean;
  active?: boolean;
  outcomes?: string;
  outcomePrices?: string;
  volume?: string;
  liquidity?: string;
};

export type GammaEvent = {
  id: string;
  title?: string;
  slug?: string;
  endDate?: string;
  closed?: boolean;
  active?: boolean;
  markets?: GammaMarket[];
};

export type CuratedMarket = {
  polymarketId: string;
  question: string;
  endTs: number;
  priceYesBps: number;
  lmsr_b?: number;  // LMSR bonding curve parameter (default: 1_000_000)
  closed: boolean;
  winningOutcome: 0 | 1 | null;
  raw: GammaMarket;
};

function parseJsonArray(value?: string): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseEndTs(market: GammaMarket, event?: GammaEvent): number {
  const raw = market.endDateIso || market.endDate || event?.endDate;
  if (!raw) {
    // Default: 7 days from now if API omits end date
    return Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    return Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  }
  return Math.floor(ms / 1000);
}

function parsePrices(market: GammaMarket): { yesBps: number; winning: 0 | 1 | null } {
  const prices = parseJsonArray(market.outcomePrices).map(Number);
  const outcomes = parseJsonArray(market.outcomes).map((o) => o.toLowerCase());

  let yesBps = 5000;
  if (prices.length >= 1 && Number.isFinite(prices[0])) {
    yesBps = Math.min(9999, Math.max(1, Math.round(prices[0] * 10_000)));
  }

  let winning: 0 | 1 | null = null;
  if (market.closed && prices.length >= 2) {
    if (prices[0] >= 0.99) winning = 0;
    else if (prices[1] >= 0.99) winning = 1;
    else if (outcomes[0]?.includes("yes") && prices[0] > prices[1]) winning = 0;
    else if (prices[1] > prices[0]) winning = 1;
  }

  return { yesBps, winning };
}

function parseLmsrB(market: GammaMarket): number {
  // Derive LMSR b parameter from Gamma market liquidity
  let liquidity = 0;
  if (market.liquidity && Number.isFinite(Number(market.liquidity))) {
    liquidity = Math.max(1, Number(market.liquidity));
  }
  // Scale: larger liquidity → larger b (deeper market)
  // b = 1_000_000 * (liquidity / 1_000_000 + 1), capped at 10_000_000
  const b = 1_000_000 * Math.min(10, liquidity / 1_000_000 + 1);
  return Math.round(b);
}

export function normalizeMarket(market: GammaMarket, event?: GammaEvent): CuratedMarket | null {
  const id = market.id || market.conditionId || market.slug;
  if (!id) return null;

  const question = (market.question || event?.title || "Untitled market").slice(0, 200);
  const { yesBps, winning } = parsePrices(market);
  const lmsr_b = parseLmsrB(market);

  return {
    polymarketId: String(id).slice(0, 64),
    question,
    endTs: parseEndTs(market, event),
    priceYesBps: yesBps,
    lmsr_b,
    closed: Boolean(market.closed),
    winningOutcome: winning,
    raw: market,
  };
}

export async function fetchActiveEvents(limit = 25): Promise<GammaEvent[]> {
  const url = `${GAMMA_BASE}/events?active=true&closed=false&limit=${limit}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Gamma API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as GammaEvent[];
}

export async function fetchMarketBySlug(slug: string): Promise<GammaMarket | null> {
  const url = `${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const data = (await res.json()) as GammaMarket[];
  return Array.isArray(data) ? data[0] ?? null : null;
}

export async function collectBinaryMarkets(limitEvents = 25): Promise<CuratedMarket[]> {
  const events = await fetchActiveEvents(limitEvents);
  const out: CuratedMarket[] = [];

  for (const event of events) {
    for (const market of event.markets ?? []) {
      const outcomes = parseJsonArray(market.outcomes).map((o) => o.toLowerCase());
      const isBinary =
        outcomes.length === 2 &&
        ((outcomes.includes("yes") && outcomes.includes("no")) || outcomes.length === 2);
      if (!isBinary) continue;
      const normalized = normalizeMarket(market, event);
      if (normalized && !normalized.closed) out.push(normalized);
    }
  }

  return out;
}

/** Offline/dev path when Gamma is unreachable. */
export function marketsFromFixtures(raw: GammaMarket[]): CuratedMarket[] {
  return raw
    .map((m) => normalizeMarket(m))
    .filter((m): m is CuratedMarket => Boolean(m && !m.closed));
}

export type MarketStatus = "open" | "frozen" | "resolved";

export type StoredMarket = CuratedMarket & {
  pubkey?: string;
  status: MarketStatus;
  createdAt: string;
};
