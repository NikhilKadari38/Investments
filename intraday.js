// ─── NK Trade Tracker — Intraday Module ───────────────────────────────────────

import { db } from "./firebase-config.js";
import {
  collection, addDoc, getDocs, doc, updateDoc, deleteDoc,
  query, where, serverTimestamp, setDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const INTRADAY_COL      = "nktt_intraday";
const INTRADAY_DAYS_COL = "nktt_intraday_days";

let _fund        = "zerodha";
let _trades      = [];     // [{id, fund, date, symbol, qty, direction, entryPrice, exitPrice, grossPL}]
let _dayActuals  = {};     // { "2026-07-07": 4735 }
let _editingId   = null;
let _initialized = false;

// ── Helpers ───────────────────────────────────────────────────────────────────
const $        = (id) => document.getElementById(id);
const _capKey  = () => "intradayCapital_"     + _fund;
const _wdKey   = () => "intradayWithdrawals_" + _fund;
const _getCap  = () => parseFloat(localStorage.getItem(_capKey())  || "0");
const _getWds  = () => JSON.parse(localStorage.getItem(_wdKey())   || "[]");

function _fmt(v) {
  if (v === null || v === undefined || isNaN(v)) return "–";
  return "₹" + parseFloat(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Entry Point ───────────────────────────────────────────────────────────────
export async function initIntraday(fund) {
  _fund = fund || localStorage.getItem("currentFund") || "zerodha";
  await _loadAll();
  _render();
  if (!_initialized) {
    _bindEvents();
    _initialized = true;
  }
  _syncPlatformPicker();
}

// ── Data Loading ──────────────────────────────────────────────────────────────
async function _loadAll() {
  try {
    const q    = query(collection(db, INTRADAY_COL), where("fund", "==", _fund));
    const snap = await getDocs(q);
    _trades    = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Sort newest date first, then by createdAt within same day
    _trades.sort((a, b) => {
      if (b.date !== a.date) return b.date.localeCompare(a.date);
      const ca = a.createdAt?.toMillis?.() ?? 0;
      const cb = b.createdAt?.toMillis?.() ?? 0;
      return cb - ca;
    });
  } catch (e) {
    console.error("Intraday trades load error:", e);
    _trades = [];
  }
  try {
    const q2    = query(collection(db, INTRADAY_DAYS_COL), where("fund", "==", _fund));
    const snap2 = await getDocs(q2);
    _dayActuals = {};
    snap2.docs.forEach(d => { _dayActuals[d.data().date] = d.data().actualCredited; });
  } catch (e) {
    _dayActuals = {};
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function _render() {
  _renderLog();
  _renderSummary();
}

function _syncPlatformPicker() {
  const el = $("intradayPlatformName");
  if (el) el.textContent = _fund === "zerodha" ? "Zerodha" : "Groww";
  $("intradayPlatformMenu")?.querySelectorAll(".platform-item").forEach(i =>
    i.classList.toggle("active", i.dataset.fund === _fund)
  );
}

// ── Trade Log ─────────────────────────────────────────────────────────────────
function _renderLog() {
  const log   = $("intradayLog");
  const empty = $("intradayEmpty");
  if (!log) return;
  log.innerHTML = "";

  if (_trades.length === 0) {
    if (empty) empty.style.display = "flex";
    return;
  }
  if (empty) empty.style.display = "none";

  // Group by date (already sorted newest first)
  const groups = {};
  const dateOrder = [];
  _trades.forEach(t => {
    if (!groups[t.date]) { groups[t.date] = []; dateOrder.push(t.date); }
    groups[t.date].push(t);
  });

  [...new Set(dateOrder)].forEach(date => {
    log.appendChild(_buildDateGroup(date, groups[date]));
  });
}

function _buildDateGroup(date, trades) {
  const grossSum = trades.reduce((s, t) => s + (t.grossPL || 0), 0);
  const actual   = _dayActuals[date];
  const charges  = actual !== undefined ? grossSum - actual : null;
  const grossCls = grossSum >= 0 ? "profit" : "loss";

  const label = new Date(date + "T12:00:00").toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "short", year: "numeric"
  });

  const group = document.createElement("div");
  group.className  = "id-group";
  group.dataset.date = date;

  group.innerHTML = `
    <div class="id-group-header">
      <span class="id-group-date">${label}</span>
      <span class="id-group-count">${trades.length} trade${trades.length !== 1 ? "s" : ""}</span>
    </div>
    <div class="id-table">
      <div class="id-thead">
        <span>Type</span><span>Symbol</span><span>Qty</span>
        <span>Entry</span><span>Exit</span><span>P/L</span><span></span>
      </div>
    </div>
  `;

  // Insert trade rows into table
  const table = group.querySelector(".id-table");
  trades.forEach(t => table.appendChild(_buildTradeRow(t)));

  // Merged summary row — spans full width after all trades
  const summary = document.createElement("div");
  summary.className = "id-day-summary";
  summary.innerHTML = `
    <div class="id-sum-cell">
      <span class="id-sum-label">Day Gross</span>
      <span class="id-sum-val ${grossCls}">${grossSum >= 0 ? "+" : ""}${_fmt(grossSum)}</span>
    </div>
    <div class="id-sum-sep">|</div>
    <div class="id-sum-cell">
      <span class="id-sum-label">Actual Received</span>
      <input class="id-actual-input" type="number" data-date="${date}"
        placeholder="Enter ₹ received" step="0.01"
        value="${actual !== undefined ? actual : ""}" />
    </div>
    <div class="id-sum-sep">|</div>
    <div class="id-sum-cell">
      <span class="id-sum-label">Tax / Charges</span>
      <span class="id-charges-val loss" data-date="${date}">${charges !== null ? _fmt(Math.abs(charges)) : "–"}</span>
    </div>
  `;
  table.appendChild(summary);

  // Actual input binding
  group.querySelector(".id-actual-input").addEventListener("change", async (e) => {
    const val = parseFloat(e.target.value);
    if (isNaN(val)) return;
    await _saveDayActual(date, val);
    const newCharges = grossSum - val;
    const chargesEl  = group.querySelector(".id-charges-val");
    if (chargesEl) chargesEl.textContent = _fmt(Math.abs(newCharges));
    _renderSummary();
  });

  return group;
}

function _buildTradeRow(t) {
  const isLong = t.direction === "long";
  const pl     = t.grossPL || 0;
  const plCls  = pl >= 0 ? "profit" : "loss";

  const row = document.createElement("div");
  row.className = "id-row";
  row.innerHTML = `
    <span><span class="id-dir-badge ${isLong ? "long" : "short"}">${isLong ? "▲ L" : "▼ S"}</span></span>
    <span class="id-symbol">${t.symbol}</span>
    <span class="id-mono">${t.qty}</span>
    <span class="id-mono">${_fmt(t.entryPrice)}</span>
    <span class="id-mono">${_fmt(t.exitPrice)}</span>
    <span class="id-mono ${plCls}">${pl >= 0 ? "+" : ""}${_fmt(pl)}</span>
    <span class="id-row-actions">
      <button class="id-edit-btn" data-id="${t.id}" title="Edit">✎</button>
      <button class="id-del-btn"  data-id="${t.id}" title="Delete">✕</button>
    </span>
  `;
  row.querySelector(".id-edit-btn").addEventListener("click", () => _openEditModal(t.id));
  row.querySelector(".id-del-btn").addEventListener("click",  () => _deleteTrade(t.id));
  return row;
}

// ── Summary Panel ─────────────────────────────────────────────────────────────
function _renderSummary() {
  const aside = $("intradaySummary");
  if (!aside) return;

  const capital       = _getCap();
  const withdrawals   = _getWds();
  const totalWithdrawn = withdrawals.reduce((s, w) => s + w.amount, 0);

  // Totals
  const totalGross = _trades.reduce((s, t) => s + (t.grossPL || 0), 0);

  // Per-day map (use actual where entered, else gross for that day)
  const dates    = [...new Set(_trades.map(t => t.date))].sort();
  const dayPLMap = {};
  dates.forEach(date => {
    const dayGross = _trades.filter(t => t.date === date).reduce((s, t) => s + (t.grossPL || 0), 0);
    dayPLMap[date] = _dayActuals[date] !== undefined ? _dayActuals[date] : dayGross;
  });

  // Charges only from days where actual was entered
  const daysWithActual = Object.entries(_dayActuals);
  const totalActualEntered = daysWithActual.reduce((s, [, v]) => s + v, 0);
  const grossForActualDays = daysWithActual.reduce((s, [date]) => {
    return s + _trades.filter(t => t.date === date).reduce((ss, t) => ss + (t.grossPL || 0), 0);
  }, 0);
  const totalCharges = grossForActualDays - totalActualEntered;

  // Total "effective" P&L (actual where available, gross otherwise)
  const totalEffective = Object.values(dayPLMap).reduce((s, v) => s + v, 0);

  // Metrics
  const dayPLValues = Object.values(dayPLMap);
  const winDays     = dayPLValues.filter(v => v > 0).length;
  const lossDays    = dayPLValues.filter(v => v < 0).length;
  const totalDays   = dayPLValues.length;
  const winRate     = totalDays > 0 ? (winDays / totalDays) * 100 : null;
  const bestDay     = dayPLValues.length ? Math.max(...dayPLValues) : null;
  const worstDay    = dayPLValues.length ? Math.min(...dayPLValues) : null;
  const avgDaily    = totalDays > 0 ? totalEffective / totalDays : null;

  // Weekly avg
  const weekMap = {};
  Object.entries(dayPLMap).forEach(([date, pl]) => {
    const d = new Date(date + "T12:00:00");
    const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const wk  = mon.toISOString().slice(0, 10);
    weekMap[wk] = (weekMap[wk] || 0) + pl;
  });
  const weekVals  = Object.values(weekMap);
  const avgWeekly = weekVals.length ? weekVals.reduce((a, b) => a + b, 0) / weekVals.length : null;

  // Long vs Short counts
  const longCount  = _trades.filter(t => t.direction === "long").length;
  const shortCount = _trades.filter(t => t.direction === "short").length;

  const withdrawable = Math.max(0, totalEffective - capital - totalWithdrawn);
  const grossCls     = totalGross     >= 0 ? "profit" : "loss";
  const effectiveCls = totalEffective >= 0 ? "profit" : "loss";

  aside.innerHTML = `
    <h2 class="sum-head">Intraday</h2>

    <div class="sum-hero id-capital-hero">
      <div>
        <div class="sum-hero-label">Trading Capital
          <span class="id-fund-tag">${_fund === "zerodha" ? "Zerodha" : "Groww"}</span>
        </div>
        <div class="sum-hero-val" id="idCapitalVal">
          ${capital > 0 ? _fmt(capital) : '<span class="id-cap-placeholder">Tap ✎ to set</span>'}
        </div>
      </div>
      <div class="sum-hero-badge id-edit-cap" title="Edit capital" style="cursor:pointer">✎</div>
    </div>

    <div class="sum-stat-pair">
      <div class="sum-stat-card">
        <div class="sum-stat-label">Gross P/L</div>
        <div class="sum-stat-val ${grossCls}">${totalGross >= 0 ? "+" : ""}${_fmt(totalGross)}</div>
      </div>
      <div class="sum-stat-card">
        <div class="sum-stat-label">Effective P/L</div>
        <div class="sum-stat-val ${effectiveCls}">${totalEffective >= 0 ? "+" : ""}${_fmt(totalEffective)}</div>
      </div>
    </div>

    <div class="sum-pl-oval ${totalCharges > 0 ? "is-loss" : ""}">
      <div>
        <div class="sum-pl-label">Total Charges / Tax</div>
        <div class="sum-pl-val loss">${_fmt(Math.abs(totalCharges))}</div>
      </div>
      <span class="sum-pl-pct" style="color:var(--text-3);font-size:11px">${daysWithActual.length} day${daysWithActual.length !== 1 ? "s" : ""} data</span>
    </div>

    <div class="sum-pl-oval ${withdrawable > 0 ? "is-profit" : ""} id-withdrawable-oval" id="withdrawableOval" style="${withdrawable > 0 ? "cursor:pointer" : ""}">
      <div>
        <div class="sum-pl-label">Withdrawable${withdrawable > 0 ? " &nbsp;↗" : ""}</div>
        <div class="sum-pl-val ${withdrawable > 0 ? "profit" : ""}">${_fmt(withdrawable)}</div>
      </div>
      <span class="sum-pl-pct" style="color:var(--text-3);font-size:11px">above capital</span>
    </div>

    <div class="sum-pl-oval">
      <div>
        <div class="sum-pl-label">Total Withdrawn</div>
        <div class="sum-pl-val">${_fmt(totalWithdrawn)}</div>
      </div>
      <span class="sum-pl-pct" style="color:var(--text-3);font-size:11px">${withdrawals.length} txn</span>
    </div>

    <div class="sum-graph-sep"></div>

    <div class="id-metrics-grid">
      <div class="id-metric-card">
        <div class="id-metric-label">Win Rate</div>
        <div class="id-metric-val ${winRate !== null && winRate >= 50 ? "profit" : "loss"}">
          ${winRate !== null ? winRate.toFixed(0) + "%" : "–"}
        </div>
        <div class="id-metric-sub">${winDays}W / ${lossDays}L</div>
      </div>
      <div class="id-metric-card">
        <div class="id-metric-label">Best Day</div>
        <div class="id-metric-val profit">${bestDay !== null && bestDay > 0 ? "+" + _fmt(bestDay) : bestDay !== null ? _fmt(bestDay) : "–"}</div>
      </div>
      <div class="id-metric-card">
        <div class="id-metric-label">Worst Day</div>
        <div class="id-metric-val loss">${worstDay !== null ? _fmt(worstDay) : "–"}</div>
      </div>
      <div class="id-metric-card">
        <div class="id-metric-label">Avg / Day</div>
        <div class="id-metric-val ${avgDaily !== null && avgDaily >= 0 ? "profit" : "loss"}">
          ${avgDaily !== null ? (avgDaily >= 0 ? "+" : "") + _fmt(avgDaily) : "–"}
        </div>
      </div>
      <div class="id-metric-card">
        <div class="id-metric-label">Avg / Week</div>
        <div class="id-metric-val ${avgWeekly !== null && avgWeekly >= 0 ? "profit" : "loss"}">
          ${avgWeekly !== null ? (avgWeekly >= 0 ? "+" : "") + _fmt(avgWeekly) : "–"}
        </div>
      </div>
      <div class="id-metric-card">
        <div class="id-metric-label">Trades</div>
        <div class="id-metric-val">${_trades.length}</div>
        <div class="id-metric-sub">${longCount}L / ${shortCount}S</div>
      </div>
      <div class="id-metric-card">
        <div class="id-metric-label">Trading Days</div>
        <div class="id-metric-val">${totalDays}</div>
        <div class="id-metric-sub">${weekVals.length} week${weekVals.length !== 1 ? "s" : ""}</div>
      </div>
      <div class="id-metric-card">
        <div class="id-metric-label">Avg / Trade</div>
        <div class="id-metric-val ${_trades.length > 0 && totalGross / _trades.length >= 0 ? "profit" : "loss"}">
          ${_trades.length > 0 ? (totalGross / _trades.length >= 0 ? "+" : "") + _fmt(totalGross / _trades.length) : "–"}
        </div>
      </div>
    </div>

    ${withdrawals.length > 0 ? `
    <div class="sum-graph-sep"></div>
    <div class="id-withdraw-log">
      <div class="id-withdraw-log-title">Withdrawal Log</div>
      ${withdrawals.slice().reverse().map(w => `
        <div class="id-withdraw-row">
          <span class="id-withdraw-date">${w.date}</span>
          <span class="id-withdraw-note">${w.note || "—"}</span>
          <span class="id-withdraw-amt loss">${_fmt(w.amount)}</span>
        </div>
      `).join("")}
    </div>
    ` : ""}
  `;

  aside.querySelector(".id-edit-cap")?.addEventListener("click", _editCapital);
  const wOval = $("withdrawableOval");
  if (wOval && withdrawable > 0) wOval.addEventListener("click", () => _showWithdrawModal(withdrawable));
}

// ── Capital Edit ──────────────────────────────────────────────────────────────
function _editCapital() {
  const current = _getCap();
  const fundName = _fund === "zerodha" ? "Zerodha" : "Groww";
  const newVal = prompt(
    `Intraday Capital — ${fundName}\nCurrent: ₹${current.toLocaleString("en-IN")}\n\nEnter new capital amount:`
  );
  if (newVal === null) return;
  const parsed = parseFloat(newVal);
  if (isNaN(parsed) || parsed < 0) { _toast("Invalid amount.", "error"); return; }
  if (!confirm(`Set ${fundName} intraday capital to ₹${parsed.toLocaleString("en-IN")}?`)) return;
  localStorage.setItem(_capKey(), parsed);
  _renderSummary();
  _toast("Capital updated.", "success");
}

// ── Withdrawal ────────────────────────────────────────────────────────────────
function _showWithdrawModal(max) {
  const modal = $("withdrawModal");
  if (!modal) return;
  const label = $("withdrawMaxLabel");
  if (label) label.textContent = "Withdrawable: " + _fmt(max);
  const amt = $("withdrawAmountInput");
  const note = $("withdrawNoteInput");
  if (amt)  amt.value  = "";
  if (note) note.value = "";
  modal.classList.remove("hidden");
  if (amt) amt.focus();
}

function _closeWithdrawModal() {
  $("withdrawModal")?.classList.add("hidden");
}

function _confirmWithdrawal() {
  const amt  = parseFloat($("withdrawAmountInput")?.value);
  const note = $("withdrawNoteInput")?.value.trim() || "";
  if (!amt || amt <= 0) { _toast("Enter a valid amount.", "error"); return; }
  const wds = _getWds();
  const todayLabel = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric"
  });
  wds.push({ date: todayLabel, amount: amt, note });
  localStorage.setItem(_wdKey(), JSON.stringify(wds));
  _closeWithdrawModal();
  _renderSummary();
  _toast("Withdrawal logged!", "success");
}

// ── Add/Edit Modal ────────────────────────────────────────────────────────────
function _openAddModal() {
  _editingId = null;
  const modal = $("intradayModal");
  if (!modal) return;
  const title = $("intradayModalTitle");
  if (title) title.textContent = "Add Intraday Trade";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const dateEl = $("idInputDate"); if (dateEl) dateEl.value = today;
  const sym    = $("idInputSymbol"); if (sym) sym.value = "";
  const qty    = $("idInputQty");    if (qty) qty.value = "";
  const entry  = $("idInputEntry");  if (entry) entry.value = "";
  const exit   = $("idInputExit");   if (exit) exit.value = "";
  const gross  = $("idGrossDisplay"); if (gross) { gross.textContent = "–"; gross.className = "id-gross-display"; }
  _setDir("long");
  modal.classList.remove("hidden");
  sym?.focus();
}

function _openEditModal(id) {
  const t = _trades.find(t => t.id === id);
  if (!t) return;
  _editingId = id;
  const modal = $("intradayModal");
  if (!modal) return;
  const title = $("intradayModalTitle"); if (title) title.textContent = "Edit Trade";
  const dateEl = $("idInputDate"); if (dateEl) dateEl.value = t.date;
  const sym    = $("idInputSymbol"); if (sym) sym.value = t.symbol;
  const qty    = $("idInputQty");    if (qty) qty.value = t.qty;
  const entry  = $("idInputEntry");  if (entry) entry.value = t.entryPrice;
  const exit   = $("idInputExit");   if (exit) exit.value = t.exitPrice;
  _setDir(t.direction);
  _calcGross();
  modal.classList.remove("hidden");
  sym?.focus();
}

function _closeModal() {
  $("intradayModal")?.classList.add("hidden");
  _editingId = null;
}

function _setDir(dir) {
  $("idDirLong")?.classList.toggle("active",  dir === "long");
  $("idDirShort")?.classList.toggle("active", dir === "short");
  const entryLbl = $("idEntryLabel");
  const exitLbl  = $("idExitLabel");
  if (entryLbl) entryLbl.textContent = dir === "long"  ? "Buy Price"   : "Short Price";
  if (exitLbl)  exitLbl.textContent  = dir === "long"  ? "Sell Price"  : "Cover Price";
}

function _getDir() {
  return $("idDirLong")?.classList.contains("active") ? "long" : "short";
}

function _calcGross() {
  const qty   = parseFloat($("idInputQty")?.value)   || 0;
  const entry = parseFloat($("idInputEntry")?.value)  || 0;
  const exit  = parseFloat($("idInputExit")?.value)   || 0;
  const el    = $("idGrossDisplay");
  if (!el) return;
  if (qty > 0 && entry > 0 && exit > 0) {
    const gross = _getDir() === "long" ? (exit - entry) * qty : (entry - exit) * qty;
    el.textContent = (gross >= 0 ? "+" : "") + _fmt(gross);
    el.className   = "id-gross-display " + (gross >= 0 ? "profit" : "loss");
  } else {
    el.textContent = "–";
    el.className   = "id-gross-display";
  }
}

async function _saveTrade() {
  const date       = $("idInputDate")?.value;
  const symbol     = $("idInputSymbol")?.value.trim().toUpperCase();
  const qty        = parseFloat($("idInputQty")?.value);
  const entryPrice = parseFloat($("idInputEntry")?.value);
  const exitPrice  = parseFloat($("idInputExit")?.value);
  const direction  = _getDir();

  if (!date || !symbol || !qty || !entryPrice || !exitPrice) {
    _toast("Fill all fields.", "error"); return;
  }

  const grossPL = direction === "long"
    ? (exitPrice - entryPrice) * qty
    : (entryPrice - exitPrice) * qty;

  const btn = $("idSaveBtn");
  if (btn) { btn.textContent = "Saving..."; btn.disabled = true; }

  try {
    if (_editingId) {
      const upd = { date, symbol, qty, direction, entryPrice, exitPrice, grossPL };
      await updateDoc(doc(db, INTRADAY_COL, _editingId), upd);
      const idx = _trades.findIndex(t => t.id === _editingId);
      if (idx !== -1) _trades[idx] = { ..._trades[idx], ...upd };
      // Re-sort after date may have changed
      _trades.sort((a, b) => {
        if (b.date !== a.date) return b.date.localeCompare(a.date);
        const ca = a.createdAt?.toMillis?.() ?? 0;
        const cb = b.createdAt?.toMillis?.() ?? 0;
        return cb - ca;
      });
    } else {
      const data = { fund: _fund, date, symbol, qty, direction, entryPrice, exitPrice, grossPL, createdAt: serverTimestamp() };
      const ref  = await addDoc(collection(db, INTRADAY_COL), data);
      _trades.unshift({ id: ref.id, ...data, createdAt: { toMillis: () => Date.now() } });
      // Re-sort
      _trades.sort((a, b) => {
        if (b.date !== a.date) return b.date.localeCompare(a.date);
        const ca = a.createdAt?.toMillis?.() ?? 0;
        const cb = b.createdAt?.toMillis?.() ?? 0;
        return cb - ca;
      });
    }
    _closeModal();
    _render();
    _toast(_editingId ? "Trade updated!" : "Trade added!", "success");
  } catch (e) {
    _toast("Error: " + e.message, "error");
  } finally {
    if (btn) { btn.textContent = "Save Trade"; btn.disabled = false; }
  }
}

async function _deleteTrade(id) {
  if (!confirm("Delete this trade? This cannot be undone.")) return;
  try {
    await deleteDoc(doc(db, INTRADAY_COL, id));
    _trades = _trades.filter(t => t.id !== id);
    _render();
    _toast("Deleted.", "info");
  } catch (e) {
    _toast("Error: " + e.message, "error");
  }
}

async function _saveDayActual(date, amount) {
  const id = _fund + "_" + date;
  try {
    await setDoc(doc(db, INTRADAY_DAYS_COL, id), { fund: _fund, date, actualCredited: amount });
    _dayActuals[date] = amount;
  } catch (e) {
    console.error("Save day actual error:", e);
    _toast("Could not save.", "error");
  }
}

// ── Event Binding (once) ──────────────────────────────────────────────────────
function _bindEvents() {
  // Add button
  $("intradayAddBtn")?.addEventListener("click", _openAddModal);

  // Intraday platform picker
  const platBtn    = $("intradayPlatformBtn");
  const platMenu   = $("intradayPlatformMenu");
  const platPicker = $("intradayPlatformPicker");
  if (platBtn && platMenu && platPicker) {
    platBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      platMenu.classList.toggle("hidden");
      platPicker.classList.toggle("open");
      platMenu.querySelectorAll(".platform-item").forEach(i =>
        i.classList.toggle("active", i.dataset.fund === _fund)
      );
    });
    platMenu.querySelectorAll(".platform-item").forEach(item => {
      item.addEventListener("click", () => {
        platMenu.classList.add("hidden");
        platPicker.classList.remove("open");
        // Dispatch global fund change — app.js listens and calls initIntraday + applyFund
        document.dispatchEvent(new CustomEvent("nktt-fund-change", { detail: { fund: item.dataset.fund } }));
      });
    });
    document.addEventListener("click", (e) => {
      if (!platPicker.contains(e.target)) {
        platMenu.classList.add("hidden");
        platPicker.classList.remove("open");
      }
    });
  }

  // Trade modal
  $("idModalClose")?.addEventListener("click",  _closeModal);
  $("idCancelBtn")?.addEventListener("click",   _closeModal);
  $("intradayModal")?.addEventListener("click", (e) => { if (e.target === $("intradayModal")) _closeModal(); });
  $("idSaveBtn")?.addEventListener("click",     _saveTrade);

  // Direction toggle
  $("idDirLong")?.addEventListener("click",  () => { _setDir("long");  _calcGross(); });
  $("idDirShort")?.addEventListener("click", () => { _setDir("short"); _calcGross(); });

  // Auto-calc
  ["idInputQty", "idInputEntry", "idInputExit"].forEach(id => {
    $(id)?.addEventListener("input", _calcGross);
  });

  // Withdrawal modal
  $("withdrawCloseBtn")?.addEventListener("click",   _closeWithdrawModal);
  $("withdrawCancelBtn")?.addEventListener("click",  _closeWithdrawModal);
  $("withdrawConfirmBtn")?.addEventListener("click", _confirmWithdrawal);
  $("withdrawModal")?.addEventListener("click", (e) => { if (e.target === $("withdrawModal")) _closeWithdrawModal(); });
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function _toast(msg, type = "info") {
  let wrap = document.querySelector(".toast-wrap");
  if (!wrap) { wrap = document.createElement("div"); wrap.className = "toast-wrap"; document.body.appendChild(wrap); }
  const t = document.createElement("div");
  t.className   = "toast " + type;
  t.textContent = msg;
  wrap.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add("visible")));
  setTimeout(() => { t.classList.remove("visible"); setTimeout(() => t.remove(), 280); }, 2600);
}
