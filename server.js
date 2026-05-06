'use strict';

const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');

const app      = express();
const PORT     = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'profile.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DB_DIR   = path.join(__dirname, 'db');
const DB_FILE  = path.join(DB_DIR, 'transactions.sqlite');

[DATA_DIR, UPLOADS_DIR, DB_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── SQLite setup ──────────────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const db = new Database(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account     TEXT,
    date        TEXT,
    description TEXT,
    amount      REAL,
    balance     REAL,
    category    TEXT,
    reference   TEXT,
    notes       TEXT,
    source_type TEXT,
    source_file TEXT,
    imported_at TEXT
  )
`);

// Migrate: add columns that may be missing in older DB files
['category TEXT', 'reference TEXT', 'notes TEXT', 'source_type TEXT'].forEach(col => {
  try { db.exec(`ALTER TABLE transactions ADD COLUMN ${col}`); } catch {}
});

// Primary dedup: by (date, description, amount, account) — catches rows without a reference
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_dedup ON transactions(date, description, amount, account)');
} catch {}

// Secondary dedup: (date, amount, account, reference) when reference present.
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_dedup_ref
           ON transactions(date, amount, account, reference)
           WHERE reference IS NOT NULL AND reference != ''`);
} catch {}

// Tertiary dedup: (date, amount, balance, account) when balance present and no reference.
// balance is a running total unique to each row position in the statement, so
// date+amount+balance is an extremely strong fingerprint even without a reference.
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_dedup_bal
           ON transactions(date, amount, balance, account)
           WHERE balance IS NOT NULL AND reference IS NULL`);
} catch {}

// ── Multer ────────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const safe = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, Date.now() + '_' + safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── Profile helpers ───────────────────────────────────────────────────────────
function loadProfile() {
  if (!fs.existsSync(DATA_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return null; }
}
function saveProfile(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── Insert helpers ────────────────────────────────────────────────────────────
const insertTx = db.prepare(`
  INSERT OR IGNORE INTO transactions
    (account, date, description, amount, balance, category, reference, notes, source_type, source_file, imported_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
`);

const insertMany = db.transaction((rows) => {
  let inserted = 0;
  for (const r of rows) {
    const info = insertTx.run(
      r.account, r.date, r.description, r.amount,
      r.balance ?? null, r.category ?? null, r.reference ?? null,
      r.notes ?? null, r.source_type ?? null,
      r.source ?? r.source_file ?? null,
      new Date().toISOString()
    );
    if (info.changes > 0) inserted++;
  }
  return inserted;
});

// ── API routes ────────────────────────────────────────────────────────────────
app.get('/api/profile', (req, res) => {
  const p = loadProfile();
  res.json(p || { exists: false });
});

app.post('/api/profile', (req, res) => {
  const existing = loadProfile() || {};
  const updated  = { ...existing, ...req.body, updatedAt: new Date().toISOString() };
  saveProfile(updated);
  res.json({ ok: true });
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const accountName = req.body.accountName || req.file.originalname;
  const { parseFile } = require('./server/parsers');

  const result = await parseFile(req.file.path, accountName);

  // Profile-data files (balances, mortgage) → update profile.json, not transactions
  if (result.type === 'profile_data') {
    const existing = loadProfile() || {};
    existing[result.profileKey] = result.profileData;
    existing.updatedAt = new Date().toISOString();
    saveProfile(existing);
    return res.json({
      ok: true,
      filename: req.file.originalname,
      rows: 0,
      profileUpdated: result.profileKey,
      sourceType: result.sourceType,
      warning: result.warning || null
    });
  }

  // Transaction files → insert into SQLite
  const inserted = insertMany(result.transactions);

  const detectedAccount = result.transactions[0]?.account || null;

  res.json({
    ok: true,
    filename:        req.file.originalname,
    rows:            result.transactions.length,
    inserted,
    duplicates:      result.transactions.length - inserted,
    sourceType:      result.sourceType,
    detectedAccount,
    stats:           result.stats || null,
    preview:         result.transactions.slice(0, 5),
    warning:         result.warning || null
  });
});

app.get('/api/uploads', (req, res) => {
  const rows = db.prepare(`
    SELECT source_file, account, source_type,
           COUNT(*)       AS tx_count,
           MIN(date)      AS date_from,
           MAX(date)      AS date_to,
           MAX(imported_at) AS imported_at
    FROM transactions
    GROUP BY source_file, account
    ORDER BY MAX(imported_at) DESC
  `).all();
  res.json(rows);
});

app.delete('/api/uploads/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const info = db.prepare('DELETE FROM transactions WHERE source_file = ?').run(filename);
  res.json({ ok: true, deleted: info.changes });
});

app.get('/api/transactions', (req, res) => {
  const account = req.query.account;
  const limit   = parseInt(req.query.limit) || 2000;
  const rows = account
    ? db.prepare('SELECT * FROM transactions WHERE account = ? ORDER BY id DESC LIMIT ?').all(account, limit)
    : db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT ?').all(limit);
  res.json(rows);
});

app.delete('/api/transactions', (req, res) => {
  const account = req.query.account;
  if (account) db.prepare('DELETE FROM transactions WHERE account = ?').run(account);
  else         db.prepare('DELETE FROM transactions').run();
  res.json({ ok: true });
});

app.post('/api/ai', async (req, res) => {
  const { messages, systemContext } = req.body;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': req.headers['x-api-key'] || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 2048, system: systemContext, messages })
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log('Financial Dashboard is running!');
  console.log('Open browser: http://localhost:' + PORT);
});
