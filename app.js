// ─── NK Trade Tracker — Main App ─────────────────────────────────────────────

import { db, TRADES_COLLECTION, AUTH_COLLECTION } from "./firebase-config.js";
import {
  collection, addDoc, getDocs, doc, updateDoc, deleteDoc,
  query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { fetchLivePrice } from "./prices.js";
import { initChatbot }    from "./chatbot.js";

// ─── State ────────────────────────────────────────────────────────────────────
let trades          = [];
let currentFilter   = "all";
let activeSellId    = null;
let priceInterval   = null;

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

// ─── Session Check ────────────────────────────────────────────────────────────
if (sessionStorage.getItem("nktt_ok")) _showApp();

// ─── Auth ─────────────────────────────────────────────────────────────────────
$("loginBtn").addEventListener("click", _handleLogin);
$("loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") _handleLogin(); });
$("logoutBtn").addEventListener("click", () => {
  sessionStorage.removeItem("nktt_ok");
  clearInterval(priceInterval);
  location.reload();
});

async function _handleLogin() {
  const pw  = $("loginPassword").value.trim();
  const btn = $("loginBtn");
  if (!pw) return;
  btn.textContent = "Checking...";
  btn.disabled    = true;

  try {
    const snap = await getDocs(collection(db, AUTH_COLLECTION));
    let ok = false;
    snap.forEach((d) => { if (d.data().user === "nikhil" && d.data().password === pw) ok = true; });
    if (ok) {
      sessionStorage.setItem("nktt_ok", "1");
      $("loginOverlay").classList.add("hidden");
      _showApp();
    } else {
      $("loginError").textContent = "Incorrect password.";
      btn.textContent = "Access";
      btn.disabled    = false;
    }
  } catch (e) {
    $("loginError").textContent = "Firebase error — check config.";
    btn.textContent = "Access";
    btn.disabled    = false;
  }
}

async function _showApp() {
  $("loginOverlay").classList.add("hidden");
  $("app").classList.remove("hidden");
  _initBgCanvas();
  await _initApp();
}


// ─── Animated Background Canvas ──────────────────────────────────────────────
function _initBgCanvas() {
  const canvas = document.getElementById('bgCanvas');
  if (!canvas) return;

  // size canvas to fill the fixed bg-canvas div
  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const ctx = canvas.getContext('2d');

  function isDark() {
    return document.documentElement.getAttribute('data-theme') !== 'light';
  }

  // ── DARK: animated neon grid + large glowing orbs + shooting sparks ──────
  const orbs = Array.from({ length: 5 }, (_, i) => ({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    r: 120 + Math.random() * 180,
    vx: (Math.random() - 0.5) * 0.4,
    vy: (Math.random() - 0.5) * 0.4,
    phase: Math.random() * Math.PI * 2,
    color: i % 2 === 0 ? '255,230,0' : '57,255,110'
  }));

  const sparks = Array.from({ length: 22 }, () => ({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    vx: (Math.random() - 0.5) * 0.8,
    vy: -Math.random() * 0.6 - 0.2,
    life: Math.random(),
    maxLife: 0.6 + Math.random() * 0.8,
    size: 1.5 + Math.random() * 2.5
  }));

  // ── LIGHT: floating amber + blue bubbles + dot grid ──────────────────────
  const bubbles = Array.from({ length: 12 }, (_, i) => ({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    r: 60 + Math.random() * 120,
    vx: (Math.random() - 0.5) * 0.25,
    vy: (Math.random() - 0.5) * 0.25,
    phase: Math.random() * Math.PI * 2,
    color: i < 8 ? '224,123,0' : '29,111,191'
  }));

  let t = 0;

  function drawDark() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // animated grid — lines pulse in opacity
    const gs = 80;
    const gridAlpha = 0.04 + Math.sin(t * 0.4) * 0.02;
    ctx.strokeStyle = 'rgba(255,230,0,' + gridAlpha + ')';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += gs) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += gs) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // glowing orbs — large, very visible
    orbs.forEach(o => {
      o.x += o.vx; o.y += o.vy; o.phase += 0.012;
      if (o.x < -o.r) o.x = W + o.r; if (o.x > W + o.r) o.x = -o.r;
      if (o.y < -o.r) o.y = H + o.r; if (o.y > H + o.r) o.y = -o.r;
      const pulse = 0.07 + Math.sin(o.phase) * 0.04;
      const grad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r);
      grad.addColorStop(0,   'rgba(' + o.color + ',' + pulse + ')');
      grad.addColorStop(0.5, 'rgba(' + o.color + ',' + (pulse * 0.4) + ')');
      grad.addColorStop(1,   'rgba(' + o.color + ',0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); ctx.fill();
    });

    // corner bracket decorations — static, bold
    ctx.strokeStyle = 'rgba(255,230,0,0.35)';
    ctx.lineWidth = 2;
    const bl = 36;
    [[20,20],[W-20,20],[20,H-20],[W-20,H-20]].forEach(([cx,cy]) => {
      const sx = cx < W/2 ? 1 : -1, sy = cy < H/2 ? 1 : -1;
      ctx.beginPath(); ctx.moveTo(cx, cy+sy*bl); ctx.lineTo(cx,cy); ctx.lineTo(cx+sx*bl,cy); ctx.stroke();
    });

    // rising sparks
    sparks.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.life += 0.008;
      if (p.life > p.maxLife) {
        p.x = Math.random() * W; p.y = H + 10;
        p.vx = (Math.random()-0.5)*0.8; p.vy = -Math.random()*0.6-0.2;
        p.life = 0; p.maxLife = 0.6 + Math.random()*0.8;
      }
      const alpha = Math.sin((p.life / p.maxLife) * Math.PI) * 0.7;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(255,230,0,' + alpha + ')'; ctx.fill();
    });
  }

  function drawLight() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // dot grid — visible amber dots
    const gs = 48;
    for (let x = gs; x < W; x += gs) {
      for (let y = gs; y < H; y += gs) {
        const a = 0.12 + Math.sin(t * 0.3 + x * 0.01 + y * 0.01) * 0.04;
        ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI*2);
        ctx.fillStyle = 'rgba(224,123,0,' + a + ')'; ctx.fill();
      }
    }

    // large soft bubbles
    bubbles.forEach(b => {
      b.x += b.vx; b.y += b.vy; b.phase += 0.008;
      if (b.x < -b.r) b.x = W+b.r; if (b.x > W+b.r) b.x = -b.r;
      if (b.y < -b.r) b.y = H+b.r; if (b.y > H+b.r) b.y = -b.r;
      const pulse = 0.08 + Math.sin(b.phase) * 0.04;
      const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      grad.addColorStop(0,   'rgba(' + b.color + ',' + pulse + ')');
      grad.addColorStop(0.6, 'rgba(' + b.color + ',' + (pulse*0.3) + ')');
      grad.addColorStop(1,   'rgba(' + b.color + ',0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI*2); ctx.fill();
    });

    // decorative circles — bold
    ctx.strokeStyle = 'rgba(224,123,0,0.14)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(W*0.9, H*0.85, 110, 0, Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.arc(W*0.9, H*0.85, 65, 0, Math.PI*2); ctx.stroke();
    ctx.strokeStyle = 'rgba(29,111,191,0.10)';
    ctx.beginPath(); ctx.arc(W*0.06, H*0.78, 80, 0, Math.PI*2); ctx.stroke();
  }

  function draw() {
    t += 0.016;
    if (isDark()) drawDark(); else drawLight();
    requestAnimationFrame(draw);
  }

  draw();
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function _initApp() {
  _updateMarketStatus();
  setInterval(_updateMarketStatus, 60000);
  await _loadTrades();
  _renderTable();
  _updateSummary();
  initChatbot(_getPortfolioContext);
  _startPriceRefresh();
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
    _renderTable();
  });
});

// ─── Render Table ─────────────────────────────────────────────────────────────
function _renderTable() {
  const filtered = trades.filter((t) => {
    if (currentFilter === "open")   return t.status === "open";
    if (currentFilter === "closed") return t.status === "closed";
    return true;
  });

  const tbody = $("tradeTableBody");
  tbody.innerHTML = "";
  $("emptyState").style.display = filtered.length === 0 ? "flex" : "none";
  if (filtered.length === 0) return;

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

    const sellCell = isClosed
      ? '<span class="td-mono">' + _fmt(trade.sellPrice) + '</span>'
      : '<button class="btn-sell-row" data-id="' + trade.id + '">Sell</button>';

    const currValCell = currVal !== null
      ? '<span class="td-mono ' + (unrealPl >= 0 ? "profit" : "loss") + '">' + _fmt(currVal) + '</span>'
      : '<span class="dash-val">–</span>';

    tr.innerHTML =
      '<td class="td-num">'    + (i + 1) + '</td>' +
      '<td class="td-symbol">' +
        '<span class="sym-badge">' + trade.symbol + '</span>' +
        (trade.exchange ? '<span class="exch-tag">' + trade.exchange + '</span>' : '') +
      '</td>' +
      '<td class="td-mono">'   + trade.shares + '</td>' +
      '<td class="td-mono">'   + _fmt(trade.buyPrice) + '</td>' +
      '<td class="td-date">'   + _fmtDate(trade.buyDate) + '</td>' +
      '<td class="td-mono">'   + _fmt(trade.investedAmount) + '</td>' +
      '<td class="td-live">'   + liveCell + '</td>' +
      '<td>'                   + currValCell + '</td>' +
      '<td class="td-sell">'   + sellCell + '</td>' +
      '<td class="td-date">'   + (trade.sellDate ? _fmtDate(trade.sellDate) : '<span class="dash-val">–</span>') + '</td>' +
      '<td class="td-mono '    + plClass + '">' + (plVal !== null ? _fmt(plVal) : '<span class="dash-val">–</span>') + '</td>' +
      '<td class="td-mono '    + plClass + '">' + (plPct !== null ? _fmtPct(plPct) : '<span class="dash-val">–</span>') + '</td>' +
      '<td><span class="status-badge ' + trade.status + '">' + (trade.status === "open" ? "Open" : "Closed") + '</span></td>' +
      '<td><button class="btn-del" data-id="' + trade.id + '" title="Delete">✕</button></td>';

    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".btn-sell-row").forEach((btn) =>
    btn.addEventListener("click", () => _openSellModal(btn.dataset.id))
  );
  tbody.querySelectorAll(".btn-del").forEach((btn) =>
    btn.addEventListener("click", () => _confirmDelete(btn.dataset.id))
  );
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
      symbol, exchange, shares, buyPrice, buyDate, investedAmount,
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

// ─── Summary Panel ────────────────────────────────────────────────────────────
function _updateSummary() {
  const open   = trades.filter((t) => t.status === "open");
  const closed = trades.filter((t) => t.status === "closed");

  const activeInvested = open.reduce((s, t) => s + t.investedAmount, 0);
  const currentValue   = open.reduce((s, t) =>
    s + (t.livePrice ? t.livePrice * t.shares : t.investedAmount), 0);
  const unrealized     = currentValue - activeInvested;
  const unrealPct      = activeInvested > 0 ? (unrealized / activeInvested) * 100 : 0;
  const realized       = closed.reduce((s, t) => s + (t.returns ?? 0), 0);
  const wins           = closed.filter((t) => (t.returns ?? 0) > 0).length;
  const winRate        = closed.length > 0
    ? Math.round((wins / closed.length) * 100) + "%"
    : "–";

  $("sumActiveInvested").textContent = _fmt(activeInvested);
  $("sumCurrentValue").textContent   = _fmt(currentValue);

  const uEl  = $("sumUnrealized");
  const uPEl = $("sumUnrealizedPct");
  uEl.textContent   = _fmt(unrealized);
  uEl.className     = "summary-value " + (unrealized >= 0 ? "profit" : "loss");
  uPEl.textContent  = _fmtPct(unrealPct);
  uPEl.className    = "summary-sub " + (unrealized >= 0 ? "profit" : "loss");

  const rEl = $("sumRealized");
  rEl.textContent   = _fmt(realized);
  rEl.className     = "summary-value " + (realized >= 0 ? "profit" : "loss");

  $("sumTotalTrades").textContent = trades.length;
  $("sumWinRate").textContent     = winRate;

  _renderMovers();
}

function _renderMovers() {
  const el   = $("topMovers");
  const open = trades.filter((t) => t.status === "open" && t.livePrice);
  if (!el) return;
  if (open.length === 0) {
    el.innerHTML = '<span class="muted-txt">No live prices yet</span>';
    return;
  }
  const sorted = [...open]
    .sort((a, b) => (b.livePrice - b.buyPrice) / b.buyPrice - (a.livePrice - a.buyPrice) / a.buyPrice)
    .slice(0, 4);

  el.innerHTML = sorted.map((t) => {
    const pct = ((t.livePrice - t.buyPrice) / t.buyPrice) * 100;
    return '<div class="mover-row">' +
      '<span class="sym-badge sm">' + t.symbol + '</span>' +
      '<span class="' + (pct >= 0 ? "profit" : "loss") + '">' + _fmtPct(pct) + '</span>' +
      '</div>';
  }).join("");
}

// ─── Portfolio Context for Chatbot ────────────────────────────────────────────
function _getPortfolioContext() {
  const open   = trades.filter((t) => t.status === "open");
  const closed = trades.filter((t) => t.status === "closed");
  const totalInvested = open.reduce((s, t) => s + t.investedAmount, 0);
  const realized      = closed.reduce((s, t) => s + (t.returns ?? 0), 0);
  const wins          = closed.filter((t) => (t.returns ?? 0) > 0).length;

  const openStr = open.map((t) =>
    t.symbol + "(" + t.shares + "sh @ ₹" + t.buyPrice +
    (t.livePrice ? ", live ₹" + t.livePrice : "") + ")"
  ).join(", ");

  return [
    "Portfolio: " + open.length + " open, " + closed.length + " closed trades.",
    "Active invested: ₹" + totalInvested.toLocaleString("en-IN"),
    "Realized returns: ₹" + realized.toLocaleString("en-IN"),
    closed.length > 0 ? "Win rate: " + Math.round(wins / closed.length * 100) + "%" : "",
    open.length > 0 ? "Open positions: " + openStr : "No open positions."
  ].filter(Boolean).join("\n");
}

// ─── Live Prices ──────────────────────────────────────────────────────────────
async function _fetchAndSavePrice(tradeId, symbol, exchange) {
  const { price, exchange: detected } = await fetchLivePrice(symbol, exchange);
  const idx = trades.findIndex((t) => t.id === tradeId);
  if (idx === -1) return;

  trades[idx].livePrice = price;
  const upd = { livePrice: price };
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
  // Mon–Fri, 9:00 AM to 3:30 PM IST
  return day >= 1 && day <= 5 && min >= 540 && min <= 930;
}

// ─── Refresh All Prices ───────────────────────────────────────────────────────
// Fetches all open trades in parallel — Cloudflare Worker handles the load fine
async function _refreshAllPrices() {
  const open = trades.filter((t) => t.status === "open");
  if (open.length === 0) return;
  await Promise.all(open.map((t) => _fetchAndSavePrice(t.id, t.symbol, t.exchange)));
}

// ─── Start / Restart Price Refresh ───────────────────────────────────────────
// Always fetches once on load. Then auto-refreshes every 5s during market hours.
function _startPriceRefresh() {
  _refreshAllPrices(); // immediate fetch on load regardless of time
  clearInterval(priceInterval);
  priceInterval = setInterval(() => {
    if (_isMarketHours()) _refreshAllPrices();
  }, 5000); // every 5 seconds
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
