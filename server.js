const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parse/sync');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data', 'profile.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

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

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const filePath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();
  let parsed = [];

  if (ext === '.csv' || ext === '.txt') {
    try {
      const raw = fs.readFileSync(filePath);
      let content = '';
      try { content = raw.toString('utf8'); } catch { content = raw.toString('latin1'); }
      if (content.includes('?') && content.length < raw.length * 0.9) {
        content = raw.toString('latin1');
      }
      const records = csv.parse(content, { skip_empty_lines: true, relax_column_count: true, bom: true });
      parsed = records.slice(1).map(row => ({
        date: row[0] || '',
        description: row[1] || row[2] || '',
        amount: parseFloat((row[2] || row[3] || '0').toString().replace(/[^\d.-]/g, '')) || 0,
        balance: parseFloat((row[3] || row[4] || '0').toString().replace(/[^\d.-]/g, '')) || 0,
        raw: row
      })).filter(r => r.description || r.amount);
    } catch (e) {
      console.error('CSV parse error:', e.message);
    }
  }

  const profile = loadProfile() || {};
  if (!profile.transactions) profile.transactions = [];
  const accountName = req.body.accountName || req.file.originalname;
  parsed.forEach(t => profile.transactions.push({ ...t, account: accountName, importedAt: new Date().toISOString() }));
  saveProfile(profile);

  res.json({ ok: true, filename: req.file.originalname, rows: parsed.length, preview: parsed.slice(0, 5) });
});

app.get('/api/transactions', (req, res) => {
  const p = loadProfile();
  res.json(p?.transactions || []);
});

app.delete('/api/transactions', (req, res) => {
  const p = loadProfile() || {};
  const account = req.query.account;
  if (account) {
    p.transactions = (p.transactions || []).filter(t => t.account !== account);
  } else {
    p.transactions = [];
  }
  saveProfile(p);
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
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 2048,
        system: systemContext,
        messages
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ הדשבורד הפיננסי פעיל!`);
  console.log(`🌐 פתח בדפדפן: http://localhost:${PORT}\n`);
});
