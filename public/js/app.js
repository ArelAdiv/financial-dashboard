'use strict';

let profile = null;
let transactions = [];
let chatHistory = [];
let currentStep = 1;
const TOTAL_STEPS = 5;
let pieChart = null;

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('dashboard-date').textContent =
    new Date().toLocaleDateString('he-IL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

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

// ── Overlay / App toggle ──────────────────────────────────────────────────────
function showOverlay() {
  document.getElementById('wizard-overlay').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}
function showApp() {
  document.getElementById('wizard-overlay').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}
function openWizard() {
  if (profile && profile.members) populateWizardFromProfile();
  else initWizard();
  showOverlay();
}

// ── Views ─────────────────────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelector(`[data-view="${name}"]`)?.classList.add('active');
  if (name === 'transactions') renderTransactions();
  if (name === 'accounts') renderAccountsFull();
  if (name === 'upload') { loadUploads(); loadAccountsMgmt(); }
}

// ── Wizard ────────────────────────────────────────────────────────────────────
function initWizard() {
  currentStep = 1;
  updateWizardUI();
  setTimeout(updateMemberForms, 0);
  updateBankForms();
  updateCCForms();
  updateLoanForms();
  const c = document.getElementById('savings-container');
  c.innerHTML = '';
  c.appendChild(makeSavingsRow(0));
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
  if (!validateStep(currentStep)) return;
  if (currentStep === TOTAL_STEPS) { saveWizard(); return; }
  currentStep++;
  updateWizardUI();
  if (currentStep === 2) updateBankForms();
  if (currentStep === 3) updateCCForms();
  if (currentStep === 4) updateLoanForms();
}

function prevStep() {
  if (currentStep === 1) return;
  clearErrors();
  currentStep--;
  updateWizardUI();
}

// ── Step Validation ───────────────────────────────────────────────────────────
function validateStep(step) {
  clearErrors();
  let valid = true;

  if (step === 1) {
    const statusEl = document.getElementById('w-status');
    const adultsEl = document.getElementById('w-adults');
    if (!statusEl.value) { showError(statusEl, 'שדה חובה'); valid = false; }
    const adultsCount = parseInt(adultsEl.value);
    if (!adultsCount || adultsCount < 1) { showError(adultsEl, 'נדרש לפחות בעל משק בית אחד'); valid = false; }
    document.querySelectorAll('.adult-row').forEach(row => {
      const nameEl = row.querySelector('.m-name');
      const ageEl = row.querySelector('.m-age');
      if (!nameEl.value.trim()) { showError(nameEl, 'שם חובה'); valid = false; }
      const age = parseInt(ageEl.value);
      if (!ageEl.value || age < 18 || age > 120) { showError(ageEl, 'גיל חובה (18–120)'); valid = false; }
    });
  }

  if (step === 2) {
    document.querySelectorAll('#banks-container .account-form').forEach(form => {
      const bankEl = form.querySelector('.b-bank');
      if (!bankEl.value) { showError(bankEl, 'נדרש לבחור בנק'); valid = false; }
      const checked = form.querySelectorAll('.b-usage:checked');
      if (!checked.length) {
        const container = form.querySelector('.usage-checkboxes');
        showError(container, 'נדרש לסמן לפחות אופן שימוש אחד');
        valid = false;
      }
    });
  }

  if (step === 3) {
    document.querySelectorAll('#cc-container .account-form').forEach(form => {
      const el = form.querySelector('.cc-company');
      if (!el.value) { showError(el, 'נדרש לבחור חברת אשראי'); valid = false; }
    });
  }

  if (step === 4) {
    document.querySelectorAll('#loans-container .account-form').forEach(form => {
      const el = form.querySelector('.l-type');
      if (!el.value) { showError(el, 'נדרש לבחור סוג הלוואה'); valid = false; }
    });
  }

  if (step === 5) {
    document.querySelectorAll('#savings-container .account-form').forEach(form => {
      const typeEl = form.querySelector('.s-type');
      const nameEl = form.querySelector('.s-name');
      if (!typeEl.value) { showError(typeEl, 'נדרש לבחור סוג'); valid = false; }
      if (!nameEl.value.trim()) { showError(nameEl, 'שם/חברה חובה'); valid = false; }
      if (typeEl.value === 'other') {
        const customEl = form.querySelector('.s-custom-type');
        if (customEl && !customEl.value.trim()) { showError(customEl, 'נדרש לפרט את הסוג'); valid = false; }
      }
    });
  }

  return valid;
}

function showError(el, msg) {
  if (!el) return;
  el.classList.add('error-field');
  const errDiv = document.createElement('div');
  errDiv.className = 'field-error';
  errDiv.textContent = msg;
  el.parentNode.appendChild(errDiv);
}

function clearErrors() {
  document.querySelectorAll('.error-field').forEach(el => el.classList.remove('error-field'));
  document.querySelectorAll('.field-error').forEach(el => el.remove());
}

// ── Member forms ──────────────────────────────────────────────────────────────
function updateMemberForms() {
  const adults = parseInt(document.getElementById('w-adults').value) || 1;
  const children = parseInt(document.getElementById('w-children').value) || 0;

  const ac = document.getElementById('adults-container');
  while (ac.children.length > adults) ac.lastElementChild.remove();
  while (ac.children.length < adults) {
    const i = ac.children.length;
    const div = document.createElement('div');
    div.className = 'member-row adult-row';
    div.innerHTML =
      '<div class="member-title">בעל/ת משק בית #' + (i + 1) + (i === 0 ? ' (אתה/את)' : '') + '</div>' +
      '<div class="field-grid">' +
      '<div class="field"><label>שם <span class="req">*</span></label><input type="text" class="m-name" placeholder="שם פרטי"></div>' +
      '<div class="field"><label>גיל <span class="req">*</span></label><input type="number" class="m-age" min="18" max="120" placeholder="גיל"></div>' +
      '</div>';
    ac.appendChild(div);
  }

  const cc2 = document.getElementById('children-container');
  document.getElementById('children-section').style.display = children > 0 ? '' : 'none';
  while (cc2.children.length > children) cc2.lastElementChild.remove();
  while (cc2.children.length < children) {
    const i = cc2.children.length;
    const div = document.createElement('div');
    div.className = 'member-row child-row';
    div.innerHTML =
      '<div class="member-title">ילד/ה #' + (i + 1) + '</div>' +
      '<div class="field-grid">' +
      '<div class="field"><label>שם</label><input type="text" class="m-name" placeholder="שם פרטי"></div>' +
      '<div class="field"><label>גיל</label><input type="number" class="m-age" min="0" max="17" placeholder="גיל"></div>' +
      '</div>';
    cc2.appendChild(div);
  }
}

// ── Remove form row ───────────────────────────────────────────────────────────
function removeForm(btn) {
  const form = btn.closest('.account-form');
  if (!form) return;
  const container = form.parentElement;
  form.remove();
  const countMap = { 'banks-container': 'w-bank-count', 'cc-container': 'w-cc-count', 'loans-container': 'w-loan-count' };
  if (countMap[container.id]) document.getElementById(countMap[container.id]).value = container.children.length;
}

// ── Bank forms ────────────────────────────────────────────────────────────────
function makeBankForm(i) {
  const div = document.createElement('div');
  div.className = 'account-form';
  div.innerHTML =
    '<div class="form-title-row"><div class="member-title">חשבון #' + (i + 1) + '</div>' +
    '<button type="button" class="remove-form-btn" onclick="removeForm(this)">✕ הסר</button></div>' +
    '<div class="field-grid">' +
    '<div class="field"><label>בנק <span class="req">*</span></label>' +
    '<select class="b-bank">' +
    '<option value="">-- בחר --</option>' +
    '<option>פועלים</option><option>לאומי</option><option>דיסקונט</option>' +
    '<option>מזרחי טפחות</option><option>הבינלאומי</option><option>אוצר החייל</option>' +
    '<option>יהב</option><option>ONE ZERO</option><option>אחר</option>' +
    '</select></div>' +
    '<div class="field"><label>שם בעל החשבון (אם שונה)</label>' +
    '<input type="text" class="b-owner" placeholder="אופציונלי"></div>' +
    '</div>' +
    '<div class="field">' +
    '<label>אופן שימוש <span class="req">*</span></label>' +
    '<div class="usage-checkboxes">' +
    '<label class="checkbox-label"><input type="checkbox" class="b-usage" value="checking"> עו"ש</label>' +
    '<label class="checkbox-label"><input type="checkbox" class="b-usage" value="saving"> חיסכון</label>' +
    '<label class="checkbox-label"><input type="checkbox" class="b-usage" value="deposit"> פיקדון</label>' +
    '<label class="checkbox-label"><input type="checkbox" class="b-usage" value="mortgage"> משכנתא</label>' +
    '<label class="checkbox-label"><input type="checkbox" class="b-usage" value="loans"> הלוואות</label>' +
    '<label class="checkbox-label"><input type="checkbox" class="b-usage" value="investments"> השקעות</label>' +
    '<label class="checkbox-label"><input type="checkbox" class="b-usage" value="business"> עסקי</label>' +
    '</div></div>';
  return div;
}

function updateBankForms() {
  const count = parseInt(document.getElementById('w-bank-count').value) || 0;
  const c = document.getElementById('banks-container');
  while (c.children.length > count) c.lastElementChild.remove();
  while (c.children.length < count) c.appendChild(makeBankForm(c.children.length));
}

// ── Credit card forms ─────────────────────────────────────────────────────────
function makeCCForm(i) {
  const div = document.createElement('div');
  div.className = 'account-form';
  div.innerHTML =
    '<div class="form-title-row"><div class="member-title">כרטיס #' + (i + 1) + '</div>' +
    '<button type="button" class="remove-form-btn" onclick="removeForm(this)">✕ הסר</button></div>' +
    '<div class="field-grid">' +
    '<div class="field"><label>חברת אשראי <span class="req">*</span></label>' +
    '<select class="cc-company">' +
    '<option value="">-- בחר --</option>' +
    '<option>ויזה כאל</option><option>ישראכרט</option><option>מקס</option>' +
    '<option>אמריקן אקספרס</option><option>אחר</option>' +
    '</select></div>' +
    '<div class="field"><label>שם בעל הכרטיס (אם שונה)</label>' +
    '<input type="text" class="cc-owner" placeholder="אופציונלי"></div>' +
    '<div class="field"><label>יום חיוב בחודש</label>' +
    '<input type="number" class="cc-day" min="1" max="31" placeholder="10"></div>' +
    '</div>';
  return div;
}

function updateCCForms() {
  const count = parseInt(document.getElementById('w-cc-count').value) || 0;
  const c = document.getElementById('cc-container');
  while (c.children.length > count) c.lastElementChild.remove();
  while (c.children.length < count) c.appendChild(makeCCForm(c.children.length));
}

// ── Loan forms ────────────────────────────────────────────────────────────────
function makeLoanForm(i) {
  const div = document.createElement('div');
  div.className = 'account-form';
  div.innerHTML =
    '<div class="form-title-row"><div class="member-title">הלוואה #' + (i + 1) + '</div>' +
    '<button type="button" class="remove-form-btn" onclick="removeForm(this)">✕ הסר</button></div>' +
    '<div class="field-grid">' +
    '<div class="field"><label>סוג הלוואה <span class="req">*</span></label>' +
    '<select class="l-type">' +
    '<option value="">-- בחר --</option>' +
    '<option>הלוואת בנק</option><option>משכנתא</option><option>הלוואת רכב</option>' +
    '<option>הלוואת חברת אשראי</option><option>הלוואה ממעביד</option><option>אחר</option>' +
    '</select></div>' +
    '<div class="field"><label>מטרת ההלוואה</label>' +
    '<input type="text" class="l-purpose" placeholder="לדוגמא: רכב, שיפוץ..."></div>' +
    '<div class="field"><label>איפה ההלוואה (בנק / חברה)</label>' +
    '<input type="text" class="l-lender" placeholder="לדוגמא: בנק פועלים"></div>' +
    '</div>';
  return div;
}

function updateLoanForms() {
  const count = parseInt(document.getElementById('w-loan-count').value) || 0;
  const c = document.getElementById('loans-container');
  while (c.children.length > count) c.lastElementChild.remove();
  while (c.children.length < count) c.appendChild(makeLoanForm(c.children.length));
}

// ── Savings forms ─────────────────────────────────────────────────────────────
function makeSavingsRow(i) {
  const div = document.createElement('div');
  div.className = 'account-form';
  div.innerHTML =
    '<div class="form-title-row"><div class="member-title">חיסכון/השקעה #' + (i + 1) + '</div>' +
    '<button type="button" class="remove-form-btn" onclick="removeForm(this)">✕ הסר</button></div>' +
    '<div class="field-grid">' +
    '<div class="field"><label>סוג <span class="req">*</span></label>' +
    '<select class="s-type" onchange="toggleCustomType(this)">' +
    '<option value="">-- בחר --</option>' +
    '<option value="pension">קרן פנסיה</option>' +
    '<option value="gemel">קופת גמל</option>' +
    '<option value="hishtalmut">קרן השתלמות</option>' +
    '<option value="saving">חיסכון</option>' +
    '<option value="stocks">תיק השקעות / מניות</option>' +
    '<option value="crypto">קריפטו</option>' +
    '<option value="real-estate">נדל"ן</option>' +
    '<option value="other">אחר</option>' +
    '</select>' +
    '<div class="custom-type-wrap" style="display:none;margin-top:6px">' +
    '<label>פרט סוג: <span class="req">*</span></label>' +
    '<input type="text" class="s-custom-type" placeholder="תיאור הסוג">' +
    '</div></div>' +
    '<div class="field"><label>שם / חברה <span class="req">*</span></label>' +
    '<input type="text" class="s-name" placeholder="לדוגמא: מנורה מבטחים"></div>' +
    '<div class="field"><label>עבור מה? (אופציונלי)</label>' +
    '<input type="text" class="s-goal" placeholder="מטרת החיסכון / שם החיסכון"></div>' +
    '</div>';
  return div;
}

function toggleCustomType(select) {
  const wrap = select.parentNode.querySelector('.custom-type-wrap');
  if (wrap) wrap.style.display = select.value === 'other' ? 'block' : 'none';
}

function addSavingsRow() {
  const c = document.getElementById('savings-container');
  c.appendChild(makeSavingsRow(c.children.length));
}

// ── Collect & Save wizard ─────────────────────────────────────────────────────
function collectWizardData() {
  const adults = Array.from(document.querySelectorAll('.adult-row')).map(r => ({
    name: r.querySelector('.m-name')?.value.trim() || '',
    age: parseInt(r.querySelector('.m-age')?.value) || 0,
    isAdult: true
  }));
  const children = Array.from(document.querySelectorAll('.child-row')).map(r => ({
    name: r.querySelector('.m-name')?.value.trim() || '',
    age: parseInt(r.querySelector('.m-age')?.value) || 0,
    isAdult: false
  }));

  const banks = Array.from(document.querySelectorAll('#banks-container .account-form')).map(r => ({
    bank: r.querySelector('.b-bank')?.value || '',
    usage: Array.from(r.querySelectorAll('.b-usage:checked')).map(cb => cb.value),
    owner: r.querySelector('.b-owner')?.value.trim() || ''
  }));

  const creditCards = Array.from(document.querySelectorAll('#cc-container .account-form')).map(r => ({
    company: r.querySelector('.cc-company')?.value || '',
    owner: r.querySelector('.cc-owner')?.value.trim() || '',
    day: parseInt(r.querySelector('.cc-day')?.value) || null
  }));

  const loans = Array.from(document.querySelectorAll('#loans-container .account-form')).map(r => ({
    type: r.querySelector('.l-type')?.value || '',
    purpose: r.querySelector('.l-purpose')?.value.trim() || '',
    lender: r.querySelector('.l-lender')?.value.trim() || ''
  }));

  const savings = Array.from(document.querySelectorAll('#savings-container .account-form')).map(r => {
    const type = r.querySelector('.s-type')?.value || '';
    return {
      type,
      customType: type === 'other' ? (r.querySelector('.s-custom-type')?.value.trim() || null) : null,
      name: r.querySelector('.s-name')?.value.trim() || '',
      goal: r.querySelector('.s-goal')?.value.trim() || ''
    };
  });

  const adultsCount = parseInt(document.getElementById('w-adults').value) || 1;
  const childrenCount = parseInt(document.getElementById('w-children').value) || 0;
  return {
    maritalStatus: document.getElementById('w-status').value,
    adultsCount,
    childrenCount,
    householdSize: adultsCount + childrenCount,
    members: [...adults, ...children],
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

  currentStep = 1;
  updateWizardUI();

  setTimeout(() => {
    updateMemberForms();
    updateBankForms();
    updateCCForms();
    updateLoanForms();

    // Rebuild savings rows from profile
    const sc = document.getElementById('savings-container');
    sc.innerHTML = '';
    const savCount = (profile.savings || []).length || 1;
    for (let i = 0; i < savCount; i++) sc.appendChild(makeSavingsRow(i));

    // Fill members
    const adults = (profile.members || []).filter(m => m.isAdult !== false);
    const children = (profile.members || []).filter(m => m.isAdult === false);
    document.querySelectorAll('.adult-row').forEach((row, i) => {
      if (adults[i]) {
        row.querySelector('.m-name').value = adults[i].name || '';
        row.querySelector('.m-age').value = adults[i].age || '';
      }
    });
    document.querySelectorAll('.child-row').forEach((row, i) => {
      if (children[i]) {
        row.querySelector('.m-name').value = children[i].name || '';
        row.querySelector('.m-age').value = children[i].age || '';
      }
    });

    // Fill banks
    document.querySelectorAll('#banks-container .account-form').forEach((form, i) => {
      const b = (profile.banks || [])[i];
      if (!b) return;
      form.querySelector('.b-bank').value = b.bank || '';
      form.querySelector('.b-owner').value = b.owner || '';
      const usages = b.usage || [];
      form.querySelectorAll('.b-usage').forEach(cb => { cb.checked = usages.includes(cb.value); });
    });

    // Fill credit cards
    document.querySelectorAll('#cc-container .account-form').forEach((form, i) => {
      const c = (profile.creditCards || [])[i];
      if (!c) return;
      form.querySelector('.cc-company').value = c.company || '';
      form.querySelector('.cc-owner').value = c.owner || '';
      form.querySelector('.cc-day').value = c.day || '';
    });

    // Fill loans
    document.querySelectorAll('#loans-container .account-form').forEach((form, i) => {
      const l = (profile.loans || [])[i];
      if (!l) return;
      form.querySelector('.l-type').value = l.type || '';
      form.querySelector('.l-purpose').value = l.purpose || '';
      form.querySelector('.l-lender').value = l.lender || '';
    });

    // Fill savings
    document.querySelectorAll('#savings-container .account-form').forEach((form, i) => {
      const s = (profile.savings || [])[i];
      if (!s) return;
      const typeEl = form.querySelector('.s-type');
      typeEl.value = s.type || '';
      toggleCustomType(typeEl);
      if (s.type === 'other' && s.customType) form.querySelector('.s-custom-type').value = s.customType;
      form.querySelector('.s-name').value = s.name || '';
      form.querySelector('.s-goal').value = s.goal || '';
    });
  }, 50);
}

// ── Dashboard Render ──────────────────────────────────────────────────────────
function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return '₪ —';
  return '₪ ' + Math.round(n).toLocaleString('he-IL');
}

function renderDashboard() {
  if (!profile) return;

  const name = profile.members?.[0]?.name;
  document.getElementById('dashboard-greeting').textContent = name ? `שלום, ${name}` : 'דשבורד פיננסי';

  // Metrics from transactions
  const now = new Date();
  const thisMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

  const lastBalanceByAccount = {};
  let monthlyIncome = 0, monthlyExpenses = 0;

  transactions.forEach(t => {
    if (t.balance) lastBalanceByAccount[t.account] = t.balance;
    const tMonth = (t.date || t.imported_at || '').substring(0, 7);
    if (tMonth === thisMonth) {
      if (t.amount > 0) monthlyIncome += t.amount;
      else monthlyExpenses += Math.abs(t.amount);
    }
  });

  const totalAssets = Object.values(lastBalanceByAccount).filter(b => b > 0).reduce((s, b) => s + b, 0);
  const totalLiab = Object.values(lastBalanceByAccount).filter(b => b < 0).reduce((s, b) => s + Math.abs(b), 0);
  const netWorth = totalAssets - totalLiab;
  const monthlySavings = monthlyIncome - monthlyExpenses;

  document.getElementById('m-income').textContent = monthlyIncome ? fmt(monthlyIncome) : '₪ —';
  document.getElementById('m-loans').textContent = monthlyExpenses ? fmt(monthlyExpenses) : '₪ —';

  const lb = profile?.live_balances;
  if (lb) {
    const _dep = lb.investments?.deposits ?? null;
    const _pri = lb.investments?.pri ?? null;
    const _tot = lb.investments?.total ?? null;
    const investTotal = _tot ?? ((_dep ?? 0) + (_pri ?? 0));
    const lbAssets = (lb.checking ?? 0) + investTotal;
    const lbLiab = Math.abs(lb.mortgage ?? 0) + Math.abs(lb.credit_card_debt ?? 0);
    const lbNet = lb.net_worth ?? (lbAssets - lbLiab);

    document.getElementById('m-assets').textContent = fmt(lbAssets);
    document.getElementById('m-liab').textContent = fmt(lbLiab);
    document.getElementById('m-net').textContent = fmt(lbNet);
    document.getElementById('m-net').className = 'metric-value ' + (lbNet >= 0 ? 'green' : 'red');

    document.getElementById('m-saving-label').textContent = 'סה״כ השקעות';
    document.getElementById('m-saving-sub').textContent = 'פיקדונות + פר"י';
    document.getElementById('m-saving').textContent = fmt(investTotal);
    document.getElementById('m-saving').className = 'metric-value green';

    renderLiveBalances();
    renderLeumiBalances();
    renderBalanceSnapshot();
    renderPieChart(lb.checking ?? 0, investTotal, lbLiab);
  } else {
    document.getElementById('m-assets').textContent = totalAssets ? fmt(totalAssets) : '₪ —';
    document.getElementById('m-liab').textContent = totalLiab ? fmt(totalLiab) : '₪ —';
    document.getElementById('m-net').textContent = (totalAssets || totalLiab) ? fmt(netWorth) : '₪ —';
    document.getElementById('m-net').className = 'metric-value ' + (netWorth >= 0 ? 'green' : 'red');

    document.getElementById('m-saving-label').textContent = 'חיסכון חודשי';
    document.getElementById('m-saving-sub').textContent = 'הפרש הכנסות-הוצאות';
    document.getElementById('m-saving').textContent = (monthlyIncome || monthlyExpenses) ? fmt(monthlySavings) : '₪ —';
    document.getElementById('m-saving').className = 'metric-value';

    renderLiveBalances();
    renderLeumiBalances();
    renderBalanceSnapshot();
    renderPieChart(totalAssets, 0, totalLiab);
  }

  renderAccountSection('dash-banks', (profile.banks || []).map(b => ({
    icon: '🏦', name: b.bank,
    type: (b.usage || []).map(usageLabel).join(', ') || 'חשבון בנק',
    balance: lastBalanceByAccount[b.bank] ?? null,
    detail: b.owner ? `בעל: ${b.owner}` : ''
  })));

  renderAccountSection('dash-cc', (profile.creditCards || []).map(c => ({
    icon: '💳', name: c.company, type: 'כרטיס אשראי',
    balance: null, detail: c.day ? `יום חיוב: ${c.day}` : ''
  })));

  renderAccountSection('dash-savings', (profile.savings || []).map(s => ({
    icon: savingsIcon(s.type),
    name: s.name || savingsLabel(s.type),
    type: s.type === 'other' ? (s.customType || 'אחר') : savingsLabel(s.type),
    balance: null, detail: s.goal || ''
  })));

  renderAccountSection('dash-loans', (profile.loans || []).map(l => ({
    icon: '📋', name: l.type, type: l.purpose || 'הלוואה פעילה',
    balance: null, detail: l.lender || ''
  })));

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
      ${item.balance !== null ? `<div class="account-balance ${item.balance >= 0 ? 'pos' : 'neg'}">${fmt(Math.abs(item.balance))}</div>` : ''}
    </div>`).join('');
}

// ── Live balances card (DailyBalances.xlsx) ───────────────────────────────────
function renderLiveBalances() {
  const card   = document.getElementById('card-live-balances');
  const el     = document.getElementById('dash-live-balances');
  const dateEl = document.getElementById('live-balances-date');
  if (!card || !el) return;

  const lb = profile?.live_balances;
  if (!lb) { card.style.display = 'none'; return; }
  card.style.display = '';

  const d = lb.report_date;
  dateEl.textContent = d
    ? 'נכון ל-' + d.substring(8,10) + '/' + d.substring(5,7) + '/' + d.substring(0,4)
    : '';

  const row = (label, value, cls, sub) => {
    if (value === null || value === undefined) return '';
    const sign = (cls === 'neg') ? '-' : '';
    return `<div class="lb-row${sub ? ' lb-sub' : ''}">
      <span class="lb-label">${label}</span>
      <span class="lb-val ${cls}">${sign}${fmt(Math.abs(value))}</span>
    </div>`;
  };

  let html = '<div class="lb-grid">';

  // עו"ש
  html += '<div class="lb-section">';
  html += '<div class="lb-section-title">🏦 עו"ש</div>';
  html += row('יתרה', lb.checking, lb.checking >= 0 ? 'pos' : 'neg', false);
  if (lb.credit_line) html += row('מסגרת אשראי', lb.credit_line, 'neutral', true);
  html += '</div>';

  // השקעות
  const investDepositsRaw = lb.investments?.deposits ?? null;
  const investPri         = lb.investments?.pri ?? null;
  const investTotalRaw    = lb.investments?.total ?? null;
  // Use stored total as the ground truth; derive deposits when not parsed directly
  const _invSum = (investDepositsRaw ?? 0) + (investPri ?? 0);
  const investTotal    = investTotalRaw ?? (_invSum > 0 ? _invSum : null);
  const investDeposits = investDepositsRaw ?? (investTotal !== null && investPri !== null ? investTotal - investPri : null);
  if (investTotal !== null || investDeposits !== null || investPri !== null) {
    html += '<div class="lb-section">';
    html += '<div class="lb-section-title">📈 השקעות</div>';
    if (investDeposits !== null) html += row('פיקדונות', investDeposits, 'pos', true);
    if (investPri     !== null) html += row('פר"י',      investPri,      'pos', true);
    if (investTotal   !== null) html += row('סה"כ', investTotal, 'pos', false);
    html += '</div>';
  }

  // אשראי
  if (lb.credit_card_debt !== null && lb.credit_card_debt !== undefined) {
    html += '<div class="lb-section">';
    html += '<div class="lb-section-title">💳 חיוב אשראי</div>';
    html += row('חיוב כרטיסים', lb.credit_card_debt, 'neg', false);
    html += '</div>';
  }

  // משכנתא
  if (lb.mortgage !== null && lb.mortgage !== undefined) {
    html += '<div class="lb-section">';
    html += '<div class="lb-section-title">🏠 משכנתא</div>';
    html += row('יתרת חוב', lb.mortgage, 'neg', false);
    html += '</div>';
  }

  html += '</div>'; // lb-grid

  // Net worth summary bar
  if (lb.net_worth !== null && lb.net_worth !== undefined) {
    const nwCls = lb.net_worth >= 0 ? 'pos' : 'neg';
    const sign  = lb.net_worth < 0 ? '-' : '';
    html += `<div class="lb-net-worth">
      <span>שווי נטו</span>
      <span class="lb-val ${nwCls}" style="font-size:16px">${sign}${fmt(Math.abs(lb.net_worth))}</span>
    </div>`;
  }

  el.innerHTML = html;
}

// ── Leumi balances card (sheet001.htm) ───────────────────────────────────────
function renderLeumiBalances() {
  const card   = document.getElementById('card-leumi-balances');
  const el     = document.getElementById('dash-leumi-balances');
  const dateEl = document.getElementById('leumi-balances-date');
  if (!card || !el) return;

  const lb = profile?.leumi_balances;
  if (!lb) { card.style.display = 'none'; return; }
  card.style.display = '';

  const d = lb.report_date;
  if (dateEl) dateEl.textContent = d
    ? 'נכון ל-' + d.substring(8,10) + '/' + d.substring(5,7) + '/' + d.substring(0,4)
    : '';

  const row = (label, value, cls, sub) => {
    if (value === null || value === undefined) return '';
    const sign = cls === 'neg' ? '-' : '';
    return `<div class="lb-row${sub ? ' lb-sub' : ''}">
      <span class="lb-label">${label}</span>
      <span class="lb-val ${cls}">${sign}${fmt(Math.abs(value))}</span>
    </div>`;
  };

  let html = '<div class="lb-grid">';

  // עו"ש
  html += '<div class="lb-section">';
  html += '<div class="lb-section-title">🏦 עו"ש</div>';
  html += row('יתרה', lb.checking, (lb.checking ?? 0) >= 0 ? 'pos' : 'neg', false);
  html += '</div>';

  // כרטיסי אשראי
  if (lb.credit_card_debt !== null && lb.credit_card_debt !== undefined) {
    html += '<div class="lb-section">';
    html += '<div class="lb-section-title">💳 כרטיסי אשראי</div>';
    html += row('חיוב כרטיסים', lb.credit_card_debt, 'neg', false);
    html += '</div>';
  }

  // הלוואות
  if (lb.loans?.length || lb.loans_total !== null) {
    html += '<div class="lb-section">';
    html += '<div class="lb-section-title">📋 הלוואות</div>';
    for (const loan of (lb.loans || [])) {
      const lbl = loan.loan_id ? `${loan.name} (${loan.loan_id})` : loan.name;
      html += row(lbl, loan.balance, 'neg', lb.loans.length > 1);
    }
    if (lb.loans_total !== null && lb.loans.length > 1)
      html += row('סה"כ הלוואות', lb.loans_total, 'neg', false);
    else if (lb.loans_total !== null && !lb.loans.length)
      html += row('סה"כ הלוואות', lb.loans_total, 'neg', false);
    html += '</div>';
  }

  html += '</div>'; // lb-grid

  // Net summary bar
  const net = (lb.total_credit ?? 0) + (lb.total_debit ?? 0);
  if (lb.total_credit !== null || lb.total_debit !== null) {
    const nwCls = net >= 0 ? 'pos' : 'neg';
    html += `<div class="lb-net-worth">
      <span>יתרה נטו</span>
      <span class="lb-val ${nwCls}" style="font-size:16px">${net < 0 ? '-' : ''}${fmt(Math.abs(net))}</span>
    </div>`;
  }

  el.innerHTML = html;
}

// ── Balance snapshot card ─────────────────────────────────────────────────────
const SNAP_TYPE_LABEL = {
  checking: 'עו"ש', savings: 'חסכונות ופיקדונות', investments: 'השקעות',
  pension: 'פנסיה / גמל', mortgage: 'משכנתא', loan: 'הלוואות'
};
const SNAP_TYPE_ICON = {
  checking: '🏦', savings: '💰', investments: '📈',
  pension: '🏛', mortgage: '🏠', loan: '📋'
};
const SNAP_ORDER = ['checking', 'savings', 'investments', 'pension', 'mortgage', 'loan'];

function renderBalanceSnapshot() {
  const card = document.getElementById('card-balance-snapshot');
  const el   = document.getElementById('dash-balance-snapshot');
  const dateEl = document.getElementById('snapshot-date');
  if (!card || !el) return;

  const snap = profile?.balance_snapshot;
  if (!snap || !snap.accounts?.length) { card.style.display = 'none'; return; }

  card.style.display = '';

  const d = snap.report_date;
  dateEl.textContent = d
    ? 'נכון ל-' + d.substring(8,10) + '/' + d.substring(5,7) + '/' + d.substring(0,4)
    : snap.updated_at ? 'עודכן: ' + new Date(snap.updated_at).toLocaleDateString('he-IL') : '';

  // Group by type, preserve order
  const groups = {};
  for (const acc of snap.accounts) {
    if (!groups[acc.type]) groups[acc.type] = [];
    groups[acc.type].push(acc);
  }

  let html = '<div class="snapshot-grid">';
  for (const type of SNAP_ORDER) {
    const items = groups[type];
    if (!items) continue;

    const topItems  = items.filter(i => i.isSectionTotal || !i.isSub);
    const subItems  = items.filter(i => i.isSub && !i.isSectionTotal);
    const displayed = topItems.length ? topItems : items;

    html += `<div class="snapshot-section">
      <div class="snapshot-type-header">${SNAP_TYPE_ICON[type] || '•'} ${SNAP_TYPE_LABEL[type] || type}</div>`;

    for (const item of displayed) {
      const isDebt  = (type === 'loan' || type === 'mortgage');
      const balance = item.balance ?? 0;
      const cls     = isDebt ? 'neg' : (balance >= 0 ? 'pos' : 'neg');
      html += `<div class="snapshot-row${item.isSub ? ' snapshot-sub' : ''}">
        <span class="snapshot-label">${item.label || SNAP_TYPE_LABEL[type] || type}</span>
        <span class="snapshot-bal ${cls}">${fmt(Math.abs(balance))}</span>
      </div>`;
      if (item.credit_line) {
        html += `<div class="snapshot-row snapshot-sub snapshot-meta-row">
          <span class="snapshot-label">מסגרת אשראי</span>
          <span class="snapshot-bal">${fmt(Math.abs(item.credit_line))}</span>
        </div>`;
      }
    }

    if (subItems.length) {
      for (const item of subItems) {
        const balance = item.balance ?? 0;
        const isDebt  = (type === 'loan' || type === 'mortgage');
        const cls     = isDebt ? 'neg' : (balance >= 0 ? 'pos' : 'neg');
        html += `<div class="snapshot-row snapshot-sub">
          <span class="snapshot-label">${item.label}</span>
          <span class="snapshot-bal ${cls}">${fmt(Math.abs(balance))}</span>
        </div>`;
      }
    }

    html += '</div>';
  }
  html += '</div>';
  el.innerHTML = html;
}

function usageLabel(u) {
  return { checking: 'עו"ש', saving: 'חיסכון', deposit: 'פיקדון', mortgage: 'משכנתא', loans: 'הלוואות', investments: 'השקעות', business: 'עסקי' }[u] || u;
}
function savingsLabel(t) {
  return { pension: 'קרן פנסיה', gemel: 'קופת גמל', hishtalmut: 'קרן השתלמות', saving: 'חיסכון', stocks: 'תיק השקעות', crypto: 'קריפטו', 'real-estate': 'נדל"ן' }[t] || t || 'חיסכון';
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
  if (!data.length) {
    document.getElementById('chart-legend').innerHTML = '<div style="color:#999;font-size:13px">אין נתונים להצגה — טען קבצים מהבנק</div>';
    return;
  }
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

// ── Accounts full view ────────────────────────────────────────────────────────
function renderAccountsFull() {
  const el = document.getElementById('accounts-full');
  if (!profile) { el.innerHTML = '<div class="empty-state">עדיין לא הוגדר פרופיל</div>'; return; }

  const sections = [
    {
      title: 'חשבונות בנק',
      items: (profile.banks || []).map(b => ({
        icon: '🏦', name: b.bank,
        type: (b.usage || []).map(usageLabel).join(', ') || 'חשבון בנק',
        detail: b.owner || ''
      }))
    },
    {
      title: 'כרטיסי אשראי',
      items: (profile.creditCards || []).map(c => ({
        icon: '💳', name: c.company, type: 'כרטיס אשראי',
        detail: c.day ? `יום חיוב: ${c.day}` : ''
      }))
    },
    {
      title: 'חיסכון, גמל, פנסיה',
      items: (profile.savings || []).map(s => ({
        icon: savingsIcon(s.type),
        name: s.name || savingsLabel(s.type),
        type: s.type === 'other' ? (s.customType || 'אחר') : savingsLabel(s.type),
        detail: s.goal || ''
      }))
    },
    {
      title: 'הלוואות',
      items: (profile.loans || []).map(l => ({
        icon: '📋', name: l.type, type: l.purpose || 'הלוואה',
        detail: l.lender || ''
      }))
    }
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
          </div>`).join('')
        : '<div class="empty-state">לא הוגדרו נתונים</div>'}
      </div>
    </div>`).join('');
}

// ── Transactions ──────────────────────────────────────────────────────────────
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
  filtered = [...filtered].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id - a.id);

  const body = document.getElementById('tx-body');
  const empty = document.getElementById('tx-empty');

  if (!filtered.length) {
    body.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  const fmtDate = d => d ? d.substring(8,10) + '/' + d.substring(5,7) + '/' + d.substring(0,4) : '—';
  body.innerHTML = filtered.slice(0, 500).map(t => {
    const credit = t.amount > 0  ? Math.round(t.amount).toLocaleString('he-IL')  : '';
    const debit  = t.amount < 0  ? Math.round(-t.amount).toLocaleString('he-IL') : '';
    const bal    = t.balance != null ? Math.round(t.balance).toLocaleString('he-IL') : '—';
    const srcFile = (t.source_file || t.source || '').replace(/^\d+_/, '');
    const accountDisplay = t.account && t.account !== srcFile ? t.account : '—';
    return `
    <tr>
      <td class="tx-date">${fmtDate(t.date)}</td>
      <td>${t.description || '—'}</td>
      <td class="tx-doc">${accountDisplay}</td>
      <td class="tx-doc">${srcFile}</td>
      <td class="tx-ref">${t.reference || ''}</td>
      <td class="tx-num tx-credit">${credit}</td>
      <td class="tx-num tx-debit">${debit}</td>
      <td class="tx-num tx-bal">${bal}</td>
    </tr>`;
  }).join('');
}

// ── Upload ────────────────────────────────────────────────────────────────────
async function handleUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  await doUpload(file);
  event.target.value = '';
}

async function doUpload(file) {
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
      renderDashboard();
      loadUploads();
      loadAccountsMgmt();

      // Balance/profile report uploaded
      if (data.profileUpdated) {
        profile = await fetch('/api/profile').then(r => r.json());
        renderDashboard();
        let successText;
        if (data.profileUpdated === 'live_balances' && profile.live_balances?.checking != null) {
          successText = `נטענו נתוני יתרות בהצלחה — יתרת עו"ש: ${fmt(profile.live_balances.checking)}`;
        } else if (data.profileUpdated === 'leumi_balances' && profile.leumi_balances) {
          const llb = profile.leumi_balances;
          const loanAbs = Math.abs(llb.loans_total ?? 0);
          successText = `נטענו נתוני יתרות לאומי בהצלחה — עו"ש: ${fmt(llb.checking)} | חוב הלוואות: ${fmt(loanAbs)}`;
        } else {
          const count = data.inserted || 0;
          successText = `דוח יתרות עודכן מ-${data.filename}${count > 0 ? ` — ${count} סעיפים נקלטו` : ''}`;
        }
        let msg = `<div class="upload-success">✓ ${successText}</div>`;
        if (data.warning) msg += `<div class="upload-warning" style="margin-top:8px;white-space:pre-line">${data.warning}</div>`;
        status.innerHTML = msg;
      // If 0 rows and there's a warning (e.g. frameset file), show only the warning
      } else if (data.inserted === 0 && data.warning) {
        status.innerHTML = `<div class="upload-warning" style="white-space:pre-line">${data.warning}</div>`;
      } else {
        const skipped = data.stats?.skipped ?? (data.rows - data.inserted);
        const skippedNote = skipped > 0 ? ` (${skipped} שורות דולגו)` : '';
        const accountNote = data.detectedAccount ? `<br><span style="font-size:12px;opacity:.8">חשבון שזוהה: <strong>${data.detectedAccount}</strong></span>` : '';
        let msg = `<div class="upload-success">✓ נטענו בהצלחה ${data.inserted} שורות חדשות מ-${data.filename}${skippedNote}${accountNote}</div>`;
        if (data.warning) msg += `<div class="upload-warning" style="margin-top:8px">${data.warning}</div>`;
        status.innerHTML = msg;
      }
    } else {
      status.innerHTML = `<div class="upload-error">שגיאה: ${data.error}</div>`;
    }
  } catch (e) {
    status.innerHTML = `<div class="upload-error">שגיאה בהעלאה: ${e.message}</div>`;
  }
}

function setupDrop() {
  const dz = document.getElementById('drop-zone');
  if (!dz) return;
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', async e => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) await doUpload(file);
  });
}

// ── Account management ────────────────────────────────────────────────────────
async function loadAccountsMgmt() {
  const container = document.getElementById('accounts-mgmt-list');
  const countEl   = document.getElementById('accounts-mgmt-count');
  if (!container) return;

  const accounts = await fetch('/api/accounts').then(r => r.json());
  countEl.textContent = accounts.length ? `${accounts.length} חשבונות` : '';

  if (!accounts.length) {
    container.innerHTML = '<div class="empty-state">אין חשבונות — העלה מסמך תחילה</div>';
    return;
  }

  container.innerHTML = `
    <table class="uploads-table">
      <thead><tr>
        <th>שם נוכחי</th>
        <th>עסקאות</th>
        <th>תאריכים</th>
        <th>שם חדש</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${accounts.map(a => `
          <tr data-account="${escAttr(a.account)}">
            <td style="font-weight:500">${a.account}</td>
            <td style="text-align:center;color:#666">${a.tx_count}</td>
            <td style="font-size:12px;color:#999">${(a.date_from||'').substring(0,10)} — ${(a.date_to||'').substring(0,10)}</td>
            <td><input class="acct-rename-input" type="text" placeholder="שם חדש..." value="" style="width:100%;padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px"></td>
            <td><button class="acct-rename-btn btn-secondary small" style="white-space:nowrap">שמור</button></td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  container.querySelectorAll('tr[data-account]').forEach(row => {
    row.querySelector('.acct-rename-btn').addEventListener('click', () => {
      const from = row.dataset.account;
      const to   = row.querySelector('.acct-rename-input').value.trim();
      if (to) renameAccount(from, to);
    });
    row.querySelector('.acct-rename-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') row.querySelector('.acct-rename-btn').click();
    });
  });
}

function escAttr(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

async function renameAccount(from, to) {
  try {
    const res  = await fetch('/api/accounts/rename', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to })
    });
    const data = await res.json();
    if (data.ok) {
      transactions = await fetch('/api/transactions').then(r => r.json());
      renderDashboard();
      loadAccountsMgmt();
      loadUploads();
    }
  } catch (e) {
    alert('שגיאה בשינוי שם: ' + e.message);
  }
}

// ── Uploaded documents ────────────────────────────────────────────────────────
async function loadUploads() {
  const container = document.getElementById('uploads-list');
  const countEl = document.getElementById('uploads-count');
  if (!container) return;

  try {
    const rows = await fetch('/api/uploads').then(r => r.json());
    countEl.textContent = rows.length ? `${rows.length} קבצים` : '';

    if (!rows.length) {
      container.innerHTML = '<div class="empty-state">לא הועלו מסמכים עדיין</div>';
      return;
    }

    const sourceTypeLabel = t => ({
      poalim_transactions:   'פועלים — עסקאות',
      poalim_balances:       'פועלים — יתרות',
      poalim_mortgage:       'פועלים — משכנתא',
      poalim_daily_balances: 'פועלים — יתרות יומיות',
      leumi_balances:        'לאומי — יתרות עדכניות',
      leumi_transactions:    'לאומי — עסקאות',
      leumi_balances:        'לאומי — יתרות',
      isracard_cc:           'ישראכרט',
      max_cc:                'מקס',
      cal_cc:                'כאל',
      generic:               'כללי'
    })[t] || t || '—';

    const fmtDate = d => d ? d.substring(0, 10) : '—';

    container.innerHTML = `
      <table class="uploads-table">
        <thead>
          <tr>
            <th>שם קובץ</th>
            <th>חשבון</th>
            <th>סוג</th>
            <th>עסקאות</th>
            <th>תאריכים</th>
            <th>הועלה</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => {
            const sfSafe = (r.source_file || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
            const isProfile = !!r.profile_key;
            const txCell = isProfile
              ? `<td style="text-align:center;color:#999">—</td>`
              : `<td style="text-align:center">${r.tx_count}</td>`;
            const dateCell = isProfile
              ? `<td style="font-size:12px;color:#999">—</td>`
              : `<td style="font-size:12px;color:#666">${fmtDate(r.date_from)} — ${fmtDate(r.date_to)}</td>`;
            return `
            <tr>
              <td class="uploads-filename" title="${r.source_file || ''}">${
                ({ live_balances: 'DailyBalances (יתרות)', leumi_balances: 'לאומי — יתרות', balance_snapshot: 'דוח יתרות', mortgage_details: 'דוח משכנתא' })[r.source_file]
                || (r.source_file || '').replace(/^\d+_/, '')
              }</td>
              <td>${r.account || '—'}</td>
              <td>${sourceTypeLabel(r.source_type)}</td>
              ${txCell}
              ${dateCell}
              <td style="font-size:12px;color:#999">${fmtDate(r.imported_at)}</td>
              <td><button class="remove-upload-btn" data-file="${sfSafe}" data-is-profile="${isProfile}">הסר</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    container.querySelectorAll('.remove-upload-btn').forEach(btn => {
      btn.addEventListener('click', () => removeUpload(btn.dataset.file, btn.dataset.isProfile === 'true'));
    });
  } catch (e) {
    container.innerHTML = `<div class="upload-error">שגיאה בטעינת רשימה: ${e.message}</div>`;
  }
}

async function removeUpload(filename, isProfile = false) {
  const displayName = filename.replace(/^\d+_/, '');
  const msg = isProfile
    ? `להסיר את קובץ היתרות "${displayName}" ואת הנתונים שנטענו ממנו?`
    : `להסיר את הקובץ "${displayName}" וכל עסקאותיו?`;
  if (!confirm(msg)) return;
  try {
    const res = await fetch('/api/uploads/' + encodeURIComponent(filename), { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
      if (data.isProfile) {
        // Refresh profile so dashboard hides the removed balance card
        profile = await fetch('/api/profile').then(r => r.json());
      } else {
        transactions = await fetch('/api/transactions').then(r => r.json());
      }
      renderDashboard();
      loadUploads();
      loadAccountsMgmt();
    }
  } catch (e) {
    alert('שגיאה בהסרת הקובץ: ' + e.message);
  }
}

// ── AI Agent ──────────────────────────────────────────────────────────────────
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
  if (!profile) return 'No financial profile available.';

  const adults = (profile.members || []).filter(m => m.isAdult !== false);
  const children = (profile.members || []).filter(m => m.isAdult === false);
  const membersStr = adults.map(m => `${m.name} (גיל ${m.age})`).join(' | ');
  const childrenStr = children.length ? children.map(m => `${m.name} (גיל ${m.age})`).join(', ') : 'אין';

  const banks = (profile.banks || []).map(b => `${b.bank} [${(b.usage || []).map(usageLabel).join(', ')}]`).join(' | ');
  const cc = (profile.creditCards || []).map(c => `${c.company}${c.day ? ` (יום חיוב ${c.day})` : ''}`).join(' | ');
  const loans = (profile.loans || []).map(l => `${l.type}${l.purpose ? ' — ' + l.purpose : ''}${l.lender ? ' ב-' + l.lender : ''}`).join(' | ');
  const savings = (profile.savings || []).map(s => {
    const typeName = s.type === 'other' ? (s.customType || 'אחר') : savingsLabel(s.type);
    return `${s.name} (${typeName})${s.goal ? ' — ' + s.goal : ''}`;
  }).join(' | ');

  // Transaction summaries
  const now = new Date();
  const thisMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const lastBalanceByAccount = {};
  let monthlyIncome = 0, monthlyExpenses = 0;

  transactions.forEach(t => {
    if (t.balance) lastBalanceByAccount[t.account] = t.balance;
    const tMonth = (t.date || t.imported_at || '').substring(0, 7);
    if (tMonth === thisMonth) {
      if (t.amount > 0) monthlyIncome += t.amount;
      else monthlyExpenses += Math.abs(t.amount);
    }
  });

  const totalAssets = Object.values(lastBalanceByAccount).filter(b => b > 0).reduce((s, b) => s + b, 0);
  const totalLiab = Object.values(lastBalanceByAccount).filter(b => b < 0).reduce((s, b) => s + Math.abs(b), 0);
  const balanceSummary = Object.entries(lastBalanceByAccount)
    .map(([acc, bal]) => `${acc}: ${fmt(bal)}`).join(' | ') || 'אין נתוני יתרה';

  return `אתה סוכן פיננסי אישי מקצועי. אתה עונה בעברית שוטפת ונותן המלצות ברורות ומספריות.

=== פרופיל משק הבית ===
גודל: ${profile.householdSize} נפשות | סטטוס: ${profile.maritalStatus || 'לא צוין'}
מבוגרים: ${membersStr || 'לא הוגדרו'} | ילדים: ${childrenStr}
מטרות: ${profile.goals || 'לא הוגדרו'}

=== חשבונות ===
חשבונות בנק: ${banks || 'אין'}
כרטיסי אשראי: ${cc || 'אין'}
הלוואות: ${loans || 'אין'}
חיסכון/השקעות: ${savings || 'אין'}

=== סיכום עסקאות ===
יתרות לפי חשבון: ${balanceSummary}
סה"כ נכסים (יתרות חיוביות): ${fmt(totalAssets)}
סה"כ התחייבויות (יתרות שליליות): ${fmt(totalLiab)}
הכנסות חודש נוכחי: ${fmt(monthlyIncome)}
הוצאות חודש נוכחי: ${fmt(monthlyExpenses)}
סה"כ עסקאות טעונות: ${transactions.length}

הוראות:
- ענה בעברית בלבד
- היה ספציפי ומספרי
- ציין את הנחות העבודה שלך
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
