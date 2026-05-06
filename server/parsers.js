'use strict';

const fs   = require('fs');
const path = require('path');
const xlsx = require('xlsx');

// ── Utilities ─────────────────────────────────────────────────────────────────

function parseNum(s) {
  if (s === null || s === undefined || s === '') return null;
  const str = s.toString().trim();
  if (!str) return null;
  // Parentheses = negative: (1,234.56)
  const inParens = /^\(([^)]+)\)$/.test(str);
  const cleaned = str
    .replace(/^\(([^)]+)\)$/, '$1')
    .replace(/,/g, '')
    .replace(/\s/g, '')
    .replace(/−/g, '-')   // Unicode minus sign
    .replace(/[^\d.-]/g, '');
  const n = parseFloat(cleaned);
  if (isNaN(n)) return null;
  return inParens ? -Math.abs(n) : n;
}

function normalizeDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;

  // JS Date object (xlsx cellDates:true)
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    return raw.toISOString().substring(0, 10);
  }

  // Excel serial number
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

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY (4-digit year)
  let m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;

  // DD/MM/YY or DD.MM.YY (2-digit year)
  m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})$/);
  if (m) return `20${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;

  return null;
}

function isSummaryRow(row) {
  return row.some(c => {
    const s = (c ?? '').toString();
    return s.includes('סה"כ') || s.includes('סה״כ') ||
           s.includes('סך הכל') || s.includes('סה״כ');
  });
}

function isHtmlFile(filePath) {
  try {
    const buf = Buffer.alloc(10);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, 10, 0);
    fs.closeSync(fd);
    const sig = buf.toString('latin1').toLowerCase().trim();
    return sig.startsWith('<html') || sig.startsWith('<!doc');
  } catch { return false; }
}

function readExcelRows(filePath) {
  const wb = xlsx.readFile(filePath, { cellDates: false, raw: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
}

function str(v) { return (v ?? '').toString().trim(); }

// ── File-type detection ───────────────────────────────────────────────────────

/**
 * Returns source_type string based on file content.
 * Call after reading first rows (or detecting HTML).
 */
function detectFileType(filePath, rows) {
  const ext = path.extname(filePath).toLowerCase();

  // Leumi: XLS files that are actually HTML
  if ((ext === '.xls' || ext === '.xlsx') && isHtmlFile(filePath)) {
    try {
      const html = fs.readFileSync(filePath, 'utf8');
      if (html.includes('תנועות בחשבון')) return 'leumi_transactions';
      if (html.includes('פירוט יתרות'))   return 'leumi_balances';
      return 'leumi_transactions';
    } catch { return 'leumi_transactions'; }
  }

  // Scan first 8 rows for known markers
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

// ── Generic fallback (keeps existing header-detection logic) ──────────────────

const DATE_HDRS    = ['תאריך', 'date'];
const DESC_HDRS    = ['תיאור פעולה', 'תיאור', 'פירוט', 'פרטים', 'description', 'name'];
const AMOUNT_HDRS  = ['סכום', 'amount'];
const DEBIT_HDRS   = ['חיוב'];
const CREDIT_HDRS  = ['זיכוי'];
const BALANCE_HDRS = ['יתרה', 'balance'];
const ALL_HDRS     = [...DATE_HDRS, ...DESC_HDRS, ...AMOUNT_HDRS, ...DEBIT_HDRS, ...CREDIT_HDRS, ...BALANCE_HDRS];

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = rows[i].map(c => str(c).toLowerCase());
    const hits  = cells.filter(c => ALL_HDRS.some(k => c.includes(k.toLowerCase())));
    if (hits.length >= 2) return i;
  }
  return 0;
}

function detectCols(headers) {
  const low = headers.map(h => str(h).toLowerCase());
  const find = opts => {
    const i = low.findIndex(h => opts.some(o => h.includes(o.toLowerCase())));
    return i >= 0 ? i : null;
  };
  return {
    date: find(DATE_HDRS), description: find(DESC_HDRS),
    amount: find(AMOUNT_HDRS), debit: find(DEBIT_HDRS),
    credit: find(CREDIT_HDRS), balance: find(BALANCE_HDRS)
  };
}

function parseGeneric(rows, accountName, sourceFile) {
  if (rows.length < 2) return { type: 'transactions', transactions: [], sourceType: 'generic', stats: { found: 0, imported: 0, skipped: 0 } };
  const hi   = findHeaderRow(rows);
  const cols = detectCols(rows[hi].map(String));
  let found = 0, skipped = 0;
  const transactions = [];

  for (const row of rows.slice(hi + 1)) {
    found++;
    const dateRaw = cols.date !== null ? row[cols.date] : row[0];
    const date = normalizeDate(dateRaw);
    if (!date) { skipped++; continue; }
    if (isSummaryRow(row)) { skipped++; continue; }

    let amount = 0;
    if (cols.debit !== null || cols.credit !== null) {
      const credit = parseNum(cols.credit !== null ? row[cols.credit] : '') ?? 0;
      const debit  = parseNum(cols.debit  !== null ? row[cols.debit]  : '') ?? 0;
      amount = credit - debit;
    } else {
      amount = parseNum(cols.amount !== null ? row[cols.amount] : row[2]) ?? 0;
    }

    const desc = str(cols.description !== null ? row[cols.description] : row[1]) || str(row[2]);
    if (!desc && amount === 0) { skipped++; continue; }

    transactions.push({
      date, description: desc, amount,
      balance:     parseNum(cols.balance !== null ? row[cols.balance] : row[cols.debit !== null ? 4 : 3]),
      category:    null, reference: null, notes: null,
      account:     accountName, source: sourceFile, source_type: 'generic'
    });
  }

  console.log(`[generic] found=${found} imported=${transactions.length} skipped=${skipped}`);
  return { type: 'transactions', transactions, sourceType: 'generic', stats: { found, imported: transactions.length, skipped } };
}

// ── Poalim: Transactions ──────────────────────────────────────────────────────
function parsePoalimTransactions(rows, accountName, sourceFile) {
  // Dynamically locate the header row (contains חובה + זכות/זיכוי)
  let headerIdx = 4; // safe default
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const line = rows[i].map(c => str(c)).join(' ');
    if (line.includes('חובה') && (line.includes('זכות') || line.includes('זיכוי'))) {
      headerIdx = i; break;
    }
  }

  const hdrs = rows[headerIdx].map(c => str(c));
  const ci = (keywords, def) => {
    const idx = hdrs.findIndex(h => keywords.some(k => h.includes(k)));
    return idx >= 0 ? idx : def;
  };
  const dateCol    = ci(['תאריך'], 0);
  const descCol    = ci(['פעולה', 'תיאור'], 1);
  const detailCol  = ci(['פרטים'], 2);
  const refCol     = ci(['אסמכתא'], 3);
  const debitCol   = ci(['חובה'], 4);
  const creditCol  = ci(['זכות', 'זיכוי'], 5);
  const balanceCol = ci(['יתרה'], 6);

  console.log(`[poalim_tx] headerIdx=${headerIdx} cols: date=${dateCol} desc=${descCol} debit=${debitCol} credit=${creditCol} balance=${balanceCol}`);

  let found = 0, skipped = 0;
  const transactions = [];

  for (const row of rows.slice(headerIdx + 1)) {
    found++;
    const date = normalizeDate(row[dateCol]);
    if (!date) { skipped++; continue; }
    if (isSummaryRow(row)) { skipped++; continue; }

    const debit  = parseNum(row[debitCol]);
    const credit = parseNum(row[creditCol]);

    if ((debit === null || debit === 0) && (credit === null || credit === 0)) { skipped++; continue; }

    const amount = (credit !== null && credit !== 0) ? Math.abs(credit) : -Math.abs(debit ?? 0);

    const noteParts = [str(row[detailCol]), str(row[8]), str(row[9])].filter(Boolean);

    transactions.push({
      date, description: str(row[descCol]), amount,
      balance:   parseNum(row[balanceCol]),
      category:  null,
      reference: str(row[refCol]) || null,
      notes:     noteParts.join(' | ') || null,
      account:   accountName, source: sourceFile, source_type: 'poalim_transactions'
    });
  }

  console.log(`[poalim_transactions] found=${found} imported=${transactions.length} skipped=${skipped}`);
  return { type: 'transactions', transactions, sourceType: 'poalim_transactions', stats: { found, imported: transactions.length, skipped } };
}

// ── Poalim: Balances ──────────────────────────────────────────────────────────
// Returns profile_data, not transactions
function parsePoalimBalances(rows, accountName, sourceFile) {
  let checking_balance = null, credit_line = null, investments_total = null, report_date = null;

  // Report date from row 4 (idx 3)
  const row3text = (rows[3] ?? []).map(str).join(' ');
  const dm = row3text.match(/(\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4})/);
  if (dm) report_date = normalizeDate(dm[1]);

  // עו"ש balance: first row containing עו"ש in rows 4–15
  for (let i = 4; i < Math.min(rows.length, 20); i++) {
    const line = rows[i].map(str).join(' ');
    if (line.includes('עו"ש') || line.includes('עוש')) {
      credit_line      = parseNum(rows[i][2]);
      checking_balance = parseNum(rows[i][3]);
      break;
    }
  }

  // Investments total: first סה"כ row after 'השקעות' header
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
// Returns profile_data
function parsePoalimMortgage(rows, accountName, sourceFile) {
  const loans = [];

  // Headers at row idx 4, data from idx 5
  for (const row of rows.slice(5)) {
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
function parseLeumiTransactions(filePath, accountName, sourceFile) {
  const { parse } = require('node-html-parser');
  const raw  = fs.readFileSync(filePath);
  // Try UTF-8; fall back to Windows-1255 via latin1 if garbled
  let html = raw.toString('utf8');
  if (html.includes('?????') || html.includes('�')) html = raw.toString('latin1');

  const root  = parse(html);
  const transactions = [];
  let found = 0, skipped = 0;

  // Find the table that has תאריך + (חובה or זכות)
  let dataTable = null;
  for (const t of root.querySelectorAll('table')) {
    const text = t.text;
    if (text.includes('תאריך') && (text.includes('חובה') || text.includes('זכות'))) {
      dataTable = t; break;
    }
  }
  if (!dataTable) {
    console.log('[leumi_transactions] No data table found');
    return { type: 'transactions', transactions: [], sourceType: 'leumi_transactions', stats: { found: 0, imported: 0, skipped: 0 } };
  }

  const tRows = dataTable.querySelectorAll('tr');

  // Locate header row
  let headerIdx = 0;
  for (let i = 0; i < tRows.length; i++) {
    if (tRows[i].text.includes('תאריך') && tRows[i].text.includes('תיאור')) { headerIdx = i; break; }
  }

  const headerCells = tRows[headerIdx].querySelectorAll('th,td').map(td => td.text.trim());
  const ci = h => headerCells.findIndex(c => c.includes(h));
  const colDate    = ci('תאריך');
  const colDesc    = ci('תיאור');
  const colDebit   = ci('חובה');
  const colCredit  = ci('זכות');
  const colBalance = ci('יתרה');
  const colRef     = ci('אסמכתא');

  for (let i = headerIdx + 1; i < tRows.length; i++) {
    found++;
    const cells = tRows[i].querySelectorAll('td').map(td => td.text.trim());
    if (cells.length < 3) { skipped++; continue; }

    const date = normalizeDate(cells[colDate >= 0 ? colDate : 0]);
    if (!date) { skipped++; continue; }
    if (isSummaryRow(cells)) { skipped++; continue; }

    const credit = colCredit >= 0 ? parseNum(cells[colCredit]) : null;
    const debit  = colDebit  >= 0 ? parseNum(cells[colDebit])  : null;

    let amount = 0;
    if (credit !== null && credit !== 0)      amount =  Math.abs(credit);
    else if (debit !== null && debit !== 0)   amount = -Math.abs(debit);
    else { skipped++; continue; }

    transactions.push({
      date,
      description: cells[colDesc >= 0 ? colDesc : 1] ?? '',
      amount,
      balance:   colBalance >= 0 ? parseNum(cells[colBalance]) : null,
      category:  null,
      reference: colRef >= 0 ? cells[colRef] || null : null,
      notes:     null,
      account:   accountName, source: sourceFile, source_type: 'leumi_transactions'
    });
  }

  console.log(`[leumi_transactions] found=${found} imported=${transactions.length} skipped=${skipped}`);
  return { type: 'transactions', transactions, sourceType: 'leumi_transactions', stats: { found, imported: transactions.length, skipped } };
}

// ── Leumi: Balances (HTML-based XLS) ─────────────────────────────────────────
function parseLeumiBalances(filePath, accountName, sourceFile) {
  const { parse } = require('node-html-parser');
  const html = fs.readFileSync(filePath, 'utf8');
  const root = parse(html);

  let checking_balance = null, report_date = null;

  for (const t of root.querySelectorAll('table')) {
    for (const row of t.querySelectorAll('tr')) {
      const text = row.text;
      if (text.includes('עו"ש') || text.includes('עוש')) {
        const cells = row.querySelectorAll('td').map(td => td.text.trim());
        for (const c of cells) {
          const n = parseNum(c);
          if (n !== null && n !== 0) { checking_balance = n; break; }
        }
      }
    }
  }

  console.log(`[leumi_balances] checking_balance=${checking_balance}`);
  return { type: 'profile_data', profileKey: 'balances', profileData: { checking_balance, report_date }, sourceType: 'leumi_balances' };
}

// ── Isracard ──────────────────────────────────────────────────────────────────
// Row 10 (idx 9): headers  Row 11+ (idx 10+): data
function parseIsracard(rows, accountName, sourceFile) {
  let found = 0, skipped = 0;
  const transactions = [];

  for (const row of rows.slice(10)) {
    found++;
    const date = normalizeDate(row[0]);
    if (!date) { skipped++; continue; }
    if (isSummaryRow(row)) { skipped++; continue; }

    const amountRaw = parseNum(row[4]);  // סכום חיוב בש"ח
    if (amountRaw === null) { skipped++; continue; }

    transactions.push({
      date, description: str(row[1]),
      amount:    -Math.abs(amountRaw),
      balance:   null,
      category:  null,
      reference: str(row[6]) || null,
      notes:     str(row[7]) || null,
      account:   accountName, source: sourceFile, source_type: 'isracard_cc'
    });
  }

  console.log(`[isracard_cc] found=${found} imported=${transactions.length} skipped=${skipped}`);
  return { type: 'transactions', transactions, sourceType: 'isracard_cc', stats: { found, imported: transactions.length, skipped } };
}

// ── Max ───────────────────────────────────────────────────────────────────────
// Rows 1-3: metadata  Row 4 (idx 3): headers  Row 5+ (idx 4+): data
function parseMax(rows, accountName, sourceFile) {
  let found = 0, skipped = 0;
  const transactions = [];

  for (const row of rows.slice(4)) {
    found++;
    if (isSummaryRow(row)) { skipped++; continue; }
    const date = normalizeDate(row[0]);
    if (!date) { skipped++; continue; }

    const amountRaw = parseNum(row[5]);  // סכום חיוב
    if (amountRaw === null || amountRaw === 0) { skipped++; continue; }

    const noteParts = [str(row[4]), str(row[10]), str(row[14])].filter(Boolean);

    transactions.push({
      date, description: str(row[1]),
      amount:    -Math.abs(amountRaw),
      balance:   null,
      category:  str(row[2]) || null,
      reference: null,
      notes:     noteParts.join(' | ') || null,
      account:   accountName, source: sourceFile, source_type: 'max_cc'
    });
  }

  console.log(`[max_cc] found=${found} imported=${transactions.length} skipped=${skipped}`);
  return { type: 'transactions', transactions, sourceType: 'max_cc', stats: { found, imported: transactions.length, skipped } };
}

// ── Cal ───────────────────────────────────────────────────────────────────────
// Row 1: header  Row 3: billing date  Row 4 (idx 3): headers  Row 5+ (idx 4+): data
function parseCal(rows, accountName, sourceFile) {
  let found = 0, skipped = 0;
  const transactions = [];

  for (const row of rows.slice(4)) {
    found++;
    const date = normalizeDate(row[0]);
    if (!date) { skipped++; continue; }
    if (isSummaryRow(row)) { skipped++; continue; }

    const amountRaw = parseNum(row[3]);  // סכום חיוב
    if (amountRaw === null) { skipped++; continue; }

    // description: col B, fall back to col F (ענף) if empty
    const desc = str(row[1]) || str(row[5]);
    const noteParts = [str(row[4]), str(row[6])].filter(Boolean);

    transactions.push({
      date, description: desc,
      amount:    -Math.abs(amountRaw),
      balance:   null,
      category:  str(row[5]) || null,
      reference: null,
      notes:     noteParts.join(' | ') || null,
      account:   accountName, source: sourceFile, source_type: 'cal_cc'
    });
  }

  console.log(`[cal_cc] found=${found} imported=${transactions.length} skipped=${skipped}`);
  return { type: 'transactions', transactions, sourceType: 'cal_cc', stats: { found, imported: transactions.length, skipped } };
}

// ── PDF fallback ──────────────────────────────────────────────────────────────
async function parsePdf(filePath, accountName, sourceFile) {
  try {
    const pdfParse = require('pdf-parse');
    const pdfData  = await pdfParse(fs.readFileSync(filePath));
    const lines    = pdfData.text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) {
      return { type: 'transactions', transactions: [], warning: PDF_WARNING, sourceType: 'pdf' };
    }
    const transactions = lines.slice(1).map(line => {
      const parts = line.split(/\s{2,}|\t/);
      const amount = parseNum(parts[2] ?? '0') ?? 0;
      const date   = normalizeDate(parts[0]);
      if (!date) return null;
      return { date, description: parts[1] || line, amount, balance: parseNum(parts[3] ?? '0'),
               category: null, reference: null, notes: null,
               account: accountName, source: sourceFile, source_type: 'pdf' };
    }).filter(Boolean);

    if (!transactions.length)
      return { type: 'transactions', transactions: [], warning: PDF_WARNING, sourceType: 'pdf' };

    console.log(`[pdf] imported=${transactions.length}`);
    return { type: 'transactions', transactions, sourceType: 'pdf' };
  } catch {
    return { type: 'transactions', transactions: [], warning: PDF_WARNING, sourceType: 'pdf' };
  }
}

const PDF_WARNING = 'PDF זה עובד רק על קבצים דיגיטליים (לא סרוקים). אם הנתונים לא נוצרו כראוי, נסה לייצא כ-CSV מהאתר.';

// ── Main entry point ──────────────────────────────────────────────────────────

async function parseFile(filePath, accountName) {
  const ext        = path.extname(filePath).toLowerCase();
  const sourceFile = path.basename(filePath);

  try {
    // PDF
    if (ext === '.pdf') return parsePdf(filePath, accountName, sourceFile);

    // HTML-disguised XLS (Leumi)
    if ((ext === '.xls' || ext === '.xlsx') && isHtmlFile(filePath)) {
      const html = fs.readFileSync(filePath, 'utf8');
      if (html.includes('פירוט יתרות')) return parseLeumiBalances(filePath, accountName, sourceFile);
      return parseLeumiTransactions(filePath, accountName, sourceFile);
    }

    // Read rows
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
    return { type: 'transactions', transactions: [], error: e.message, sourceType: 'error' };
  }
}

module.exports = { parseFile };
