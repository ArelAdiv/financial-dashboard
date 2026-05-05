'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parse/sync');

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'profile.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DB_DIR = path.join(__dirname, 'db');
const DB_FILE = path.join(DB_DIR, 'transactions.sqlite');

[DATA_DIR, UPLOADS_DIR, DB_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

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
    source_file TEXT,
    imported_at TEXT
  )
`);

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

function loadProfile() {
  if (!fs.existsSync(DATA_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return null; }
}

function saveProfile(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const DATE_HEADERS = ['תאריך', 'date'];
const DESC_HEADERS = ['תיאור', 'פירוט', 'description', 'name'];
const AMOUNT_HEADERS = ['סכום', 'חיוב', 'זיכוי', 'amount', 'credit', 'debit'];
const BALANCE_HEADERS = ['יתרה', 'balance'];

function detectColumns(headers) {
  const lower = headers.map(h => (h || '').toLowerCase().trim());
  const find = (opts) => {
    const idx = lower.findIndex(h => opts.some(o => h.includes(o.toLowerCase())));
    return idx >= 0 ? idx : null;
  };
  return {
    date: find(DATE_HEADERS),
    description: find(DESC_HEADERS),
    amount: find(AMOUNT_HEADERS),
    balance: find(BALANCE_HEADERS)
  };
}

function parseNum(s) {
  return parseFloat((s || '').toString().replace(/[^\d.-]/g, '')) || 0;
}

function rowToTransaction(row, cols, account, sourceFile) {
  const get = (col, fallback) => col !== null ? (row[col] || '') : (row[fallback] || '');
  return {
    account,
    date: get(cols.date, 0),
    description: get(cols.description, 1) || (row[2] || ''),
    amount: parseNum(get(cols.amount, 2)),
    balance: parseNum(get(cols.balance, 3)),
    source_file: sourceFile,
    imported_at: new Date().toISOString()
  };
}

const insertTx = db.prepare(
  'INSERT INTO transactions (account, date, description, amount, balance, source_file, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const insertMany = db.transaction((rows) => {
  for (const r of rows) insertTx.run(r.account, r.date, r.description, r.amount, r.balance, r.source_file, r.imported_at);
});

app.get('/api/profile', (req, res) => {
  const p = loadProfile();
  res.json(p || { exists: false });
});

app.post('/api/profile', (req, res) => {
  const existing = loadProfile() || {};
  const updated = { ...existing, ...req.body, updatedAt: new Date().toISOString() };
  saveProfile(updated);
  res.json({ ok: true });
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const filePath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();
  const accountName = req.body.accountName || req.file.originalname;
  let parsed = [];
  let warning = null;

  try {
    if (ext === '.csv' || ext === '.txt') {
      const raw = fs.readFileSync(filePath);
      let content = raw.toString('utf8');
      if (content.includes('�')) content = raw.toString('latin1');
      const records = csv.parse(content, { skip_empty_lines: true, relax_column_count: true, bom: true });
      if (records.length > 1) {
        const cols = detectColumns(records[0].map(String));
        parsed = records.slice(1)
          .map(row => rowToTransaction(row, cols, accountName, req.file.originalname))
          .filter(r => r.description || r.amount);
      }
    } else if (ext === '.xlsx' || ext === '.xls') {
      const xlsx = require('xlsx');
      const wb = xlsx.readFile(filePath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const records = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (records.length > 1) {
        const cols = detectColumns(records[0].map(String));
        parsed = records.slice(1)
          .map(row => rowToTransaction(row, cols, accountName, req.file.originalname))
          .filter(r => r.description || r.amount);
      }
    } else if (ext === '.pdf') {
      try {
        const pdfParse = require('pdf-parse');
        const pdfData = await pdfParse(fs.readFileSync(filePath));
        const lines = pdfData.text.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 2) {
          warning = 'PDF זה עובד רק על קבצים דיגיטליים (לא סרוקים). אם הנתונים לא נוצרו כראוי, נסה לייצא כ-CSV מהאתר.';
        } else {
          parsed = lines.slice(1).map(line => {
            const parts = line.split(/\s{2,}|\t/);
            return {
              account: accountName,
              date: parts[0] || '',
              description: parts[1] || line,
              amount: parseNum(parts[2] || '0'),
              balance: parseNum(parts[3] || '0'),
              source_file: req.file.originalname,
              imported_at: new Date().toISOString()
            };
          }).filter(r => r.description || r.amount);
          if (!parsed.length) {
            warning = 'PDF זה עובד רק על קבצים דיגיטליים (לא סרוקים). אם הנתונים לא נוצרו כראוי, נסה לייצא כ-CSV מהאתר.';
          }
        }
      } catch {
        warning = 'PDF זה עובד רק על קבצים דיגיטליים (לא סרוקים). אם הנתונים לא נוצרו כראוי, נסה לייצא כ-CSV מהאתר.';
      }
    }
  } catch (e) {
    console.error('Parse error:', e.message);
  }

  insertMany(parsed);
  res.json({ ok: true, filename: req.file.originalname, rows: parsed.length, preview: parsed.slice(0, 5), warning });
});

app.get('/api/transactions', (req, res) => {
  const account = req.query.account;
  const limit = parseInt(req.query.limit) || 2000;
  const rows = account
    ? db.prepare('SELECT * FROM transactions WHERE account = ? ORDER BY id DESC LIMIT ?').all(account, limit)
    : db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT ?').all(limit);
  res.json(rows);
});

app.delete('/api/transactions', (req, res) => {
  const account = req.query.account;
  if (account) {
    db.prepare('DELETE FROM transactions WHERE account = ?').run(account);
  } else {
    db.prepare('DELETE FROM transactions').run();
  }
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
