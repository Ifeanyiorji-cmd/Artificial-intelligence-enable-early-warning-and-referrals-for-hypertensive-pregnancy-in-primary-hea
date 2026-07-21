// AMEWRIN backend — minimal API matching what index.html already expects.
// Endpoints: /api/register /api/login /api/logout /api/assessments /api/facilities
//
// Uses Postgres (via DATABASE_URL) instead of local SQLite so account data
// survives container restarts/redeploys — SQLite files on Render's free tier
// live on ephemeral disk and get wiped on every restart.

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-before-deploying';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL env var. Set it to your Postgres connection string (see README).');
  process.exit(1);
}

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// Most managed free Postgres providers (Neon, Supabase, Render Postgres) require SSL.
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      name TEXT,
      phone TEXT UNIQUE NOT NULL,
      role TEXT,
      facility TEXT,
      pin_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS assessments (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      diagnosis TEXT,
      diagnosis_confidence REAL,
      referral_probability REAL,
      vitals JSONB,
      symptoms JSONB,
      facility_referred_to TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS facilities (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      town TEXT,
      lga TEXT,
      tier TEXT,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      address TEXT,
      phone TEXT,
      added_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('Database tables ready.');
}

// ---------- Helpers ----------
function signToken(account) {
  return jwt.sign({ id: account.id, phone: account.phone }, JWT_SECRET, { expiresIn: '90d' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.accountId = payload.id;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired — please sign in again.' });
  }
}

function publicAccount(row) {
  return { id: row.id, name: row.name, phone: row.phone, role: row.role, facility: row.facility };
}

// ---------- Auth ----------
app.post('/api/register', async (req, res) => {
  try {
    const { name, phone, role, facility, pin } = req.body || {};
    if (!phone || !pin) return res.status(400).json({ error: 'Phone number and PIN are required.' });
    if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4-6 digits.' });

    const existing = await pool.query('SELECT id FROM accounts WHERE phone = $1', [phone]);
    if (existing.rows.length) return res.status(409).json({ error: 'An account with this phone number already exists.' });

    const pinHash = bcrypt.hashSync(pin, 10);
    const result = await pool.query(
      'INSERT INTO accounts (name, phone, role, facility, pin_hash) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name || null, phone, role || null, facility || null, pinHash]
    );
    const account = result.rows[0];
    res.json({ token: signToken(account), account: publicAccount(account) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error during registration.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { phone, pin } = req.body || {};
    if (!phone || !pin) return res.status(400).json({ error: 'Enter your phone number and PIN.' });

    const result = await pool.query('SELECT * FROM accounts WHERE phone = $1', [phone]);
    const account = result.rows[0];
    if (!account || !bcrypt.compareSync(pin, account.pin_hash)) {
      return res.status(401).json({ error: 'Phone number or PIN is incorrect.' });
    }
    res.json({ token: signToken(account), account: publicAccount(account) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error during sign-in.' });
  }
});

app.post('/api/logout', (req, res) => {
  // JWTs are stateless here — nothing to invalidate server-side.
  res.json({ ok: true });
});

// ---------- Assessments (per-account history) ----------
app.get('/api/assessments', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM assessments WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.accountId]
    );
    res.json({ assessments: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load assessments.' });
  }
});

app.post('/api/assessments', authMiddleware, async (req, res) => {
  try {
    const { diagnosis, diagnosis_confidence, referral_probability, vitals, symptoms, facility_referred_to } = req.body || {};
    await pool.query(
      `INSERT INTO assessments (account_id, diagnosis, diagnosis_confidence, referral_probability, vitals, symptoms, facility_referred_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        req.accountId,
        diagnosis || null,
        diagnosis_confidence ?? null,
        referral_probability ?? null,
        JSON.stringify(vitals || {}),
        JSON.stringify(symptoms || []),
        facility_referred_to || null,
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save assessment.' });
  }
});

// ---------- Shared facility directory ----------
app.get('/api/facilities', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM facilities ORDER BY created_at DESC');
    res.json({ facilities: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load facilities.' });
  }
});

app.post('/api/facilities', authMiddleware, async (req, res) => {
  try {
    const { name, town, lga, tier, lat, lng, address, phone } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Facility name is required.' });
    await pool.query(
      `INSERT INTO facilities (name, town, lga, tier, lat, lng, address, phone, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [name, town || '', lga || '', tier || 'custom', lat ?? null, lng ?? null, address || '', phone || '', req.accountId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save facility.' });
  }
});

app.get('/', (req, res) => res.send('AMEWRIN backend is running.'));

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`AMEWRIN backend listening on port ${PORT}`));
  })
  .catch((e) => {
    console.error('Failed to initialize database:', e);
    process.exit(1);
  });
