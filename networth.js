// ─── NK Trade Tracker — Net Worth Module ──────────────────────────────────────

import { db } from "./firebase-config.js";
import {
  collection, getDocs, query, where
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

let _nwInit = false;
let _pdata  = {};  // { zerodha: { swing, intraday }, groww: { swing, intraday } }
let _bank   = 0;

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
  await Promise.all(PLATFORMS.map(p => _loadPlatform(p)));
  _loadBank();
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

function _loadBank() {
  const initBal = parseFloat(localStorage.getItem(PTT_BANK_KEY) || "0");
  const txs     = JSON.parse(localStorage.getItem(PTT_TX_KEY) || "[]");
  _bank = txs.reduce((b, t) => t.type === "income" ? b + t.amount : b - t.amount, initBal);
}

// ─── Shell ────────────────────────────────────────────────────────────────────
function _renderShell() {
  const left  = $("nwPlatforms");
  const right = $("nwSummaryPanel");
  if (!left || !right) return;

  left.innerHTML =
    '<p class="nw-section-label">Investments</p>' +
    PLATFORMS.map(_buildPlatformCard).join("") +
    '<p class="nw-section-label nw-section-label-bank">Bank</p>' +
    '<div class="nw-platform-card" id="nwCardBank" style="--nw-c:#22c55e">' +
      '<div class="nw-card-header" id="nwHeaderBank">' +
        '<div class="nw-card-info">' +
          '<div class="nw-card-logo-circle" style="background:#22c55e;box-shadow:0 4px 14px rgba(34,197,94,.35)">€</div>' +
          '<div>' +
            '<div class="nw-card-name">Bank Balance</div>' +
            '<div class="nw-card-sub">Personal Account</div>' +
          '</div>' +
        '</div>' +
        '<div class="nw-card-right">' +
          '<div class="nw-card-value" id="nwValBank"><span class="nw-spinner"></span></div>' +
          '<button class="nw-expand-btn" id="nwToggleBank">▼</button>' +
        '</div>' +
      '</div>' +
      '<div class="nw-card-detail hidden" id="nwDetailBank"></div>' +
    '</div>';

  right.innerHTML =
    '<div class="nw-right-inner">' +
      /* ── Hero total ── */
      '<div class="nw-hero-card">' +
        '<div class="nw-hero-orb"></div>' +
        '<div class="nw-hero-orb nw-hero-orb2"></div>' +
        '<div class="nw-hero-eyebrow">Total Net Worth</div>' +
        '<div class="nw-hero-amount" id="nwHeroEur">–</div>' +
        '<div class="nw-hero-sub" id="nwHeroInr">–</div>' +
      '</div>' +

      /* ── Currency breakdown ── */
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

      /* ── Exchange rate ── */
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

      /* ── Allocation ── */
      '<div class="nw-breakdown-card" id="nwBreakdown"></div>' +
    '</div>';
}

function _buildPlatformCard(p) {
  const glow = p.color.replace('#', '');
  const r = parseInt(glow.slice(0,2),16);
  const g = parseInt(glow.slice(2,4),16);
  const b = parseInt(glow.slice(4,6),16);
  return (
    '<div class="nw-platform-card" id="nwCard' + p.id + '" style="--nw-c:' + p.color + ';--nw-r:' + r + ';--nw-g:' + g + ';--nw-b:' + b + '">' +
      '<div class="nw-card-header" id="nwHeader' + p.id + '">' +
        '<div class="nw-card-info">' +
          '<div class="nw-card-logo-circle" style="background:' + p.color + ';box-shadow:0 4px 14px rgba(' + r + ',' + g + ',' + b + ',.38)">' + p.letter + '</div>' +
          '<div>' +
            '<div class="nw-card-name">' + p.name + '</div>' +
            '<div class="nw-card-sub">Swing · Intraday</div>' +
          '</div>' +
        '</div>' +
        '<div class="nw-card-right">' +
          '<div class="nw-card-value" id="nwVal' + p.id + '"><span class="nw-spinner"></span></div>' +
          '<button class="nw-expand-btn" id="nwToggle' + p.id + '">▼</button>' +
        '</div>' +
      '</div>' +
      '<div class="nw-card-detail hidden" id="nwDetail' + p.id + '"></div>' +
    '</div>'
  );
}

// ─── Render Values ────────────────────────────────────────────────────────────
function _renderAll() {
  PLATFORMS.forEach(p => _renderPlatform(p));
  _renderBank();
  _renderSummary();
}

function _renderPlatform(p) {
  const d = _pdata[p.id];
  if (!d) return;

  const swingVal    = d.swing?.value    ?? 0;
  const intradayVal = d.intraday?.value ?? 0;
  const total       = swingVal + intradayVal;

  const valEl = $("nwVal" + p.id);
  if (valEl) valEl.innerHTML = _fmtINR(total);

  const detail = $("nwDetail" + p.id);
  if (!detail) return;

  let html = "";

  if (d.swing && (d.swing.openCount + d.swing.closedCount > 0 || d.swing.deposited > 0)) {
    html +=
      '<div class="nw-detail-section">' +
        '<div class="nw-detail-section-title">Swing Trading</div>' +
        '<div class="nw-detail-grid">' +
          _diItem("Current Value",   _fmtINR(d.swing.currentOpen), "accent") +
          _diItem("Available Funds", _fmtINR(d.swing.freeCash)) +
          _diItem("Deposited",       _fmtINR(d.swing.deposited)) +
          _diItem("Open Positions",  d.swing.openCount + " trade" + (d.swing.openCount !== 1 ? "s" : "")) +
        '</div>' +
      '</div>';
  }

  if (d.intraday && (d.intraday.capital > 0 || d.intraday.totalDays > 0)) {
    const net = d.intraday.totalEffective - d.intraday.totalWithdrawn;
    html +=
      '<div class="nw-detail-section' + (html ? " nw-detail-sep" : "") + '">' +
        '<div class="nw-detail-section-title">Intraday Trading</div>' +
        '<div class="nw-detail-grid">' +
          _diItem("Current Value",  _fmtINR(d.intraday.value), "accent") +
          _diItem("Capital",        _fmtINR(d.intraday.capital)) +
          _diItem("Net P&L",        _fmtINR(net), net >= 0 ? "profit" : "loss") +
          _diItem("Withdrawn",      _fmtINR(d.intraday.totalWithdrawn)) +
          _diItem("Trading Days",   d.intraday.totalDays) +
          _diItem("Win Rate",       d.intraday.totalDays > 0 ? d.intraday.winRate + "%" : "–") +
        '</div>' +
      '</div>';
  }

  detail.innerHTML = html || '<div class="nw-detail-empty">No data yet</div>';
}

function _diItem(label, value, cls) {
  return (
    '<div class="nw-detail-item">' +
      '<span class="nw-di-label">' + label + '</span>' +
      '<span class="nw-di-value' + (cls ? " " + cls : "") + '">' + value + '</span>' +
    '</div>'
  );
}

function _renderBank() {
  const valEl = $("nwValBank");
  if (valEl) valEl.innerHTML = _fmtEUR(_bank);

  const detail = $("nwDetailBank");
  if (!detail) return;

  const initBal = parseFloat(localStorage.getItem(PTT_BANK_KEY) || "0");
  const txs     = JSON.parse(localStorage.getItem(PTT_TX_KEY) || "[]");
  const income  = txs.filter(t => t.type === "income").reduce((s, t)  => s + t.amount, 0);
  const expense = txs.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);

  detail.innerHTML =
    '<div class="nw-detail-section">' +
      '<div class="nw-detail-grid">' +
        _diItem("Current Balance",  _fmtEUR(_bank),    "accent") +
        _diItem("Opening Balance",  _fmtEUR(initBal)) +
        _diItem("Total Income",    "+" + _fmtEUR(income),  "profit") +
        _diItem("Total Expenses",  "−" + _fmtEUR(expense), "loss") +
        _diItem("Transactions",     txs.length) +
      '</div>' +
    '</div>';
}

function _renderSummary() {
  const rate = _getRate();

  const zerTotal = (_pdata.zerodha?.swing?.value ?? 0) + (_pdata.zerodha?.intraday?.value ?? 0);
  const grrTotal = (_pdata.groww?.swing?.value   ?? 0) + (_pdata.groww?.intraday?.value   ?? 0);
  const totalInr = zerTotal + grrTotal;
  const totalEur = _bank;

  const allInr = totalInr + (_bank * rate);
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
    { label: "Zerodha", color: "#F97316", inrEquiv: zerTotal,      display: _fmtINR(zerTotal),   show: zerTotal > 0 || (_pdata.zerodha?.swing?.deposited ?? 0) > 0 },
    { label: "Groww",   color: "#5367FF", inrEquiv: grrTotal,      display: _fmtINR(grrTotal),   show: grrTotal > 0 || (_pdata.groww?.swing?.deposited   ?? 0) > 0 },
    { label: "Bank",    color: "#22c55e", inrEquiv: _bank * rate,  display: _fmtEUR(_bank),      show: true },
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
    PLATFORMS.forEach(p => {
      const header = $("nwHeader" + p.id);
      if (header && (e.target === header || header.contains(e.target))) {
        _toggleDetail("nwDetail" + p.id, "nwToggle" + p.id);
      }
    });

    const bankHeader = $("nwHeaderBank");
    if (bankHeader && (e.target === bankHeader || bankHeader.contains(e.target))) {
      _toggleDetail("nwDetailBank", "nwToggleBank");
    }

    if (e.target.id === "nwRefresh") {
      const btn = e.target;
      btn.classList.add("nw-spinning");
      btn.disabled = true;
      await _loadAll();
      _renderAll();
      btn.classList.remove("nw-spinning");
      btn.disabled = false;
    }
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

function _toggleDetail(detailId, toggleId) {
  const detail = $(detailId);
  const btn    = $(toggleId);
  if (!detail) return;
  const isHidden = detail.classList.toggle("hidden");
  if (btn) btn.textContent = isHidden ? "▼" : "▲";
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
