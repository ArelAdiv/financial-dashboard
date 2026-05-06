'use strict';

const fs   = require('fs');
const path = require('path');
const xlsx = require('xlsx');

// ── Utilities ─────────────────────────────────────────────────────────────────

function parseNum(s) {
  if (s === null || s === undefined || s === '') return null;
  const raw = s.toString().trim();
  if (!raw) return null;
  const inParens = /^\(([^)]+)\)$/.test(raw);
  const cleaned = raw
    .replace(/^\(([^)]+)\)$/, '$1')
    .replace(/,/g, '')
    .replace(/\s/g, '')
    .replace(/−/g, '-')
    .replace(/[^\d.-]/g, '');
  const n = parseFloat(cleaned);
  if (isNaN(n)) return null;
  return inParens ? -Math.abs(n) : n;
}

function normalizeDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    return raw.toISOString().substring(0, 10);
  }
  if (typeof raw === 'number') {
    try {
      const d = xlsx.SSF.parse_date_code(raw);
      if (d && d.y > 1900)
        return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
    } catch {}
    return null;
  }
  const s = raw.toString().trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})$/);
  if (m) return `20${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return null;
}

function isSummaryRow(row) {
  return row.some(c => {
    const s = (c ?? '').toString().trim();
    return s === 'סה"כ' || s === 'סה״כ' || s === 'סך הכל' ||
           s.startsWith('סה"כ') || s.startsWith('סה״כ') || s.startsWith('סך הכל');
  });
}

function isHtmlFile(filePath) {
  try {
    const buf = Buffer.alloc(20);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, 20, 0);
    fs.closeSync(fd);
    // Skip UTF-8 BOM (EF BB BF) or UTF-16 BOM if present
    let offset = 0;
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) offset = 3;
    else if (buf[0] === 0xFF && buf[1] === 0xFE) offset = 2;
    else if (buf[0] === 0xFE && buf[1] === 0xFF) offset = 2;
    const sig = buf.slice(offset, offset + 10).toString('latin1').toLowerCase().trimStart();
    return sig.startsWith('<html') || sig.startsWith('<!doc');
  } catch { return false; }
}

function readExcelRows(filePath) {
  const wb = xlsx.readFile(filePath, { cellDates: false, raw: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
}

function str(v) { return (v ?? '').toString().trim(); }

// ── Shared: dynamic header + column detection ─────────────────────────────────
//
// findHeader(rows, requiredKeywords, maxScan)
//   Scans up to maxScan rows for the first row whose joined text contains
//   ALL of the requiredKeywords.  Returns row index or -1.
//
// colIdx(headers, keywords, fallback)
//   Returns the index of the first header cell that contains any keyword,
//   or fallback if none found.

function findHeader(rows, requiredKeywords, maxScan = 15) {
  for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
    const line = rows[i].map(c => str(c)).join(' ');
    if (requiredKeywords.every(kw => line.includes(kw))) return i;
  }
  return -1;
}

function colIdx(headers, keywords, fallback = -1) {
  const i = headers.findIndex(h => keywords.some(k => str(h).includes(k)));
  return i >= 0 ? i : fallback;
}

// ── Account ID extraction ─────────────────────────────────────────────────────
//
// Each extractor returns a short stable identifier (account/card number)
// that uniquely identifies the financial account in the file.
// If found, it is used as the `account` field so uploads from the same
// account always group together regardless of user-provided name.

function extractPoalimAccountId(rows) {
  // Header rows contain: "מספר חשבון 12-766-71350"
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const line = rows[i].map(c => str(c)).join(' ');
    const m = line.match(/מספר חשבון[:\s]*([\d\-]+)/);
    if (m) return `פועלים ${m[1].trim()}`;
  }
  return null;
}

function extractLeumiAccountId(html) {
  // HTML header contains: "מספר חשבון: 123456789" or similar
  const m = html.match(/מספר חשבון[:\s]*([\d\-]+)/);
  if (m) return `לאומי ${m[1].trim()}`;
  return null;
}

function extractIsracardId(rows) {
  // Header rows contain: "4 ספרות אחרונות של הכרטיס: 1234" or card number
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const line = rows[i].map(c => str(c)).join(' ');
    let m = line.match(/\*+(\d{4})/);
    if (m) return `ישראכרט *${m[1]}`;
    m = line.match(/ספרות אחרונות[:\s]*(\d{4})/);
    if (m) return `ישראכרט *${m[1]}`;
    m = line.match(/כרטיס[:\s]+(\d{8,19})/);
    if (m) return `ישראכרט ${m[1].slice(-4).padStart(m[1].length, '*')}`;
  }
  return null;
}

function extractMaxId(rows) {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const line = rows[i].map(c => str(c)).join(' ');
    let m = line.match(/\*+(\d{4})/);
    if (m) return `מקס *${m[1]}`;
    m = line.match(/ספרות אחרונות[:\s]*(\d{4})/);
    if (m) return `מקס *${m[1]}`;
  }
  return null;
}

function extractCalId(rows) {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const line = rows[i].map(c => str(c)).join(' ');
    let m = line.match(/\*+(\d{4})/);
    if (m) return `כאל *${m[1]}`;
    m = line.match(/ספרות אחרונות[:\s]*(\d{4})/);
    if (m) return `כאל *${m[1]}`;
  }
  return null;
}

// Resolves the final account label:
// - Detected account ID takes priority as the unique identifier
// - User-provided name is appended in parentheses for readability
// - Falls back to user-provided name, then sourceFile
function resolveAccount(detected, userProvided, sourceFile) {
  if (detected) {
    return userProvided && userProvided !== sourceFile
      ? `${userProvided} (${detected})`
      : detected;
  }
  return userProvided || sourceFile;
}

// ── File-type detection ───────────────────────────────────────────────────────

function detectFileType(filePath, rows) {
  const ext = path.extname(filePath).toLowerCase();

  if ((ext === '.xls' || ext === '.xlsx') && isHtmlFile(filePath)) {
    try {
      const html = readLeumiHtml(filePath);
      if (html.includes('תנועות בחשבון')) return 'leumi_transactions';
      if (html.includes('פירוט יתרות'))   return 'leumi_balances';
      return 'leumi_transactions';
    } catch { return 'leumi_transactions'; }
  }

  for (const row of rows.slice(0, 8)) {
    const line = row.map(c => str(c)).join(' ');
    if (line.includes('תנועות בחשבון'))              return 'poalim_transactions';
    if (line.includes('ריכוז יתרות'))                return 'poalim_balances';
    if (line.includes('משכנתאות'))                   return 'poalim_mortgage';
    if (line.includes('פירוט עסקאות') &&
        line.includes('מסטרקארד'))                   return 'isracard_cc';
    if (line.includes('כל המשתמשים') ||
        (line.includes('קטגוריה') && rows.slice(0,5)
          .some(r => r.map(str).join(' ').includes('כרטיס')))) return 'max_cc';
    if (line.includes('פירוט עסקאות לחשבון לאומי') ||
        (line.toLowerCase().includes('cal') &&
         line.includes('חשבון')))                    return 'cal_cc';
  }

  return 'generic';
}

// ── Generic fallback ──────────────────────────────────────────────────────────

const DATE_HDRS    = ['תאריך', 'date'];
const DESC_HDRS    = ['תיאור פעולה', 'תיאור', 'פירוט', 'פרטים', 'description', 'name', 'פעולה'];
const AMOUNT_HDRS  = ['סכום', 'amount'];
const DEBIT_HDRS   = ['חובה'];
const CREDIT_HDRS  = ['זיכוי', 'זכות'];
const BALANCE_HDRS = ['יתרה', 'balance'];
const ALL_HDRS     = [...DATE_HDRS, ...DESC_HDRS, ...AMOUNT_HDRS, ...DEBIT_HDRS, ...CREDIT_HDRS, ...BALANCE_HDRS];

function parseGeneric(rows, accountName, sourceFile) {
  if (rows.length < 2) return txResult([], 'generic', { found: 0, imported: 0, skipped: 0 });

  // Find header row
  let hi = 0;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = rows[i].map(c => str(c).toLowerCase());
    if (cells.filter(c => ALL_HDRS.some(k => c.includes(k.toLowerCase()))).length >= 2) { hi = i; break; }
  }

  const hdrs = rows[hi].map(String);
  const dc = {
    date:    colIdx(hdrs, DATE_HDRS, 0),
    desc:    colIdx(hdrs, DESC_HDRS, 1),
    amount:  colIdx(hdrs, AMOUNT_HDRS, -1),
    debit:   colIdx(hdrs, DEBIT_HDRS, -1),
    credit:  colIdx(hdrs, CREDIT_HDRS, -1),
    balance: colIdx(hdrs, BALANCE_HDRS, -1)
  };

  let found = 0, skipped = 0;
  const transactions = [];

  for (const row of rows.slice(hi + 1)) {
    found++;
    const date = normalizeDate(row[dc.date]);
    if (!date) { skipped++; continue; }
    if (isSummaryRow(row)) { skipped++; continue; }

    let amount = 0;
    if (dc.debit >= 0 || dc.credit >= 0) {
      const credit = dc.credit >= 0 ? parseNum(row[dc.credit]) ?? 0 : 0;
      const debit  = dc.debit  >= 0 ? parseNum(row[dc.debit])  ?? 0 : 0;
      amount = credit - debit;
    } else {
      amount = parseNum(dc.amount >= 0 ? row[dc.amount] : row[2]) ?? 0;
    }

    const desc = str(dc.desc >= 0 ? row[dc.desc] : row[1]) || str(row[2]);
    if (!desc && amount === 0) { skipped++; continue; }

    transactions.push({
      date, description: desc, amount,
      balance:     dc.balance >= 0 ? parseNum(row[dc.balance]) : null,
      category: null, reference: null, notes: null,
      account: accountName, source: sourceFile, source_type: 'generic'
    });
  }

  console.log(`[generic] headerIdx=${hi} found=${found} imported=${transactions.length} skipped=${skipped}`);
  return txResult(transactions, 'generic', { found, imported: transactions.length, skipped });
}

// ── Poalim: Transactions ──────────────────────────────────────────────────────
function parsePoalimTransactions(rows, accountName, sourceFile) {
  const account = resolveAccount(extractPoalimAccountId(rows), accountName, sourceFile);
  const hi = findHeader(rows, ['חובה'], 10);
  if (hi < 0) {
    console.log('[poalim_tx] header not found, falling back to generic');
    return parseGeneric(rows, account, sourceFile);
  }

  const hdrs = rows[hi].map(c => str(c));
  const dc = {
    date:    colIdx(hdrs, ['תאריך'], 0),
    desc:    colIdx(hdrs, ['פעולה', 'תיאור'], 1),
    detail:  colIdx(hdrs, ['פרטים'], 2),
    ref:     colIdx(hdrs, ['אסמכתא'], 3),
    debit:   colIdx(hdrs, ['חובה'], 4),
    credit:  colIdx(hdrs, ['זכות', 'זיכוי'], 5),
    balance: colIdx(hdrs, ['יתרה'], 6)
  };
  console.log(`[poalim_tx] headerIdx=${hi} cols:`, dc);

  let found = 0, skipped = 0;
  const transactions = [];

  for (const row of rows.slice(hi + 1)) {
    found++;
    const date = normalizeDate(row[dc.date]);
    if (!date) { skipped++; continue; }
    if (isSummaryRow(row)) { skipped++; continue; }

    const debit  = parseNum(row[dc.debit]);
    const credit = parseNum(row[dc.credit]);
    if ((debit === null || debit === 0) && (credit === null || credit === 0)) { skipped++; continue; }

    const amount = (credit !== null && credit !== 0) ? Math.abs(credit) : -Math.abs(debit ?? 0);
    const noteParts = [str(row[dc.detail]), str(row[8]), str(row[9])].filter(Boolean);

    transactions.push({
      date, description: str(row[dc.desc]), amount,
      balance:   parseNum(row[dc.balance]),
      category:  null,
      reference: str(row[dc.ref]) || null,
      notes:     noteParts.join(' | ') || null,
      account:   account, source: sourceFile, source_type: 'poalim_transactions'
    });
  }

  console.log(`[poalim_transactions] found=${found} imported=${transactions.length} skipped=${skipped}`);
  return txResult(transactions, 'poalim_transactions', { found, imported: transactions.length, skipped });
}

// ── Poalim: Balances ──────────────────────────────────────────────────────────
function parsePoalimBalances(rows, accountName, sourceFile) {
  let checking_balance = null, credit_line = null, investments_total = null, report_date = null;

  const row3text = (rows[3] ?? []).map(str).join(' ');
  const dm = row3text.match(/(\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4})/);
  if (dm) report_date = normalizeDate(dm[1]);

  for (let i = 4; i < Math.min(rows.length, 20); i++) {
    const line = rows[i].map(str).join(' ');
    if (line.includes('עו"ש') || line.includes('עוש')) {
      credit_line      = parseNum(rows[i][2]);
      checking_balance = parseNum(rows[i][3]);
      break;
    }
  }

  let inInv = false;
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i].map(str).join(' ');
    if (line.includes('השקעות')) { inInv = true; continue; }
    if (inInv && isSummaryRow(rows[i])) {
      investments_total = parseNum(rows[i][3]);
      break;
    }
  }

  const profileData = { checking_balance, credit_line, investments_total, report_date };
  console.log(`[poalim_balances] extracted:`, profileData);
  return { type: 'profile_data', profileKey: 'balances', profileData, sourceType: 'poalim_balances' };
}

// ── Poalim: Mortgage ──────────────────────────────────────────────────────────
function parsePoalimMortgage(rows, accountName, sourceFile) {
  const hi = findHeader(rows, ['מסלול', 'יתרה'], 10);
  const startIdx = hi >= 0 ? hi + 1 : 5;
  const loans = [];

  for (const row of rows.slice(startIdx)) {
    const loanId = str(row[0]);
    if (!loanId || loanId.length < 6) continue;
    if (isSummaryRow(row)) continue;
    loans.push({
      loan_id:    loanId,
      index_type: str(row[1]),
      rate_type:  str(row[2]),
      start_date: normalizeDate(row[3]),
      end_date:   normalizeDate(row[4]),
      balance:    parseNum(row[5])
    });
  }

  console.log(`[poalim_mortgage] found ${loans.length} loans`);
  return { type: 'profile_data', profileKey: 'mortgage_details', profileData: { loans }, sourceType: 'poalim_mortgage' };
}

// ── Leumi: Transactions (HTML-based XLS) ──────────────────────────────────────
// Parses HTML into separate tables (array of arrays of rows).
// This lets us pick the transaction table instead of a navigation/header table.
function parseHtmlTables(html) {
  const decodeEntities = s => s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  const stripTags = s => s.replace(/<[^>]+>/g, '');

  const tables = [];
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  const trRe    = /<tr[\s\S]*?<\/tr>/gi;
  const cellRe  = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

  let tbl;
  while ((tbl = tableRe.exec(html)) !== null) {
    const rows = [];
    const trMatch = new RegExp(trRe.source, 'gi');
    let tr;
    while ((tr = trMatch.exec(tbl[0])) !== null) {
      const cells = [];
      const cr = new RegExp(cellRe.source, 'gi');
      let m;
      while ((m = cr.exec(tr[0])) !== null) {
        cells.push(decodeEntities(stripTags(m[1])).trim());
      }
      if (cells.some(c => c)) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

// Pick the table whose rows contain all of the given keywords (joined).
function findTableWithKeywords(tables, keywords) {
  for (const table of tables) {
    const joined = table.map(r => r.join(' ')).join(' ');
    if (keywords.every(kw => joined.includes(kw))) return table;
  }
  // Fallback: largest table
  return tables.reduce((best, t) => t.length > best.length ? t : best, []);
}

function readLeumiHtml(filePath) {
  const raw = fs.readFileSync(filePath);
  // Check for BOM and strip it
  let offset = 0;
  if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) offset = 3;

  // Try UTF-8 first; fall back to Windows-1255 (latin1 approximation) only if
  // the decoded text contains the Unicode replacement character U+FFFD
  const utf8 = raw.slice(offset).toString('utf8');
  if (!utf8.includes('�')) return utf8;

  // File is not valid UTF-8 — re-read as latin1 (covers Windows-1255 for Hebrew)
  return raw.slice(offset).toString('latin1');
}

function parseLeumiTransactions(filePath, accountName, sourceFile) {
  const html = readLeumiHtml(filePath);
  const account = resolveAccount(extractLeumiAccountId(html), accountName, sourceFile);

  // ── Method 1: per-table HTML regex — pick the table with תאריך ──────────
  let rows = [];
  const tables = parseHtmlTables(html);
  console.log(`[leumi_tx] html tables found: ${tables.length}, sizes: ${tables.map(t => t.length).join(', ')}`);

  const txTable = findTableWithKeywords(tables, ['תאריך']);
  if (txTable.length >= 2) {
    rows = txTable;
    console.log(`[leumi_tx] method=html-table rows=${rows.length} first=${JSON.stringify(rows[0])}`);
  }

  // ── Method 2: xlsx.readFile — pick sheet containing תאריך ────────────────
  if (rows.length < 3) {
    try {
      const wb = xlsx.readFile(filePath, { cellDates: false, raw: false });
      for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        const r = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
        const joined = r.map(row => row.join(' ')).join(' ');
        if (joined.includes('תאריך') && r.length > rows.length) rows = r;
      }
      console.log(`[leumi_tx] method=xlsx.readFile rows=${rows.length}`);
    } catch (e) {
      console.log('[leumi_tx] xlsx.readFile failed:', e.message);
    }
  }

  console.log(`[leumi_tx] final rows=${rows.length}`);

  // Dynamic header + column detection (same pattern as all other parsers)
  const hi = findHeader(rows, ['תאריך'], 20);
  if (hi < 0) {
    console.log('[leumi_tx] header row not found');
    return txResult([], 'leumi_transactions', { found: 0, imported: 0, skipped: 0 });
  }

  const hdrs = rows[hi].map(c => str(c));
  console.log(`[leumi_tx] headerIdx=${hi} cols:`, hdrs);

  const ci = (keywords, def) => {
    const i = hdrs.findIndex(h => keywords.some(k => h.includes(k)));
    return i >= 0 ? i : def;
  };
  const dc = {
    date:    ci(['תאריך'], 0),
    desc:    ci(['תיאור', 'תאור', 'פרטים', 'פעולה'], 1),
    ref:     ci(['אסמכתא', 'מסמך'], -1),
    debit:   ci(['חובה', 'חיוב'], -1),
    credit:  ci(['זכות', 'זיכוי'], -1),
    balance: ci(['יתרה'], -1)
  };

  let found = 0, skipped = 0;
  const transactions = [];

  for (const row of rows.slice(hi + 1)) {
    found++;
    const date = normalizeDate(row[dc.date]);
    if (!date) { skipped++; continue; }
    if (isSummaryRow(row)) { skipped++; continue; }

    const credit = dc.credit >= 0 ? parseNum(row[dc.credit]) : null;
    const debit  = dc.debit  >= 0 ? parseNum(row[dc.debit])  : null;

    let amount = 0;
    if (credit !== null && credit !== 0)     amount =  Math.abs(credit);
    else if (debit !== null && debit !== 0)  amount = -Math.abs(debit);
    else { skipped++; continue; }

    transactions.push({
      date,
      description: str(row[dc.desc]),
      amount,
      balance:   dc.balance >= 0 ? parseNum(row[dc.balance]) : null,
      category:  null,
      reference: dc.ref >= 0 ? str(row[dc.ref]) || null : null,
      notes:     null,
      account:   account, source: sourceFile, source_type: 'leumi_transactions'
    });
  }

  console.log(`[leumi_transactions] found=${found} imported=${transactions.length} skipped=${skipped}`);
  return txResult(transactions, 'leumi_transactions', { found, imported: transactions.length, skipped });
}

// ── Leumi: Balances (HTML-based XLS) ─────────────────────────────────────────
function parseLeumiBalances(filePath, accountName, sourceFile) {
  let rows;
  try {
    rows = readExcelRows(filePath);
  } catch (e) {
    const html = readLeumiHtml(filePath);
    try {
      const wb = xlsx.read(html, { type: 'string' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    } catch { rows = []; }
  }

  let checking_balance = null, report_date = null;

  for (const row of rows) {
    const line = row.map(c => str(c)).join(' ');
    if (line.includes('עו"ש') || line.includes('עוש')) {
      for (const cell of row) {
        const n = parseNum(cell);
        if (n !== null && n !== 0) { checking_balance = n; break; }
      }
      if (checking_balance !== null) break;
    }
  }

  console.log(`[leumi_balances] checking_balance=${checking_balance}`);
  return { type: 'profile_data', profileKey: 'balances', profileData: { checking_balance, report_date }, sourceType: 'leumi_balances' };
}

// ── Isracard ──────────────────────────────────────────────────────────────────
function parseIsracard(rows, accountName, sourceFile) {
  const account = resolveAccount(extractIsracardId(rows), accountName, sourceFile);
  const hi = findHeader(rows, ['תאריך', 'בית עסק'], 15);
  if (hi < 0) {
    console.log('[isracard] header not found, falling back to generic');
    return parseGeneric(rows, accountName, sourceFile);
  }

  const hdrs = rows[hi].map(c => str(c));
  const dc = {
    date:   colIdx(hdrs, ['תאריך עסקה', 'תאריך'], 0),
    desc:   colIdx(hdrs, ['שם בית עסק', 'בית עסק', 'תיאור'], 1),
    amount: colIdx(hdrs, ['סכום חיוב', 'סכום'], 4),
    ref:    colIdx(hdrs, ['אסמכתא'], 6),
    notes:  colIdx(hdrs, ['הערות', 'פרטים'], 7)
  };
  console.log(`[isracard] headerIdx=${hi} cols:`, dc);

  let found = 0, skipped = 0;
  const transactions = [];

  for (const row of rows.slice(hi + 1)) {
    found++;
    const date = normalizeDate(row[dc.date]);
    if (!date) { skipped++; continue; }
    if (isSummaryRow(row)) { skipped++; continue; }

    const amountRaw = parseNum(row[dc.amount]);
    if (amountRaw === null) { skipped++; continue; }

    transactions.push({
      date, description: str(row[dc.desc]),
      amount:    -Math.abs(amountRaw),
      balance:   null,
      category:  null,
      reference: dc.ref >= 0 ? str(row[dc.ref]) || null : null,
      notes:     dc.notes >= 0 ? str(row[dc.notes]) || null : null,
      account:   account, source: sourceFile, source_type: 'isracard_cc'
    });
  }

  console.log(`[isracard_cc] found=${found} imported=${transactions.length} skipped=${skipped}`);
  return txResult(transactions, 'isracard_cc', { found, imported: transactions.length, skipped });
}

// ── Max ───────────────────────────────────────────────────────────────────────
function parseMax(rows, accountName, sourceFile) {
  const account = resolveAccount(extractMaxId(rows), accountName, sourceFile);
  const hi = findHeader(rows, ['תאריך', 'סכום'], 15);
  if (hi < 0) {
    console.log('[max] header not found, falling back to generic');
    return parseGeneric(rows, account, sourceFile);
  }

  const hdrs = rows[hi].map(c => str(c));
  const dc = {
    date:     colIdx(hdrs, ['תאריך עסקה', 'תאריך'], 0),
    desc:     colIdx(hdrs, ['שם בית עסק', 'בית עסק', 'תיאור'], 1),
    category: colIdx(hdrs, ['קטגוריה'], 2),
    amount:   colIdx(hdrs, ['סכום חיוב', 'סכום'], 5),
    notes1:   colIdx(hdrs, ['פרטים', 'הערות'], -1),
    notes2:   colIdx(hdrs, ['מטבע עסקה'], -1)
  };
  console.log(`[max] headerIdx=${hi} cols:`, dc);

  let found = 0, skipped = 0;
  const transactions = [];

  for (const row of rows.slice(hi + 1)) {
    found++;
    if (isSummaryRow(row)) { skipped++; continue; }
    const date = normalizeDate(row[dc.date]);
    if (!date) { skipped++; continue; }

    const amountRaw = parseNum(row[dc.amount]);
    if (amountRaw === null || amountRaw === 0) { skipped++; continue; }

    const noteParts = [
      dc.notes1 >= 0 ? str(row[dc.notes1]) : '',
      dc.notes2 >= 0 ? str(row[dc.notes2]) : ''
    ].filter(Boolean);

    transactions.push({
      date, description: str(row[dc.desc]),
      amount:    -Math.abs(amountRaw),
      balance:   null,
      category:  dc.category >= 0 ? str(row[dc.category]) || null : null,
      reference: null,
      notes:     noteParts.join(' | ') || null,
      account:   account, source: sourceFile, source_type: 'max_cc'
    });
  }

  console.log(`[max_cc] found=${found} imported=${transactions.length} skipped=${skipped}`);
  return txResult(transactions, 'max_cc', { found, imported: transactions.length, skipped });
}

// ── Cal ───────────────────────────────────────────────────────────────────────
function parseCal(rows, accountName, sourceFile) {
  const account = resolveAccount(extractCalId(rows), accountName, sourceFile);
  const hi = findHeader(rows, ['תאריך', 'סכום'], 15);
  if (hi < 0) {
    console.log('[cal] header not found, falling back to generic');
    return parseGeneric(rows, account, sourceFile);
  }

  const hdrs = rows[hi].map(c => str(c));
  const dc = {
    date:     colIdx(hdrs, ['תאריך עסקה', 'תאריך'], 0),
    desc:     colIdx(hdrs, ['שם בית עסק', 'בית עסק', 'תיאור'], 1),
    amount:   colIdx(hdrs, ['סכום חיוב', 'סכום בש"ח', 'סכום'], 3),
    category: colIdx(hdrs, ['ענף', 'קטגוריה'], 5),
    notes:    colIdx(hdrs, ['פרטים', 'הערות'], -1)
  };
  console.log(`[cal] headerIdx=${hi} cols:`, dc);

  let found = 0, skipped = 0;
  const transactions = [];

  for (const row of rows.slice(hi + 1)) {
    found++;
    const date = normalizeDate(row[dc.date]);
    if (!date) { skipped++; continue; }
    if (isSummaryRow(row)) { skipped++; continue; }

    const amountRaw = parseNum(row[dc.amount]);
    if (amountRaw === null) { skipped++; continue; }

    const desc = str(row[dc.desc]) || (dc.category >= 0 ? str(row[dc.category]) : '');

    transactions.push({
      date, description: desc,
      amount:    -Math.abs(amountRaw),
      balance:   null,
      category:  dc.category >= 0 ? str(row[dc.category]) || null : null,
      reference: null,
      notes:     dc.notes >= 0 ? str(row[dc.notes]) || null : null,
      account:   account, source: sourceFile, source_type: 'cal_cc'
    });
  }

  console.log(`[cal_cc] found=${found} imported=${transactions.length} skipped=${skipped}`);
  return txResult(transactions, 'cal_cc', { found, imported: transactions.length, skipped });
}

// ── PDF fallback ──────────────────────────────────────────────────────────────
async function parsePdf(filePath, accountName, sourceFile) {
  try {
    const pdfParse = require('pdf-parse');
    const pdfData  = await pdfParse(fs.readFileSync(filePath));
    const lines    = pdfData.text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2)
      return txResult([], 'pdf', {}, PDF_WARNING);

    const transactions = lines.slice(1).map(line => {
      const parts = line.split(/\s{2,}|\t/);
      const date  = normalizeDate(parts[0]);
      if (!date) return null;
      return {
        date, description: parts[1] || line,
        amount:  parseNum(parts[2] ?? '0') ?? 0,
        balance: parseNum(parts[3] ?? '0'),
        category: null, reference: null, notes: null,
        account: accountName, source: sourceFile, source_type: 'pdf'
      };
    }).filter(Boolean);

    if (!transactions.length) return txResult([], 'pdf', {}, PDF_WARNING);
    console.log(`[pdf] imported=${transactions.length}`);
    return txResult(transactions, 'pdf');
  } catch {
    return txResult([], 'pdf', {}, PDF_WARNING);
  }
}

const PDF_WARNING = 'PDF זה עובד רק על קבצים דיגיטליים (לא סרוקים). אם הנתונים לא נוצרו כראוי, נסה לייצא כ-CSV מהאתר.';

// ── Helper: build transaction result ─────────────────────────────────────────
function txResult(transactions, sourceType, stats = {}, warning = null) {
  return {
    type: 'transactions',
    transactions,
    sourceType,
    stats: { found: stats.found ?? transactions.length, imported: stats.imported ?? transactions.length, skipped: stats.skipped ?? 0 },
    ...(warning ? { warning } : {})
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function parseFile(filePath, accountName) {
  const ext        = path.extname(filePath).toLowerCase();
  const sourceFile = path.basename(filePath);

  try {
    if (ext === '.pdf') return parsePdf(filePath, accountName, sourceFile);

    if ((ext === '.xls' || ext === '.xlsx') && isHtmlFile(filePath)) {
      const html = readLeumiHtml(filePath);
      if (html.includes('פירוט יתרות')) return parseLeumiBalances(filePath, accountName, sourceFile);
      return parseLeumiTransactions(filePath, accountName, sourceFile);
    }

    let rows = [];
    if (ext === '.xlsx' || ext === '.xls') {
      rows = readExcelRows(filePath);
    } else if (ext === '.csv' || ext === '.txt') {
      const csvParse = require('csv-parse/sync');
      const raw = fs.readFileSync(filePath);
      let content = raw.toString('utf8');
      if (content.includes('�')) content = raw.toString('latin1');
      rows = csvParse.parse(content, { skip_empty_lines: true, relax_column_count: true, bom: true });
    }

    const sourceType = detectFileType(filePath, rows);
    console.log(`[parseFile] type=${sourceType} file=${sourceFile}`);

    switch (sourceType) {
      case 'poalim_transactions': return parsePoalimTransactions(rows, accountName, sourceFile);
      case 'poalim_balances':     return parsePoalimBalances(rows, accountName, sourceFile);
      case 'poalim_mortgage':     return parsePoalimMortgage(rows, accountName, sourceFile);
      case 'isracard_cc':         return parseIsracard(rows, accountName, sourceFile);
      case 'max_cc':              return parseMax(rows, accountName, sourceFile);
      case 'cal_cc':              return parseCal(rows, accountName, sourceFile);
      default:                    return parseGeneric(rows, accountName, sourceFile);
    }
  } catch (e) {
    console.error(`[parseFile] Error:`, e.message);
    return txResult([], 'error', {}, e.message);
  }
}

module.exports = { parseFile };
