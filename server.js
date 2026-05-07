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
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_dedup_bal
           ON transactions(date, amount, balance, account)
           WHERE balance IS NOT NULL AND reference IS NULL`);
} catch {}

// ── Account aliases ───────────────────────────────────────────────────────────
// Maps auto-detected account identifiers to user-defined display names.
db.exec(`
  CREATE TABLE IF NOT EXISTS account_aliases (
    detected TEXT PRIMARY KEY,
    alias    TEXT NOT NULL,
    updated_at TEXT
  )
`);

// ── Profile uploads ────────────────────────────────────────────────────────────
// Tracks non-transaction files (balance reports, mortgage) so they can be listed
// and removed from the UI just like transaction files.
db.exec(`
  CREATE TABLE IF NOT EXISTS profile_uploads (
    filename    TEXT PRIMARY KEY,
    profile_key TEXT NOT NULL,
    source_type TEXT NOT NULL,
    imported_at TEXT NOT NULL
  )
`);

const getAlias    = db.prepare('SELECT alias FROM account_aliases WHERE detected = ?');
const upsertAlias = db.prepare(`
  INSERT INTO account_aliases (detected, alias, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(detected) DO UPDATE SET alias=excluded.alias, updated_at=excluded.updated_at
`);

function applyAliases(transactions) {
  if (!transactions.length) return transactions;
  // Build a set of unique raw account values in this batch
  const unique = [...new Set(transactions.map(t => t.account).filter(Boolean))];
  const map = {};
  for (const raw of unique) {
    const row = getAlias.get(raw);
    if (row) map[raw] = row.alias;
  }
  if (!Object.keys(map).length) return transactions;
  return transactions.map(t => ({ ...t, account: map[t.account] ?? t.account }));
}

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

  // Apply user-defined account aliases before storing
  if (result.type === 'transactions') {
    result.transactions = applyAliases(result.transactions);
  }

  // Profile-data files (balances, mortgage) → update profile.json, not transactions
  if (result.type === 'profile_data') {
    const existing = loadProfile() || {};

    if (result.profileKey === 'balance_snapshot') {
      // Merge accounts from this upload with any existing snapshot accounts from
      // other sources so Poalim + Leumi snapshots coexist
      const prev = existing.balance_snapshot || {};
      const prevAccounts = (prev.accounts || []).filter(a => a.source !== result.profileData.source);
      const mergedAccounts = [...prevAccounts, ...(result.profileData.accounts || [])];
      existing.balance_snapshot = { ...result.profileData, accounts: mergedAccounts };
    } else {
      existing[result.profileKey] = result.profileData;
    }

    existing.updatedAt = new Date().toISOString();
    saveProfile(existing);

    // Record in profile_uploads so the file appears in the uploads list and can be removed
    db.prepare(`
      INSERT OR REPLACE INTO profile_uploads (filename, profile_key, source_type, imported_at)
      VALUES (?, ?, ?, ?)
    `).run(req.file.filename, result.profileKey, result.sourceType, new Date().toISOString());

    const accountCount = result.profileData?.accounts?.length ?? 0;
    return res.json({
      ok: true,
      filename:       req.file.originalname,
      rows:           accountCount,
      inserted:       accountCount,
      profileUpdated: result.profileKey,
      sourceType:     result.sourceType,
      warning:        result.warning || null
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
  const txRows   = db.prepare(`
    SELECT source_file, account, source_type,
           COUNT(*)         AS tx_count,
           MIN(date)        AS date_from,
           MAX(date)        AS date_to,
           MAX(imported_at) AS imported_at,
           NULL             AS profile_key
    FROM transactions
    GROUP BY source_file, account
  `).all();

  const profRows = db.prepare(`
    SELECT filename AS source_file, NULL AS account, source_type,
           0 AS tx_count, NULL AS date_from, NULL AS date_to,
           imported_at, profile_key
    FROM profile_uploads
  `).all();

  const all = [...txRows, ...profRows]
    .sort((a, b) => (b.imported_at || '').localeCompare(a.imported_at || ''));
  res.json(all);
});

app.delete('/api/uploads/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);

  // Profile upload?
  const profRow = db.prepare('SELECT * FROM profile_uploads WHERE filename = ?').get(filename);
  if (profRow) {
    db.prepare('DELETE FROM profile_uploads WHERE filename = ?').run(filename);

    const existing = loadProfile() || {};
    if (profRow.profile_key === 'balance_snapshot') {
      // Remove only accounts from this source so other banks' data survives
      if (existing.balance_snapshot?.accounts) {
        existing.balance_snapshot.accounts = existing.balance_snapshot.accounts
          .filter(a => a.source !== profRow.source_type);
        if (!existing.balance_snapshot.accounts.length) delete existing.balance_snapshot;
      }
    } else {
      delete existing[profRow.profile_key];
    }
    existing.updatedAt = new Date().toISOString();
    saveProfile(existing);
    return res.json({ ok: true, deleted: 1, isProfile: true });
  }

  // Transaction upload
  const info = db.prepare('DELETE FROM transactions WHERE source_file = ?').run(filename);
  res.json({ ok: true, deleted: info.changes, isProfile: false });
});

// ── Account management ────────────────────────────────────────────────────────
app.get('/api/accounts', (req, res) => {
  const rows = db.prepare(`
    SELECT account, COUNT(*) AS tx_count,
           MIN(date) AS date_from, MAX(date) AS date_to
    FROM transactions
    GROUP BY account
    ORDER BY account
  `).all();
  // Attach alias info
  const aliases = db.prepare('SELECT detected, alias FROM account_aliases').all();
  const aliasMap = Object.fromEntries(aliases.map(a => [a.detected, a.alias]));
  res.json(rows.map(r => ({ ...r, alias: aliasMap[r.account] || null })));
});

app.put('/api/accounts/rename', (req, res) => {
  const { from, to } = req.body;
  if (!from || !to || from === to) return res.status(400).json({ error: 'invalid' });

  db.transaction(() => {
    // Update all existing transactions
    db.prepare('UPDATE transactions SET account = ? WHERE account = ?').run(to, from);
    // Store mapping: the original "from" value → new alias
    // Also remap any existing alias that pointed to "from"
    upsertAlias.run(from, to, new Date().toISOString());
    // If "from" itself was already an alias target of something else, update that too
    db.prepare(`UPDATE account_aliases SET alias = ? WHERE alias = ?`).run(to, from);
  })();

  res.json({ ok: true });
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
