// ─── NK Trade Tracker — Main App ─────────────────────────────────────────────

import { db, TRADES_COLLECTION, AUTH_COLLECTION } from "./firebase-config.js";
import {
  collection, addDoc, getDocs, doc, updateDoc, deleteDoc,
  query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { fetchLivePrice } from "./prices.js";
import { initResearch } from "./research.js";
import { initIntraday } from "./intraday.js";

// ─── State ────────────────────────────────────────────────────────────────────
let trades          = [];
let currentFilter   = "all";
let _tradeSort      = "newest"; // "newest" | "oldest"
let activeSellId    = null;
let priceInterval   = null;
let currentFund     = localStorage.getItem("portfolioFund")  || "zerodha";
let intradayFund    = localStorage.getItem("intradayFund")   || "groww";

const FUND_CONFIG = {
  zerodha: { name: "Zerodha", deposited: 350000, color: "#F97316" },
  groww:   { name: "Groww",   deposited: 0,      color: "#5367FF" },
};

// ─── DOM Helper ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ─── Theme ───────────────────────────────────────────────────────────────────
const savedTheme = localStorage.getItem("nktt_theme") || "dark";
document.documentElement.setAttribute("data-theme", savedTheme);
document.addEventListener("DOMContentLoaded", () => {
  const btn = $("themeToggle");
  if (btn) btn.textContent = savedTheme === "dark" ? "🌙" : "☀️";
});

document.addEventListener("click", (e) => {
  if (e.target.id !== "themeToggle") return;
  const html    = document.documentElement;
  const current = html.getAttribute("data-theme");
  const next    = current === "dark" ? "light" : "dark";
  html.setAttribute("data-theme", next);
  localStorage.setItem("nktt_theme", next);
  e.target.textContent = next === "dark" ? "🌙" : "☀️";
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function _handleLogin() {
  const pw  = $("loginPassword").value.trim();
  const btn = $("loginBtn");
  const err = $("loginError");
  if (!pw) { err.textContent = "Please enter your password."; return; }

  btn.textContent = "Checking...";
  btn.disabled    = true;
  err.textContent = "";

  try {
    const snap = await getDocs(collection(db, AUTH_COLLECTION));
    let ok = false;
    snap.forEach((d) => {
      const data = d.data();
      if (data.user === "nikhil" && data.password === pw) ok = true;
    });
    if (ok) {
      sessionStorage.setItem("nktt_ok", "1");
      _showApp();
    } else {
      err.textContent  = "Incorrect password.";
      btn.textContent  = "Access";
      btn.disabled     = false;
    }
  } catch (e) {
    console.error("Login error:", e);
    err.textContent  = "Connection error: " + (e.message || "check Firebase config");
    btn.textContent  = "Access";
    btn.disabled     = false;
  }
}

async function _showApp() {
  $("loginOverlay").classList.add("hidden");
  $("app").classList.remove("hidden");
  _initBgCanvas();
  _initMobile();
  _initRouter();
  await _initApp();
  _applyFund();
  initResearch(trades, currentFund);
  _initAIMonitor();
}

// ─── SPA Router (hash-based) ─────────────────────────────────────────────────
function _getCurrentPage() {
  const hash = location.hash.replace("#", "").toLowerCase();
  if (hash === "research")  return "research";
  if (hash === "intraday")  return "intraday";
  return "portfolio";
}

function _navigateTo(page) {
  if (page === "research")  { location.hash = "Research";  return; }
  if (page === "intraday")  { location.hash = "Intraday";  return; }
  location.hash = "Swing";
}

function _showPage(page) {
  const portfolio = $("page-portfolio");
  const intraday  = $("page-intraday");
  const research  = $("page-research");
  const fab       = $("fabAdd");
  if (portfolio) portfolio.classList.toggle("hidden", page !== "portfolio");
  if (intraday)  intraday.classList.toggle("hidden",  page !== "intraday");
  if (research)  research.classList.toggle("hidden",  page !== "research");
  if (fab && window.innerWidth <= 768) fab.classList.toggle("hidden", page === "research");
  document.querySelectorAll(".nav-link").forEach((l) => {
    l.classList.toggle("active", l.dataset.page === page);
  });
  if (page === "intraday") initIntraday(intradayFund);
}

function _initRouter() {
  document.querySelectorAll(".nav-link[data-page]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      if (link.dataset.page === "research") {
        const container = document.querySelector(".research-container");
        if (container && container.classList.contains("has-results")) {
          container.classList.remove("has-results");
          const results = $("researchResults");
          const input = $("researchSymbol");
          if (input) input.value = "";
          if (results) {
            results.innerHTML = "";
            if (typeof initResearch === "function") {
              // Re-import won't work, so trigger suggestions manually
              const evt = new Event("research-reset");
              document.dispatchEvent(evt);
            }
          }
        }
      }
      _navigateTo(link.dataset.page);
    });
  });

  // Platform picker
  const platBtn  = $("platformBtn");
  const platMenu = $("platformMenu");
  const platPicker = $("platformPicker");
  if (platBtn && platMenu) {
    platBtn.addEventListener("click", () => {
      platMenu.classList.toggle("hidden");
      platPicker.classList.toggle("open");
      platMenu.querySelectorAll(".platform-item").forEach(i => i.classList.toggle("active", i.dataset.fund === currentFund));
    });
    platMenu.querySelectorAll(".platform-item").forEach(item => {
      item.addEventListener("click", () => {
        currentFund = item.dataset.fund;
        localStorage.setItem("portfolioFund", currentFund);
        platMenu.classList.add("hidden");
        platPicker.classList.remove("open");
        _applyFund();
      });
    });
    document.addEventListener("click", (e) => {
      if (!platPicker.contains(e.target)) { platMenu.classList.add("hidden"); platPicker.classList.remove("open"); }
    });
  }

  window.addEventListener("hashchange", () => _showPage(_getCurrentPage()));
  _showPage(_getCurrentPage());

  // Intraday platform picker — only updates intraday fund, never touches portfolio
  document.addEventListener("nktt-fund-change", (e) => {
    intradayFund = e.detail.fund;
    localStorage.setItem("intradayFund", intradayFund);
    initIntraday(intradayFund);
  });
}


// ─── Fund Switcher ───────────────────────────────────────────────────────────
function _applyFund() {
  const config = FUND_CONFIG[currentFund];

  // Load custom deposited capital from localStorage for non-zerodha funds
  if (currentFund !== "zerodha") {
    const saved = localStorage.getItem("depositedCapital_" + currentFund);
    if (saved) config.deposited = parseInt(saved);
  }

  // Update deposited capital display
  const heroEl = $("sumDepositedVal");
  if (heroEl) {
    if (currentFund === "zerodha") {
      heroEl.textContent = "₹" + Number(config.deposited).toLocaleString("en-IN");
      heroEl.onclick = null;
      heroEl.style.cursor = "default";
    } else {
      if (config.deposited > 0) {
        heroEl.textContent = "₹" + Number(config.deposited).toLocaleString("en-IN");
      } else {
        heroEl.textContent = "Click to set capital";
      }
      heroEl.style.cursor = "pointer";
      heroEl.onclick = () => _editDepositedCapital();
    }
  }

  const freeLabel = document.querySelector(".sum-free-sub");
  if (freeLabel) freeLabel.textContent = "In " + config.name + " funds";

  // Sync picker display
  const pName = $("platformName");
  if (pName) pName.textContent = config.name;

  _renderTable();
  _updateSummary();
  _renderCurrentGraph();

  // Re-init research with new fund context
  initResearch(trades, currentFund);
  const resResults = $("researchResults");
  const resContainer = document.querySelector(".research-container");
  if (resContainer && resContainer.classList.contains("has-results")) {
    resContainer.classList.remove("has-results");
    if (resResults) resResults.innerHTML = "";
    document.dispatchEvent(new Event("research-reset"));
  }
}

function _editDepositedCapital() {
  const heroEl = $("sumDepositedVal");
  if (!heroEl) return;
  const config = FUND_CONFIG[currentFund];
  const input = document.createElement("input");
  input.type = "number";
  input.className = "sum-hero-val-input";
  input.value = config.deposited || "";
  input.placeholder = "Enter amount";
  heroEl.textContent = "";
  heroEl.appendChild(input);
  input.focus();

  const save = () => {
    const val = parseInt(input.value) || 0;
    FUND_CONFIG[currentFund].deposited = val;
    localStorage.setItem("depositedCapital_" + currentFund, val);
    _applyFund();
  };
  input.addEventListener("blur", save);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
}

function _tradesForFund() {
  return trades.filter((t) => (t.fund || "zerodha") === currentFund);
}

// ─── Animated Background Canvas ──────────────────────────────────────────────
function _initBgCanvas() {
  const canvas = document.getElementById('bgCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', () => { resize(); });

  function isDark() {
    return document.documentElement.getAttribute('data-theme') !== 'light';
  }

  // shared: slow floating dots
  let dots = [];
  function initDots() {
    dots = Array.from({ length: 55 }, () => ({
      x:     Math.random() * canvas.width,
      y:     Math.random() * canvas.height,
      r:     1.5 + Math.random() * 3,
      vx:    (Math.random() - 0.5) * 0.35,
      vy:    (Math.random() - 0.5) * 0.35,
      phase: Math.random() * Math.PI * 2,
    }));
  }
  initDots();
  window.addEventListener('resize', initDots);

  let t = 0;

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    t += 0.012;

    const dark = isDark();
    const dotColor  = dark ? '249,115,22' : '234,107,0';
    const lineColor = dark ? '249,115,22' : '234,107,0';

    // update + draw dots
    dots.forEach((d, i) => {
      d.x += d.vx; d.y += d.vy; d.phase += 0.018;
      if (d.x < 0) d.x = W; if (d.x > W) d.x = 0;
      if (d.y < 0) d.y = H; if (d.y > H) d.y = 0;

      const alpha = dark
        ? 0.15 + Math.sin(d.phase) * 0.10
        : 0.20 + Math.sin(d.phase) * 0.12;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + dotColor + ',' + alpha + ')';
      ctx.fill();
    });

    // draw connecting lines between nearby dots
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const dx = dots[i].x - dots[j].x;
        const dy = dots[i].y - dots[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 120) {
          const alpha = dark
            ? (1 - dist / 120) * 0.12
            : (1 - dist / 120) * 0.14;
          ctx.beginPath();
          ctx.moveTo(dots[i].x, dots[i].y);
          ctx.lineTo(dots[j].x, dots[j].y);
          ctx.strokeStyle = 'rgba(' + lineColor + ',' + alpha + ')';
          ctx.lineWidth = 0.6;
          ctx.stroke();
        }
      }
    }

    requestAnimationFrame(draw);
  }

  draw();
}

// ─── Mobile Init ─────────────────────────────────────────────────────────────
function _initMobile() {
  const fab = $("fabAdd");
  if (!fab) return;

  function checkMobile() {
    if (window.innerWidth <= 768 && _getCurrentPage() !== "research") {
      fab.classList.remove("hidden");
    } else {
      fab.classList.add("hidden");
    }
  }
  checkMobile();
  window.addEventListener("resize", checkMobile);

  fab.addEventListener("click", () => {
    const page = _getCurrentPage();
    if (page === "intraday") {
      $("intradayAddBtn")?.click();
    } else {
      $("addTradeModal").classList.remove("hidden");
      $("inputBuyDate").valueAsDate = new Date();
      $("inputSymbol").focus();
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function _initApp() {
  _updateMarketStatus();
  setInterval(_updateMarketStatus, 60000);
  await _loadTrades();
  _renderTable();
  _updateSummary();
  _startPriceRefresh();
  try { _initTicker(); }      catch(e) { console.error("Ticker init error:", e); }
  try { _initGraphToggle(); } catch(e) { console.error("Graph init error:", e); }
  // Position filter thumb on the initially active tab
  requestAnimationFrame(() => {
    const active = document.querySelector(".filter-tab.active");
    if (active) _moveFilterThumb(active);
  });
}

// ─── Load Trades ──────────────────────────────────────────────────────────────
async function _loadTrades() {
  try {
    const q    = query(collection(db, TRADES_COLLECTION), orderBy("createdAt", "asc"));
    const snap = await getDocs(q);
    trades     = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error("Load error:", e);
    trades = [];
  }
}

// ─── Filter Tabs ──────────────────────────────────────────────────────────────
document.querySelectorAll(".filter-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".filter-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    currentFilter = tab.dataset.filter;
    _moveFilterThumb(tab);
    _renderTable();
  });
});

document.addEventListener("click", (e) => {
  if (e.target.id === "sortToggleBtn") {
    _tradeSort = _tradeSort === "newest" ? "oldest" : "newest";
    _renderTable();
  }
});

function _moveFilterThumb(activeTab) {
  const thumb     = document.querySelector(".filter-thumb");
  const container = document.querySelector(".filter-tabs");
  if (!thumb || !container) return;
  const cRect = container.getBoundingClientRect();
  const tRect = activeTab.getBoundingClientRect();
  thumb.style.width     = tRect.width + "px";
  thumb.style.transform = "translateX(" + (tRect.left - cRect.left) + "px)";
}

// ─── Render Table ─────────────────────────────────────────────────────────────
function _renderTable() {
  const fundTrades = _tradesForFund();
  const filtered = fundTrades.filter((t) => {
    if (currentFilter === "open")   return t.status === "open";
    if (currentFilter === "closed") return t.status === "closed";
    return true;
  });

  const tbody = $("tradeTableBody");
  tbody.innerHTML = "";
  $("emptyState").style.display = filtered.length === 0 ? "flex" : "none";

  // Update sort button icon
  const sortBtn = $("sortToggleBtn");
  if (sortBtn) sortBtn.textContent = _tradeSort === "newest" ? "▼" : "▲";

  if (filtered.length === 0) return;

  // Assign serial numbers in original order
  const serialMap = {};
  filtered.forEach((t, i) => { serialMap[t.id] = i + 1; });

  // Reverse display order if toggled
  if (_tradeSort === "oldest") filtered.reverse();

  filtered.forEach((trade, i) => {
    const tr       = document.createElement("tr");
    tr.dataset.id  = trade.id;
    const isClosed = trade.status === "closed";
    if (isClosed) {
      const pl = trade.returns ?? 0;
      tr.classList.add(pl >= 0 ? "row-closed-profit" : "row-closed-loss");
    } else if (trade.livePrice) {
      tr.classList.add(trade.livePrice >= trade.buyPrice ? "row-open-up" : "row-open-down");
    }

    // Unrealized P/L for open trades
    let unrealPl  = null;
    let unrealPct = null;
    let currVal   = null;
    if (!isClosed && trade.livePrice) {
      currVal   = trade.livePrice * trade.shares;
      unrealPl  = currVal - trade.investedAmount;
      unrealPct = (unrealPl / trade.investedAmount) * 100;
    }

    const plVal   = isClosed ? trade.returns    : unrealPl;
    const plPct   = isClosed ? trade.plPercent  : unrealPct;
    const plClass = plVal > 0 ? "profit" : plVal < 0 ? "loss" : "";

    const liveCell = trade.livePrice
      ? '<span class="live-val">' + _fmt(trade.livePrice) + '</span>'
      : '<span class="dash-val">–</span>';

    const dayPct     = trade.dayChangePct;
    const dayClass   = dayPct > 0 ? "profit" : dayPct < 0 ? "loss" : "";
    const dayCell    = (trade.status === "open" && dayPct !== null && dayPct !== undefined)
      ? '<span class="' + dayClass + '">' + (dayPct >= 0 ? "+" : "") + dayPct + "%</span>"
      : '<span class="dash-val">–</span>';

    const sellCell = isClosed
      ? '<span class="td-mono">' + _fmt(trade.sellPrice) + '</span>'
      : '<button class="btn-sell-row" data-id="' + trade.id + '">Sell</button>';

    const currValCell = currVal !== null
      ? '<span class="td-mono ' + (unrealPl >= 0 ? "profit" : "loss") + '">' + _fmt(currVal) + '</span>'
      : '<span class="dash-val">–</span>';

    tr.innerHTML =
      '<td class="td-num">'    + serialMap[trade.id] + '</td>' +
      '<td class="td-symbol">' +
        '<span class="sym-badge">' + trade.symbol + '</span>' +
        (trade.exchange ? '<span class="exch-tag">' + trade.exchange + '</span>' : '') +
      '</td>' +
      '<td class="td-mono">'   + trade.shares + '</td>' +
      '<td class="td-mono">'   + _fmt(trade.buyPrice) + '</td>' +
      '<td class="td-date">'   + _fmtDate(trade.buyDate) + '</td>' +
      '<td class="td-mono">'   + _fmt(trade.investedAmount) + '</td>' +
      '<td class="td-live">'   + liveCell + '</td>' +
      '<td class="td-mono">'   + dayCell + '</td>' +
      '<td>'                   + currValCell + '</td>' +
      '<td class="td-sell">'   + sellCell + '</td>' +
      '<td class="td-date">'   + (trade.sellDate ? _fmtDate(trade.sellDate) : '<span class="dash-val">–</span>') + '</td>' +
      '<td class="td-mono '    + plClass + '">' + (plVal !== null ? _fmt(plVal) : '<span class="dash-val">–</span>') + '</td>' +
      '<td class="td-mono '    + plClass + '">' + (plPct !== null ? _fmtPct(plPct) : '<span class="dash-val">–</span>') + '</td>' +
      '<td><span class="status-badge ' + trade.status + '">' + (trade.status === "open" ? "Open" : "Closed") + '</span></td>' +
      '<td>' + _daysHeldCell(trade) + '</td>';

    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".btn-sell-row").forEach((btn) =>
    btn.addEventListener("click", () => _openSellModal(btn.dataset.id))
  );
  tbody.querySelectorAll(".btn-del").forEach((btn) =>
    btn.addEventListener("click", () => _confirmDelete(btn.dataset.id))
  );

  // ── Totals footer ──────────────────────────────────────────────────────────
  const table = $("tradeTable");
  const oldFoot = table.querySelector("tfoot");
  if (oldFoot) oldFoot.remove();

  if (filtered.length > 1 && currentFilter !== "all") {
    const totalInvested = filtered.reduce((s, t) => s + t.investedAmount, 0);
    let returnsVal = 0, plPct = 0, currValCell = "";

    if (currentFilter === "open") {
      const currVal = filtered.reduce((s, t) =>
        s + (t.livePrice ? t.livePrice * t.shares : t.investedAmount), 0);
      returnsVal = currVal - totalInvested;
      plPct      = totalInvested > 0 ? (returnsVal / totalInvested) * 100 : 0;
      const cls  = returnsVal >= 0 ? "profit" : "loss";
      currValCell = '<td class="td-mono ' + cls + '">' + _fmt(currVal) + '</td>';

    } else { // closed
      returnsVal  = filtered.reduce((s, t) => s + (t.returns ?? 0), 0);
      plPct       = totalInvested > 0 ? (returnsVal / totalInvested) * 100 : 0;
      currValCell = '<td><span class="dash-val">–</span></td>';
    }

    const plClass = returnsVal >= 0 ? "profit" : "loss";
    const dash    = '<td><span class="dash-val">–</span></td>';
    const tfoot   = document.createElement("tfoot");
    tfoot.innerHTML =
      '<tr>' +
        '<td class="totals-label">TOTALS</td>' +
        '<td></td>' +                                                             // Symbol
        '<td></td>' + '<td></td>' + '<td></td>' +                                 // Shares / Buy Price / Buy Date
        '<td class="td-mono">'               + _fmt(totalInvested) + '</td>' +    // Invested
        dash + dash +                                                              // Live Price / Day %
        currValCell +                                                              // Curr. Value
        dash + '<td></td>' +                                                       // Sell Price / Sell Date
        '<td class="td-mono ' + plClass + '">' + _fmt(returnsVal)  + '</td>' +    // Returns
        '<td class="td-mono ' + plClass + '">' + _fmtPct(plPct)    + '</td>' +    // P/L %
        '<td></td><td></td>' +                                                     // Status / Delete
      '</tr>';
    table.appendChild(tfoot);
  }

  _renderCards(filtered);
}

// ─── Mobile Card Render ───────────────────────────────────────────────────────
function _renderCards(filtered) {
  const container = $("tradeCards");
  if (!container) return;
  container.innerHTML = "";

  if (filtered.length === 0) {
    container.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:40px 0;font-size:13px;">No trades yet — tap <strong style="color:var(--accent)">+ Add Trade</strong> below</p>';
    return;
  }

  filtered.forEach((trade) => {
    const isClosed = trade.status === "closed";
    const card     = document.createElement("div");
    card.className = "trade-card";
    card.dataset.id = trade.id;

    // card color class
    if (isClosed) {
      card.classList.add((trade.returns ?? 0) >= 0 ? "card-closed-profit" : "card-closed-loss");
    } else if (trade.livePrice) {
      card.classList.add(trade.livePrice >= trade.buyPrice ? "card-open-up" : "card-open-down");
    }

    // P/L values
    let plVal = null, plPct = null, currVal = null;
    if (isClosed) {
      plVal = trade.returns; plPct = trade.plPercent;
    } else if (trade.livePrice) {
      currVal = trade.livePrice * trade.shares;
      plVal   = currVal - trade.investedAmount;
      plPct   = (plVal / trade.investedAmount) * 100;
    }
    const plClass = plVal > 0 ? "profit" : plVal < 0 ? "loss" : "";

    const sellBtn = isClosed
      ? ""
      : '<button class="tc-sell-btn" data-id="' + trade.id + '">Sell</button>';

    card.innerHTML =
      '<div class="tc-top">' +
        '<div class="tc-symbol">' +
          '<span class="sym-badge">' + trade.symbol + '</span>' +
          (trade.exchange ? '<span class="exch-tag">' + trade.exchange + '</span>' : '') +
          '<span class="status-badge ' + trade.status + '">' + (isClosed ? "Closed" : "Open") + '</span>' +
        '</div>' +
        '<div class="tc-actions">' +
          (isClosed ? '<span class="days-held">' + _daysHeldLabel(trade) + '</span>' : '<button class="btn-del" data-id="' + trade.id + '">✕</button>') +
        '</div>' +
      '</div>' +
      '<div class="tc-grid">' +
        '<div class="tc-field"><span class="tc-label">Shares</span><span class="tc-val">' + trade.shares + '</span></div>' +
        '<div class="tc-field"><span class="tc-label">Buy Price</span><span class="tc-val">' + _fmt(trade.buyPrice) + '</span></div>' +
        '<div class="tc-field"><span class="tc-label">Invested</span><span class="tc-val">' + _fmt(trade.investedAmount) + '</span></div>' +
        '<div class="tc-field"><span class="tc-label">Live Price</span><span class="tc-val live">' + (trade.livePrice ? _fmt(trade.livePrice) : "–") + '</span></div>' +
        '<div class="tc-field"><span class="tc-label">Day Change</span><span class="tc-val ' + (trade.status === "open" && trade.dayChangePct !== null && trade.dayChangePct !== undefined ? (trade.dayChangePct >= 0 ? "profit" : "loss") : "") + '">' + (trade.status === "open" && trade.dayChangePct !== null && trade.dayChangePct !== undefined ? (trade.dayChangePct >= 0 ? "+" : "") + trade.dayChangePct + "%" : "–") + '</span></div>' +
        '<div class="tc-field"><span class="tc-label">Returns</span><span class="tc-val ' + plClass + '">' + (plVal !== null ? _fmt(plVal) : "–") + '</span></div>' +
        '<div class="tc-field"><span class="tc-label">P/L %</span><span class="tc-val ' + plClass + '">' + (plPct !== null ? _fmtPct(plPct) : "–") + '</span></div>' +
      '</div>' +
      sellBtn;

    card.querySelector(".btn-del")?.addEventListener("click", () => _confirmDelete(trade.id));
    card.querySelector(".tc-sell-btn")?.addEventListener("click", () => _openSellModal(trade.id));
    container.appendChild(card);
  });

  // ── Mobile totals card ────────────────────────────────────────────────────
  if (filtered.length > 1 && currentFilter !== "all") {
    const totalInvested = filtered.reduce((s, t) => s + t.investedAmount, 0);
    let returnsVal = 0, plPct = 0, secondLabel = "Curr. Value", secondVal = "–";

    if (currentFilter === "open") {
      const currVal = filtered.reduce((s, t) =>
        s + (t.livePrice ? t.livePrice * t.shares : t.investedAmount), 0);
      returnsVal  = currVal - totalInvested;
      plPct       = totalInvested > 0 ? (returnsVal / totalInvested) * 100 : 0;
      secondLabel = "Curr. Value";
      secondVal   = _fmt(currVal);

    } else { // closed
      returnsVal  = filtered.reduce((s, t) => s + (t.returns ?? 0), 0);
      plPct       = totalInvested > 0 ? (returnsVal / totalInvested) * 100 : 0;
      secondLabel = "Returns";
      secondVal   = _fmt(returnsVal);
    }

    const plClass = returnsVal >= 0 ? "profit" : "loss";
    const totalsCard = document.createElement("div");
    totalsCard.className = "totals-card";
    totalsCard.innerHTML =
      '<div class="tc-totals-title">Totals</div>' +
      '<div class="tc-totals-grid">' +
        '<div class="tc-field"><span class="tc-label">Invested</span><span class="tc-val">'       + _fmt(totalInvested) + '</span></div>' +
        '<div class="tc-field"><span class="tc-label">' + secondLabel + '</span><span class="tc-val ' + plClass + '">' + secondVal + '</span></div>' +
        '<div class="tc-field"><span class="tc-label">P/L</span><span class="tc-val '             + plClass + '">' + _fmt(returnsVal) + '</span></div>' +
        '<div class="tc-field"><span class="tc-label">P/L %</span><span class="tc-val '           + plClass + '">' + _fmtPct(plPct)    + '</span></div>' +
      '</div>';
    container.appendChild(totalsCard);
  }
}

// ─── Add Trade Modal ──────────────────────────────────────────────────────────
$("addTradeBtn").addEventListener("click", () => {
  $("addTradeModal").classList.remove("hidden");
  $("inputBuyDate").valueAsDate = new Date();
  $("inputSymbol").focus();
});

function _closeAddModal() {
  $("addTradeModal").classList.add("hidden");
  ["inputSymbol","inputShares","inputBuyPrice","inputInvested"].forEach((id) => { $(id).value = ""; });
  $("inputExchange").value     = "auto";
  $("inputBuyDate").valueAsDate = new Date();
}

$("closeAddModal").addEventListener("click",  _closeAddModal);
$("cancelAddTrade").addEventListener("click", _closeAddModal);
$("addTradeModal").addEventListener("click",  (e) => { if (e.target === $("addTradeModal")) _closeAddModal(); });

["inputShares", "inputBuyPrice"].forEach((id) => {
  $(id).addEventListener("input", () => {
    const s = parseFloat($("inputShares").value) || 0;
    const p = parseFloat($("inputBuyPrice").value) || 0;
    $("inputInvested").value = (s > 0 && p > 0) ? _fmt(s * p) : "";
  });
});

$("confirmAddTrade").addEventListener("click", async () => {
  const symbol   = $("inputSymbol").value.trim().toUpperCase();
  const exchSel  = $("inputExchange").value;
  const shares   = parseInt($("inputShares").value);
  const buyPrice = parseFloat($("inputBuyPrice").value);
  const buyDate  = $("inputBuyDate").value;

  if (!symbol || !shares || !buyPrice || !buyDate) { _toast("Please fill all fields.", "error"); return; }
  if (shares < 1)                                   { _toast("Shares must be at least 1.", "error"); return; }

  const exchange       = exchSel === "auto" ? null : exchSel;
  const investedAmount = shares * buyPrice;

  const btn = $("confirmAddTrade");
  btn.textContent = "Adding...";
  btn.disabled    = true;

  try {
    const data = {
      symbol, exchange, shares, buyPrice, buyDate, investedAmount, fund: currentFund,
      sellShares: null, sellPrice: null, sellDate: null,
      sellAmount: null, returns: null, plPercent: null, livePrice: null,
      status: "open", createdAt: serverTimestamp()
    };
    const ref = await addDoc(collection(db, TRADES_COLLECTION), data);
    trades.push({ id: ref.id, ...data, createdAt: new Date() });
    _closeAddModal();
    _renderTable();
    _updateSummary();
    _toast("Trade added!", "success");
    _fetchAndSavePrice(ref.id, symbol, exchange);
  } catch (e) {
    _toast("Error: " + e.message, "error");
  } finally {
    btn.textContent = "Add Trade";
    btn.disabled    = false;
  }
});

// ─── Sell Modal ───────────────────────────────────────────────────────────────
function _openSellModal(tradeId) {
  const trade = trades.find((t) => t.id === tradeId);
  if (!trade) return;
  activeSellId = tradeId;

  $("sellInfo").innerHTML =
    '<div class="sell-chip"><span class="sym-badge">' + trade.symbol + '</span>' +
    '<span class="sell-chip-detail">' + trade.shares + ' shares @ ' + _fmt(trade.buyPrice) + '</span></div>';

  $("sellSharesInput").value      = trade.shares;
  $("sellSharesInput").max        = trade.shares;
  $("sellPriceInput").value       = "";
  $("sellDateInput").valueAsDate  = new Date();
  $("sellAmountInput").value      = "";
  $("sellPreview").innerHTML      = "";

  $("sellModal").classList.remove("hidden");
  $("sellPriceInput").focus();
}

function _closeSellModal() {
  $("sellModal").classList.add("hidden");
  activeSellId = null;
}

$("closeSellModal").addEventListener("click",  _closeSellModal);
$("cancelSell").addEventListener("click",      _closeSellModal);
$("sellModal").addEventListener("click", (e) => { if (e.target === $("sellModal")) _closeSellModal(); });

["sellSharesInput", "sellPriceInput"].forEach((id) => {
  $(id).addEventListener("input", () => {
    const trade = trades.find((t) => t.id === activeSellId);
    if (!trade) return;
    const ss  = parseInt($("sellSharesInput").value) || 0;
    const sp  = parseFloat($("sellPriceInput").value) || 0;
    const amt = ss * sp;
    $("sellAmountInput").value = (amt > 0) ? _fmt(amt) : "";
    if (ss > 0 && sp > 0) {
      const invested  = ss * trade.buyPrice;
      const returns   = amt - invested;
      const pct       = (returns / invested) * 100;
      const cls       = returns >= 0 ? "profit" : "loss";
      const partial   = ss < trade.shares
        ? '<div class="preview-note">' + (trade.shares - ss) + ' shares will remain open</div>'
        : "";
      $("sellPreview").innerHTML =
        '<div class="preview-box ' + cls + '">Returns: ' + _fmt(returns) + '&nbsp;&nbsp;(' + _fmtPct(pct) + ')' + partial + '</div>';
    } else {
      $("sellPreview").innerHTML = "";
    }
  });
});

$("confirmSell").addEventListener("click", async () => {
  const trade = trades.find((t) => t.id === activeSellId);
  if (!trade) return;

  const ss    = parseInt($("sellSharesInput").value);
  const sp    = parseFloat($("sellPriceInput").value);
  const sDate = $("sellDateInput").value;

  if (!ss || !sp || !sDate)  { _toast("Fill all fields.", "error"); return; }
  if (ss > trade.shares)     { _toast("Exceeds available shares.", "error"); return; }
  if (ss < 1)                { _toast("At least 1 share required.", "error"); return; }

  const sellAmt   = ss * sp;
  const invested  = ss * trade.buyPrice;
  const returns   = sellAmt - invested;
  const plPercent = (returns / invested) * 100;

  const btn = $("confirmSell");
  btn.textContent = "Processing...";
  btn.disabled    = true;

  try {
    if (ss === trade.shares) {
      // ── Full sell ──
      const upd = { sellShares: ss, sellPrice: sp, sellDate: sDate, sellAmount: sellAmt, returns, plPercent, status: "closed" };
      await updateDoc(doc(db, TRADES_COLLECTION, trade.id), upd);
      const idx = trades.findIndex((t) => t.id === trade.id);
      trades[idx] = { ...trades[idx], ...upd };

    } else {
      // ── Partial sell ──
      const remaining = trade.shares - ss;

      // Update existing row → sell the sold portion
      const upd = {
        shares: ss, investedAmount: ss * trade.buyPrice,
        sellShares: ss, sellPrice: sp, sellDate: sDate,
        sellAmount: sellAmt, returns, plPercent, status: "closed"
      };
      await updateDoc(doc(db, TRADES_COLLECTION, trade.id), upd);
      const idx = trades.findIndex((t) => t.id === trade.id);
      trades[idx] = { ...trades[idx], ...upd };

      // New row for remaining shares (same buy price)
      const newData = {
        symbol: trade.symbol, exchange: trade.exchange,
        shares: remaining, buyPrice: trade.buyPrice, buyDate: trade.buyDate,
        investedAmount: remaining * trade.buyPrice,
        sellShares: null, sellPrice: null, sellDate: null,
        sellAmount: null, returns: null, plPercent: null,
        livePrice: trade.livePrice ?? null,
        status: "open", createdAt: serverTimestamp()
      };
      const ref = await addDoc(collection(db, TRADES_COLLECTION), newData);
      trades.push({ id: ref.id, ...newData, createdAt: new Date() });
    }

    _closeSellModal();
    _renderTable();
    _updateSummary();
    _toast(ss === trade.shares ? "Trade closed!" : "Partial sell done — remaining row added!", "success");
  } catch (e) {
    _toast("Error: " + e.message, "error");
  } finally {
    btn.textContent = "Confirm Sell";
    btn.disabled    = false;
  }
});

// ─── Delete ───────────────────────────────────────────────────────────────────
async function _confirmDelete(tradeId) {
  if (!confirm("Delete this trade? This cannot be undone.")) return;
  try {
    await deleteDoc(doc(db, TRADES_COLLECTION, tradeId));
    trades = trades.filter((t) => t.id !== tradeId);
    _renderTable();
    _updateSummary();
    _toast("Deleted.", "info");
  } catch (e) {
    _toast("Error: " + e.message, "error");
  }
}

// ─── Summary Panel ───────────────────────────────────────────────────────────
function _updateSummary() {
  const fundTrades = _tradesForFund();
  const open   = fundTrades.filter((t) => t.status === "open");
  const closed = fundTrades.filter((t) => t.status === "closed");

  const activeInvested = open.reduce((s, t) => s + t.investedAmount, 0);
  const currentValue   = open.reduce((s, t) =>
    s + (t.livePrice ? t.livePrice * t.shares : t.investedAmount), 0);
  const unrealized     = currentValue - activeInvested;
  const unrealPct      = activeInvested > 0 ? (unrealized / activeInvested) * 100 : 0;
  const realized       = closed.reduce((s, t) => s + (t.returns ?? 0), 0);

  // Stat cards
  const invEl = $("sumActiveInvested");
  const curEl = $("sumCurrentValue");
  const DEPOSITED    = FUND_CONFIG[currentFund].deposited;
  const vsDeposited  = ((currentValue   - DEPOSITED) / DEPOSITED) * 100;
  const vsInvested   = ((activeInvested - DEPOSITED) / DEPOSITED) * 100;
  const vsDepClass   = currentValue   >= DEPOSITED ? "profit" : "loss";
  const vsInvClass   = activeInvested >= DEPOSITED ? "profit" : "loss";

  if (invEl) {
    invEl.innerHTML = _fmt(activeInvested) +
      '<span class="cur-val-pct ' + vsInvClass + '">' + (vsInvested >= 0 ? "+" : "") + vsInvested.toFixed(2) + "%</span>";
    invEl.className = "sum-stat-val accent";
  }
  if (curEl) {
    curEl.innerHTML = _fmt(currentValue) +
      '<span class="cur-val-pct ' + vsDepClass + '">' + (vsDeposited >= 0 ? "+" : "") + vsDeposited.toFixed(2) + "%</span>";
    curEl.className = "sum-stat-val " + (unrealized >= 0 ? "profit" : "loss");
  }

  // Unrealized P/L oval
  const plOval = $("sumUnrealizedOval");
  const plVal  = $("sumUnrealized");
  const plPct  = $("sumUnrealizedPct");
  if (plVal)  plVal.textContent  = _fmt(unrealized);
  if (plPct)  plPct.textContent  = _fmtPct(unrealPct);
  if (plOval) plOval.className   = "sum-pl-oval " + (unrealized >= 0 ? "is-profit" : "is-loss");

  // Day P/L oval
  const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const dayPL = open.reduce((s, t) => {
    if (!t.livePrice) return s;
    if (t.buyDate === todayIST) {
      return s + (t.livePrice - t.buyPrice) * t.shares;
    }
    if (t.dayChangePct === null || t.dayChangePct === undefined) return s;
    const prevClose = t.livePrice * 100 / (100 + t.dayChangePct);
    return s + (t.livePrice - prevClose) * t.shares;
  }, 0);
  const dayPct = activeInvested > 0 ? (dayPL / activeInvested) * 100 : 0;
  const dayOval = $("sumDayPLOval");
  const dayValEl = $("sumDayPL");
  const dayPctEl = $("sumDayPLPct");
  if (dayValEl) dayValEl.textContent = _fmt(dayPL);
  if (dayPctEl) dayPctEl.textContent = _fmtPct(dayPct);
  if (dayOval)  dayOval.className    = "sum-pl-oval " + (dayPL >= 0 ? "is-profit" : "is-loss");

  // Realized Returns oval
  const closedInvested = closed.reduce((s, t) => s + t.investedAmount, 0);
  const realizedPct    = closedInvested > 0 ? (realized / closedInvested) * 100 : 0;
  const realOval = $("sumRealizedOval");
  const rEl      = $("sumRealized");
  const rPctEl   = $("sumRealizedPct");
  if (rEl)      rEl.textContent      = _fmt(realized);
  if (rPctEl)   rPctEl.textContent   = _fmtPct(realizedPct);
  if (realOval) realOval.className   = "sum-pl-oval " + (realized >= 0 ? "is-profit" : "is-loss");

  // Available Funds
  const freeFunds  = DEPOSITED + realized - activeInvested;
  const freeEl     = $("sumFreeFunds");
  if (freeEl) freeEl.textContent = _fmt(freeFunds);


  // Update ticker
  _updateTicker();

  // Re-render graph with current data
  _renderCurrentGraph();
}

// ─── Graph Toggle ─────────────────────────────────────────────────────────────
let _activeGraph = "overview";

function _initGraphToggle() {
  document.querySelectorAll(".sum-tgl-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sum-tgl-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      _activeGraph = btn.dataset.graph;
      $("sumGraphTitle").textContent = _activeGraph === "overview" ? "Overview" : "Trade Breakdown";
      _renderCurrentGraph();
    });
  });
}

function _renderCurrentGraph() {
  if (_activeGraph === "overview") _renderOverviewGraph();
  else _renderTradesGraph();
}

function _renderOverviewGraph() {
  const container = $("sumGraph");
  if (!container) return;
  container.className = "sum-graph-area sum-graph-overview";
  const DEPOSITED = FUND_CONFIG[currentFund].deposited;
  const fundTrades = _tradesForFund();
  const open      = fundTrades.filter((t) => t.status === "open");
  const closed    = fundTrades.filter((t) => t.status === "closed");
  const invested  = open.reduce((s, t) => s + t.investedAmount, 0);
  const current   = open.reduce((s, t) =>
    s + (t.livePrice ? t.livePrice * t.shares : t.investedAmount), 0);
  const realized  = closed.reduce((s, t) => s + (t.returns ?? 0), 0);
  const available = DEPOSITED + realized - invested;

  const max  = Math.max(DEPOSITED, invested, current, available, 1);
  const maxH = 90;

  const bars = [
    { label: "Deposited", val: DEPOSITED, cls: "dep" },
    { label: "Invested",  val: invested,  cls: "inv" },
    { label: "Current",   val: current,   cls: "cur" },
    { label: "Available", val: available,  cls: "avl" },
  ];

  // Render bars at height:0 first, then animate to target after a frame
  container.innerHTML = bars.map((b) => {
    const h   = Math.max(14, Math.round((b.val / max) * maxH));
    const lbl = "₹" + (b.val / 100000).toFixed(1) + "L";
    return '<div class="pop-col" data-h="' + h + '">' +
      '<div class="pop-top-val" style="opacity:0">' + lbl + '</div>' +
      '<div class="pop-stick-wrap">' +
        '<div class="pop-stick ' + b.cls + '" style="height:0;transition:none;"></div>' +
      '</div>' +
      '<div class="pop-lbl">' + b.label + '</div>' +
    '</div>';
  }).join("");

  // Staggered grow animation — slow and satisfying
  requestAnimationFrame(() => requestAnimationFrame(() => {
    container.querySelectorAll(".pop-col").forEach((col, i) => {
      const stick = col.querySelector(".pop-stick");
      const label = col.querySelector(".pop-top-val");
      const h = col.dataset.h;
      setTimeout(() => {
        stick.style.transition = "height 1.4s cubic-bezier(.22,1,.36,1)";
        stick.style.height = h + "px";
        label.style.transition = "opacity 0.8s ease 0.5s";
        label.style.opacity = "1";
      }, i * 180);
    });
  }));
}

function _renderTradesGraph() {
  const container = $("sumGraph");
  if (!container) return;
  container.className = "sum-graph-area sum-graph-trades";

  const open = trades.filter((t) => t.status === "open");
  if (!open.length) {
    container.innerHTML = '<span style="color:var(--text-3);font-size:12px;text-align:center;width:100%;">No open trades</span>';
    return;
  }

  // Build rows with bars starting at width:0, store targets in data attributes
  container.innerHTML = open.map((t) => {
    const curr     = t.livePrice ? t.livePrice * t.shares : t.investedAmount;
    const pl       = curr - t.investedAmount;
    const isProfit = pl >= 0;
    const plPct    = t.investedAmount > 0 ? (pl / t.investedAmount) * 100 : 0;
    const sign     = isProfit ? "+" : "";
    const sym      = t.symbol.length > 9 ? t.symbol.slice(0, 9) + "…" : t.symbol;

    let barHtml;
    if (isProfit) {
      const darkW  = curr > 0 ? Math.round((t.investedAmount / curr) * 100) : 100;
      const lightW = 100 - darkW;
      barHtml =
        '<div class="hbar-track hbar-profit">' +
          '<div class="hbar-seg profit-dark"  style="width:0" data-w="' + darkW  + '"></div>' +
          '<div class="hbar-seg profit-light" style="width:0" data-w="' + lightW + '"></div>' +
        '</div>';
    } else {
      const darkW = t.investedAmount > 0
        ? Math.min(100, Math.round((curr / t.investedAmount) * 100))
        : 0;
      barHtml =
        '<div class="hbar-track hbar-loss">' +
          '<div class="hbar-seg loss-dark" style="width:0" data-w="' + darkW + '"></div>' +
        '</div>';
    }

    return '<div class="hbar-row" style="opacity:0">' +
      '<span class="hbar-sym">' + sym + '</span>' +
      barHtml +
      '<span class="hbar-pct ' + (isProfit ? "profit" : "loss") + '">' + sign + plPct.toFixed(2) + '%</span>' +
    '</div>';
  }).join("");

  // Staggered slide-in + bar grow — slow and satisfying
  requestAnimationFrame(() => requestAnimationFrame(() => {
    container.querySelectorAll(".hbar-row").forEach((row, i) => {
      setTimeout(() => {
        row.style.transition = "opacity 0.4s ease";
        row.style.opacity = "1";
        row.querySelectorAll(".hbar-seg[data-w]").forEach((seg, j) => {
          const targetW = seg.dataset.w;
          // Slight delay between segments in the same bar (dark then light)
          setTimeout(() => {
            seg.style.transition = "width 1.3s cubic-bezier(.22,1,.36,1)";
            seg.style.width = targetW + "%";
          }, j * 120);
        });
      }, i * 160);
    });
  }));
}

// ─── Ticker Tape ─────────────────────────────────────────────────────────────
let _tickerInterval = null;
let _tickerIsA      = true;

function _initTicker() {
  clearInterval(_tickerInterval);
  _updateTicker();
  _tickerInterval = setInterval(_rotateTicker, 4000);
}

function _updateTicker() {
  const fundTrades = _tradesForFund();
  const open = fundTrades.filter((t) => t.status === "open");

  // No trades — show scrolling message
  if (open.length === 0) {
    const label = $("tickerLabel");
    const elA = $("tickerA");
    const elB = $("tickerB");
    if (label) label.textContent = "";
    if (elA) elA.innerHTML = '<span class="ticker-empty-msg">Add stocks to start tracking your ' + FUND_CONFIG[currentFund].name + ' portfolio</span>';
    if (elB) elB.innerHTML = '';
    window._tickerGroups = [];
    return;
  }

  // Group 1 — top 4 biggest day movers (by absolute dayChangePct)
  const movers = [...open]
    .filter((t) => t.dayChangePct !== null && t.dayChangePct !== undefined)
    .sort((a, b) => Math.abs(b.dayChangePct) - Math.abs(a.dayChangePct))
    .slice(0, 3);

  // Group 2 — top 4 portfolio gainers (by unrealized P/L %)
  const gainers = [...open]
    .filter((t) => t.livePrice)
    .map((t) => {
      const pl = (t.livePrice * t.shares - t.investedAmount) / t.investedAmount * 100;
      return { ...t, portfolioPct: parseFloat(pl.toFixed(2)) };
    })
    .sort((a, b) => b.portfolioPct - a.portfolioPct)
    .slice(0, 3);

  window._tickerGroups = [
    { label: "Day Movers",   data: movers,  key: "dayChangePct" },
    { label: "Top Gainers",  data: gainers, key: "portfolioPct" },
  ];

  // Render initial group A
  _fillTickerRow("tickerA", window._tickerGroups[0]);
  if (!$("tickerB").innerHTML) _fillTickerRow("tickerB", window._tickerGroups[1]);
}

function _fillTickerRow(id, group) {
  const el = $(id);
  if (!el) return;
  if (!group.data.length) {
    el.innerHTML = '<span style="color:var(--text-3);font-family:var(--ff-mono);font-size:11px;">–</span>';
    return;
  }
  el.innerHTML = group.data.map((t) => {
    const pct    = group.key === "dayChangePct" ? t.dayChangePct : t.portfolioPct;
    const isUp   = pct >= 0;
    const cls    = isUp ? "up" : "down";
    const arrow  = isUp ? "▲" : "▼";
    const sign   = isUp ? "+" : "";
    return '<div class="tick-chip ' + cls + '">' +
      '<span class="tick-sym">' + t.symbol + '</span>' +
      '<span class="tick-pct ' + cls + '">' + arrow + ' ' + sign + parseFloat(pct).toFixed(2) + '%</span>' +
    '</div>';
  }).join("");
}

function _rotateTicker() {
  const groups = window._tickerGroups || [];
  if (!groups.length) return;

  const a = $("tickerA"), b = $("tickerB"), lbl = $("tickerLabel");
  if (!a || !b) return;

  const nextIdx    = _tickerIsA ? 1 : 0;
  const entering   = _tickerIsA ? b : a;
  const leaving    = _tickerIsA ? a : b;

  _fillTickerRow(entering.id, groups[nextIdx]);
  entering.style.transition = "none";
  entering.style.transform  = "translateY(100%)";
  entering.style.opacity    = "0";

  requestAnimationFrame(() => requestAnimationFrame(() => {
    leaving.style.transition  = "transform 0.45s ease, opacity 0.45s ease";
    leaving.style.transform   = "translateY(-100%)";
    leaving.style.opacity     = "0";
    entering.style.transition = "transform 0.45s ease, opacity 0.45s ease";
    entering.style.transform  = "translateY(0)";
    entering.style.opacity    = "1";
    if (lbl) lbl.textContent  = groups[nextIdx].label;
    _tickerIsA = !_tickerIsA;
  }));
}

// ─── Live Prices ──────────────────────────────────────────────────────────────
async function _fetchAndSavePrice(tradeId, symbol, exchange) {
  const { price, dayChangePct, exchange: detected } = await fetchLivePrice(symbol, exchange);
  const idx = trades.findIndex((t) => t.id === tradeId);
  if (idx === -1) return;

  trades[idx].livePrice    = price;
  trades[idx].dayChangePct = dayChangePct;
  const upd = { livePrice: price, dayChangePct: dayChangePct ?? null };
  if (detected && !trades[idx].exchange) {
    trades[idx].exchange = detected;
    upd.exchange = detected;
  }

  try { await updateDoc(doc(db, TRADES_COLLECTION, tradeId), upd); } catch {}
  _renderTable();
  _updateSummary();
}

// ─── Market Hours Check ───────────────────────────────────────────────────────
function _isMarketHours() {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const day = ist.getDay();
  const min = ist.getHours() * 60 + ist.getMinutes();
  // Mon–Fri, 9:15 AM to 3:30 PM IST
  return day >= 1 && day <= 5 && min >= 555 && min <= 930;
}

// ─── Refresh All Prices ───────────────────────────────────────────────────────
// Fetches all open trades in parallel — Cloudflare Worker handles the load fine
async function _refreshAllPrices() {
  const open = trades.filter((t) => t.status === "open");
  if (open.length === 0) return;
  await Promise.all(open.map((t) => _fetchAndSavePrice(t.id, t.symbol, t.exchange)));
}

// ─── Refresh Closed Trade Prices (display only) ───────────────────────────────
// Fetches current price for closed trades purely for visual context.
// In-memory only — no Firestore write, no summary/ticker impact.
async function _refreshClosedPrices() {
  const closed = trades.filter((t) => t.status === "closed");
  if (!closed.length) return;

  // One API call per unique symbol
  const symbolMap = {};
  closed.forEach((t) => { if (!symbolMap[t.symbol]) symbolMap[t.symbol] = t.exchange; });

  const results = await Promise.all(
    Object.entries(symbolMap).map(async ([symbol, exchange]) => {
      const { price } = await fetchLivePrice(symbol, exchange);
      return { symbol, price };
    })
  );

  const priceMap = {};
  results.forEach(({ symbol, price }) => { if (price !== null) priceMap[symbol] = price; });

  let changed = false;
  trades.forEach((t, idx) => {
    if (t.status !== "closed" || priceMap[t.symbol] === undefined) return;
    trades[idx].livePrice = priceMap[t.symbol];
    changed = true;
  });

  if (changed) _renderTable();
}

// ─── Start / Restart Price Refresh ───────────────────────────────────────────
// Always fetches once on load. Then auto-refreshes every 5s during market hours.
function _startPriceRefresh() {
  _refreshAllPrices();    // immediate fetch on load regardless of time
  _refreshClosedPrices(); // closed trades: display-only, no calculations affected
  clearInterval(priceInterval);
  priceInterval = setInterval(() => {
    if (_isMarketHours()) {
      _refreshAllPrices();
      _refreshClosedPrices();
    }
  }, 5000);
}

// ─── Tara Chat ───────────────────────────────────────────────────────────────
const AI_WORKER = "https://nk-price-proxy.lotuswhite9392.workers.dev";
let _aiInterval  = null;
let _aiLastRun   = 0;
let _chatHistory = [];

function _initAIMonitor() {
  const closeBtn  = $("aiClose");
  const toggleBtn = $("aiToggle");
  const sendBtn   = $("aiChatSend");
  const chatInput = $("aiChatInput");

  if (closeBtn) closeBtn.addEventListener("click", () => {
    const d = $("aiDialogue");
    d.classList.add("closing");
    d.addEventListener("animationend", function handler() {
      d.classList.add("hidden");
      d.classList.remove("closing");
      d.removeEventListener("animationend", handler);
    }, { once: true });
  });

  if (toggleBtn) toggleBtn.addEventListener("click", () => {
    const d = $("aiDialogue");
    const rect = toggleBtn.getBoundingClientRect();
    d.style.right = (window.innerWidth - rect.left) + "px";
    if (d.classList.contains("hidden")) {
      d.classList.remove("hidden");
      d.classList.remove("closing");
      d.style.animation = "none";
      d.offsetHeight;
      d.style.animation = "";
      if (_chatHistory.length === 0) _autoGreet();
      if (chatInput) chatInput.focus();
    } else {
      d.classList.add("closing");
      d.addEventListener("animationend", function handler() {
        d.classList.add("hidden");
        d.classList.remove("closing");
        d.removeEventListener("animationend", handler);
      }, { once: true });
    }
  });

  if (sendBtn && chatInput) {
    sendBtn.addEventListener("click", () => _sendChat());
    chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") _sendChat(); });
  }

  // Auto-run during market hours
  setTimeout(() => {
    if (_isMarketHours()) {
      const hasLive = _tradesForFund().some((t) => t.status === "open" && t.livePrice);
      if (hasLive) _autoPortfolioCheck();
    }
  }, 45000);
  _aiInterval = setInterval(() => {
    if (_isMarketHours() && Date.now() - _aiLastRun > 1700000) _autoPortfolioCheck();
  }, 1800000);
}

function _autoGreet() {
  const fundTrades = _tradesForFund();
  const open = fundTrades.filter((t) => t.status === "open");
  if (open.length === 0) {
    _addChatMsg("tara", "Hey! No stocks in " + FUND_CONFIG[currentFund].name + " yet. Add some trades and I'll keep an eye on them for you.");
  } else {
    _addChatMsg("tara", "Hey! I'm watching your " + FUND_CONFIG[currentFund].name + " portfolio (" + open.length + " stocks). Ask me anything — or I'll check in automatically during market hours.");
  }
}

function _autoPortfolioCheck() {
  const fundTrades = _tradesForFund();
  const open = fundTrades.filter((t) => t.status === "open" && t.livePrice);
  if (open.length === 0) return;
  _aiLastRun = Date.now();
  _sendToTara(_buildPortfolioContext() + "\nGive a quick portfolio check. Per-stock verdict, alerts, and cash advice. Under 200 words. Do NOT mention next check time, scheduling, or when you will run again.");
}

function _sendChat() {
  const input = $("aiChatInput");
  if (!input) return;
  const msg = input.value.trim();
  if (!msg) return;
  input.value = "";
  _addChatMsg("user", msg);
  const context = _buildPortfolioContext();
  _sendToTara(context + "\n\nUser asks: " + msg);
}

function _buildPortfolioContext() {
  const fundTrades = _tradesForFund();
  const open = fundTrades.filter((t) => t.status === "open");
  const closed = fundTrades.filter((t) => t.status === "closed");
  const DEPOSITED = FUND_CONFIG[currentFund].deposited;
  const realized = closed.reduce((s, t) => s + (t.returns ?? 0), 0);
  const invested = open.reduce((s, t) => s + t.investedAmount, 0);
  const current = open.reduce((s, t) => s + (t.livePrice ? t.livePrice * t.shares : t.investedAmount), 0);
  const freeCash = DEPOSITED + realized - invested;
  const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  let ctx = "PORTFOLIO (" + FUND_CONFIG[currentFund].name + "):\n" +
    "Deposited: ₹" + DEPOSITED + " | Invested: ₹" + invested.toFixed(0) +
    " | Current: ₹" + current.toFixed(0) + " | Free: ₹" + freeCash.toFixed(0) +
    " | Realized: ₹" + realized.toFixed(0) + "\n";

  if (open.length > 0) {
    ctx += "\nOPEN:\n";
    open.forEach((t) => {
      const pl = (t.livePrice ? t.livePrice * t.shares : t.investedAmount) - t.investedAmount;
      const plPct = (pl / t.investedAmount * 100).toFixed(1);
      const dayStr = t.dayChangePct != null ? (t.dayChangePct >= 0 ? "+" : "") + t.dayChangePct + "%" : "?";
      const daysHeld = t.buyDate ? Math.floor((new Date(todayIST) - new Date(t.buyDate)) / 86400000) : "?";
      ctx += t.symbol + ": " + t.shares + "sh @₹" + t.buyPrice + " →₹" + (t.livePrice || "?") +
        " (" + (pl >= 0 ? "+" : "") + plPct + "%, Day:" + dayStr + ", " + daysHeld + "d held)\n";
    });
  }
  return ctx;
}

async function _sendToTara(prompt) {
  const msgs = $("aiChatMessages");
  if (!msgs) return;

  // Show typing indicator
  const typing = document.createElement("div");
  typing.className = "ai-chat-typing";
  typing.innerHTML = '<div class="res-spinner" style="width:14px;height:14px"></div> Tara is thinking...';
  msgs.appendChild(typing);
  msgs.scrollTop = msgs.scrollHeight;

  // Build messages array with history for context
  const apiMessages = [];
  _chatHistory.forEach((m) => {
    apiMessages.push({ role: m.role === "tara" ? "assistant" : "user", content: m.text });
  });
  apiMessages.push({ role: "user", content: prompt });

  try {
    const res = await fetch(AI_WORKER + "?type=ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: apiMessages.map(m => m.role + ": " + m.content).join("\n") }),
    });
    const data = await res.json();
    typing.remove();

    if (data.analysis) {
      _addChatMsg("tara", data.analysis);
      _aiLastRun = Date.now();
      const timeEl = $("aiTime");
      if (timeEl) timeEl.textContent = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

      // Toast for urgent alerts
      if (data.analysis.includes("EXIT") || data.analysis.includes("⚠️")) {
        const line = data.analysis.split("\n").find(l => l.includes("EXIT") || l.includes("⚠️"));
        if (line) _toast(line.replace(/[🔴⚠️]/g, "").trim(), "error");
      }
    } else {
      typing.remove();
      _addChatMsg("tara", "I couldn't process that. Try asking differently.");
    }
  } catch {
    typing.remove();
    _addChatMsg("tara", "Connection issue. Try again in a moment.");
  }
}

function _addChatMsg(role, text) {
  const msgs = $("aiChatMessages");
  if (!msgs) return;
  _chatHistory.push({ role, text });
  const div = document.createElement("div");
  div.className = "ai-chat-msg " + role;
  div.innerHTML = text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/^(OVERALL|ALERTS|CASH):?\s*/gm, '<span class="ai-section-label">$1</span> ')
    .replace(/(🔴\s*EXIT)/g, '<span class="ai-tag-exit">$1</span>')
    .replace(/(⭐\s*BOOK PROFIT)/g, '<span class="ai-tag-book">$1</span>')
    .replace(/(🟡\s*WATCH)/g, '<span class="ai-tag-watch">$1</span>')
    .replace(/(🟢\s*HOLD)/g, '<span class="ai-tag-hold">$1</span>')
    .replace(/\n/g, '<br>');
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

// ─── Market Status ────────────────────────────────────────────────────────────
function _updateMarketStatus() {
  const ist  = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h    = ist.getHours();
  const m    = ist.getMinutes();
  const day  = ist.getDay();
  const open =
    day >= 1 && day <= 5 &&
    (h > 9 || (h === 9 && m >= 15)) &&
    (h < 15 || (h === 15 && m <= 30));

  const dot  = $("marketStatusDot");
  const txt  = $("marketStatusText");
  if (dot) dot.className     = "status-dot " + (open ? "open" : "closed");
  if (txt) txt.textContent   = open ? "Market Open" : "Market Closed";
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function _toast(msg, type = "info") {
  let wrap = document.querySelector(".toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "toast-wrap";
    document.body.appendChild(wrap);
  }
  const t = document.createElement("div");
  t.className   = "toast " + type;
  t.textContent = msg;
  wrap.appendChild(t);
  requestAnimationFrame(() => { requestAnimationFrame(() => t.classList.add("visible")); });
  setTimeout(() => {
    t.classList.remove("visible");
    setTimeout(() => t.remove(), 280);
  }, 2600);
}

// ─── Startup ─────────────────────────────────────────────────────────────────
// Always attach login listeners first — isolated so nothing can break them
(function attachLoginListeners() {
  try {
    const loginBtn = document.getElementById("loginBtn");
    const loginPw  = document.getElementById("loginPassword");
    const logoutBtn = document.getElementById("logoutBtn");
    if (loginBtn)  loginBtn.addEventListener("click", _handleLogin);
    if (loginPw)   loginPw.addEventListener("keydown", (e) => { if (e.key === "Enter") _handleLogin(); });
    if (logoutBtn) logoutBtn.addEventListener("click", () => {
      sessionStorage.removeItem("nktt_ok");
      clearInterval(priceInterval);
      location.reload();
    });
  } catch(e) { console.error("Login listener error:", e); }
})();

// Auto-login if session exists
try {
  if (sessionStorage.getItem("nktt_ok")) _showApp();
} catch(e) { console.error("Session check error:", e); }

// ─── Formatters ───────────────────────────────────────────────────────────────
function _fmt(val) {
  if (val === null || val === undefined || isNaN(val)) return "–";
  return "₹" + parseFloat(val).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _fmtPct(val) {
  if (val === null || val === undefined || isNaN(val)) return "–";
  return (val >= 0 ? "+" : "") + parseFloat(val).toFixed(2) + "%";
}

function _fmtDate(str) {
  if (!str) return "–";
  const [y, m, d] = str.split("-");
  return d + "/" + m + "/" + y.slice(2);
}

function _daysHeldLabel(trade) {
  if (!trade.buyDate) return "–";
  const end = trade.status === "closed" && trade.sellDate ? trade.sellDate : new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return Math.floor((new Date(end) - new Date(trade.buyDate)) / 86400000) + "d";
}

function _daysHeldCell(trade) {
  if (!trade.buyDate) return '<span class="dash-val">–</span>';
  const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const endDate = trade.status === "closed" && trade.sellDate ? trade.sellDate : todayIST;
  const days = Math.floor((new Date(endDate) - new Date(trade.buyDate)) / 86400000);
  const label = days + "d";
  if (trade.status === "closed") {
    return '<span class="days-held">' + label + '</span>';
  }
  const cls = days > 14 ? "days-warn" : days > 10 ? "days-caution" : "days-ok";
  return '<span class="days-held ' + cls + '">' + label + '</span>' +
    '<button class="btn-del" data-id="' + trade.id + '" title="Delete">✕</button>';
}
