// ─── NK Trade Tracker — Part-Time & Expenses Module ─────────────────────────

import { db } from "./firebase-config.js";
import {
  collection, getDocs, doc, getDoc, setDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Legacy localStorage keys (used only for one-time migration)
const PTT_HOURS_KEY  = "ptt_hours_v1";
const PTT_RATE_KEY   = "ptt_rate_v1";
const PTT_SALARY_KEY = "ptt_salary_v1";
const PTT_TX_KEY     = "ptt_transactions_v1";
const PTT_BANK_KEY   = "ptt_bank_init_v1";

const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];
const DOW    = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

// ── In-memory state (synced from Firestore) ───────────────────────────────────
let _state = { rate: 14, bankInit: 0, hours: {}, salaries: {}, txs: [] };
let _pttYear  = new Date().getFullYear();
let _pttMonth = new Date().getMonth();
let _pttInit  = false;
let _txType   = "expense";
let _settingsTimer = null;

const _$       = (id)    => document.getElementById(id);
const _pad     = (n)     => String(n).padStart(2, "0");
const _today   = ()      => { const n = new Date(); return `${n.getFullYear()}-${_pad(n.getMonth()+1)}-${_pad(n.getDate())}`; };
const _dateKey = (y,m,d) => `${y}-${_pad(m+1)}-${_pad(d)}`;
const _monKey  = (y,m)   => `${y}-${_pad(m+1)}`;

function _fmtE(v) {
  return "€" + Number(v).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function _fmtDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// ── State readers (replace localStorage reads) ────────────────────────────────
function _getHours()   { return _state.hours; }
function _getSalaries(){ return _state.salaries; }
function _getTxs()     { return _state.txs; }
function _getRate()    { return _state.rate; }
function _getInitBal() { return _state.bankInit; }
function _calcBalance(txs) {
  return txs.reduce((bal, t) => t.type === "income" ? bal + t.amount : bal - t.amount, _getInitBal());
}

// ── Firestore helpers ─────────────────────────────────────────────────────────
async function _saveSettings() {
  try {
    await setDoc(doc(db, "nktt_parttime", "settings"), {
      rate:     _state.rate,
      bankInit: _state.bankInit,
      hours:    _state.hours,
      salaries: _state.salaries
    });
  } catch (e) { console.error("ptt settings save:", e); }
}

function _saveSettingsDebounced() {
  clearTimeout(_settingsTimer);
  _settingsTimer = setTimeout(_saveSettings, 800);
}

// ── Load from Firestore (with localStorage migration) ─────────────────────────
async function _loadFromFirestore() {
  try {
    const snap = await getDoc(doc(db, "nktt_parttime", "settings"));
    if (snap.exists()) {
      const d = snap.data();
      _state.rate     = d.rate     ?? 14;
      _state.bankInit = d.bankInit ?? 0;
      _state.hours    = d.hours    ?? {};
      _state.salaries = d.salaries ?? {};
    } else {
      // One-time migration from localStorage
      const r = parseFloat(localStorage.getItem(PTT_RATE_KEY));
      _state.rate     = isNaN(r) ? 14 : r;
      _state.bankInit = parseFloat(localStorage.getItem(PTT_BANK_KEY) || "0") || 0;
      try { _state.hours    = JSON.parse(localStorage.getItem(PTT_HOURS_KEY)  || "{}"); } catch { _state.hours    = {}; }
      try { _state.salaries = JSON.parse(localStorage.getItem(PTT_SALARY_KEY) || "{}"); } catch { _state.salaries = {}; }
      await _saveSettings();
    }

    // Load transactions
    const txSnap = await getDocs(collection(db, "nktt_ptt_tx"));
    if (txSnap.empty) {
      // One-time migration of transactions from localStorage
      try {
        const local = JSON.parse(localStorage.getItem(PTT_TX_KEY) || "[]");
        for (const tx of local) {
          await setDoc(doc(db, "nktt_ptt_tx", tx.id), {
            id: tx.id, date: tx.date, type: tx.type, category: tx.category, amount: tx.amount
          });
          _state.txs.push(tx);
        }
      } catch { _state.txs = []; }
    } else {
      _state.txs = txSnap.docs.map(d => d.data());
    }
  } catch (e) {
    console.error("ptt load from Firestore:", e);
    // Fallback to localStorage if Firestore is unavailable
    try { _state.hours    = JSON.parse(localStorage.getItem(PTT_HOURS_KEY)  || "{}"); } catch { _state.hours    = {}; }
    try { _state.salaries = JSON.parse(localStorage.getItem(PTT_SALARY_KEY) || "{}"); } catch { _state.salaries = {}; }
    try { _state.txs      = JSON.parse(localStorage.getItem(PTT_TX_KEY)     || "[]"); } catch { _state.txs      = []; }
    const r = parseFloat(localStorage.getItem(PTT_RATE_KEY));
    _state.rate     = isNaN(r) ? 14 : r;
    _state.bankInit = parseFloat(localStorage.getItem(PTT_BANK_KEY) || "0") || 0;
  }
}

// ── Entry Point ───────────────────────────────────────────────────────────────
export async function initParttime() {
  if (!_pttInit) {
    _pttInit = true;
    // Show loading while Firestore loads
    const aside = _$("pttExpensePanel");
    if (aside) aside.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-3);font-family:var(--ff-ui)">Loading…</div>`;
    await _loadFromFirestore();
    _bindPttEvents();
  }
  _renderAll();
}

function _renderAll() {
  _renderSettingsBar();
  _renderCalendar();
  _recalcSummary();
  _renderHistory();
  _renderBankBalance();
}

// ── Settings Bar ──────────────────────────────────────────────────────────────
function _renderSettingsBar() {
  const el = _$("pttSettingsBar");
  if (!el) return;
  const sal = _getSalaries()[_monKey(_pttYear, _pttMonth)] ?? 0;
  el.innerHTML = `
    <label class="ptt-sb-field">
      <span class="ptt-sb-label">Hourly Rate (€)</span>
      <input id="pttRateInput" type="number" step="0.5" min="0" value="${_getRate()}" class="ptt-sb-input" />
    </label>
    <label class="ptt-sb-field">
      <span class="ptt-sb-label">Monthly Salary (€)</span>
      <input id="pttSalaryInput" type="number" step="10" min="0" value="${sal || ""}" placeholder="0" class="ptt-sb-input" />
    </label>`;

  _$("pttRateInput").addEventListener("input", () => {
    const v = parseFloat(_$("pttRateInput").value);
    _state.rate = isNaN(v) ? 14 : v;
    _renderCalendar();
    _recalcSummary();
    _renderHistory();
    _saveSettings();
  });

  _$("pttSalaryInput").addEventListener("input", () => {
    const v = parseFloat(_$("pttSalaryInput").value);
    _state.salaries[_monKey(_pttYear, _pttMonth)] = isNaN(v) ? 0 : v;
    _recalcSummary();
    _renderHistory();
    _saveSettings();
  });
}

// ── Calendar ──────────────────────────────────────────────────────────────────
function _renderCalendar() {
  const wrap = _$("pttCalendar");
  if (!wrap) return;

  const rate        = _getRate();
  const hoursData   = _getHours();
  const daysInMonth = new Date(_pttYear, _pttMonth + 1, 0).getDate();
  const firstDay    = new Date(_pttYear, _pttMonth, 1).getDay();
  const startOffset = (firstDay + 6) % 7;
  const todayStr    = _today();

  wrap.innerHTML = `
    <div class="ptt-cal-nav">
      <button class="ptt-nav-btn" id="pttPrevMonth">&#8592;</button>
      <h2 class="ptt-cal-title">${MONTHS[_pttMonth]} ${_pttYear}</h2>
      <button class="ptt-nav-btn" id="pttNextMonth">&#8594;</button>
    </div>
    <div class="ptt-cal-card">
      <div class="ptt-cal-grid" id="pttCalGrid"></div>
    </div>`;

  const grid = _$("pttCalGrid");

  DOW.forEach((d, i) => {
    const el = document.createElement("div");
    el.className = "ptt-dow" + (i >= 5 ? " ptt-dow-wknd" : "");
    el.textContent = d;
    grid.appendChild(el);
  });

  for (let i = 0; i < startOffset; i++) {
    const el = document.createElement("div");
    el.className = "ptt-day ptt-day-empty";
    grid.appendChild(el);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const key    = _dateKey(_pttYear, _pttMonth, d);
    const col    = (startOffset + d - 1) % 7;
    const isWknd = col >= 5;
    const stored = hoursData[key];
    const h      = stored != null ? parseFloat(stored) : 0;

    const cell = document.createElement("div");
    cell.className = "ptt-day" +
      (isWknd         ? " ptt-day-wknd"  : "") +
      (key===todayStr ? " ptt-day-today" : "");

    const num = document.createElement("div");
    num.className   = "ptt-day-num";
    num.textContent = d;
    cell.appendChild(num);

    const input = document.createElement("input");
    input.className   = "ptt-hrs-inp";
    input.type        = "number";
    input.min         = "0";
    input.max         = "24";
    input.step        = "0.25";
    input.placeholder = "-";
    if (h > 0) input.value = h;
    cell.appendChild(input);

    const earn = document.createElement("div");
    earn.className  = "ptt-day-earn";
    earn.textContent = h > 0 ? _fmtE(h * rate) : "";
    cell.appendChild(earn);

    input.addEventListener("input", () => {
      const val = parseFloat(input.value);
      if (isNaN(val) || val <= 0) { delete _state.hours[key]; earn.textContent = ""; }
      else { _state.hours[key] = val; earn.textContent = _fmtE(val * rate); }
      _recalcSummary();
      _renderHistory();
      _saveSettingsDebounced();
    });

    grid.appendChild(cell);
  }

  _$("pttPrevMonth").addEventListener("click", () => {
    _pttMonth--;
    if (_pttMonth < 0) { _pttMonth = 11; _pttYear--; }
    _renderSettingsBar();
    _renderCalendar();
    _recalcSummary();
  });
  _$("pttNextMonth").addEventListener("click", () => {
    _pttMonth++;
    if (_pttMonth > 11) { _pttMonth = 0; _pttYear++; }
    _renderSettingsBar();
    _renderCalendar();
    _recalcSummary();
  });
}

// ── Summary ───────────────────────────────────────────────────────────────────
function _recalcSummary() {
  const hoursData = _getHours();
  const rate      = _getRate();
  const salaries  = _getSalaries();
  const mk        = _monKey(_pttYear, _pttMonth);
  const salary    = salaries[mk] ?? 0;

  let totalHours = 0;
  Object.keys(hoursData).forEach(k => {
    if (k.startsWith(mk)) totalHours += hoursData[k];
  });
  const totalEarn = totalHours * rate;
  const diff      = totalEarn - salary;
  const pct       = salary > 0 ? (totalEarn / salary) * 100 : null;

  const el = _$("pttMonthSummary");
  if (!el) return;

  el.innerHTML = `
    <div class="ptt-sum-cards">
      <div class="ptt-sum-card">
        <span class="ptt-sum-label">Total Hours</span>
        <span class="ptt-sum-val">${totalHours.toFixed(1)}</span>
      </div>
      <div class="ptt-sum-card">
        <span class="ptt-sum-label">Total Earnings</span>
        <span class="ptt-sum-val profit">${_fmtE(totalEarn)}</span>
      </div>
      <div class="ptt-sum-card">
        <span class="ptt-sum-label">VS. Salary</span>
        <span class="ptt-sum-val ${salary > 0 ? (diff >= 0 ? "profit" : "loss") : ""}">${salary > 0 ? _fmtE(diff) : "—"}</span>
      </div>
      <div class="ptt-sum-card">
        <span class="ptt-sum-label">% of Salary</span>
        <span class="ptt-sum-val ${pct !== null && pct >= 100 ? "profit" : ""}">${pct !== null ? pct.toFixed(1) + "%" : "—"}</span>
      </div>
    </div>`;
}

// ── History Table ─────────────────────────────────────────────────────────────
function _renderHistory() {
  const el = _$("pttHistory");
  if (!el) return;

  const hoursData = _getHours();
  const salaries  = _getSalaries();
  const rate      = _getRate();

  const byMonth = {};
  Object.keys(hoursData).forEach(k => {
    const mk = k.slice(0, 7);
    byMonth[mk] = (byMonth[mk] || 0) + hoursData[k];
  });
  const months = Object.keys(byMonth).sort().reverse();

  let bodyHtml = "";
  if (!months.length) {
    bodyHtml = `<tr class="ptt-empty-row"><td colspan="5">No hours logged yet — start typing in the calendar above.</td></tr>`;
  } else {
    months.forEach(mk => {
      const [yy, mm] = mk.split("-");
      const label = `${MONTHS[parseInt(mm, 10) - 1]} ${yy}`;
      const h    = byMonth[mk];
      const earn = h * rate;
      const sal  = salaries[mk] ?? 0;
      const diff = earn - sal;
      const dcls = sal > 0 ? (diff >= 0 ? "profit" : "loss") : "";
      bodyHtml += `<tr>
        <td>${label}</td>
        <td class="td-num-right">${h.toFixed(1)}</td>
        <td class="td-num-right profit">${_fmtE(earn)}</td>
        <td class="td-num-right">${sal ? _fmtE(sal) : "—"}</td>
        <td class="td-num-right ${dcls}">${sal ? _fmtE(diff) : "—"}</td>
      </tr>`;
    });
  }

  el.innerHTML = `
    <div class="ptt-history-card">
      <h3 class="ptt-history-title">Monthly History</h3>
      <table class="ptt-hist-table">
        <thead><tr>
          <th>Month</th>
          <th class="td-num-right">Hours</th>
          <th class="td-num-right">Earnings</th>
          <th class="td-num-right">Salary</th>
          <th class="td-num-right">Difference</th>
        </tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </div>`;
}

// ── Bank Balance Panel ────────────────────────────────────────────────────────
function _renderBankBalance() {
  const aside = _$("pttExpensePanel");
  if (!aside) return;

  const txs     = _getTxs();
  const today   = _today();
  const balance = _calcBalance(txs);

  const withBal = [...txs].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  let running = _getInitBal();
  withBal.forEach(t => {
    running = t.type === "income" ? running + t.amount : running - t.amount;
    t._balAfter = running;
  });
  withBal.reverse();

  const thisMon    = today.slice(0, 7);
  const monIncome  = txs.filter(t => t.date.startsWith(thisMon) && t.type === "income").reduce((s, t)  => s + t.amount, 0);
  const monExpense = txs.filter(t => t.date.startsWith(thisMon) && t.type === "expense").reduce((s, t) => s + t.amount, 0);

  aside.innerHTML = `
    <h2 class="sum-head">Bank Balance</h2>

    <div class="ptt-bal-hero">
      <div class="ptt-bal-hero-top">
        <div>
          <div class="ptt-exp-hero-label">Current Balance</div>
          <div class="ptt-bal-val">${_fmtE(balance)}</div>
        </div>
        <button class="ptt-set-init-btn" id="pttSetInitBtn" title="Set opening balance">✎ Set Initial</button>
      </div>
      <div class="ptt-bal-mon-row">
        <span class="ptt-bal-mon-item">
          <span class="ptt-bal-mon-label">This Month In</span>
          <span style="color:#4ade80;font-family:var(--ff-display);font-size:15px;font-weight:800">+${_fmtE(monIncome)}</span>
        </span>
        <span class="ptt-bal-mon-divider"></span>
        <span class="ptt-bal-mon-item">
          <span class="ptt-bal-mon-label">This Month Out</span>
          <span style="color:#f87171;font-family:var(--ff-display);font-size:15px;font-weight:800">-${_fmtE(monExpense)}</span>
        </span>
      </div>
    </div>

    <div class="ptt-tx-type-toggle">
      <button class="ptt-type-btn${_txType === "expense" ? " active-expense" : ""}" data-type="expense">− Expense</button>
      <button class="ptt-type-btn${_txType === "income"  ? " active-income"  : ""}" data-type="income">+ Income</button>
    </div>

    <div class="ptt-exp-form">
      <input type="text" id="pttExpDate" value="${_fmtDate(today)}" placeholder="DD/MM/YYYY" maxlength="10" class="ptt-form-input" />
      <input type="text" id="pttExpCat" placeholder="${_txType === "income" ? "Source (Salary, Splitwise…)" : "Category (Rent, Food, Gym…)"}" class="ptt-form-input" autocomplete="off" />
      <div class="ptt-exp-amt-row">
        <span class="ptt-curr-sym">€</span>
        <input type="number" id="pttExpAmt" placeholder="0.00" min="0" step="0.01" class="ptt-form-input ptt-amt-input" />
        <button class="btn-primary ptt-add-btn ${_txType === "income" ? "ptt-add-income" : ""}" id="pttExpAddBtn">Add</button>
      </div>
    </div>

    <div class="sum-graph-sep"></div>

    <div class="ptt-exp-list">
      ${withBal.length === 0
        ? `<div class="ptt-history-empty">No transactions yet. Add your opening balance first.</div>`
        : withBal.map(t => `
          <div class="ptt-tx-row">
            <div class="ptt-exp-left">
              <span class="ptt-exp-date">${_fmtDate(t.date)}</span>
              <span class="ptt-exp-cat">${t.category}</span>
            </div>
            <div class="ptt-tx-right">
              <div class="ptt-tx-amt ${t.type === "income" ? "profit" : "loss"}">
                ${t.type === "income" ? "+" : "−"}${_fmtE(t.amount)}
              </div>
              <div class="ptt-tx-bal">→ ${_fmtE(t._balAfter)}</div>
              <button class="ptt-exp-del" data-id="${t.id}">✕</button>
            </div>
          </div>`).join("")}
    </div>`;

  aside.querySelectorAll(".ptt-type-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      _txType = btn.dataset.type;
      _renderBankBalance();
    });
  });

  _$("pttSetInitBtn")?.addEventListener("click", () => {
    const input = _$("pttInitBalInput");
    if (input) input.value = _getInitBal() || "";
    _$("pttInitBalModal")?.classList.remove("hidden");
    setTimeout(() => input?.focus(), 50);
  });

  _$("pttExpDate")?.addEventListener("input", (e) => {
    let v = e.target.value.replace(/\D/g, "").slice(0, 8);
    if (v.length >= 5) v = v.slice(0,2) + "/" + v.slice(2,4) + "/" + v.slice(4);
    else if (v.length >= 3) v = v.slice(0,2) + "/" + v.slice(2);
    e.target.value = v;
  });

  _$("pttExpAddBtn")?.addEventListener("click", _addTx);

  aside.querySelectorAll(".ptt-exp-del").forEach(btn => {
    btn.addEventListener("click", () => _deleteTx(btn.dataset.id));
  });
}

async function _addTx() {
  const raw = (_$("pttExpDate")?.value || "").trim();
  const cat = _$("pttExpCat")?.value.trim();
  const amt = parseFloat(_$("pttExpAmt")?.value);
  if (!raw || !cat || isNaN(amt) || amt <= 0) return;

  const parts = raw.split("/");
  if (parts.length !== 3 || parts[2].length !== 4) return;
  const date = `${parts[2]}-${parts[1].padStart(2,"0")}-${parts[0].padStart(2,"0")}`;

  const tx = { id: Date.now().toString(), date, type: _txType, category: cat, amount: amt };
  _state.txs.push(tx);

  if (_$("pttExpCat")) _$("pttExpCat").value = "";
  if (_$("pttExpAmt")) _$("pttExpAmt").value = "";
  _renderBankBalance();

  try {
    await setDoc(doc(db, "nktt_ptt_tx", tx.id), tx);
  } catch (e) { console.error("tx add:", e); }
}

async function _deleteTx(id) {
  _state.txs = _state.txs.filter(t => t.id !== id);
  _renderBankBalance();

  try {
    await deleteDoc(doc(db, "nktt_ptt_tx", id));
  } catch (e) { console.error("tx del:", e); }
}

function _bindPttEvents() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && document.activeElement?.id === "pttExpAmt") _addTx();
    if (e.key === "Enter" && document.activeElement?.id === "pttInitBalInput") _confirmInitBal();
    if (e.key === "Escape") _$("pttInitBalModal")?.classList.add("hidden");
  });

  _$("pttInitBalConfirm")?.addEventListener("click", _confirmInitBal);

  const closeModal = () => _$("pttInitBalModal")?.classList.add("hidden");
  _$("pttInitBalCancel")?.addEventListener("click", closeModal);
  _$("pttInitBalClose")?.addEventListener("click", closeModal);
  _$("pttInitBalModal")?.addEventListener("click", (e) => {
    if (e.target === _$("pttInitBalModal")) closeModal();
  });
}

async function _confirmInitBal() {
  const val = parseFloat(_$("pttInitBalInput")?.value);
  if (isNaN(val)) return;
  _state.bankInit = val;
  _$("pttInitBalModal")?.classList.add("hidden");
  _renderBankBalance();
  await _saveSettings();
}
