'use strict';

const fs     = require('fs');
const path   = require('path');
const xlsx   = require('xlsx');
const crypto = require('crypto');

function makePendingKey(description, amount, date) {
  return crypto.createHash('md5')
    .update(`${description || ''}|${amount}|${date || ''}`)
    .digest('hex');
}

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
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const line = rows[i].map(c => str(c)).join(' ');
    let m = line.match(/\*+(\d{4})/);
    if (m) return `ישראכרט *${m[1]}`;
    m = line.match(/ספרות אחרונות[:\s]*(\d{4})/);
    if (m) return `ישראכרט *${m[1]}`;
    m = line.match(/כרטיס[:\s]+(\d{8,19})/);
    if (m) return `ישראכרט *${m[1].slice(-4)}`;
    // "לכרטיס מאסטרקארד 8790" — bare 4-digit card suffix
    m = line.match(/מאסטרקארד\s+(\d{4})\b/);
    if (m) return `ישראכרט *${m[1]}`;
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

function extractCalHeader(rows) {
  let digits = null, linked_account = null;
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const line = rows[i].map(c => str(c)).join(' ');
    if (!digits) {
      let m = line.match(/\*+(\d{4})/);
      if (m) { digits = m[1]; }
      else {
        m = line.match(/ספרות אחרונות[:\s]*(\d{4})/);
        if (m) digits = m[1];
      }
    }
    if (!linked_account) {
      // Bank account numbers are typically 6-9 digits; skip 4-digit card numbers
      const m = line.match(/\b(\d{6,9})\b/);
      if (m && m[1] !== digits) linked_account = m[1];
    }
  }
  return { digits, linked_account, account_id: digits ? `כאל *${digits}` : null };
}

// Resolves the final account label.
// Detected account ID always takes priority so multiple files for the same
// account automatically group together regardless of filename or user input.
function resolveAccount(detected, userProvided, sourceFile) {
  if (detected) return detected;
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
    if (line.includes('חשבונות שוטפים'))             return 'poalim_daily_balances';
    if (line.includes('תנועות בחשבון'))              return 'poalim_transactions';
    if (line.includes('ריכוז יתרות'))                return 'poalim_balances';
    if (line.includes('משכנתאות'))                   return 'poalim_mortgage';
    if (line.includes('פירוט עסקאות') &&
        line.includes('מסטרקארד'))                   return 'isracard_cc';
    if (line.includes('כל המשתמשים') ||
        (line.includes('קטגוריה') && rows.slice(0,5)
          .some(r => r.map(str).join(' ').includes('כרטיס')))) return 'max_cc';
    // New Max CC format: row 4 header contains these two columns
    if (line.includes('שם בית העסק') &&
        (line.includes('סכום חיוב') || line.includes('4 ספרות'))) return 'max_cc';
    // Leumi CC and כאל CC — both use the same column structure
    if (line.includes('פירוט עסקאות') &&
        (line.includes('כרטיס') || line.includes('אשראי')))  return 'cal_cc';
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
// ── Shared: balance-snapshot extraction helpers ───────────────────────────────

const BALANCE_TYPE_PATTERNS = [
  { type: 'checking',    re: /עו"ש|עובר ושב|עוש(?!\w)/ },
  { type: 'savings',     re: /חסכונות|חסכון|פיקדונות|פיקדון/ },
  { type: 'loan',        re: /הלוואות(?! משכנתא)|הלוואה(?! משכנתא)/ },
  { type: 'mortgage',    re: /משכנתא/ },
  { type: 'investments', re: /השקעות|תיק השקעות/ },
  { type: 'pension',     re: /פנסיה|קופת גמל|קרן השתלמות/ },
];

function detectBalanceType(line) {
  for (const { type, re } of BALANCE_TYPE_PATTERNS) {
    if (re.test(line)) return type;
  }
  return null;
}

function buildBalanceSnapshot(items, report_date, source) {
  return {
    accounts:   items,
    report_date,
    source,
    updated_at: new Date().toISOString()
  };
}

// ── Poalim: Balances ──────────────────────────────────────────────────────────
function parsePoalimBalances(rows, accountName, sourceFile) {
  let report_date = null;
  let currentType = null;
  const sections = {}; // type → [{label, balance, credit_line, isSummary}]

  for (const row of rows) {
    const cells = row.map(str);
    const line  = cells.join(' ');

    // Extract report date from any header row
    if (!report_date) {
      const m = line.match(/(\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4})/);
      if (m) report_date = normalizeDate(m[1]);
    }

    // Detect section transitions
    const detectedType = detectBalanceType(line);
    if (detectedType) currentType = detectedType;
    if (!currentType) continue;

    // Collect numeric values from this row
    const nums = cells.map(parseNum).filter(n => n !== null && n !== 0);
    if (!nums.length) continue;

    // Skip rows that are pure numbers / currency symbols with no label
    const label = cells.find(c => c.length >= 2 && !/^[\d,.\-()\s₪%]+$/.test(c));

    const entry = {
      label:      label || '',
      balance:    nums[nums.length - 1],
      isSummary:  isSummaryRow(row)
    };
    // For checking account rows, first number is typically the credit line
    if (currentType === 'checking' && nums.length >= 2) {
      entry.credit_line = nums[0];
    }

    if (!sections[currentType]) sections[currentType] = [];
    sections[currentType].push(entry);
  }

  // Flatten into accounts array: use individual (non-summary) rows when present,
  // fall back to summary rows for a section total.
  const LABELS = {
    checking: 'עו"ש', savings: 'חסכונות', loan: 'הלוואות',
    mortgage: 'משכנתא', investments: 'השקעות', pension: 'פנסיה / גמל'
  };
  const accounts = [];
  const ORDER = ['checking', 'savings', 'investments', 'pension', 'mortgage', 'loan'];

  for (const type of ORDER) {
    const items = sections[type] || [];
    if (!items.length) continue;

    const detail  = items.filter(i => !i.isSummary && i.label);
    const summary = items.filter(i =>  i.isSummary);

    if (detail.length === 1) {
      const d = detail[0];
      accounts.push({ type, label: d.label || LABELS[type], balance: d.balance,
                      ...(d.credit_line != null ? { credit_line: d.credit_line } : {}) });
    } else if (detail.length > 1) {
      // Multiple sub-accounts — emit individual rows; add section total if available
      if (summary.length) {
        accounts.push({ type, label: LABELS[type], balance: summary[0].balance, isSectionTotal: true });
      }
      for (const d of detail) {
        accounts.push({ type, label: d.label, balance: d.balance, isSub: true,
                        ...(d.credit_line != null ? { credit_line: d.credit_line } : {}) });
      }
    } else if (summary.length) {
      accounts.push({ type, label: LABELS[type], balance: summary[0].balance });
    }
  }

  console.log(`[poalim_balances] report_date=${report_date} accounts:`, accounts);
  return {
    type: 'profile_data', profileKey: 'balance_snapshot',
    profileData: buildBalanceSnapshot(accounts, report_date, 'poalim_balances'),
    sourceType: 'poalim_balances'
  };
}

// ── Poalim: Mortgage ──────────────────────────────────────────────────────────
function parsePoalimMortgage(rows, accountName, sourceFile) {
  const hi = findHeader(rows, ['מסלול', 'יתרה'], 10);
  const startIdx = hi >= 0 ? hi + 1 : 5;
  const accounts = [];
  let totalBalance = 0;

  for (const row of rows.slice(startIdx)) {
    const loanId = str(row[0]);
    if (!loanId || loanId.length < 6) continue;
    if (isSummaryRow(row)) continue;
    const balance = parseNum(row[5]);
    if (balance === null) continue;
    totalBalance += balance;
    accounts.push({
      type:       'mortgage',
      label:      `משכנתא – מסלול ${loanId}`,
      balance:    -Math.abs(balance),
      isSub:      true,
      end_date:   normalizeDate(row[4]) || null,
      index_type: str(row[1]) || null,
      rate_type:  str(row[2]) || null,
    });
  }

  // Add section total as the primary entry
  if (accounts.length > 1) {
    accounts.unshift({ type: 'mortgage', label: 'משכנתא', balance: -Math.abs(totalBalance), isSectionTotal: true });
  } else if (accounts.length === 1) {
    accounts[0].label = 'משכנתא';
    accounts[0].isSub = false;
  }

  console.log(`[poalim_mortgage] found ${accounts.length} entries, total=${totalBalance}`);
  return {
    type: 'profile_data', profileKey: 'balance_snapshot',
    profileData: buildBalanceSnapshot(accounts, null, 'poalim_mortgage'),
    sourceType: 'poalim_mortgage'
  };
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

function isFrameset(html) {
  return /<frameset[\s>]/i.test(html);
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

const LEUMI_FRAMESET_WARNING =
  'קובץ לאומי זה הוא קובץ מסגרת (frameset) ואינו מכיל נתוני תנועות ישירות.\n' +
  'כאשר הורדת את הקובץ מלאומי נוצרה תיקייה בשם "שם-הקובץ.files" לצד הקובץ.\n' +
  'פתח את התיקייה, מצא את הקובץ sheet001.htm והעלה אותו ישירות לאתר במקום הקובץ הראשי.';

function parseLeumiTransactions(filePath, accountName, sourceFile) {
  const html = readLeumiHtml(filePath);

  // Frameset files are just pointers — the real data is in sheet001.htm
  if (isFrameset(html)) {
    console.log('[leumi_tx] detected frameset — no transaction data in this file');
    return txResult([], 'leumi_transactions', { found: 0, imported: 0, skipped: 0 }, LEUMI_FRAMESET_WARNING);
  }

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

  // Dynamic header + column detection — require multiple column keywords so we
  // skip metadata rows like "תאריך שמירה/הדפסה: ..." and land on the real header
  let hi = findHeader(rows, ['תאריך', 'חובה'], 40);
  if (hi < 0) hi = findHeader(rows, ['תאריך', 'יתרה'], 40);
  if (hi < 0) hi = findHeader(rows, ['תאריך', 'זכות'], 40);
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

// ── Leumi: Balances (sheet001.htm / פירוט יתרות) ─────────────────────────────
function parseLeumiBalances(filePath, accountName, sourceFile) {
  const html = readLeumiHtml(filePath);

  if (isFrameset(html)) {
    console.log('[leumi_balances] detected frameset');
    return txResult([], 'leumi_balances', { found: 0, imported: 0, skipped: 0 }, LEUMI_FRAMESET_WARNING);
  }

  // Strip RTL/LTR Unicode markers and normalise whitespace from a cell value
  const clean = s => (s || '').toString()
    .replace(/[‎‏‪‫‬‭‮]/g, '')
    .replace(/\xa0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const parseAmt = s => parseNum(clean(s));

  // Extract all tables; use the largest one
  const tables = parseHtmlTables(html);
  let rawRows = tables.reduce((best, t) => t.length > best.length ? t : best, []);
  const rows  = rawRows.map(row => row.map(clean));

  console.log(`[leumi_balances] rows=${rows.length}`);

  let report_date      = null;
  let checking         = null;
  let credit_card_debt = null;
  let loans_total      = null;
  let total_credit     = null;
  let total_debit      = null;
  const loans          = [];

  let section = null; // 'checking' | 'credit' | 'loans'

  // Keywords that mark column-header rows to skip
  const HEADER_KEYWORDS = ['חשבון', 'נכון לתאריך', 'יתרה בש"ח', 'כרטיס', 'מועד החיוב',
                           'הלוואה', 'סכום הלוואה', 'תאריך סיום', 'יתרה משוערכת', 'סכום החיוב'];

  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i];
    const line  = cells.join(' ');

    // ── Extract report date from any row ──────────────────────────────────────
    if (!report_date) {
      const m = line.match(/(\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4})/);
      if (m) report_date = normalizeDate(m[1]);
    }

    // ── Section headers ───────────────────────────────────────────────────────
    if (line.includes('עובר ושב'))       { section = 'checking'; continue; }
    if (line.includes('כרטיסי אשראי'))   { section = 'credit';   continue; }
    if (line.includes('הלוואות'))         { section = 'loans';    continue; }

    // ── Summary row — יתרות בזכות / יתרות בחובה ─────────────────────────────
    if (line.includes('יתרות בזכות') || line.includes('יתרות בחובה')) {
      const mc = line.match(/יתרות בזכות[:\s₪]*([\d,.\-]+)/);
      const md = line.match(/יתרות בחובה[:\s₪]*([\-\d,.‎‏]+)/);
      if (mc) total_credit = parseAmt(mc[1]);
      if (md) total_debit  = parseAmt(md[1].replace(/-/, '')) !== null
                              ? -Math.abs(parseAmt(md[1]) ?? 0) : null;
      continue;
    }

    if (!section) continue;

    // ── Skip column-header rows ───────────────────────────────────────────────
    if (HEADER_KEYWORDS.some(kw => cells.includes(kw))) continue;

    // ── Section total rows: סה"כ ─────────────────────────────────────────────
    const isTotalRow = isSummaryRow(cells) || line.includes('סה"כ') || line.includes('סה״כ');

    // ── CHECKING ──────────────────────────────────────────────────────────────
    if (section === 'checking' && !isTotalRow) {
      // Data row: ['662-20596/69', '', '', '10/05/2026', '13,811.13', '']
      const nums = cells.map(parseAmt).filter(n => n !== null);
      if (nums.length) checking = nums[nums.length - 1]; // last number is balance
    }

    // ── CREDIT CARDS ──────────────────────────────────────────────────────────
    if (section === 'credit' && isTotalRow) {
      const nums = cells.map(parseAmt).filter(n => n !== null && n !== 0);
      if (nums.length) credit_card_debt = -Math.abs(nums[nums.length - 1]);
    }

    // ── LOANS ─────────────────────────────────────────────────────────────────
    if (section === 'loans') {
      if (isTotalRow) {
        const nums = cells.map(parseAmt).filter(n => n !== null && n !== 0);
        if (nums.length) loans_total = -Math.abs(nums[nums.length - 1]);
      } else if (cells[0] && cells[0].length > 2) {
        // Data row: ['מט"י ז"א ... 2529-1/3', '662-...', '30,000', '11/12/2027', '08/05/2026', '20,780.55']
        // Split name from loan_id (trailing alphanumeric-dash-slash pattern)
        const nameIdMatch = cells[0].match(/^(.+?)\s+([\d]{3,}[\-\/][\d\/\-]+)$/);
        const loanName    = nameIdMatch ? nameIdMatch[1].trim() : cells[0];
        const loanId      = nameIdMatch ? nameIdMatch[2] : '';

        const originalAmt = parseAmt(cells[2]);
        const endDate     = normalizeDate(cells[3]);
        const balance     = parseAmt(cells[5] || cells[cells.length - 1]);

        if (balance !== null && balance !== 0) {
          loans.push({
            name:            loanName,
            loan_id:         loanId,
            original_amount: originalAmt,
            end_date:        endDate,
            balance:         -Math.abs(balance)
          });
        }
      }
    }
  }

  if (loans_total === null && loans.length)
    loans_total = loans.reduce((s, l) => s + l.balance, 0);

  const leumi_balances = {
    report_date, checking, credit_card_debt,
    loans, loans_total, total_credit, total_debit,
    updated_at: new Date().toISOString()
  };

  console.log('[leumi_balances]', leumi_balances);
  return {
    type: 'profile_data', profileKey: 'leumi_balances',
    profileData: leumi_balances, sourceType: 'leumi_balances'
  };
}

// ── Isracard ──────────────────────────────────────────────────────────────────
function parseIsracard(rows, accountName, sourceFile) {
  const account   = resolveAccount(extractIsracardId(rows), accountName, sourceFile);
  const cardDigits = (account.match(/\*(\d{4})/) || [])[1] || null;
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
      reference:   dc.ref >= 0 ? str(row[dc.ref]) || null : null,
      notes:       dc.notes >= 0 ? str(row[dc.notes]) || null : null,
      card_digits: cardDigits,
      account:     account, source: sourceFile, source_type: 'isracard_cc'
    });
  }

  console.log(`[isracard_cc] found=${found} imported=${transactions.length} skipped=${skipped}`);
  return txResult(transactions, 'isracard_cc', { found, imported: transactions.length, skipped });
}

// ── Max CC (multi-sheet) ──────────────────────────────────────────────────────
// Receives filePath directly so it can read multiple sheets.
// Sheet structure:
//   Row 2 cell A  → card name with 4-digit suffix, e.g. "9226-clal pay"
//   Row 3 cell A  → date range "YYYY-MM-DD-YYYY-MM-DD"; end date = report date
//   Row 4         → column headers
//   Rows 5+       → transaction data
// Parses all of: עסקאות במועד החיוב / עסקאות חו"ל ומט"ח / עסקאות בחיוב מיידי
function parseMax(filePath, accountName, sourceFile) {
  const wb = xlsx.readFile(filePath, { cellDates: false, raw: false });

  const TARGET_SHEETS = [
    'עסקאות במועד החיוב',
    'עסקאות חו"ל ומט"ח',
    'עסקאות בחיוב מיידי',
    'עסקאות שאושרו וטרם נקלטו',
  ];

  // Extract card digits and report date from the first sheet's metadata rows
  const firstRows = xlsx.utils.sheet_to_json(
    wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });

  let globalDigits = null;
  let reportDate   = null;

  if (firstRows.length > 1) {
    const r2 = str(firstRows[1][0]); // "9226-clal pay" or "****9226"
    const m  = r2.match(/^(\d{4})[-\s]/) || r2.match(/\*+(\d{4})/);
    if (m) globalDigits = m[1];
  }

  if (firstRows.length > 2) {
    const r3    = str(firstRows[2][0]); // "2025-05-01-2026-05-13"
    const dates = [...r3.matchAll(/\d{4}-\d{2}-\d{2}/g)].map(m => m[0]);
    if (dates.length >= 2) reportDate = dates[dates.length - 1];
    else if (dates.length === 1) reportDate = dates[0];
  }

  const account = resolveAccount(
    globalDigits ? `מקס *${globalDigits}` : extractMaxId(firstRows),
    accountName, sourceFile);

  const allTransactions = [];
  let found = 0, skipped = 0;

  for (const sheetName of wb.SheetNames) {
    const normalized = sheetName.replace(/\s+/g, ' ').trim();
    const isTarget = TARGET_SHEETS.some(t => normalized.includes(t) || t.includes(normalized));
    if (!isTarget && !normalized.includes('עסקאות')) continue;

    const isImmediateDebit = normalized.includes('חיוב מיידי');
    const isPending        = normalized.includes('טרם נקלטו') || normalized.includes('שאושרו');
    const rows = xlsx.utils.sheet_to_json(
      wb.Sheets[sheetName], { header: 1, defval: '', raw: false });

    // Per-sheet card digits (sheet row 2 may have a different card)
    let sheetDigits = globalDigits;
    if (rows.length > 1) {
      const r2 = str(rows[1][0]);
      const m  = r2.match(/^(\d{4})[-\s]/) || r2.match(/\*+(\d{4})/);
      if (m) sheetDigits = m[1];
    }

    // Header expected at row 4 (index 3)
    const hi = findHeader(rows, ['שם בית העסק'], 8);
    if (hi < 0) continue;

    for (const row of rows.slice(hi + 1)) {
      found++;
      if (isSummaryRow(row)) { skipped++; continue; }

      const date = normalizeDate(str(row[0]));  // col A
      if (!date)  { skipped++; continue; }

      // col F = סכום חיוב (known after billing); col H = סכום עסקה מקורי (always present).
      // Pending transactions have col F empty — fall back to col H.
      const amountRaw = parseNum(row[5]) ?? parseNum(row[7]);
      if (amountRaw === null || amountRaw === 0) { skipped++; continue; }

      // col D: per-row card digits (may be blank → fall back to sheet-level)
      const rowDigits  = str(row[3]) || sheetDigits || null;

      // col E: transaction type
      const txType     = str(row[4]);

      // col G/H/I: currency info (for foreign transactions)
      const origAmount   = parseNum(row[7]);
      const origCurrency = str(row[8]);

      // col J: billing date
      const billingDate = normalizeDate(str(row[9])) || null;

      // col K: notes from file ("תשלום 1 מתוך 2", etc.)
      const rawNotes = str(row[10]);

      // Build notes field
      const noteParts = [];
      if (rawNotes) noteParts.push(rawNotes);
      // Foreign currency: append readable original amount
      if (origAmount !== null && origCurrency &&
          origCurrency !== 'ש"ח' && origCurrency !== '₪')
        noteParts.push(`סכום מקורי: ${origAmount} ${origCurrency}`);
      // Tag so paymentType() can detect these in the frontend
      if (isImmediateDebit) noteParts.push('חיוב מיידי');
      if (txType === 'הוראת קבע') noteParts.push('הוראת קבע');

      const description  = str(row[1]);
      const txAmount     = -Math.abs(amountRaw);
      const txStatus     = isPending ? 'pending' : 'cleared';
      const txPendingKey = makePendingKey(description, txAmount, date);

      allTransactions.push({
        date,
        description,
        amount:       txAmount,
        balance:      null,
        category:     str(row[2]) || null,      // col C – real consumer category
        reference:    null,
        notes:        noteParts.join(' | ') || null,
        billing_date: billingDate,
        card_digits:  rowDigits,
        status:       txStatus,
        pending_key:  txPendingKey,
        account,
        source:       sourceFile,
        source_type:  'max_cc',
      });
    }
  }

  console.log(`[max_cc] sheets parsed, found=${found} imported=${allTransactions.length} skipped=${skipped} reportDate=${reportDate}`);
  const result = txResult(allTransactions, 'max_cc', { found, imported: allTransactions.length, skipped });
  if (reportDate) result.stats.reportDate = reportDate;
  return result;
}

// ── Cal ───────────────────────────────────────────────────────────────────────
function parseCal(rows, accountName, sourceFile) {
  const { digits, linked_account, account_id } = extractCalHeader(rows);
  const account = resolveAccount(account_id, accountName, sourceFile);

  const hi = findHeader(rows, ['תאריך', 'סכום'], 15);
  if (hi < 0) {
    console.log('[cal] header not found, falling back to generic');
    return parseGeneric(rows, account, sourceFile);
  }

  const hdrs = rows[hi].map(c => str(c));
  const dc = {
    date:         colIdx(hdrs, ['תאריך עסקה', 'תאריך'], 0),
    desc:         colIdx(hdrs, ['שם בית עסק', 'בית עסק', 'תיאור'], 1),
    amount:       colIdx(hdrs, ['סכום חיוב', 'סכום בש"ח', 'סכום'], 2),
    billing_date: colIdx(hdrs, ['מועד חיוב'], 3),
    tx_type:      colIdx(hdrs, ['סוג עסקה'], 4),
    notes:        colIdx(hdrs, ['הערות', 'פרטים'], 6),
  };
  console.log(`[cal] headerIdx=${hi} digits=${digits} linked=${linked_account} cols:`, dc);

  let found = 0, skipped = 0;
  const transactions = [];

  for (const row of rows.slice(hi + 1)) {
    found++;
    const date = normalizeDate(row[dc.date]);
    if (!date) { skipped++; continue; }
    if (isSummaryRow(row)) { skipped++; continue; }

    const amountRaw = parseNum(row[dc.amount]);
    if (amountRaw === null) { skipped++; continue; }

    const billingDate = dc.billing_date >= 0 ? normalizeDate(row[dc.billing_date]) : null;
    const txType      = dc.tx_type >= 0 ? str(row[dc.tx_type]) || null : null;
    const notes       = dc.notes  >= 0 ? str(row[dc.notes])   || null : null;
    const desc        = str(row[dc.desc]) || '';
    const txAmount    = -Math.abs(amountRaw);
    const isPending   = !!(txType && txType.includes('בקליטה'));

    transactions.push({
      date, description: desc,
      amount:         txAmount,
      balance:        null,
      category:       txType,
      reference:      null,
      notes,
      billing_date:   billingDate,
      card_digits:    digits,
      linked_account,
      status:      isPending ? 'pending' : 'cleared',
      pending_key: isPending ? makePendingKey(desc, txAmount, date) : null,
      account, source: sourceFile, source_type: 'cal_cc'
    });
  }

  console.log(`[cal_cc] found=${found} imported=${transactions.length} skipped=${skipped}`);
  return txResult(transactions, 'cal_cc', { found, imported: transactions.length, skipped });
}

// ── Poalim: DailyBalances.xlsx ────────────────────────────────────────────────
// Structured snapshot file: חשבונות שוטפים / השקעות / אשראי / משכנתאות
function parsePoalimDailyBalances(rows, accountName, sourceFile) {
  let checkingIdx = -1, investIdx = -1, creditIdx = -1, mortgageIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i].map(str).join(' ');
    if (checkingIdx < 0 && line.includes('חשבונות שוטפים')) checkingIdx = i;
    else if (investIdx   < 0 && line.includes('השקעות'))      investIdx   = i;
    else if (creditIdx   < 0 && line.includes('אשראי'))       creditIdx   = i;
    else if (mortgageIdx < 0 && (line.includes('משכנתאות') || line.includes('משכנתא'))) mortgageIdx = i;
  }

  let report_date = null;

  // Scan top rows for a "נכון ליום" date before section headers
  // The date cell may be an Excel serial number (raw number, not string), so use raw rows
  const topEnd = Math.min(checkingIdx >= 0 ? checkingIdx + 5 : 20, rows.length);
  outer: for (let i = 0; i < topEnd; i++) {
    const raw = rows[i];
    for (let j = 0; j < raw.length; j++) {
      if (str(raw[j]).includes('נכון')) {
        // Try the next cell (date value right after the label)
        for (let k = j + 1; k <= j + 3 && k < raw.length; k++) {
          const d = normalizeDate(raw[k]);
          if (d) { report_date = d; break outer; }
        }
      }
    }
  }

  // Skip metadata and column-header rows
  const isMetaRow = (cells) => {
    const line = cells.join(' ');
    if (line.includes('מספר חשבון') || line.includes('תאריך הפקה')) return true;
    return cells.some(c => c === 'סוג' || c === 'נכון ליום' || c.startsWith('יתרה') || c === 'מסגרת');
  };

  // Read a number from a specific column; reject date strings like '05.05.2026'
  const cellNum = (cells, idx) => {
    if (idx < 0 || idx >= cells.length) return null;
    const v = cells[idx];
    if (!v) return null;
    if (normalizeDate(v) !== null) return null;
    return parseNum(v);
  };

  // Find יתרה + מסגרת column indices from the section header row
  const sectionCols = (from, to) => {
    for (let i = from + 1; i < Math.min(to, rows.length); i++) {
      const cells = rows[i].map(str);
      const balIdx = cells.findIndex(c => c.startsWith('יתרה'));
      if (balIdx >= 0)
        return { balance: balIdx, creditLine: cells.findIndex(c => c.includes('מסגרת')), date: cells.findIndex(c => c.includes('נכון')) };
    }
    return { balance: -1, creditLine: -1, date: -1 };
  };

  // ── Section 1: Checking ──────────────────────────────────────────────────────
  let checking = null, credit_line = null;
  const checkEnd = investIdx > 0 ? investIdx : rows.length;
  const cc = sectionCols(checkingIdx, checkEnd);
  for (let i = checkingIdx + 1; i < checkEnd; i++) {
    const cells = rows[i].map(str);
    if (!cells[0] || cells[0].length < 2) continue;
    if (isMetaRow(cells) || isSummaryRow(rows[i])) continue;
    if (!report_date && cc.date >= 0) report_date = normalizeDate(cells[cc.date]);
    if (cells[0].includes('עו"ש') || cells[0].includes('עוש')) {
      checking    = cellNum(cells, cc.balance);
      credit_line = cellNum(cells, cc.creditLine);
    }
  }

  // ── Section 2: Investments ───────────────────────────────────────────────────
  let inv_deposits = null, inv_pri = null, inv_total = null;
  const investEnd = creditIdx > 0 ? creditIdx : (mortgageIdx > 0 ? mortgageIdx : rows.length);
  if (investIdx >= 0) {
    const ic = sectionCols(investIdx, investEnd);
    for (let i = investIdx + 1; i < investEnd; i++) {
      const cells = rows[i].map(str);
      if (!cells[0] || cells[0].length < 2) continue;
      if (isMetaRow(cells)) continue;
      if (!report_date && ic.date >= 0) report_date = normalizeDate(cells[ic.date]);
      if (isSummaryRow(rows[i])) {
        inv_total = cellNum(cells, ic.balance);
      } else if (cells.some(c => c.includes('פיקדון'))) {
        inv_deposits = cellNum(cells, ic.balance);
      } else if (cells.some(c => c.includes('פר"י') || c.includes("פר'י") || /פר.?י/.test(c))) {
        inv_pri = cellNum(cells, ic.balance);
      }
    }
    if (inv_total === null && (inv_deposits !== null || inv_pri !== null))
      inv_total = (inv_deposits ?? 0) + (inv_pri ?? 0);
  }

  // ── Section 3: Credit-card debt ─────────────────────────────────────────────
  let credit_card_debt = null;
  const creditEnd = mortgageIdx > 0 ? mortgageIdx : rows.length;
  if (creditIdx >= 0) {
    const xc = sectionCols(creditIdx, creditEnd);
    for (let i = creditIdx + 1; i < creditEnd; i++) {
      const cells = rows[i].map(str);
      if (!cells[0] || cells[0].length < 2) continue;
      if (isMetaRow(cells) || isSummaryRow(rows[i])) continue;
      const bal = cellNum(cells, xc.balance);
      if (bal !== null && bal !== 0) { credit_card_debt = bal; break; }
    }
  }

  // ── Section 4: Mortgage ─────────────────────────────────────────────────────
  let mortgage = null;
  if (mortgageIdx >= 0) {
    const mc = sectionCols(mortgageIdx, rows.length);
    for (let i = mortgageIdx + 1; i < Math.min(rows.length, mortgageIdx + 15); i++) {
      const cells = rows[i].map(str);
      if (!cells[0] || cells[0].length < 2) continue;
      if (isMetaRow(cells) || isSummaryRow(rows[i])) continue;
      const bal = cellNum(cells, mc.balance);
      if (bal !== null && bal !== 0) { mortgage = -Math.abs(bal); break; }
    }
  }

  const net_worth =
    (checking !== null || inv_total !== null || mortgage !== null)
      ? (checking ?? 0) + (inv_total ?? 0) + (mortgage ?? 0)
      : null;

  const live_balances = { report_date, checking, credit_line,
    investments: { deposits: inv_deposits, pri: inv_pri, total: inv_total },
    credit_card_debt, mortgage, net_worth };

  console.log('[poalim_daily_balances]', live_balances);
  return { type: 'profile_data', profileKey: 'live_balances',
           profileData: live_balances, sourceType: 'poalim_daily_balances' };
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

    // Direct upload of sheet001.htm (or any Leumi .htm data file)
    if (ext === '.htm' || ext === '.html') {
      const html = readLeumiHtml(filePath);
      if (html.includes('פירוט יתרות')) return parseLeumiBalances(filePath, accountName, sourceFile);
      return parseLeumiTransactions(filePath, accountName, sourceFile);
    }

    if ((ext === '.xls' || ext === '.xlsx') && isHtmlFile(filePath)) {
      const html = readLeumiHtml(filePath);
      if (html.includes('פירוט יתרות'))   return parseLeumiBalances(filePath, accountName, sourceFile);
      // CC export: same column structure as כאל — parse as cal_cc so amounts are negated
      if (html.includes('פירוט עסקאות') && (html.includes('כרטיס') || html.includes('אשראי'))) {
        const rows = readExcelRows(filePath);
        return parseCal(rows, accountName, sourceFile);
      }
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
      case 'poalim_daily_balances': return parsePoalimDailyBalances(rows, accountName, sourceFile);
      case 'poalim_transactions':   return parsePoalimTransactions(rows, accountName, sourceFile);
      case 'poalim_balances':       return parsePoalimBalances(rows, accountName, sourceFile);
      case 'poalim_mortgage':       return parsePoalimMortgage(rows, accountName, sourceFile);
      case 'isracard_cc':         return parseIsracard(rows, accountName, sourceFile);
      case 'max_cc':              return parseMax(filePath, accountName, sourceFile);
      case 'cal_cc':              return parseCal(rows, accountName, sourceFile);
      default:                    return parseGeneric(rows, accountName, sourceFile);
    }
  } catch (e) {
    console.error(`[parseFile] Error:`, e.message);
    return txResult([], 'error', {}, e.message);
  }
}

module.exports = { parseFile };
