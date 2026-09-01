// ─── NK Trade Tracker — Intraday Module ───────────────────────────────────────

import { db } from "./firebase-config.js";
import {
  collection, addDoc, getDocs, doc, updateDoc, deleteDoc,
  query, where, serverTimestamp, setDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const INTRADAY_COL      = "nktt_intraday";
const INTRADAY_DAYS_COL = "nktt_intraday_days";
const WORKER_URL        = "https://nk-price-proxy.lotuswhite9392.workers.dev";

let _fund        = "zerodha";
let _trades      = [];     // [{id, fund, date, symbol, qty, direction, entryPrice, exitPrice, grossPL}]
let _dayActuals  = {};     // { "2026-07-07": 4735 }
let _editingId   = null;
let _initialized = false;
let _fundsAdvice = {};     // cache: "fund_bucket" → advice string

// ── Helpers ───────────────────────────────────────────────────────────────────
const $        = (id) => document.getElementById(id);
const _wdKey   = () => "intradayWithdrawals_" + _fund;
const _depKey  = () => "intradayDeposits_"    + _fund;
const _getWds  = () => { try { return JSON.parse(localStorage.getItem(_wdKey())  || "[]"); } catch { return []; } };
const _getDeps = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(_depKey()) || "[]");
    if (stored.length > 0) return stored;
    // Auto-migrate from old single-number capital key
    const oldCap = parseFloat(localStorage.getItem("intradayCapital_" + _fund) || "0");
    if (oldCap > 0) {
      const migrated = [{ id: "init", date: "Initial", amount: oldCap, note: "Initial capital" }];
      localStorage.setItem(_depKey(), JSON.stringify(migrated));
      localStorage.removeItem("intradayCapital_" + _fund);
      return migrated;
    }
    return [];
  } catch { return []; }
};
const _getCap  = () => _getDeps().reduce((s, d) => s + d.amount, 0);

function _fmt(v) {
  if (v === null || v === undefined || isNaN(v)) return "–";
  return "₹" + parseFloat(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Entry Point ───────────────────────────────────────────────────────────────
export async function initIntraday(fund) {
  _fund = fund || localStorage.getItem("intradayFund") || "groww";
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
  const n        = trades.length;

  const label = new Date(date + "T12:00:00").toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "short", year: "numeric"
  });

  const group = document.createElement("div");
  group.className    = "id-group";
  group.dataset.date = date;

  // Header
  const header = document.createElement("div");
  header.className = "id-group-header";
  header.innerHTML = `
    <span class="id-group-date">${label}</span>
    <span class="id-group-count">${n} trade${n !== 1 ? "s" : ""}</span>
  `;
  group.appendChild(header);

  // Real <table> so we can use rowSpan for merged cells
  const table = document.createElement("table");
  table.className = "id-table";

  const thead = document.createElement("thead");
  thead.innerHTML = `<tr>
    <th>Type</th><th>Symbol</th><th>Qty</th>
    <th>Entry</th><th>Exit</th><th>P/L</th><th></th>
    <th class="id-th-merge">Day Gross</th>
    <th class="id-th-merge">Actual Received</th>
    <th class="id-th-merge">Tax / Charges</th>
  </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  trades.forEach((t, i) => {
    const isLong = t.direction === "long";
    const pl     = t.grossPL || 0;
    const plCls  = pl >= 0 ? "profit" : "loss";
    const tr     = document.createElement("tr");

    tr.innerHTML = `
      <td><span class="id-dir-badge ${isLong ? "long" : "short"}">${isLong ? "▲ L" : "▼ S"}</span></td>
      <td class="id-symbol">${t.symbol}</td>
      <td class="id-mono">${t.qty}</td>
      <td class="id-mono">${_fmt(t.entryPrice)}</td>
      <td class="id-mono">${_fmt(t.exitPrice)}</td>
      <td class="id-mono ${plCls}">${pl >= 0 ? "+" : ""}${_fmt(pl)}</td>
      <td class="id-row-actions">
        <button class="id-edit-btn" data-id="${t.id}" title="Edit">✎</button>
        <button class="id-del-btn"  data-id="${t.id}" title="Delete">✕</button>
      </td>
    `;
    tr.querySelector(".id-edit-btn").addEventListener("click", () => _openEditModal(t.id));
    tr.querySelector(".id-del-btn").addEventListener("click",  () => _deleteTrade(t.id));

    // Merged cells — only on the first row, spanning all n rows
    if (i === 0) {
      // Day Gross
      const tdGross = document.createElement("td");
      tdGross.rowSpan   = n;
      tdGross.className = "id-merged-cell";
      tdGross.innerHTML = `<div class="id-mc-label">Day Gross</div><div class="id-mc-val ${grossCls}">${grossSum >= 0 ? "+" : ""}${_fmt(grossSum)}</div>`;
      tr.appendChild(tdGross);

      // Actual Received
      const tdActual = document.createElement("td");
      tdActual.rowSpan   = n;
      tdActual.className = "id-merged-cell";
      const inp = document.createElement("input");
      inp.className    = "id-actual-input";
      inp.type         = "number";
      inp.placeholder  = "Enter ₹ received";
      inp.step         = "0.01";
      inp.dataset.date = date;
      if (actual !== undefined) inp.value = actual;
      const inpWrap = document.createElement("div");
      inpWrap.innerHTML = `<div class="id-mc-label">Actual Received</div>`;
      inpWrap.appendChild(inp);
      tdActual.appendChild(inpWrap);
      tr.appendChild(tdActual);

      // Tax
      const tdTax = document.createElement("td");
      tdTax.rowSpan   = n;
      tdTax.className = "id-merged-cell";
      tdTax.innerHTML = `<div class="id-mc-label">Tax / Charges</div><div class="id-charges-val loss">${charges !== null ? _fmt(Math.abs(charges)) : "–"}</div>`;
      tr.appendChild(tdTax);

      inp.addEventListener("change", (e) => {
        const val    = parseFloat(e.target.value);
        const prevEl = e.target;
        if (isNaN(val)) return;
        _showIdConfirm({
          icon: "💰",
          title: "Save Actual Received?",
          msg: `${_fmt(val)} for ${label}`,
          confirmLabel: "Save",
          onOk: async () => {
            await _saveDayActual(date, val);
            const newCharges = grossSum - val;
            const chargesEl  = group.querySelector(".id-charges-val");
            if (chargesEl) chargesEl.textContent = _fmt(Math.abs(newCharges));
            _renderSummary();
          },
          onCancel: () => { prevEl.value = actual !== undefined ? actual : ""; }
        });
      });
    }

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  group.appendChild(table);
  return group;
}

// ── Summary Panel ─────────────────────────────────────────────────────────────
function _renderSummary() {
  const aside = $("intradaySummary");
  if (!aside) return;

  const deposits      = _getDeps();
  const capital       = deposits.reduce((s, d) => s + d.amount, 0);
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
  // Only count day actuals for dates that still have trades
  const tradeDates     = new Set(_trades.map(t => t.date));
  const daysWithActual = Object.entries(_dayActuals).filter(([date]) => tradeDates.has(date));
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

  const withdrawable = Math.max(0, totalEffective - totalWithdrawn);
  const grossCls     = totalGross     >= 0 ? "profit" : "loss";
  const effectiveCls = totalEffective >= 0 ? "profit" : "loss";

  aside.innerHTML = `
    <h2 class="sum-head">Intraday</h2>

    <div class="sum-hero id-capital-hero${deposits.length > 0 ? " id-dep-log-btn" : ""}" style="${deposits.length > 0 ? "cursor:pointer" : ""}">
      <div>
        <div class="sum-hero-label">Account Balance
          <span class="id-fund-tag">${_fund === "zerodha" ? "Zerodha" : "Groww"}</span>
        </div>
        <div class="sum-hero-val" id="idCapitalVal">
          ${capital > 0 ? _fmt(capital + totalEffective) : '<span class="id-cap-placeholder">Tap + to add deposit</span>'}
        </div>
        ${capital > 0 ? `<div class="id-dep-chips">${(() => {
          const base = _fmt(deposits[0].amount);
          const pl   = totalEffective !== 0 ? `${totalEffective >= 0 ? "+" : ""}${_fmt(totalEffective)} P/L` : null;
          const extra = deposits.length > 1 ? `+${_fmt(deposits.slice(1).reduce((s,d)=>s+d.amount,0))} new` : null;
          return [base, pl, extra].filter(Boolean).join(" · ");
        })()}</div>` : ""}
      </div>
      <div class="sum-hero-badge id-add-deposit" title="Add deposit" style="cursor:pointer"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v12M2 8h12" stroke="white" stroke-width="2" stroke-linecap="round"/></svg></div>
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

    <div class="sum-pl-oval${withdrawals.length > 0 ? " id-withdrawn-clickable" : ""}" id="totalWithdrawnOval"${withdrawals.length > 0 ? ' style="cursor:pointer"' : ''}>
      <div>
        <div class="sum-pl-label">Total Withdrawn${withdrawals.length > 0 ? " &nbsp;↗" : ""}</div>
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


    ${capital > 0 ? _buildFundsCard({
      capital, totalEffective, totalWithdrawn,
      winRate, avgDaily, totalDays, winDays, lossDays, bestDay, worstDay
    }) : ""}
  `;

  aside.querySelector(".id-add-deposit")?.addEventListener("click", (e) => { e.stopPropagation(); _showDepositModal(); });
  aside.querySelector(".id-dep-log-btn")?.addEventListener("click", _showDepositLogModal);
  const wOval = $("withdrawableOval");
  if (wOval && withdrawable > 0) wOval.addEventListener("click", () => _showWithdrawModal(withdrawable));
  const wLogOval = $("totalWithdrawnOval");
  if (wLogOval && withdrawals.length > 0) wLogOval.addEventListener("click", _showWithdrawLogModal);

  // Funds card AI wiring
  if (capital > 0) {
    const netProfit = totalEffective - totalWithdrawn;
    const aiBtn = $("idFundsAiBtn");
    if (aiBtn) aiBtn.addEventListener("click", () => _fetchFundsAdvice({
      capital, totalEffective, totalWithdrawn, netProfit,
      winRate, avgDaily, totalDays, winDays, lossDays, bestDay, worstDay
    }));
    // Auto-fetch for deficit if not cached
    if (netProfit < -50) {
      const cacheKey = _fund + "_" + Math.round(netProfit / 200);
      if (_fundsAdvice[cacheKey]) {
        _showFundsAdvice(_fundsAdvice[cacheKey]);
      } else {
        _fetchFundsAdvice({
          capital, totalEffective, totalWithdrawn, netProfit,
          winRate, avgDaily, totalDays, winDays, lossDays, bestDay, worstDay
        });
      }
    }
  }
}

// ── Deposit ───────────────────────────────────────────────────────────────────
function _showDepositModal() {
  const modal = $("depositModal");
  if (!modal) return;
  const amt  = $("depositAmountInput");
  const note = $("depositNoteInput");
  if (amt)  amt.value  = "";
  if (note) note.value = "";
  modal.classList.remove("hidden");
  amt?.focus();
}

function _closeDepositModal() {
  $("depositModal")?.classList.add("hidden");
}

function _confirmDeposit() {
  const amt  = parseFloat($("depositAmountInput")?.value);
  const note = $("depositNoteInput")?.value.trim() || "";
  if (!amt || amt <= 0) { _toast("Enter a valid amount.", "error"); return; }
  const deps = _getDeps();
  const dateLabel = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric"
  });
  deps.push({ id: Date.now().toString(), date: dateLabel, amount: amt, note });
  localStorage.setItem(_depKey(), JSON.stringify(deps));
  _closeDepositModal();
  _renderSummary();
  _toast("Deposit added.", "success");
}

function _showDepositLogModal() {
  const modal = $("depositLogModal");
  const body  = $("depositLogBody");
  if (!modal || !body) return;
  const deps  = _getDeps();
  if (!deps.length) { body.innerHTML = `<p class="wl-empty">No deposits yet.</p>`; }
  else {
    const total = deps.reduce((s, d) => s + d.amount, 0);
    body.innerHTML = deps.map(d => `
      <div class="wl-item">
        <div class="wl-item-left">
          <span class="wl-item-date">${d.date}</span>
          <span class="wl-item-note">${d.note || "Deposit"}</span>
        </div>
        <div class="wl-item-right">
          <span class="wl-item-amt">${_fmt(d.amount)}</span>
          ${d.id !== "init" ? `<button class="wl-item-del" data-id="${d.id}">✕</button>` : ""}
        </div>
      </div>`).join("") +
      `<div class="wl-total-row"><span>Total Capital</span><span>${_fmt(total)}</span></div>`;
    body.querySelectorAll(".wl-item-del").forEach(btn =>
      btn.addEventListener("click", () => {
        const deps2 = _getDeps().filter(d => d.id !== btn.dataset.id);
        localStorage.setItem(_depKey(), JSON.stringify(deps2));
        _showDepositLogModal();
        _renderSummary();
      })
    );
  }
  modal.classList.remove("hidden");
}

function _closeDepositLogModal() {
  $("depositLogModal")?.classList.add("hidden");
}

// ── Funds Reminder ────────────────────────────────────────────────────────────
function _buildFundsCard({ capital, totalEffective, totalWithdrawn, winRate, avgDaily, totalDays, bestDay, worstDay }) {
  const net    = totalEffective - totalWithdrawn;
  const pct    = capital > 0 ? ((net / capital) * 100) : 0;
  const status = net > 50 ? "surplus" : net < -50 ? "deficit" : "neutral";

  const icon  = status === "surplus" ? "💰" : status === "deficit" ? "⚠️" : "⚖️";
  const badge = status === "surplus" ? "Surplus" : status === "deficit" ? "Deficit" : "Breakeven";

  let body = "";
  if (status === "surplus") {
    body = `
      <div class="id-funds-amount profit">+${_fmt(net)}</div>
      <div class="id-funds-sub">above your ₹${(capital / 1000).toFixed(0)}k capital (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)</div>
      <div class="id-funds-action">
        Transfer <strong>${_fmt(net)}</strong> to savings — your capital is safe and working.
      </div>`;
  } else if (status === "deficit") {
    body = `
      <div class="id-funds-amount loss">${_fmt(net)}</div>
      <div class="id-funds-sub">below your ₹${(capital / 1000).toFixed(0)}k capital (${pct.toFixed(1)}%)</div>
      <div class="id-funds-suggestion" id="idFundsSuggestion">
        <div class="id-funds-loading">
          <span class="id-funds-dot"></span><span class="id-funds-dot"></span><span class="id-funds-dot"></span>
        </div>
      </div>
      <button class="id-funds-ai-btn" id="idFundsAiBtn" style="display:none">🤖 Ask Again</button>`;
  } else {
    body = `
      <div class="id-funds-amount" style="color:var(--text-2)">₹0</div>
      <div class="id-funds-sub">at breakeven — withdrawn profits match gains</div>
      <div class="id-funds-action">Keep trading carefully. Protect your capital.</div>`;
  }

  return `
    <div class="sum-graph-sep"></div>
    <div class="id-funds-card id-funds-${status}">
      <div class="id-funds-header">
        <span class="id-funds-icon">${icon}</span>
        <span class="id-funds-title">Funds Status</span>
        <span class="id-funds-badge id-funds-badge-${status}">${badge}</span>
      </div>
      ${body}
    </div>`;
}

function _showFundsAdvice(text) {
  const el = $("idFundsSuggestion");
  if (el) el.innerHTML = text;
  const btn = $("idFundsAiBtn");
  if (btn) btn.style.display = "";
}

async function _fetchFundsAdvice({ capital, netProfit, winRate, avgDaily, totalDays, winDays, lossDays, bestDay, worstDay }) {
  const cacheKey = _fund + "_" + Math.round(netProfit / 200);
  if (_fundsAdvice[cacheKey]) { _showFundsAdvice(_fundsAdvice[cacheKey]); return; }

  const ctx = [
    `Capital: ₹${capital.toFixed(0)}`,
    `Net P&L after withdrawals: ₹${netProfit.toFixed(0)}`,
    `Win rate: ${winRate !== null ? winRate.toFixed(0) + "%" : "N/A"}`,
    `Win days: ${winDays}, Loss days: ${lossDays}, Total days: ${totalDays}`,
    `Avg per day: ${avgDaily !== null ? "₹" + avgDaily.toFixed(0) : "N/A"}`,
    `Best day: ${bestDay !== null ? "₹" + bestDay.toFixed(0) : "N/A"}`,
    `Worst day: ${worstDay !== null ? "₹" + worstDay.toFixed(0) : "N/A"}`,
    `Platform: ${_fund}`,
  ].join(" | ");

  const prompt = `You are a practical intraday trading advisor. A trader's account is ₹${Math.abs(netProfit).toFixed(0)} below starting capital. Stats: ${ctx}. Give 2-3 short, specific, actionable suggestions to recover the deficit and protect capital. No generic advice. Use emojis. Max 60 words. Format as short bullet points.`;

  try {
    const res  = await fetch(WORKER_URL + "?type=ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    const advice = data.analysis || data.result || "Couldn't load advice. Tap Ask Again.";
    _fundsAdvice[cacheKey] = advice;
    _showFundsAdvice(advice);
  } catch {
    _showFundsAdvice("⚠️ Network error. Tap Ask Again.");
    const btn = $("idFundsAiBtn");
    if (btn) btn.style.display = "";
  }
}

// ── Withdrawal Log Modal ──────────────────────────────────────────────────────
function _showWithdrawLogModal() {
  const modal = $("withdrawLogModal");
  const body  = $("withdrawLogBody");
  if (!modal || !body) return;
  _renderWithdrawLogBody(body);
  modal.classList.remove("hidden");
}

function _renderWithdrawLogBody(body) {
  const wds = _getWds();
  if (wds.length === 0) {
    body.innerHTML = `<p class="wl-empty">No withdrawals logged yet.</p>`;
    return;
  }
  const total = wds.reduce((s, w) => s + w.amount, 0);
  body.innerHTML = `
    <div class="wl-list">
      ${wds.slice().reverse().map((w, i) => {
        const realIdx = wds.length - 1 - i;
        return `
          <div class="wl-row">
            <div class="wl-row-info">
              <span class="wl-date">${w.date}</span>
              <span class="wl-note">${w.note || "—"}</span>
            </div>
            <span class="wl-amt loss">${_fmt(w.amount)}</span>
            <button class="wl-del-btn" data-idx="${realIdx}" title="Remove">✕</button>
          </div>`;
      }).join("")}
    </div>
    <div class="wl-total">
      <span>Total (${wds.length} txn)</span>
      <span class="loss">${_fmt(total)}</span>
    </div>
  `;
  body.querySelectorAll(".wl-del-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      const arr = _getWds();
      arr.splice(idx, 1);
      localStorage.setItem(_wdKey(), JSON.stringify(arr));
      _renderWithdrawLogBody(body);
      _renderSummary();
    });
  });
}

function _closeWithdrawLogModal() {
  $("withdrawLogModal")?.classList.add("hidden");
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

function _deleteTrade(id) {
  const t = _trades.find(t => t.id === id);
  _showIdConfirm({
    icon: "🗑",
    title: "Delete Trade?",
    msg: t ? `${t.symbol} · ${t.qty} qty · ${t.date}` : "This cannot be undone.",
    confirmLabel: "Delete",
    confirmClass: "btn-confirm-danger",
    onOk: async () => {
      try {
        await deleteDoc(doc(db, INTRADAY_COL, id));
        _trades = _trades.filter(t => t.id !== id);
        _render();
        _toast("Deleted.", "info");
      } catch (e) {
        _toast("Error: " + e.message, "error");
      }
    }
  });
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

// ── Custom Confirm/Prompt Popup ───────────────────────────────────────────────
function _showIdConfirm({ icon = "", title = "", msg = "", confirmLabel = "Confirm", confirmClass = "", showInput = false, inputValue = "", inputPlaceholder = "", onOk, onCancel } = {}) {
  const modal = $("idConfirmModal");
  if (!modal) return;

  $("idConfirmIcon").textContent  = icon;
  $("idConfirmTitle").textContent = title;
  $("idConfirmMsg").textContent   = msg;

  const okBtn = $("idConfirmOk");
  okBtn.textContent = confirmLabel;
  okBtn.className   = "btn-primary" + (confirmClass ? " " + confirmClass : "");

  const inp = $("idConfirmInput");
  if (showInput) {
    inp.value       = inputValue;
    inp.placeholder = inputPlaceholder;
    inp.classList.remove("hidden");
    setTimeout(() => { inp.focus(); inp.select(); }, 80);
  } else {
    inp.classList.add("hidden");
  }

  modal.classList.remove("hidden");

  const close = () => modal.classList.add("hidden");

  okBtn.onclick = () => {
    close();
    if (onOk) onOk(showInput ? inp.value : null);
  };
  $("idConfirmCancel").onclick = () => { close(); if (onCancel) onCancel(); };
  modal.onclick = (e) => { if (e.target === modal) { close(); if (onCancel) onCancel(); } };
  if (showInput) inp.onkeydown = (e) => { if (e.key === "Enter") okBtn.click(); };
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
        // Dispatch intraday-only fund change — app.js updates intradayFund, never touches portfolio
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

  // Withdrawal log modal
  $("withdrawLogCloseBtn")?.addEventListener("click", _closeWithdrawLogModal);
  $("withdrawLogDoneBtn")?.addEventListener("click",  _closeWithdrawLogModal);
  $("withdrawLogModal")?.addEventListener("click", (e) => { if (e.target === $("withdrawLogModal")) _closeWithdrawLogModal(); });

  // Deposit modal
  $("depositCloseBtn")?.addEventListener("click",   _closeDepositModal);
  $("depositCancelBtn")?.addEventListener("click",  _closeDepositModal);
  $("depositConfirmBtn")?.addEventListener("click", _confirmDeposit);
  $("depositModal")?.addEventListener("click", (e) => { if (e.target === $("depositModal")) _closeDepositModal(); });
  $("depositAmountInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") _confirmDeposit(); });

  // Deposit log modal
  $("depositLogCloseBtn")?.addEventListener("click", _closeDepositLogModal);
  $("depositLogDoneBtn")?.addEventListener("click",  _closeDepositLogModal);
  $("depositLogModal")?.addEventListener("click", (e) => { if (e.target === $("depositLogModal")) _closeDepositLogModal(); });
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
