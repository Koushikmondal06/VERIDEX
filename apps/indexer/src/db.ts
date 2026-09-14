import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export interface StoredMarket {
  polymarketId: string;
  question: string;
  endTs: number;
  priceYesBps: number;
  lmsr_b?: number;
  closed: boolean;
  winningOutcome: 0 | 1 | null;
  aiScore?: number;
  aiReason?: string;
  aiTitle?: string;
  aiTags?: string[];
  aiSummary?: string;
  raw: any;
  pubkey?: string;
  status: string;
  createdAt: string;
}

export async function marketExists(polymarketId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT polymarket_id FROM markets WHERE polymarket_id = $1',
      [polymarketId]
    );
    return result.rows.length > 0;
  } finally {
    client.release();
  }
}

export async function storeMarket(market: StoredMarket): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO markets (polymarket_id, question, end_ts, price_yes_bps, lmsr_b, closed, winning_outcome, ai_score, ai_reason, ai_title, ai_tags, ai_summary, raw_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (polymarket_id) DO UPDATE SET
       question = EXCLUDED.question,
       end_ts = EXCLUDED.end_ts,
       price_yes_bps = EXCLUDED.price_yes_bps,
       lmsr_b = EXCLUDED.lmsr_b,
       closed = EXCLUDED.closed,
       winning_outcome = EXCLUDED.winning_outcome,
       ai_score = EXCLUDED.ai_score,
       ai_reason = EXCLUDED.ai_reason,
       ai_title = EXCLUDED.ai_title,
       ai_tags = EXCLUDED.ai_tags,
       ai_summary = EXCLUDED.ai_summary,
       raw_data = EXCLUDED.raw_data`,
      [
        market.polymarketId,
        market.question,
        market.endTs,
        market.priceYesBps,
        market.lmsr_b,
        market.closed,
        market.winningOutcome,
        market.aiScore,
        market.aiReason,
        market.aiTitle,
        market.aiTags,
        market.aiSummary,
        market.raw
      ]
    );
  } finally {
    client.release();
  }
}

export async function getAllMarkets(): Promise<StoredMarket[]> {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM markets ORDER BY created_at DESC');
    return result.rows.map(row => ({
      polymarketId: row.polymarket_id,
      question: row.question,
      endTs: row.end_ts,
      priceYesBps: row.price_yes_bps,
      lmsr_b: row.lmsr_b,
      closed: row.closed,
      winningOutcome: row.winning_outcome as 0 | 1 | null,
      aiScore: row.ai_score,
      aiReason: row.ai_reason,
      aiTitle: row.ai_title,
      aiTags: row.ai_tags as string[],
      aiSummary: row.ai_summary,
      raw: row.raw_data,
      pubkey: row.pubkey,
      status: row.closed ? 'resolved' : row.frozen ? 'frozen' : 'open',
      createdAt: row.created_at
    }));
  } finally {
    client.release();
  }
}

export async function getMarketById(polymarketId: string): Promise<StoredMarket | null> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM markets WHERE polymarket_id = $1',
      [polymarketId]
    );
    if (result.rows.length === 0) return null;
    
    const row = result.rows[0];
    return {
      polymarketId: row.polymarket_id,
      question: row.question,
      endTs: row.end_ts,
      priceYesBps: row.price_yes_bps,
      lmsr_b: row.lmsr_b,
      closed: row.closed,
      winningOutcome: row.winning_outcome as 0 | 1 | null,
      aiScore: row.ai_score,
      aiReason: row.ai_reason,
      aiTitle: row.ai_title,
      aiTags: row.ai_tags as string[],
      aiSummary: row.ai_summary,
      raw: row.raw_data,
      pubkey: row.pubkey,
      status: row.closed ? 'resolved' : row.frozen ? 'frozen' : 'open',
      createdAt: row.created_at
    };
  } finally {
    client.release();
  }
}

export async function updateMarketStatus(polymarketId: string, status: string, winningOutcome?: number, aiScore?: number): Promise<void> {
  const client = await pool.connect();
  try {
    const sets: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;
    
    if (status === 'resolved') {
      sets.push(`closed = TRUE`);
      values.push(winningOutcome);
      paramIdx++;
      if (aiScore !== undefined) {
        sets.push(`ai_score = $${paramIdx}`);
        values.push(aiScore);
        paramIdx++;
      }
    }
    
    values.push(polymarketId);
    
    if (sets.length > 0) {
      await client.query(
        `UPDATE markets SET ${sets.join(', ')} WHERE polymarket_id = $${paramIdx}`,
        values
      );
    }
  } finally {
    client.release();
  }
}

export async function getMarketCount(): Promise<{total: number, active: number}> {
  const client = await pool.connect();
  try {
    const result1 = await client.query('SELECT COUNT(*) as total FROM markets');
    const result2 = await client.query('SELECT COUNT(*) as active FROM markets WHERE closed = FALSE');
    return { total: parseInt(result1.rows[0].total), active: parseInt(result2.rows[0].active) };
  } finally {
    client.release();
  }
}
