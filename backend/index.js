require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Connect to Neon PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('connect', () => {
  console.log('Connected to Neon PostgreSQL');
});

// Initialize database tables
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS markets (
      id SERIAL PRIMARY KEY,
      polymarket_id VARCHAR(64) UNIQUE NOT NULL,
      question TEXT NOT NULL,
      end_ts BIGINT NOT NULL,
      price_yes_bps INTEGER NOT NULL,
      lmsr_b INTEGER DEFAULT 1000000,
      closed BOOLEAN DEFAULT FALSE,
      winning_outcome INTEGER,
      ai_score INTEGER DEFAULT 50,
      ai_reason TEXT DEFAULT 'Auto-accepted (no AI data)',
      ai_title TEXT,
      ai_tags JSONB DEFAULT '[]',
      ai_summary TEXT,
      raw_data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      wallet_address VARCHAR(128) UNIQUE,
      created_at TIMESTAMP DEFAULT NOW(),
      last_login TIMESTAMP DEFAULT NOW()
    )
  `);

  console.log('Database tables initialized');
}

initDB().catch(console.error);

// API: Get all markets
app.get('/api/markets', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM markets ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API: Create market (admin)
app.post('/api/markets', async (req, res) => {
  try {
    const { polymarket_id, question, end_ts, price_yes_bps } = req.body;
    
    if (!polymarket_id || !question || !end_ts || price_yes_bps === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const result = await pool.query(
      `INSERT INTO markets (polymarket_id, question, end_ts, price_yes_bps, lmsr_b, closed, winning_outcome, ai_score, ai_reason, ai_title, ai_tags, ai_summary, raw_data)
       VALUES ($1, $2, $3, $4, $5, FALSE, NULL, 50, 'Auto-accepted (no AI data)', NULL, '[]', NULL, NULL)
       RETURNING *`,
      [polymarket_id, question, end_ts, price_yes_bps, 1000000]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Market ID already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// API: Get market count
app.get('/api/markets/count', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) as total FROM markets');
    const result2 = await pool.query('SELECT COUNT(*) as active FROM markets WHERE closed = FALSE');
    res.json({ total: result.rows[0].total, active: result2.rows[0].active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get market status by ID
app.get('/api/markets/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM markets WHERE polymarket_id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Market not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: User tracking
app.post('/api/users', async (req, res) => {
  try {
    const { wallet_address } = req.body;
    if (!wallet_address) {
      return res.status(400).json({ error: 'Wallet address required' });
    }
    
    const result = await pool.query(
      `INSERT INTO users (wallet_address) VALUES ($1) ON CONFLICT (wallet_address) DO UPDATE SET last_login = NOW() RETURNING *`,
      [wallet_address]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get user stats
app.get('/api/users/stats', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) as total_users FROM users');
    res.json({ total_users: result.rows[0].total_users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`Backend server running at http://localhost:${port}`);
}).on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});
