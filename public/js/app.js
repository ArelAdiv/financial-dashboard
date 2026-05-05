'use strict';

// ── State ──────────────────────────────────────────────────────
let profile = null;
let transactions = [];
let chatHistory = [];
let currentStep = 1;
const TOTAL_STEPS = 5;
let pieChart = null;

// ── Init ──────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  const today = new Date();
  document.getElementById('dashboard-date').textContent =
    today.toLocaleDateString('he-IL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  profile = await fetch('/api/profile').then(r => r.json());
  transactions = await fetch('/api/transactions').then(r => r.json());

  if (!profile || !profile.members) {
    showOverlay();
    initWizard();
  } else {
    showApp();
    renderDashboard();
  }

  setupDrop();
  loadApiKey();
});

// ── Overlay / App toggle ───────────────────────────────────────
function showOverlay() {
  document.getElementById('wizard-overlay').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}
function showApp() {
  document.getElementById('wizard-overlay').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}
function openWizard() {
  if (profile) populateWizardFromProfile();
  showOverlay();
}

// ── Views ──────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelector(`[data-view="${name}"]`)?.classList.add('active');
  if (name === 'transactions') renderTransactions();
  if (name === 'accounts') renderAccountsFull();
}

// ── Wizard ─────────────────────────────────────────────────────
function initWizard() {
  currentStep = 1;
  updateWizardUI();
  setTimeout(updateMemberForms, 0);
  updateBankForms();
  updateCCForms();
  updateLoanForms();
  updateSavings();
}

function updateWizardUI() {
  document.querySelectorAll('.wizard-step').forEach((s, i) => {
    s.classList.toggle('active', i + 1 === currentStep);
  });
  document.querySelectorAll('.step').forEach((s, i) => {
    s.classList.remove('active', 'done');
    if (i + 1 < currentStep) s.classList.add('done');
    if (i + 1 === currentStep) s.classList.add('active');
  });
  document.getElementById('step-indicator').textContent = `שלב ${currentStep} מתוך ${TOTAL_STEPS}`;
  document.getElementById('btn-prev').style.visibility = currentStep === 1 ? 'hidden' : 'visible';
  document.getElementById('btn-next').textContent = currentStep === TOTAL_STEPS ? 'סיים ✓' : 'הבא →';
}

function nextStep() {
  if (currentStep === TOTAL_STEPS) {
    saveWizard();
    return;
  }
  currentStep++;
  updateWizardUI();
  if (currentStep === 2) updateBankForms();
  if (currentStep === 3) updateCCForms();
  if (currentStep === 4) updateLoanForms();
}

function prevStep() {
  if (currentStep === 1) return;
  currentStep--;
  updateWizardUI();
}

function updateMemberForms() {
  const adults = parseInt(document.getElementById('w-adults').value) || 1;
  const children = parseInt(document.getElementById('w-children').value) || 0;

  // Adults with income fields
  const ac = document.getElementById('adults-container');
  while (ac.children.length > adults) ac.lastElementChild.remove();
  while (ac.children.length < adults) {
    const i = ac.children.length;
    const div = document.createElement('div');
    div.className = 'member-row adult-row';
    div.dataset.index = i;
    div.innerHTML =
      '<div class="member-title">בעל/ת משק בית #' + (i+1) + (i===0?' (אתה/את)':'') + '</div>' +
      '<div class="field-grid">' +
      '<div class="field"><label>שם</label><input type="text" class="m-name" placeholder="שם פרטי"></div>' +
      '<div class="field"><label>גיל</label><input type="number" class="m-age" min="0" max="120" placeholder="גיל"></div>' +
      '<div class="field"><label>הכנסה חודשית ברוטו (₪)</label><input type="number" class="m-income" min="0" placeholder="0"></div>' +
      '<div class="field"><label>הכנסה נטו (₪)</label><input type="number" class="m-net-income" min="0" placeholder="0"></div>' +
      '</div>';
    ac.appendChild(div);
  }

  // Children - name and age only, no income
  const cc2 = document.getElementById('children-container');
  document.getElementById('children-section').style.display = children > 0 ? '' : 'none';
  while (cc2.children.length > children) cc2.lastElementChild.remove();
  while (cc2.children.length < children) {
    const i = cc2.children.length;
    const div = document.createElement('div');
    div.className = 'member-row child-row';
    div.innerHTML =
      '<div class="member-title">ילד/ה #' + (i+1) + '</div>' +
      '<div class="field-grid">' +
      '<div class="field"><label>שם</label><input type="text" class="m-name" placeholder="שם פרטי"></div>' +
      '<div class="field"><label>גיל</label><input type="number" class="m-age" min="0" max="30" placeholder="גיל"></div>' +
      '</div>';
    cc2.appendChild(div);
  }
}

function makeBankForm(i) {
  const div = document.createElement('div');
  div.className = 'account-form';
  div.innerHTML =
    '<div class="member-title">חשבון #' + (i+1) + '</div>' +
    '<div class="field-grid">' +
    '<div class="field"><label>בנק</label><select class="b-bank">' +
    '<option>פועלים</option><option>לאומי</option><option>דיסקונט</option>' +
    '<option>מזרחי טפחות</option><option>הבינלאומי</option><option>אוצר החייל</option>' +
    '<option>יהב</option><option>ONE ZERO</option><option>אחר</option>' +
    '</select></div>' +
    '<div class="field"><label>סוג חשבון</label><select class="b-type">' +
    '<option value="checking">עו"ש</option><option value="deposit">פיקדון</option><option value="savings">חיסכון</option>' +
    '</select></div>' +
    '<div class="field"><label>שם בעל החשבון (אם שונה)</label><input type="text" class="b-owner" placeholder="אופציונלי"></div>' +
    '</div>';
  return div;
}

function updateBankForms() {
  const count = parseInt(document.getElementById('w-bank-count').value) || 0;
  const c = document.getElementById('banks-container');
  while (c.children.length > count) c.lastElementChild.remove();
  while (c.children.length < count) c.appendChild(makeBankForm(c.children.length));
}

function makeCCForm(i) {
  const div = document.createElement('div');
  div.className = 'account-form';
  div.innerHTML =
    '<div class="member-title">כרטיס #' + (i+1) + '</div>' +
    '<div class="field-grid">' +
    '<div class="field"><label>חברת אשראי</label><select class="cc-company">' +
    '<option>ויזה כאל</option><option>ישראכרט</option><option>מקס</option><option>אמריקן אקספרס</option><option>אחר</option>' +
    '</select></div>' +
    '<div class="field"><label>שם בעל הכרטיס</label><input type="text" class="cc-owner" placeholder="אופציונלי"></div>' +
    '<div class="field"><label>יום חיוב בחודש</label><input type="number" class="cc-day" min="1" max="31" placeholder="10"></div>' +
    '</div>';
  return div;
}

function updateCCForms() {
  const count = parseInt(document.getElementById('w-cc-count').value) || 0;
  const c = document.getElementById('cc-container');
  while (c.children.length > count) c.lastElementChild.remove();
  while (c.children.length < count) c.appendChild(makeCCForm(c.children.length));
}

function makeLoanForm(i) {
  const div = document.createElement('div');
  div.className = 'account-form';
  div.innerHTML =
    '<div class="member-title">הלוואה #' + (i+1) + '</div>' +
    '<div class="field-grid">' +
    '<div class="field"><label>סוג הלוואה</label><select class="l-type">' +
    '<option>הלוואת בנק</option><option>משכנתא</option><option>הלוואת רכב</option>' +
    '<option>הלוואת חברת אשראי</option><option>הלוואה ממעביד</option><option>אחר</option>' +
    '</select></div>' +
    '<div class="field"><label>מטרת ההלוואה</label><input type="text" class="l-purpose" placeholder="לדוגמא: רכב, שיפוץ..."></div>' +
    '<div class="field"><label>איפה ההלוואה (בנק / חברה)</label><input type="text" class="l-lender" placeholder="לדוגמא: בנק פועלים"></div>' +
    '</div>';
  return div;
}

function updateLoanForms() {
  const count = parseInt(document.getElementById('w-loan-count').value) || 0;
  const c = document.getElementById('loans-container');
  while (c.children.length > count) c.lastElementChild.remove();
  while (c.children.length < count) c.appendChild(makeLoanForm(c.children.length));
}

function addSavingsRow() {
  const c = document.getElementById('savings-container');
  const i = c.children.length;
  const div = document.createElement('div');
  div.className = 'account-form';
  div.innerHTML = `
    <div class="field-grid">
      <div class="field"><label>סוג</label>
        <select class="s-type">
          <option value="pension">קרן פנסיה</option><option value="gemel">קופת גמל</option>
          <option value="hishtalmut">קרן השתלמות</option><option value="saving">חיסכון</option>
          <option value="stocks">תיק השקעות</option><option value="crypto">קריפטו</option>
          <option value="real-estate">נדל"ן</option><option value="other">אחר</option>
        </select></div>
      <div class="field"><label>שם / חברה</label><input type="text" class="s-name" placeholder="לדוגמא: מנורה מבטחים"></div>
      <div class="field"><label>יתרה (₪)</label><input type="number" class="s-balance" placeholder="0"></div>
      <div class="field"><label>הפקדה חודשית (₪)</label><input type="number" class="s-monthly" placeholder="0"></div>
    </div>`;
  c.appendChild(div);
}

function updateSavings() {} // first row already in HTML

function collectWizardData() {
  const adults = Array.from(document.querySelectorAll('.adult-row')).map(r => ({
    name: r.querySelector('.m-name')?.value || '',
    age: parseInt(r.querySelector('.m-age')?.value) || 0,
    income: parseFloat(r.querySelector('.m-income')?.value) || 0,
    netIncome: parseFloat(r.querySelector('.m-net-income')?.value) || 0,
    isAdult: true
  }));
  const children = Array.from(document.querySelectorAll('.child-row')).map(r => ({
    name: r.querySelector('.m-name')?.value || '',
    age: parseInt(r.querySelector('.m-age')?.value) || 0,
    income: 0, netIncome: 0, isAdult: false
  }));
  const members = [...adults, ...children];

  const banks = Array.from(document.querySelectorAll('#banks-container .account-form')).map(r => ({
    bank: r.querySelector('.b-bank')?.value || '',
    type: r.querySelector('.b-type')?.value || 'checking',
    owner: r.querySelector('.b-owner')?.value || '',
    balance: 0, creditLine: 0
  }));

  const creditCards = Array.from(document.querySelectorAll('#cc-container .account-form')).map(r => ({
    company: r.querySelector('.cc-company')?.value || '',
    owner: r.querySelector('.cc-owner')?.value || '',
    day: parseInt(r.querySelector('.cc-day')?.value) || 10,
    monthly: 0, limit: 0
  }));

  const loans = Array.from(document.querySelectorAll('#loans-container .account-form')).map(r => ({
    type: r.querySelector('.l-type')?.value || '',
    purpose: r.querySelector('.l-purpose')?.value || '',
    lender: r.querySelector('.l-lender')?.value || '',
    balance: 0, monthly: 0, rate: 0, remaining: 0
  }));

  const savings = Array.from(document.querySelectorAll('#savings-container .account-form')).map(r => ({
    type: r.querySelector('.s-type')?.value || '',
    name: r.querySelector('.s-name')?.value || '',
    monthly: parseFloat(r.querySelector('.s-monthly')?.value) || 0,
    balance: 0
  }));

  return {
    adultsCount: parseInt(document.getElementById('w-adults').value) || 1,
    childrenCount: parseInt(document.getElementById('w-children').value) || 0,
    householdSize: (parseInt(document.getElementById('w-adults').value)||1) + (parseInt(document.getElementById('w-children').value)||0),
    maritalStatus: document.getElementById('w-status').value,
    members,
    banks,
    creditCards,
    loans,
    savings,
    goals: document.getElementById('w-goals').value
  };
}

async function saveWizard() {
  const data = collectWizardData();
  await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  profile = await fetch('/api/profile').then(r => r.json());
  showApp();
  renderDashboard();
}

function populateWizardFromProfile() {
  if (!profile) return;
  document.getElementById('w-adults').value = profile.adultsCount || 1;
  document.getElementById('w-children').value = profile.childrenCount || 0;
  document.getElementById('w-status').value = profile.maritalStatus || 'single';
  document.getElementById('w-bank-count').value = profile.banks?.length || 0;
  document.getElementById('w-cc-count').value = profile.creditCards?.length || 0;
  document.getElementById('w-loan-count').value = profile.loans?.length || 0;
  document.getElementById('w-goals').value = profile.goals || '';
  setTimeout(() => {
    updateMemberForms();
    (profile.members || []).forEach((m, i) => {
      const rows = document.querySelectorAll('.member-row');
      if (rows[i]) {
        rows[i].querySelector('.m-name').value = m.name || '';
        rows[i].querySelector('.m-age').value = m.age || '';
        rows[i].querySelector('.m-income').value = m.income || '';
        rows[i].querySelector('.m-net-income').value = m.netIncome || '';
      }
    });
  }, 50);
}

// ── Dashboard Render ────────────────────────────────────────────
function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return '₪ —';
  return '₪ ' + Math.round(n).toLocaleString('he-IL');
}

function renderDashboard() {
  if (!profile) return;

  // greeting
  const name = profile.members?.[0]?.name;
  document.getElementById('dashboard-greeting').textContent = name ? `שלום, ${name}` : 'דשבורד פיננסי';

  // metrics
  const bankAssets = (profile.banks || []).filter(b => b.balance > 0).reduce((s, b) => s + b.balance, 0);
  const bankNeg = (profile.banks || []).filter(b => b.balance < 0).reduce((s, b) => s + Math.abs(b.balance), 0);
  const savingsTotal = (profile.savings || []).reduce((s, b) => s + (b.balance || 0), 0);
  const loanTotal = (profile.loans || []).reduce((s, l) => s + (l.balance || 0), 0);
  const ccDebt = (profile.creditCards || []).reduce((s, c) => s + (c.monthly || 0), 0);
  const totalAssets = bankAssets + savingsTotal;
  const totalLiab = loanTotal + bankNeg;
  const netWorth = totalAssets - totalLiab;
  const totalNetIncome = (profile.members || []).reduce((s, m) => s + (m.netIncome || 0), 0);
  const loanMonthly = (profile.loans || []).reduce((s, l) => s + (l.monthly || 0), 0);
  const savingsMonthly = (profile.savings || []).reduce((s, s2) => s + (s2.monthly || 0), 0);

  document.getElementById('m-assets').textContent = fmt(totalAssets);
  document.getElementById('m-liab').textContent = fmt(totalLiab);
  document.getElementById('m-net').textContent = fmt(netWorth);
  document.getElementById('m-net').className = 'metric-value ' + (netWorth >= 0 ? 'green' : 'red');
  document.getElementById('m-income').textContent = fmt(totalNetIncome);
  document.getElementById('m-loans').textContent = fmt(loanMonthly);
  document.getElementById('m-saving').textContent = fmt(savingsMonthly);

  // bank cards
  renderAccountSection('dash-banks', (profile.banks || []).map(b => ({
    icon: '🏦', name: b.bank, type: typeLabel(b.type), balance: b.balance,
    detail: b.creditLine ? `מסגרת: ${fmt(b.creditLine)}` : ''
  })));

  renderAccountSection('dash-cc', (profile.creditCards || []).map(c => ({
    icon: '💳', name: c.company, type: 'כרטיס אשראי',
    balance: -c.monthly, detail: `חיוב חודשי | תקרה: ${fmt(c.limit)}`
  })));

  renderAccountSection('dash-savings', (profile.savings || []).map(s => ({
    icon: savingsIcon(s.type), name: s.name || savingsLabel(s.type), type: savingsLabel(s.type),
    balance: s.balance, detail: s.monthly ? `הפקדה חודשית: ${fmt(s.monthly)}` : ''
  })));

  renderAccountSection('dash-loans', (profile.loans || []).map(l => ({
    icon: '📋', name: l.type, type: l.purpose || 'הלוואה פעילה',
    balance: -l.balance, detail: `החזר חודשי: ${fmt(l.monthly)} | ${l.remaining} תשלומים`
  })));

  renderPieChart(bankAssets, savingsTotal, totalLiab);
}

function renderAccountSection(id, items) {
  const el = document.getElementById(id);
  if (!items.length) { el.innerHTML = '<div class="empty-state">לא הוגדרו נתונים</div>'; return; }
  el.innerHTML = items.map(item => `
    <div class="account-item">
      <div class="account-icon">${item.icon}</div>
      <div class="account-info">
        <div class="account-name">${item.name}</div>
        <div class="account-type">${item.type}</div>
        ${item.detail ? `<div class="account-detail">${item.detail}</div>` : ''}
      </div>
      <div class="account-balance ${item.balance >= 0 ? 'pos' : 'neg'}">${fmt(Math.abs(item.balance))}</div>
    </div>`).join('');
}

function typeLabel(t) {
  return { checking: 'עו"ש', deposit: 'פיקדון', savings: 'חיסכון' }[t] || t;
}
function savingsLabel(t) {
  return { pension: 'קרן פנסיה', gemel: 'קופת גמל', hishtalmut: 'קרן השתלמות', saving: 'חיסכון', stocks: 'תיק השקעות', crypto: 'קריפטו', 'real-estate': 'נדל"ן' }[t] || 'חיסכון';
}
function savingsIcon(t) {
  return { pension: '🏛', gemel: '💰', hishtalmut: '📈', saving: '🏦', stocks: '📊', crypto: '₿', 'real-estate': '🏠' }[t] || '💰';
}

function renderPieChart(bank, savings, liab) {
  const ctx = document.getElementById('chart-pie')?.getContext('2d');
  if (!ctx) return;
  const data = [
    { label: 'עו"ש ובנק', value: bank, color: '#2563eb' },
    { label: 'חיסכון ופנסיה', value: savings, color: '#16a34a' },
    { label: 'התחייבויות', value: liab, color: '#dc2626' }
  ].filter(d => d.value > 0);

  if (pieChart) pieChart.destroy();
  pieChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: data.map(d => d.label),
      datasets: [{ data: data.map(d => d.value), backgroundColor: data.map(d => d.color), borderWidth: 2, borderColor: '#fff' }]
    },
    options: {
      responsive: false, cutout: '65%',
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + fmt(ctx.raw) } } }
    }
  });

  document.getElementById('chart-legend').innerHTML = data.map(d => `
    <div style="display:flex;align-items:center;gap:8px;font-size:13px">
      <span style="width:12px;height:12px;border-radius:3px;background:${d.color};flex-shrink:0"></span>
      <span style="flex:1;color:#666">${d.label}</span>
      <span style="font-weight:600">${fmt(d.value)}</span>
    </div>`).join('');
}

// ── Accounts full view ─────────────────────────────────────────
function renderAccountsFull() {
  const el = document.getElementById('accounts-full');
  if (!profile) { el.innerHTML = '<div class="empty-state">עדיין לא הוגדר פרופיל</div>'; return; }
  const sections = [
    { title: 'חשבונות בנק', items: (profile.banks || []).map(b => ({ icon: '🏦', name: b.bank, type: typeLabel(b.type), balance: b.balance, detail: b.creditLine ? `מסגרת אשראי: ${fmt(b.creditLine)}` : '' })) },
    { title: 'כרטיסי אשראי', items: (profile.creditCards || []).map(c => ({ icon: '💳', name: c.company, type: 'כרטיס אשראי', balance: -c.monthly, detail: `חיוב ממוצע | תקרה: ${fmt(c.limit)} | יום חיוב ${c.day}` })) },
    { title: 'חיסכון, גמל, פנסיה', items: (profile.savings || []).map(s => ({ icon: savingsIcon(s.type), name: s.name || savingsLabel(s.type), type: savingsLabel(s.type), balance: s.balance, detail: s.monthly ? `הפקדה חודשית: ${fmt(s.monthly)}` : '' })) },
    { title: 'הלוואות', items: (profile.loans || []).map(l => ({ icon: '📋', name: l.type, type: l.purpose || 'הלוואה', balance: -l.balance, detail: `החזר: ${fmt(l.monthly)}/חודש | ריבית: ${l.rate}% | ${l.remaining} תשלומים` })) }
  ];
  el.innerHTML = sections.map(s => `
    <div class="card" style="margin-bottom:12px">
      <div class="card-header"><h3>${s.title}</h3></div>
      <div class="account-list">${s.items.length
        ? s.items.map(item => `
          <div class="account-item">
            <div class="account-icon">${item.icon}</div>
            <div class="account-info">
              <div class="account-name">${item.name}</div>
              <div class="account-type">${item.type}</div>
              ${item.detail ? `<div class="account-detail">${item.detail}</div>` : ''}
            </div>
            <div class="account-balance ${item.balance >= 0 ? 'pos' : 'neg'}">${fmt(Math.abs(item.balance))}</div>
          </div>`).join('')
        : '<div class="empty-state">לא הוגדרו נתונים</div>'
      }</div>
    </div>`).join('');
}

// ── Transactions ───────────────────────────────────────────────
function renderTransactions() {
  const allAccounts = [...new Set(transactions.map(t => t.account))];
  const sel = document.getElementById('tx-filter-account');
  sel.innerHTML = '<option value="">כל החשבונות</option>' +
    allAccounts.map(a => `<option value="${a}">${a}</option>`).join('');
  filterTransactions();
}

function filterTransactions() {
  const acct = document.getElementById('tx-filter-account').value;
  const search = document.getElementById('tx-search').value.toLowerCase();
  let filtered = transactions;
  if (acct) filtered = filtered.filter(t => t.account === acct);
  if (search) filtered = filtered.filter(t => (t.description || '').toLowerCase().includes(search));

  const body = document.getElementById('tx-body');
  const empty = document.getElementById('tx-empty');

  if (!filtered.length) {
    body.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  body.innerHTML = filtered.slice(0, 500).map(t => `
    <tr>
      <td style="color:#666;white-space:nowrap">${t.date || '—'}</td>
      <td>${t.description || '—'}</td>
      <td style="color:#999;font-size:12px">${t.account || ''}</td>
      <td class="tx-amount ${t.amount >= 0 ? 'pos' : 'neg'}">${t.amount >= 0 ? '+' : ''}${Math.round(t.amount).toLocaleString('he-IL')}</td>
      <td class="tx-amount" style="color:#999">${t.balance ? Math.round(t.balance).toLocaleString('he-IL') : '—'}</td>
    </tr>`).join('');
}

// ── Upload ─────────────────────────────────────────────────────
async function handleUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const accountName = document.getElementById('upload-account-name').value || file.name;
  const formData = new FormData();
  formData.append('file', file);
  formData.append('accountName', accountName);

  const status = document.getElementById('upload-status');
  status.innerHTML = '<div style="color:#666;font-size:13px">מעלה ומנתח...</div>';

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.ok) {
      transactions = await fetch('/api/transactions').then(r => r.json());
      status.innerHTML = `<div class="upload-success">✓ נטענו בהצלחה ${data.rows} שורות מ-${data.filename}</div>`;
    } else {
      status.innerHTML = `<div class="upload-error">שגיאה: ${data.error}</div>`;
    }
  } catch (e) {
    status.innerHTML = `<div class="upload-error">שגיאה בהעלאה: ${e.message}</div>`;
  }
  event.target.value = '';
}

function setupDrop() {
  const dz = document.getElementById('drop-zone');
  if (!dz) return;
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', async e => {
    e.preventDefault(); dz.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const accountName = document.getElementById('upload-account-name').value || file.name;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('accountName', accountName);
    const status = document.getElementById('upload-status');
    status.innerHTML = '<div style="color:#666;font-size:13px">מעלה ומנתח...</div>';
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.ok) {
        transactions = await fetch('/api/transactions').then(r => r.json());
        status.innerHTML = `<div class="upload-success">✓ נטענו ${data.rows} שורות מ-${data.filename}</div>`;
      }
    } catch (e) {
      status.innerHTML = `<div class="upload-error">שגיאה: ${e.message}</div>`;
    }
  });
}

// ── AI Agent ───────────────────────────────────────────────────
function loadApiKey() {
  const key = localStorage.getItem('anthropic_key');
  if (key) {
    document.getElementById('api-key-input').value = key;
    document.getElementById('api-key-notice').style.display = 'none';
  }
}
function saveApiKey() {
  const key = document.getElementById('api-key-input').value.trim();
  if (key) {
    localStorage.setItem('anthropic_key', key);
    document.getElementById('api-key-notice').style.display = 'none';
    alert('מפתח נשמר ✓');
  }
}

function buildSystemContext() {
  if (!profile) return 'אין פרופיל פיננסי.';
  const adultMembers = (profile.members || []).filter(m => m.isAdult !== false);
  const childMembers = (profile.members || []).filter(m => m.isAdult === false);
  const members = adultMembers.map(m => m.name + ' גיל ' + m.age + ', הכנסה ברוטו ' + fmt(m.income) + ', נטו ' + fmt(m.netIncome)).join(' | ');
  const childrenStr = childMembers.length ? childMembers.map(m => m.name + ' גיל ' + m.age).join(', ') : '';
  const banks = (profile.banks || []).map(b => `${b.bank} ${typeLabel(b.type)}: ${fmt(b.balance)} (מסגרת: ${fmt(b.creditLine)})`).join(' | ');
  const cc = (profile.creditCards || []).map(c => `${c.company}: חיוב ממוצע ${fmt(c.monthly)}, תקרה ${fmt(c.limit)}`).join(' | ');
  const loans = (profile.loans || []).map(l => `${l.type} (${l.purpose}): יתרה ${fmt(l.balance)}, החזר ${fmt(l.monthly)}/חודש, ריבית ${l.rate}%, ${l.remaining} תשלומים`).join(' | ');
  const savings = (profile.savings || []).map(s => `${s.name || savingsLabel(s.type)} (${savingsLabel(s.type)}): ${fmt(s.balance)}, הפקדה חודשית ${fmt(s.monthly)}`).join(' | ');
  const txSummary = transactions.length ? `\n\n— עסקאות: ${transactions.length} רשומות ממוצע חודשי לא מחושב, בקש ממני לנתח לפי תקופה ספציפית.` : '';

  const bankAssets = (profile.banks || []).filter(b => b.balance > 0).reduce((s, b) => s + b.balance, 0);
  const savingsTotal = (profile.savings || []).reduce((s, b) => s + (b.balance || 0), 0);
  const loanTotal = (profile.loans || []).reduce((s, l) => s + (l.balance || 0), 0);
  const netIncome = (profile.members || []).reduce((s, m) => s + (m.netIncome || 0), 0);
  const loanMonthly = (profile.loans || []).reduce((s, l) => s + (l.monthly || 0), 0);
  const ccMonthly = (profile.creditCards || []).reduce((s, c) => s + (c.monthly || 0), 0);

  return `אתה סוכן פיננסי אישי מקצועי. אתה מדבר עברית שוטפת ונותן המלצות ברורות ומספריות.

=== פרופיל משק הבית ===
גודל: ${profile.householdSize} נפשות | סטטוס: ${profile.maritalStatus}
בני משק בית: ${members || 'לא הוגדרו'}\nילדים: ${childrenStr || 'אין'}
מטרות: ${profile.goals || 'לא הוגדרו'}

=== נתונים פיננסיים ===
חשבונות בנק: ${banks || 'אין'}
כרטיסי אשראי: ${cc || 'אין'}
הלוואות: ${loans || 'אין'}
חיסכון/השקעות: ${savings || 'אין'}

=== סיכום מהיר ===
נכסים: ${fmt(bankAssets + savingsTotal)} | חובות: ${fmt(loanTotal)} | הון עצמי: ${fmt(bankAssets + savingsTotal - loanTotal)}
הכנסה נטו חודשית: ${fmt(netIncome)} | החזרי הלוואות: ${fmt(loanMonthly)} | הוצאות אשראי ממוצע: ${fmt(ccMonthly)}
יחס חוב להכנסה: ${netIncome > 0 ? ((loanMonthly / netIncome) * 100).toFixed(1) + '%' : 'לא ניתן לחשב'}
${txSummary}

כשעונים על שאלות:
- היה ספציפי ומספרי
- תמיד ציין את הנחות העבודה שלך
- תן המלצות ברות-ביצוע עם תעדוף
- כשמזהה סיכון — הסבר את הפתרון
- אם חסרים נתונים — ציין בדיוק מה חסר`;
}

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  const key = localStorage.getItem('anthropic_key');
  if (!key) { alert('יש להזין API Key תחילה'); return; }
  input.value = '';
  appendMsg('user', msg);
  chatHistory.push({ role: 'user', content: msg });
  await callAI(key);
}

function quickAsk(q) {
  showView('agent');
  document.getElementById('chat-input').value = q;
  sendMessage();
}

function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function appendMsg(role, text) {
  const c = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = `<div class="msg-who">${role === 'user' ? 'אתה' : 'סוכן פיננסי'}</div><div class="msg-bubble">${text}</div>`;
  c.appendChild(div);
  c.scrollTop = c.scrollHeight;
  return div.querySelector('.msg-bubble');
}

async function callAI(apiKey) {
  const btn = document.getElementById('send-btn');
  btn.disabled = true;
  const thinkDiv = document.createElement('div');
  thinkDiv.className = 'msg ai';
  thinkDiv.innerHTML = `<div class="msg-who">סוכן פיננסי</div><div class="msg-bubble"><div class="thinking-dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div>`;
  document.getElementById('chat-messages').appendChild(thinkDiv);
  document.getElementById('chat-messages').scrollTop = 9999;

  try {
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ messages: chatHistory.slice(-10), systemContext: buildSystemContext() })
    });
    const data = await res.json();
    thinkDiv.remove();
    const text = data.content?.[0]?.text || 'שגיאה בקבלת תשובה';
    appendMsg('ai', text);
    chatHistory.push({ role: 'assistant', content: text });
  } catch (e) {
    thinkDiv.remove();
    appendMsg('ai', 'שגיאה בחיבור לשרת AI: ' + e.message);
  }
  btn.disabled = false;
}
