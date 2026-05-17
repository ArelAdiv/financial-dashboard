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
['category TEXT', 'reference TEXT', 'notes TEXT', 'source_type TEXT', 'billing_date TEXT',
 'card_digits TEXT', 'status TEXT', 'pending_key TEXT'].forEach(col => {
  try { db.exec(`ALTER TABLE transactions ADD COLUMN ${col}`); } catch {}
});

// Back-fill status='pending' for existing CC rows where "בקליטה" appears in
// category (Cal) OR notes (Isracard stores it there).
try {
  db.exec(`UPDATE transactions SET status='pending'
           WHERE (status IS NULL OR status != 'pending')
             AND source_type IN ('cal_cc','isracard_cc','max_cc')
             AND (category LIKE '%בקליטה%' OR notes LIKE '%בקליטה%')`);
} catch {}

// Primary dedup: by (date, description, amount, account) — bank transactions (no billing_date)
// Rebuilt as partial index so CC installments with same tx-date but different billing months
// are not blocked. Drop old non-partial index first if it exists.
try { db.exec('DROP INDEX IF EXISTS idx_tx_dedup'); } catch {}
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_dedup
           ON transactions(date, description, amount, account)
           WHERE billing_date IS NULL`);
} catch {}

// CC installment dedup: billing_date distinguishes each installment of the same purchase
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_dedup_cc
           ON transactions(date, description, amount, account, billing_date)
           WHERE billing_date IS NOT NULL`);
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
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});
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

// ── Card billing reconciliation ───────────────────────────────────────────────
function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().substring(0, 10);
}

// Company name aliases used when searching bank statement descriptions
const CC_COMPANY_ALIASES = {
  'כאל':     ['כאל', 'cal', 'לאומי קארד'],
  'ישראכרט': ['ישראכרט', 'isracard'],
  'מקס':     ['מקס', 'max', 'לאומי קארד'],
};

function findActualDebit(card, billingDate) {
  if (!billingDate) return null;
  const dateFrom = shiftDate(billingDate, -5);
  const dateTo   = shiftDate(billingDate, +5);
  const CC_TYPES = `'cal_cc','isracard_cc','max_cc'`;

  // Primary: match by debit_reference — no account filter needed, reference is unique
  if (card.debit_reference) {
    const refLike = `%${card.debit_reference}%`;
    const row = db.prepare(`
      SELECT amount FROM transactions
      WHERE date BETWEEN ? AND ? AND amount < 0
        AND source_type NOT IN (${CC_TYPES})
        AND (reference LIKE ? OR LOWER(description) LIKE ?)
      ORDER BY ABS(JULIANDAY(date) - JULIANDAY(?)) LIMIT 1
    `).get(dateFrom, dateTo, refLike, refLike, billingDate);
    if (row) return Math.abs(row.amount);
  }

  // Fallback: keyword search in ALL bank accounts (no account filter)
  const keywords = [
    ...(CC_COMPANY_ALIASES[card.company] || [card.company].filter(Boolean)),
    card.digits,
  ].filter(Boolean);
  if (!keywords.length) return null;
  const conds  = keywords.map(() => 'LOWER(description) LIKE ?').join(' OR ');
  const values = keywords.map(k => `%${k.toLowerCase()}%`);
  const row = db.prepare(`
    SELECT amount FROM transactions
    WHERE date BETWEEN ? AND ? AND amount < 0
      AND source_type NOT IN (${CC_TYPES})
      AND (${conds})
    ORDER BY ABS(JULIANDAY(date) - JULIANDAY(?)) LIMIT 1
  `).get(dateFrom, dateTo, ...values, billingDate);
  if (row?.amount == null) return null;
  return Math.abs(row.amount);
}

function recalcReconciliation(profileData) {
  const cards = profileData?.creditCards || [];
  if (!cards.length) return {};
  const today = new Date();
  const todayStr   = today.toISOString().substring(0, 10);
  const todayDay   = today.getDate();
  const todayYear  = today.getFullYear();
  const todayMonth = today.getMonth() + 1;
  const pad = n => String(n).padStart(2, '0');
  const result = {};

  for (const card of cards) {
    const { digits, day: billingDay } = card;
    if (!digits || !billingDay) continue;

    // Next billing = first future occurrence; last billing = the one just before it
    let nextY, nextM, lastY, lastM;
    if (todayDay <= billingDay) {
      [nextY, nextM] = [todayYear, todayMonth];
      [lastY, lastM] = todayMonth === 1 ? [todayYear - 1, 12] : [todayYear, todayMonth - 1];
    } else {
      [nextY, nextM] = todayMonth === 12 ? [todayYear + 1, 1] : [todayYear, todayMonth + 1];
      [lastY, lastM] = [todayYear, todayMonth];
    }
    const nextBilling = `${nextY}-${pad(nextM)}-${pad(billingDay)}`;
    const lastBilling = `${lastY}-${pad(lastM)}-${pad(billingDay)}`;

    // Sum CC transactions for a given billing month.
    // Excludes "חיוב מיידי" (immediate bank debits handled separately, not via monthly billing).
    // Uses billing_date when available; falls back to transaction date for older imports.
    const calcExpected = (y, m) => {
      const lastDay = new Date(y, m, 0).getDate();
      const dateFrom = `${y}-${pad(m)}-01`;
      const dateTo   = `${y}-${pad(m)}-${pad(lastDay)}`;
      const row = db.prepare(`
        SELECT COALESCE(SUM(ABS(amount)),0) AS total FROM transactions
        WHERE card_digits=? AND (status='cleared' OR status='pending') AND amount < 0
          AND (notes IS NULL OR notes NOT LIKE '%חיוב מיידי%')
          AND (
            (billing_date IS NOT NULL AND billing_date BETWEEN ? AND ?)
            OR (billing_date IS NULL AND date BETWEEN ? AND ?)
          )
      `).get(digits, dateFrom, dateTo, dateFrom, dateTo);
      return row?.total || 0;
    };

    // If bank debit found for last billing → matched/mismatch
    const actual = findActualDebit(card, lastBilling);
    if (actual !== null) {
      const expected = calcExpected(lastY, lastM);
      const diff = Math.abs(actual - expected);
      result[digits] = { billing_date: lastBilling, expected, actual,
        status: diff <= 10 ? 'matched' : 'mismatch', diff };
    } else if (todayStr < nextBilling) {
      // No bank debit found yet → upcoming
      result[digits] = { billing_date: nextBilling, expected: calcExpected(nextY, nextM),
        actual: null, status: 'upcoming', diff: null };
    } else {
      // Billing date passed but no debit found → missing (show last billing info)
      result[digits] = { billing_date: lastBilling, expected: calcExpected(lastY, lastM),
        actual: null, status: 'missing', diff: null };
    }
  }
  return result;
}

// ── Insert helpers ────────────────────────────────────────────────────────────
const insertTx = db.prepare(`
  INSERT OR IGNORE INTO transactions
    (account, date, description, amount, balance, category, reference, notes, source_type, source_file, imported_at, billing_date, card_digits, status, pending_key)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

// Promote a pending row to cleared when a matching cleared tx arrives
const promotePending = db.prepare(`
  UPDATE transactions SET status='cleared', billing_date=?, imported_at=?
  WHERE pending_key=? AND status='pending' AND account=?
`);

const insertMany = db.transaction((rows) => {
  let inserted = 0, promoted = 0;
  const now = new Date().toISOString();
  for (const r of rows) {
    // Pending→cleared promotion: upgrade the existing pending row, skip insert
    if (r.pending_key && r.status === 'cleared') {
      const up = promotePending.run(r.billing_date ?? null, now, r.pending_key, r.account);
      if (up.changes > 0) { promoted++; continue; }
    }
    const info = insertTx.run(
      r.account, r.date, r.description, r.amount,
      r.balance ?? null, r.category ?? null, r.reference ?? null,
      r.notes ?? null, r.source_type ?? null,
      r.source ?? r.source_file ?? null,
      now,
      r.billing_date ?? null,
      r.card_digits ?? null,
      r.status   ?? 'cleared',
      r.pending_key ?? null
    );
    if (info.changes > 0) {
      inserted++;
    } else {
      console.log(`[insertMany] SKIPPED (duplicate): ${r.date} "${r.description}" ${r.amount} acct="${r.account}" ref="${r.reference}" bal=${r.balance}`);
    }
  }
  return { inserted, promoted };
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
  const cardDigitsHint = req.body.cardDigitsHint || null;
  const forceOverride  = req.body.forceOverride === '1';

  const detectedCardDigits = result.transactions[0]?.card_digits || null;
  const detectedAccount    = result.transactions[0]?.account || null;

  // If there's a card digits hint and no force override, check for conflict
  if (!forceOverride && cardDigitsHint && detectedCardDigits && cardDigitsHint !== detectedCardDigits) {
    return res.json({
      ok: true, conflict: true,
      detectedCardDigits, detectedAccount,
      filename: req.file.originalname,
      rows: result.transactions.length,
    });
  }

  // Apply card digits override if forced
  if (forceOverride && cardDigitsHint) {
    result.transactions = result.transactions.map(t => ({ ...t, card_digits: cardDigitsHint }));
  }

  const { inserted, promoted } = insertMany(result.transactions);

  // After a Max CC upload: recalculate pending totals per card and persist to profile
  if (result.sourceType === 'max_cc') {
    const pendingRows = db.prepare(`
      SELECT card_digits, COUNT(*) AS cnt, SUM(amount) AS total
      FROM transactions
      WHERE source_type='max_cc' AND status='pending' AND card_digits IS NOT NULL
      GROUP BY card_digits
    `).all();
    const profileData = loadProfile() || {};
    profileData.cards_pending = {};
    for (const row of pendingRows) {
      profileData.cards_pending[row.card_digits] = {
        total_pending: -row.total,            // amounts stored negative; display positive
        last_updated:  new Date().toISOString().substring(0, 10),
        count:         row.cnt
      };
    }
    profileData.updatedAt = new Date().toISOString();
    saveProfile(profileData);
  }

  // Auto-link CC card to profile when card digits are known
  if (result.sourceType === 'cal_cc') {
    const cardDigits  = result.transactions[0]?.card_digits;
    const rawLinkedAccount = result.transactions[0]?.linked_account;
    if (cardDigits) {
      const existing = loadProfile() || {};
      const cards = existing.creditCards || [];
      const card = cards.find(c => c.digits === cardDigits);
      if (card && rawLinkedAccount && !card.linked_account) {
        const knownAccounts = db.prepare(
          'SELECT DISTINCT account FROM transactions WHERE account IS NOT NULL'
        ).all().map(r => r.account);
        const matched = knownAccounts.find(a =>
          a.replace(/[^0-9]/g, '').includes(rawLinkedAccount)
        );
        if (matched) {
          card.linked_account = matched;
          existing.updatedAt = new Date().toISOString();
          saveProfile(existing);
        }
      }
    }
  }

  // Recalculate billing reconciliation after every CC upload
  if (['cal_cc', 'isracard_cc', 'max_cc'].includes(result.sourceType)) {
    const profileData = loadProfile() || {};
    profileData.card_reconciliation = recalcReconciliation(profileData);
    profileData.updatedAt = new Date().toISOString();
    saveProfile(profileData);
  }

  res.json({
    ok: true,
    filename:           req.file.originalname,
    rows:               result.transactions.length,
    inserted,
    promoted,
    duplicates:         result.transactions.length - inserted - promoted,
    sourceType:         result.sourceType,
    detectedAccount,
    detectedCardDigits,
    stats:              result.stats || null,
    preview:            result.transactions.slice(0, 5),
    warning:            result.warning || null
  });
});

// ── Reconciliation endpoint ───────────────────────────────────────────────────
app.get('/api/reconciliation', (req, res) => {
  const profileData = loadProfile() || {};
  const recon = recalcReconciliation(profileData);
  profileData.card_reconciliation = recon;
  profileData.updatedAt = new Date().toISOString();
  saveProfile(profileData);
  res.json(recon);
});

app.get('/api/reconciliation/:digits/history', (req, res) => {
  const { digits } = req.params;
  const profileData = loadProfile() || {};
  const card = (profileData.creditCards || []).find(c => c.digits === digits);
  if (!card) return res.status(404).json({ error: 'card not found' });

  // Get all distinct billing months for this card.
  // Excludes "חיוב מיידי" rows (not part of monthly CC billing).
  // Uses billing_date when set; falls back to transaction date for older imports.
  const billingMonths = db.prepare(`
    SELECT SUBSTR(COALESCE(billing_date, date), 1, 7) AS ym,
           COUNT(*) AS tx_count,
           COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS cc_total
    FROM transactions
    WHERE card_digits = ? AND (status = 'cleared' OR status = 'pending')
      AND (notes IS NULL OR notes NOT LIKE '%חיוב מיידי%')
    GROUP BY ym
    ORDER BY ym DESC
  `).all(digits);

  // For each billing month, determine billing date and find actual bank debit
  const pad = n => String(n).padStart(2, '0');
  const billingDay = card.day;

  const history = billingMonths.map(row => {
    const [y, m] = row.ym.split('-').map(Number);
    const billingDate = billingDay ? `${y}-${pad(m)}-${pad(billingDay)}` : null;
    const actual = billingDate ? findActualDebit(card, billingDate) : null;
    const diff = actual != null ? Math.abs(actual - row.cc_total) : null;
    const status = actual != null
      ? (diff <= 10 ? 'matched' : 'mismatch')
      : 'missing';
    return { ym: row.ym, billing_date: billingDate, cc_total: row.cc_total, actual, diff, status, tx_count: row.tx_count };
  });

  res.json({ card, history });
});

// Labels and source types for known profile keys
const PROFILE_KEY_META = {
  live_balances:    { source_type: 'poalim_daily_balances', label: 'DailyBalances.xlsx' },
  leumi_balances:   { source_type: 'leumi_balances',        label: 'לאומי — יתרות' },
  balance_snapshot: { source_type: 'poalim_balances',       label: 'דוח יתרות' },
  mortgage_details: { source_type: 'poalim_mortgage',       label: 'דוח משכנתא' },
};

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

  // Synthesize rows for profile data that exists in profile.json but has no
  // upload record (uploaded before the profile_uploads table was added).
  // Use the profile_key itself as the synthetic filename for the DELETE endpoint.
  const trackedKeys = new Set(profRows.map(r => r.profile_key));
  const prof = loadProfile() || {};
  for (const [key, meta] of Object.entries(PROFILE_KEY_META)) {
    if (prof[key] && !trackedKeys.has(key)) {
      profRows.push({
        source_file: key,          // synthetic filename — handled by DELETE
        account: null,
        source_type: meta.source_type,
        tx_count: 0,
        date_from: null,
        date_to: null,
        imported_at: prof[key]?.updated_at || prof.updatedAt || null,
        profile_key: key
      });
    }
  }

  const all = [...txRows, ...profRows]
    .sort((a, b) => (b.imported_at || '').localeCompare(a.imported_at || ''));
  res.json(all);
});

function deleteProfileKey(profileKey, sourceType) {
  const existing = loadProfile() || {};
  if (profileKey === 'balance_snapshot') {
    if (existing.balance_snapshot?.accounts) {
      existing.balance_snapshot.accounts = existing.balance_snapshot.accounts
        .filter(a => a.source !== sourceType);
      if (!existing.balance_snapshot.accounts.length) delete existing.balance_snapshot;
    }
  } else {
    delete existing[profileKey];
  }
  existing.updatedAt = new Date().toISOString();
  saveProfile(existing);
}

app.delete('/api/uploads/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);

  // Synthetic filename? (profile data that has no upload record — key used as filename)
  if (PROFILE_KEY_META[filename]) {
    deleteProfileKey(filename, PROFILE_KEY_META[filename].source_type);
    return res.json({ ok: true, deleted: 1, isProfile: true });
  }

  // Tracked profile upload?
  const profRow = db.prepare('SELECT * FROM profile_uploads WHERE filename = ?').get(filename);
  if (profRow) {
    db.prepare('DELETE FROM profile_uploads WHERE filename = ?').run(filename);
    deleteProfileKey(profRow.profile_key, profRow.source_type);
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

  try { db.transaction(() => {
    // When merging into an existing account, duplicate rows (same date+description+amount)
    // must be removed first to avoid unique-index violations.
    db.prepare(`
      DELETE FROM transactions
      WHERE account = ?
        AND rowid IN (
          SELECT t1.rowid FROM transactions t1
          WHERE t1.account = ?
            AND EXISTS (
              SELECT 1 FROM transactions t2
              WHERE t2.account = ?
                AND t2.date        = t1.date
                AND t2.description = t1.description
                AND t2.amount      = t1.amount
            )
        )
    `).run(from, from, to);

    db.prepare('UPDATE transactions SET account = ? WHERE account = ?').run(to, from);
    upsertAlias.run(from, to, new Date().toISOString());
    db.prepare(`UPDATE account_aliases SET alias = ? WHERE alias = ?`).run(to, from);
  })(); } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  res.json({ ok: true });
});

app.get('/api/transactions', (req, res) => {
  const account = req.query.account;
  const limit   = parseInt(req.query.limit) || 2000;
  // Sort by date DESC, then balance ASC (lowest balance = most debits applied = latest
  // intra-day state), then id DESC as a tiebreaker.  This produces correct ordering
  // even when a bank file (e.g. Leumi) stores rows newest-first so insertion id is
  // the inverse of chronological order within the same date.
  const rows = account
    ? db.prepare('SELECT * FROM transactions WHERE account = ? ORDER BY date DESC, balance ASC, id DESC LIMIT ?').all(account, limit)
    : db.prepare('SELECT * FROM transactions ORDER BY date DESC, balance ASC, id DESC LIMIT ?').all(limit);
  res.json(rows);
});

app.delete('/api/transactions', (req, res) => {
  const account = req.query.account;
  if (account) db.prepare('DELETE FROM transactions WHERE account = ?').run(account);
  else         db.prepare('DELETE FROM transactions').run();
  res.json({ ok: true });
});

app.post('/api/categories', (req, res) => {
  const { description, category } = req.body;
  if (!description) return res.status(400).json({ error: 'missing description' });
  const info = db.prepare('UPDATE transactions SET category = ? WHERE description = ?')
    .run(category || null, description);
  res.json({ ok: true, updated: info.changes });
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
