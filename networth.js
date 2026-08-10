// ─── NK Trade Tracker — Net Worth Module ──────────────────────────────────────

import { db } from "./firebase-config.js";
import {
  collection, getDocs, query, where, doc, getDoc, setDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const TRADES_COL        = "nktt_trades";
const INTRADAY_COL      = "nktt_intraday";
const INTRADAY_DAYS_COL = "nktt_intraday_days";
const NW_RATE_KEY       = "nw_eur_rate_v1";
const PTT_TX_KEY        = "ptt_transactions_v1";
const PTT_BANK_KEY      = "ptt_bank_init_v1";

const PLATFORMS = [
  { id: "zerodha", name: "Zerodha", color: "#F97316", letter: "Z" },
  { id: "groww",   name: "Groww",   color: "#5367FF", letter: "G" },
];

let _nwInit   = false;
let _pdata    = {};
let _bank     = 0;
let _bankTxs  = [];
let _bankInit = 0;
let _others   = [];  // [{ id, sign, name, description, amount }]

const $ = id => document.getElementById(id);

// ─── Entry Point ──────────────────────────────────────────────────────────────
export async function initNetworth() {
  _renderShell();
  if (!_nwInit) { _bindEvents(); _nwInit = true; }
  await _loadAll();
  _renderAll();
}

// ─── Data Loading ─────────────────────────────────────────────────────────────
async function _loadAll() {
  await Promise.all([
    ...PLATFORMS.map(p => _loadPlatform(p)),
    _loadBank(),
    _loadOthers()
  ]);
}

async function _loadPlatform(p) {
  const [swing, intraday] = await Promise.all([
    _loadSwing(p.id),
    _loadIntraday(p.id),
  ]);
  _pdata[p.id] = { swing, intraday };
}

async function _loadSwing(fund) {
  try {
    const deposited = fund === "zerodha"
      ? 350000
      : (parseFloat(localStorage.getItem("depositedCapital_" + fund)) || 0);

    // Zerodha: fetch all trades and filter client-side — older trades have no `fund`
    // field and default to zerodha, so a direct where("fund","==","zerodha") misses them.
    // Groww: safe to filter server-side since Groww trades always have the field.
    let allDocs;
    if (fund === "zerodha") {
      const snap = await getDocs(collection(db, TRADES_COL));
      allDocs = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(t => (t.fund || "zerodha") === "zerodha");
    } else {
      const snap = await getDocs(query(collection(db, TRADES_COL), where("fund", "==", fund)));
      allDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }

    if (allDocs.length === 0 && deposited === 0) return null;

    const closed       = allDocs.filter(t => t.status === "closed");
    const open         = allDocs.filter(t => t.status === "open");
    const realized     = closed.reduce((s, t) => s + (t.returns ?? 0), 0);
    const investedOpen = open.reduce((s, t) => s + t.investedAmount, 0);
    const currentOpen  = open.reduce((s, t) =>
      s + (t.livePrice ? t.livePrice * t.shares : t.investedAmount), 0);
    const freeCash   = deposited + realized - investedOpen;
    const totalValue = freeCash + currentOpen;

    return {
      value: totalValue, deposited, realized, freeCash,
      currentOpen, investedOpen,
      openCount: open.length, closedCount: closed.length,
    };
  } catch (e) {
    console.error("NW swing load error:", fund, e);
    return null;
  }
}

async function _loadIntraday(fund) {
  try {
    const capital    = parseFloat(localStorage.getItem("intradayCapital_" + fund) || "0");
    const withdrawals = JSON.parse(localStorage.getItem("intradayWithdrawals_" + fund) || "[]");
    const totalWithdrawn = withdrawals.reduce((s, w) => s + w.amount, 0);

    const [snap1, snap2] = await Promise.all([
      getDocs(query(collection(db, INTRADAY_COL), where("fund", "==", fund))),
      getDocs(query(collection(db, INTRADAY_DAYS_COL), where("fund", "==", fund))),
    ]);

    if (snap1.docs.length === 0 && capital === 0) return null;

    const trades = snap1.docs.map(d => d.data());
    const dayActuals = {};
    snap2.docs.forEach(d => { dayActuals[d.data().date] = d.data().actualCredited; });

    const dates = [...new Set(trades.map(t => t.date))].sort();
    const dayPLMap = {};
    dates.forEach(date => {
      const dayGross = trades.filter(t => t.date === date).reduce((s, t) => s + (t.grossPL || 0), 0);
      dayPLMap[date] = dayActuals[date] !== undefined ? dayActuals[date] : dayGross;
    });

    const totalEffective = Object.values(dayPLMap).reduce((s, v) => s + v, 0);
    const dayPLValues    = Object.values(dayPLMap);
    const winDays        = dayPLValues.filter(v => v > 0).length;
    const totalDays      = dayPLValues.length;

    return {
      value: capital + totalEffective - totalWithdrawn,
      capital, totalEffective, totalWithdrawn, totalDays, winDays,
      winRate: totalDays > 0 ? Math.round((winDays / totalDays) * 100) : 0,
    };
  } catch (e) {
    console.error("NW intraday load error:", fund, e);
    return null;
  }
}

async function _loadBank() {
  try {
    const [settingsSnap, txSnap] = await Promise.all([
      getDoc(doc(db, "nktt_parttime", "settings")),
      getDocs(collection(db, "nktt_ptt_tx"))
    ]);
    _bankInit = settingsSnap.exists() ? (settingsSnap.data().bankInit ?? 0) : 0;
    _bankTxs  = txSnap.docs.map(d => d.data());
  } catch {
    _bankInit = parseFloat(localStorage.getItem(PTT_BANK_KEY) || "0") || 0;
    try { _bankTxs = JSON.parse(localStorage.getItem(PTT_TX_KEY) || "[]"); } catch { _bankTxs = []; }
  }
  _bank = _bankTxs.reduce((b, t) => t.type === "income" ? b + t.amount : b - t.amount, _bankInit);
}

async function _loadOthers() {
  try {
    const snap = await getDocs(collection(db, "nktt_nw_others"));
    _others = snap.docs.map(d => ({ ...d.data(), id: d.id }));
  } catch { _others = []; }
}

// ─── Shell ────────────────────────────────────────────────────────────────────
function _renderShell() {
  const left  = $("nwPlatforms");
  const right = $("nwSummaryPanel");
  if (!left || !right) return;

  left.innerHTML =
    '<p class="nw-section-label">Investments</p>' +
    '<div class="nw-blocks-grid">' +
      PLATFORMS.map((p, i) => _buildBlock(p, i * 90)).join("") +
    '</div>' +
    '<p class="nw-section-label nw-section-label-bank">Bank</p>' +
    _buildBankBlock() +
    '<p class="nw-section-label">Others</p>' +
    '<div class="nw-others-section" id="nwOthersSection">' +
      '<div class="nw-others-header">' +
        '<span class="nw-others-hint">Money owed to you (+) or by you (−)</span>' +
        '<button class="nw-others-add-btn" id="nwOthersAdd">+ Add Row</button>' +
      '</div>' +
      '<table class="nw-others-table">' +
        '<thead><tr>' +
          '<th class="nw-oth-th-sign">+/−</th>' +
          '<th>Name</th>' +
          '<th>Description</th>' +
          '<th class="nw-oth-th-amt">Amount (€)</th>' +
          '<th></th>' +
        '</tr></thead>' +
        '<tbody id="nwOthersTbody"></tbody>' +
      '</table>' +
    '</div>';

  right.innerHTML =
    '<div class="nw-right-inner">' +
      '<div class="nw-hero-card">' +
        '<div class="nw-hero-orb"></div>' +
        '<div class="nw-hero-orb nw-hero-orb2"></div>' +
        '<div class="nw-hero-eyebrow">Total Net Worth</div>' +
        '<div class="nw-hero-amount" id="nwHeroEur">–</div>' +
        '<div class="nw-hero-sub" id="nwHeroInr">–</div>' +
      '</div>' +
      '<div class="nw-currency-boxes">' +
        '<div class="nw-currency-box nw-inr-box">' +
          '<div class="nw-cb-sym">₹</div>' +
          '<div class="nw-cb-label">INR Assets</div>' +
          '<div class="nw-cb-value" id="nwTotalInr">–</div>' +
        '</div>' +
        '<div class="nw-currency-box nw-eur-box">' +
          '<div class="nw-cb-sym">€</div>' +
          '<div class="nw-cb-label">EUR Assets</div>' +
          '<div class="nw-cb-value" id="nwTotalEur">–</div>' +
        '</div>' +
      '</div>' +
      '<div class="nw-rate-card">' +
        '<div class="nw-rate-pill">🔄</div>' +
        '<div class="nw-rate-body">' +
          '<div class="nw-rate-label">Exchange Rate</div>' +
          '<div class="nw-rate-row">' +
            '<span class="nw-rate-sym">€ 1 =</span>' +
            '<input type="number" id="nwEurRate" class="nw-rate-input" value="' + _getRate() + '" step="0.5" min="1" />' +
            '<span class="nw-rate-sym">₹</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="nw-breakdown-card" id="nwBreakdown"></div>' +
    '</div>';
}

function _rgb(hex) {
  const h = hex.replace('#','');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

function _buildBlock(p, delay) {
  const [r,g,b] = _rgb(p.color);
  return (
    '<div class="nw-block" id="nwBlock' + p.id + '" ' +
        'style="--nw-c:' + p.color + ';--nw-r:' + r + ';--nw-g:' + g + ';--nw-b:' + b + ';animation-delay:' + delay + 'ms">' +
      '<div class="nw-block-head">' +
        '<div class="nw-bh-orb"></div>' +
        '<div class="nw-bh-logo" style="background:' + p.color + ';box-shadow:0 4px 16px rgba(' + r + ',' + g + ',' + b + ',.45)">' + p.letter + '</div>' +
        '<div class="nw-bh-amount" id="nwVal' + p.id + '"><span class="nw-spinner"></span></div>' +
        '<div class="nw-bh-name">' + p.name + '</div>' +
        '<div class="nw-bh-sub">Swing · Intraday</div>' +
      '</div>' +
      '<div class="nw-block-body" id="nwStats' + p.id + '">' +
        '<div style="padding:12px;text-align:center"><span class="nw-spinner"></span></div>' +
      '</div>' +
    '</div>'
  );
}

function _buildBankBlock() {
  const [r,g,b] = _rgb('#22c55e');
  return (
    '<div class="nw-block nw-block-wide" id="nwBlockBank" ' +
        'style="--nw-c:#22c55e;--nw-r:' + r + ';--nw-g:' + g + ';--nw-b:' + b + ';animation-delay:180ms">' +
      '<div class="nw-block-head">' +
        '<div class="nw-bh-orb"></div>' +
        '<div class="nw-bh-logo" style="background:#22c55e;box-shadow:0 4px 16px rgba(34,197,94,.45)">€</div>' +
        '<div class="nw-bh-amount" id="nwValBank"><span class="nw-spinner"></span></div>' +
        '<div class="nw-bh-name">Bank Balance</div>' +
        '<div class="nw-bh-sub">Personal Account</div>' +
      '</div>' +
      '<div class="nw-block-body" id="nwStatsBank">' +
        '<div style="padding:12px;text-align:center"><span class="nw-spinner"></span></div>' +
      '</div>' +
    '</div>'
  );
}

// ─── Render Values ────────────────────────────────────────────────────────────
function _renderAll() {
  PLATFORMS.forEach(p => _renderPlatform(p));
  _renderBank();
  _renderOthers();
  _renderSummary();
}

function _renderPlatform(p) {
  const d = _pdata[p.id];
  if (!d) return;

  const swingVal    = d.swing?.value    ?? 0;
  const intradayVal = d.intraday?.value ?? 0;
  const total       = swingVal + intradayVal;

  const valEl = $("nwVal" + p.id);
  if (valEl) _countUp(valEl, total, false);

  const stats = $("nwStats" + p.id);
  if (!stats) return;

  const hasSwing    = d.swing    && (d.swing.openCount + d.swing.closedCount > 0 || d.swing.deposited > 0);
  const hasIntraday = d.intraday && (d.intraday.capital > 0 || d.intraday.totalDays > 0);

  if (!hasSwing && !hasIntraday) {
    stats.innerHTML = '<div class="nw-block-empty">No data yet</div>';
    return;
  }

  let tiles = "";

  if (hasSwing) {
    tiles +=
      _tile("Swing Value",  _fmtINR(d.swing.currentOpen), "accent") +
      _tile("Available",    _fmtINR(d.swing.freeCash)) +
      _tile("Deposited",    _fmtINR(d.swing.deposited)) +
      _tile("Open Trades",  d.swing.openCount + " trade" + (d.swing.openCount !== 1 ? "s" : ""));
  }
  if (hasIntraday) {
    const net = d.intraday.totalEffective - d.intraday.totalWithdrawn;
    tiles +=
      _tile("Intraday",    _fmtINR(d.intraday.value), "accent") +
      _tile("Capital",     _fmtINR(d.intraday.capital)) +
      _tile("Net P&L",     _fmtINR(net), net >= 0 ? "profit" : "loss") +
      _tile("Days Traded", d.intraday.totalDays || "–");
  }

  stats.innerHTML = '<div class="nw-tile-grid">' + tiles + '</div>';
}

function _tile(label, value, cls) {
  return (
    '<div class="nw-tile">' +
      '<div class="nw-tile-val' + (cls ? " " + cls : "") + '">' + value + '</div>' +
      '<div class="nw-tile-label">' + label + '</div>' +
    '</div>'
  );
}

function _renderBank() {
  const income  = _bankTxs.filter(t => t.type === "income").reduce((s, t)  => s + t.amount, 0);
  const expense = _bankTxs.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);

  const valEl = $("nwValBank");
  if (valEl) _countUp(valEl, _bank, true);

  const stats = $("nwStatsBank");
  if (!stats) return;

  stats.innerHTML =
    '<div class="nw-tile-grid nw-tile-grid-4">' +
      _tile("Balance",     _fmtEUR(_bank),    "accent") +
      _tile("Opening",     _fmtEUR(_bankInit)) +
      _tile("Income",      "+" + _fmtEUR(income),  "profit") +
      _tile("Expenses",    "−" + _fmtEUR(expense),  "loss") +
    '</div>';
}

function _othRowHtml(o) {
  const plusCls = o.sign === "+" ? " nw-oth-plus" : " nw-oth-minus";
  return (
    '<td><button class="nw-oth-sign' + plusCls + '" data-id="' + o.id + '">' + o.sign + '</button></td>' +
    '<td><input class="nw-oth-inp" data-id="' + o.id + '" data-field="name" value="' + (o.name||'').replace(/"/g,'&quot;') + '" placeholder="Name" /></td>' +
    '<td><input class="nw-oth-inp" data-id="' + o.id + '" data-field="description" value="' + (o.description||'').replace(/"/g,'&quot;') + '" placeholder="Description" /></td>' +
    '<td><input class="nw-oth-inp nw-oth-amt" type="number" data-id="' + o.id + '" data-field="amount" value="' + (o.amount||'') + '" placeholder="0.00" /></td>' +
    '<td><button class="nw-oth-del" data-id="' + o.id + '">×</button></td>'
  );
}

function _renderOthers() {
  const tbody = $("nwOthersTbody");
  if (!tbody) return;

  const rows = _others.map(o =>
    '<tr class="nw-oth-row" data-id="' + o.id + '">' + _othRowHtml(o) + '</tr>'
  ).join("");

  const newRow =
    '<tr class="nw-oth-row nw-oth-new" id="nwOthNewRow">' +
      '<td><button class="nw-oth-sign nw-oth-plus" id="nwOthNewSign">+</button></td>' +
      '<td><input class="nw-oth-inp" id="nwOthNewName" placeholder="Name" /></td>' +
      '<td><input class="nw-oth-inp" id="nwOthNewDesc" placeholder="Description" /></td>' +
      '<td><input class="nw-oth-inp nw-oth-amt" type="number" id="nwOthNewAmt" placeholder="0.00" /></td>' +
      '<td></td>' +
    '</tr>';

  tbody.innerHTML = rows + newRow;
}

// ─── Number counter animation ─────────────────────────────────────────────────
function _countUp(el, rawVal, isEUR, ms = 900) {
  if (!rawVal || rawVal === 0) { el.textContent = isEUR ? _fmtEUR(0) : _fmtINR(0); return; }
  const start = performance.now();
  const tick  = (now) => {
    const p = Math.min((now - start) / ms, 1);
    const e = 1 - Math.pow(1 - p, 3);          // ease-out-cubic
    const v = rawVal * e;
    el.textContent = isEUR ? _fmtEUR(v) : _fmtINR(v);
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = isEUR ? _fmtEUR(rawVal) : _fmtINR(rawVal);
  };
  requestAnimationFrame(tick);
}

function _renderSummary() {
  const rate = _getRate();

  const zerTotal  = (_pdata.zerodha?.swing?.value ?? 0) + (_pdata.zerodha?.intraday?.value ?? 0);
  const grrTotal  = (_pdata.groww?.swing?.value   ?? 0) + (_pdata.groww?.intraday?.value   ?? 0);
  const totalInr  = zerTotal + grrTotal;
  const othersEur = _others.reduce((s, o) => s + (o.sign === "+" ? o.amount : -o.amount), 0);
  const totalEur  = _bank + othersEur;

  const allInr = totalInr + (totalEur * rate);
  const allEur = totalEur + (totalInr / rate);

  // Hero
  const heroEur = $("nwHeroEur");
  const heroInr = $("nwHeroInr");
  if (heroEur) heroEur.textContent = _fmtEUR(allEur);
  if (heroInr) heroInr.textContent = "≈ " + _fmtINR(allInr);

  // Currency boxes
  const inrEl = $("nwTotalInr");
  const eurEl = $("nwTotalEur");
  if (inrEl) inrEl.textContent = _fmtINR(totalInr);
  if (eurEl) eurEl.textContent = _fmtEUR(totalEur);

  // Allocation breakdown with bars
  const breakdown = $("nwBreakdown");
  if (!breakdown) return;

  const items = [
    { label: "Zerodha", color: "#F97316", inrEquiv: zerTotal,         display: _fmtINR(zerTotal),   show: zerTotal > 0 || (_pdata.zerodha?.swing?.deposited ?? 0) > 0 },
    { label: "Groww",   color: "#5367FF", inrEquiv: grrTotal,         display: _fmtINR(grrTotal),   show: grrTotal > 0 || (_pdata.groww?.swing?.deposited   ?? 0) > 0 },
    { label: "Bank",    color: "#22c55e", inrEquiv: _bank * rate,     display: _fmtEUR(_bank),      show: true },
    { label: "Others",  color: "#a78bfa", inrEquiv: othersEur * rate, display: _fmtEUR(othersEur),  show: _others.length > 0 },
  ].filter(i => i.show);

  const totalEquiv = items.reduce((s, i) => s + i.inrEquiv, 0);

  const barsHtml = items.map((item, idx) => {
    const pct = totalEquiv > 0 ? Math.max(2, Math.round((item.inrEquiv / totalEquiv) * 100)) : 0;
    return (
      '<div class="nw-alloc-row">' +
        '<div class="nw-alloc-top">' +
          '<span class="nw-alloc-dot" style="background:' + item.color + '"></span>' +
          '<span class="nw-alloc-name">' + item.label + '</span>' +
          '<span class="nw-alloc-pct">' + pct + '%</span>' +
          '<span class="nw-alloc-val">' + item.display + '</span>' +
        '</div>' +
        '<div class="nw-alloc-track">' +
          '<div class="nw-alloc-bar" data-w="' + pct + '" style="background:' + item.color + ';width:0"></div>' +
        '</div>' +
      '</div>'
    );
  }).join("");

  breakdown.innerHTML =
    '<div class="nw-breakdown-title">Allocation</div>' +
    barsHtml +
    '<div class="nw-breakdown-divider"></div>' +
    '<div class="nw-breakdown-total-row">' +
      '<span class="nw-btr-label">Total in ₹</span>' +
      '<span class="nw-btr-val">' + _fmtINR(allInr) + '</span>' +
    '</div>' +
    '<div class="nw-breakdown-total-row">' +
      '<span class="nw-btr-label">Total in €</span>' +
      '<span class="nw-btr-val">' + _fmtEUR(allEur) + '</span>' +
    '</div>';

  // Animate bars after paint
  requestAnimationFrame(() => requestAnimationFrame(() => {
    breakdown.querySelectorAll(".nw-alloc-bar[data-w]").forEach((bar, i) => {
      setTimeout(() => {
        bar.style.transition = "width 0.9s cubic-bezier(.22,1,.36,1)";
        bar.style.width = bar.dataset.w + "%";
      }, i * 130);
    });
  }));
}

// ─── Events ───────────────────────────────────────────────────────────────────
function _bindEvents() {
  document.addEventListener("click", async (e) => {
    if (e.target.id === "nwRefresh") {
      const btn = e.target;
      btn.classList.add("nw-spinning");
      btn.disabled = true;
      await _loadAll();
      _renderAll();
      btn.classList.remove("nw-spinning");
      btn.disabled = false;
      return;
    }

    // Others: Add Row button
    if (e.target.id === "nwOthersAdd") { _saveNewOther(); return; }

    // Others: sign toggle on saved row
    if (e.target.matches(".nw-oth-sign[data-id]")) {
      const id = e.target.dataset.id;
      const o  = _others.find(x => x.id === id);
      if (!o) return;
      o.sign = o.sign === "+" ? "-" : "+";
      e.target.textContent = o.sign;
      e.target.className   = "nw-oth-sign " + (o.sign === "+" ? "nw-oth-plus" : "nw-oth-minus");
      _renderSummary();
      setDoc(doc(db, "nktt_nw_others", id), _othClean(o)).catch(console.error);
      return;
    }

    // Others: sign toggle on new row
    if (e.target.id === "nwOthNewSign") {
      const next = e.target.textContent === "+" ? "-" : "+";
      e.target.textContent = next;
      e.target.className   = "nw-oth-sign " + (next === "+" ? "nw-oth-plus" : "nw-oth-minus");
      return;
    }

    // Others: delete
    if (e.target.matches(".nw-oth-del[data-id]")) {
      const id  = e.target.dataset.id;
      const row = e.target.closest("tr");
      _others   = _others.filter(o => o.id !== id);
      row?.remove();
      _renderSummary();
      deleteDoc(doc(db, "nktt_nw_others", id)).catch(console.error);
      return;
    }
  });

  // Others: field change on saved rows
  document.addEventListener("change", (e) => {
    if (!e.target.matches(".nw-oth-inp[data-id][data-field]")) return;
    const id    = e.target.dataset.id;
    const field = e.target.dataset.field;
    const o     = _others.find(x => x.id === id);
    if (!o) return;
    o[field] = field === "amount" ? (parseFloat(e.target.value) || 0) : e.target.value;
    _renderSummary();
    clearTimeout(o._t);
    o._t = setTimeout(() => setDoc(doc(db, "nktt_nw_others", id), _othClean(o)).catch(console.error), 600);
  });

  // Others: Enter on new row amount saves it
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.id === "nwOthNewAmt") _saveNewOther();
  });

  document.addEventListener("input", (e) => {
    if (e.target.id !== "nwEurRate") return;
    const val = parseFloat(e.target.value);
    if (!isNaN(val) && val > 0) {
      localStorage.setItem(NW_RATE_KEY, val);
      _renderSummary();
    }
  });
}

function _othClean(o) {
  return { id: o.id, sign: o.sign, name: o.name || "", description: o.description || "", amount: o.amount || 0 };
}

function _saveNewOther() {
  const sign = $("nwOthNewSign")?.textContent || "+";
  const name = ($("nwOthNewName")?.value || "").trim();
  const desc = ($("nwOthNewDesc")?.value || "").trim();
  const amt  = parseFloat($("nwOthNewAmt")?.value);
  if (!name || isNaN(amt) || amt <= 0) return;

  const id    = Date.now().toString();
  const entry = { id, sign, name, description: desc, amount: amt };
  _others.push(entry);

  // Insert new DOM row before the new-row template
  const newRowEl = $("nwOthNewRow");
  if (newRowEl) {
    const tr = document.createElement("tr");
    tr.className    = "nw-oth-row";
    tr.dataset.id   = id;
    tr.innerHTML    = _othRowHtml(entry);
    newRowEl.parentNode.insertBefore(tr, newRowEl);
  }

  // Clear the new-row inputs
  if ($("nwOthNewSign")) { $("nwOthNewSign").textContent = "+"; $("nwOthNewSign").className = "nw-oth-sign nw-oth-plus"; }
  if ($("nwOthNewName")) $("nwOthNewName").value = "";
  if ($("nwOthNewDesc")) $("nwOthNewDesc").value = "";
  if ($("nwOthNewAmt"))  $("nwOthNewAmt").value  = "";

  _renderSummary();
  setDoc(doc(db, "nktt_nw_others", id), entry).catch(console.error);
}

// ─── Formatters ───────────────────────────────────────────────────────────────
function _getRate() {
  return parseFloat(localStorage.getItem(NW_RATE_KEY) || "90");
}

function _fmtINR(val) {
  if (val === null || val === undefined || isNaN(val)) return "–";
  return "₹" + Math.round(val).toLocaleString("en-IN");
}

function _fmtEUR(val) {
  if (val === null || val === undefined || isNaN(val)) return "–";
  return "€" + Math.abs(val).toLocaleString("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
