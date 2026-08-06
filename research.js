// ─── NK Trade Tracker — Stock Research & Analysis ─────────────────────────────

import { db } from "./firebase-config.js";
import {
  collection, addDoc, getDocs, deleteDoc, doc, serverTimestamp, query, where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  detectCandlePatterns, detectSwingSetup, detectRsiZone,
  PATTERN_LABELS, SETUP_LABELS, RSI_ZONE_LABELS,
  BULLISH_PATTERNS, BEARISH_PATTERNS
} from "./patterns.js";

const WORKER_URL = "https://nk-price-proxy.lotuswhite9392.workers.dev";
const WL_COL     = "nktt_watchlist";
const SIG_COL    = "nktt_signals";

let _trades      = [];
let _currentFund = "zerodha";
let _watchlist   = [];   // [{ id, symbol, notes, addedDate }]

export function initResearch(trades, fund) {
  _trades = trades || [];
  _currentFund = fund || localStorage.getItem("currentFund") || "zerodha";
  const btn   = document.getElementById("researchBtn");
  const input = document.getElementById("researchSymbol");
  if (!btn || !input) return;
  btn.addEventListener("click", () => _analyze(input.value.trim()));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") _analyze(input.value.trim()); });
  _renderSuggestions();
  _loadWatchlist();
  _loadSignals();
  _bindWatchlistEvents();

  document.addEventListener("research-reset", () => _renderSuggestions());
}

function _renderSuggestions() {
  const el = document.getElementById("researchResults");
  if (!el) return;
  const open = _trades.filter((t) => t.status === "open" && (t.fund || "zerodha") === _currentFund);
  if (open.length === 0) {
    el.innerHTML = '<div class="res-empty"><div class="res-empty-icon">📊</div><div class="res-empty-text">No stocks in ' + (_currentFund === "zerodha" ? "Zerodha" : "Groww") + '</div><div class="res-empty-sub">Add trades to this platform to see positions and get insights</div></div>';
    return;
  }
  let h = '<div class="res-empty-text">Your Open Positions</div><div class="res-suggestions">';
  open.forEach((t) => {
    const curr = t.livePrice ? t.livePrice * t.shares : t.investedAmount;
    const pl = curr - t.investedAmount;
    const plPct = t.investedAmount > 0 ? (pl / t.investedAmount * 100).toFixed(2) : 0;
    const cls = pl >= 0 ? "profit" : "loss";
    h += '<div class="res-sug-row-item" data-symbol="' + t.symbol + '">' +
      '<span class="res-sug-symbol">' + t.symbol + '</span>' +
      '<span class="res-sug-detail"><span class="res-k">Invested</span> ' + _fmt(t.investedAmount) + '</span>' +
      '<span class="res-sug-detail"><span class="res-k">Current</span> <span class="' + cls + '">' + _fmt(curr) + '</span></span>' +
      '<span class="res-sug-detail"><span class="res-k">P/L</span> <span class="' + cls + '">' + (pl >= 0 ? "+" : "") + _fmt(pl) + '</span></span>' +
      '<span class="res-sug-pl ' + cls + '">' + (pl >= 0 ? "+" : "") + plPct + '%</span></div>';
  });
  h += '</div>';
  el.innerHTML = h;
  el.querySelectorAll(".res-sug-row-item").forEach((card) => {
    card.addEventListener("click", () => { document.getElementById("researchSymbol").value = card.dataset.symbol; _analyze(card.dataset.symbol); });
  });

  // Show analysis history
  const history = JSON.parse(localStorage.getItem("resAnalysisHistory_" + _currentFund) || "[]");
  if (history.length > 0) {
    let hh = '<div class="res-empty-text" style="margin-top:16px">Recently Analyzed</div><div class="res-suggestions">';
    history.forEach((entry) => {
      const date = new Date(entry.date);
      const ago = _timeAgoShort(date);
      const sigCls = entry.signal.includes("BUY") ? "profit" : entry.signal.includes("SELL") ? "loss" : "";
      hh += '<div class="res-sug-row-item" data-symbol="' + entry.symbol + '">' +
        '<span class="res-sug-symbol">' + entry.symbol + '</span>' +
        '<span class="res-sug-detail"><span class="res-k">Price</span> ' + _fmt(entry.price) + '</span>' +
        '<span class="res-sug-detail"><span class="res-k">Signal</span> <span class="' + sigCls + '">' + entry.signal + '</span></span>' +
        '<span class="res-sug-pl" style="color:var(--text-3)">' + ago + '</span></div>';
    });
    hh += '</div>';
    el.insertAdjacentHTML("beforeend", hh);
    el.querySelectorAll(".res-suggestions:last-child .res-sug-row-item").forEach((card) => {
      card.addEventListener("click", () => { document.getElementById("researchSymbol").value = card.dataset.symbol; _analyze(card.dataset.symbol); });
    });
  }

  // Show track record
  _renderTrackRecord(el);
}

function _timeAgoShort(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.floor(hrs / 24);
  return days + "d ago";
}

// ─── Main Analysis ────────────────────────────────────────────────────────────
async function _analyze(symbol) {
  if (!symbol) return;
  symbol = symbol.toUpperCase().replace(/\.NS$|\.BO$/, "");
  const results   = document.getElementById("researchResults");
  const container = document.querySelector(".research-container");
  container.classList.remove("has-results");
  results.innerHTML = '<div class="res-loading"><div class="res-spinner"></div>Analyzing ' + symbol + '...</div>';
  try {
    const current    = await _fetchCurrent(symbol);
    const historical = await _fetchHistorical(symbol);
    const technicals = historical ? _calcTechnicals(historical, current.regularMarketPrice) : null;
    const patternData = historical ? {
      patterns: detectCandlePatterns(historical),
      setup:    detectSwingSetup(historical, technicals),
      rsiZone:  detectRsiZone(technicals?.rsi14),
    } : null;
    _render(symbol, current, historical, technicals, patternData);
  } catch {
    container.classList.remove("has-results");
    results.innerHTML = '<div class="res-error">Could not find data for <strong>' + symbol + '</strong>. Check the symbol and try again.</div>';
    _renderSuggestions();
  }
}

// ─── Data Fetching ────────────────────────────────────────────────────────────
async function _fetchCurrent(symbol) {
  for (const suffix of ["NS", "BO"]) {
    try {
      const res = await fetch(WORKER_URL + "?symbol=" + encodeURIComponent(symbol + "." + suffix));
      if (!res.ok) continue;
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) return { ...meta, exchange: suffix };
    } catch { /* next */ }
  }
  throw new Error("Not found");
}

async function _fetchHistorical(symbol) {
  for (const suffix of ["NS", "BO"]) {
    try {
      const res = await fetch(WORKER_URL + "?symbol=" + encodeURIComponent(symbol + "." + suffix) + "&range=1y&interval=1d");
      if (!res.ok) continue;
      const data = await res.json();
      const r = data?.chart?.result?.[0], q = r?.indicators?.quote?.[0];
      if (r?.timestamp && q) return { timestamps: r.timestamp, close: q.close, high: q.high, low: q.low, open: q.open, volume: q.volume };
    } catch { /* next */ }
  }
  return null;
}

// ─── Technical Calculations ───────────────────────────────────────────────────
function _calcTechnicals(data, currentPrice) {
  const closes = data.close.filter(c => c != null), volumes = data.volume.filter(v => v != null);
  const highs = data.high.filter(h => h != null), lows = data.low.filter(l => l != null);
  const dm = []; for (let i = 1; i < closes.length; i++) dm.push(Math.abs((closes[i] - closes[i - 1]) / closes[i - 1] * 100));
  const avgDailyMove = dm.length > 0 ? dm.reduce((s, v) => s + v, 0) / dm.length : 1;
  return { rsi14: _rsi(closes, 14), macd: _macd(closes), sma20: _sma(closes, 20), sma50: _sma(closes, 50), sma200: _sma(closes, 200),
    ema20: _ema(closes, 20), avgVolume: volumes.length >= 20 ? volumes.slice(-20).reduce((s, v) => s + v, 0) / 20 : null,
    latestVolume: volumes[volumes.length - 1], momentum: _momentum(closes), support: _support(lows), resistance: _resistance(highs), currentPrice, avgDailyMove };
}
function _rsi(p, n) { if (p.length < n + 1) return null; let g = 0, l = 0; for (let i = p.length - n; i < p.length; i++) { const d = p[i] - p[i - 1]; if (d > 0) g += d; else l -= d; } if (l === 0) return 100; return parseFloat((100 - 100 / (1 + g / n / (l / n))).toFixed(2)); }
function _macd(p) { if (p.length < 26) return null; const a = _ema(p, 12), b = _ema(p, 26); if (!a || !b) return null; const v = a - b; return { value: parseFloat(v.toFixed(2)), signal: v > 0 ? "Bullish" : "Bearish" }; }
function _sma(p, n) { if (p.length < n) return null; return parseFloat((p.slice(-n).reduce((s, v) => s + v, 0) / n).toFixed(2)); }
function _ema(p, n) { if (p.length < n) return null; const k = 2 / (n + 1); let e = p.slice(0, n).reduce((s, v) => s + v, 0) / n; for (let i = n; i < p.length; i++) e = (p[i] - e) * k + e; return parseFloat(e.toFixed(2)); }
function _momentum(p) { if (p.length < 21) return null; const c = p[p.length - 1]; return { d10: parseFloat(((c - p[p.length - 11]) / p[p.length - 11] * 100).toFixed(2)), d20: parseFloat(((c - p[p.length - 21]) / p[p.length - 21] * 100).toFixed(2)) }; }
function _support(l) { return l.length < 20 ? null : parseFloat(Math.min(...l.slice(-20)).toFixed(2)); }
function _resistance(h) { return h.length < 20 ? null : parseFloat(Math.max(...h.slice(-20)).toFixed(2)); }

// ─── Formatters ───────────────────────────────────────────────────────────────
function _fmt(n) { return n == null ? "–" : "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function _fmtVol(n) { if (!n) return "–"; if (n >= 1e7) return (n / 1e7).toFixed(2) + " Cr"; if (n >= 1e5) return (n / 1e5).toFixed(2) + " L"; return n.toLocaleString("en-IN"); }
function _fmtShort(n) { if (n >= 100000) return "₹" + (n / 100000).toFixed(n % 100000 === 0 ? 0 : 1) + "L"; return "₹" + n.toLocaleString("en-IN"); }

// ─── Render ───────────────────────────────────────────────────────────────────
function _render(symbol, current, hist, tech, pd) {
  const el = document.getElementById("researchResults");
  document.querySelector(".research-container").classList.add("has-results");

  const price = current.regularMarketPrice, prev = current.chartPreviousClose || current.previousClose;
  const chg = price - prev, chgP = ((chg / prev) * 100).toFixed(2), cls = chg >= 0 ? "profit" : "loss", sign = chg >= 0 ? "+" : "";
  const w52L = current.fiftyTwoWeekLow, w52H = current.fiftyTwoWeekHigh;
  const w52P = w52H && w52L ? Math.round(((price - w52L) / (w52H - w52L)) * 100) : 0;

  // Signal
  let bull = 0, total = 0, sigText = "–", sigCls = "neutral", sigDesc = "";
  if (tech) {
    const r = tech.rsi14, a50 = tech.sma50 && price > tech.sma50, a200 = tech.sma200 && price > tech.sma200, aE = tech.ema20 && price > tech.ema20;
    if (r != null) { total++; if (r > 50) bull++; } if (tech.macd) { total++; if (tech.macd.signal === "Bullish") bull++; }
    if (tech.sma50) { total++; if (a50) bull++; } if (tech.sma200) { total++; if (a200) bull++; }
    if (tech.ema20) { total++; if (aE) bull++; } if (tech.momentum) { total++; if (tech.momentum.d10 > 0) bull++; }
    if (bull >= 5) { sigText = "STRONG BUY"; sigCls = "profit"; sigDesc = "Strong upward momentum."; }
    else if (bull >= 4) { sigText = "BUY"; sigCls = "profit"; sigDesc = "Favourable for entry."; }
    else if (bull >= 3) { sigText = "NEUTRAL"; sigCls = "neutral"; sigDesc = "Mixed signals."; }
    else if (bull >= 2) { sigText = "SELL"; sigCls = "loss"; sigDesc = "Weak conditions."; }
    else { sigText = "STRONG SELL"; sigCls = "loss"; sigDesc = "All indicators down."; }
  }

  // Portfolio context
  const inP = _trades.filter(t => t.symbol === symbol && t.status === "open");
  const tInv = inP.reduce((s, t) => s + t.investedAmount, 0);
  const tCur = inP.reduce((s, t) => s + (t.livePrice ? t.livePrice * t.shares : t.investedAmount), 0);

  let h = "";

  // ── Top bar ──
  h += '<div class="res-top-bar">';
  h += '<div class="res-top-search"><input type="text" id="resSymInline" value="' + symbol + '" spellcheck="false"/><button id="resBtnInline" class="btn-primary res-btn-sm">Analyze</button></div>';
  h += '<div class="res-top-right">';
  h += '<div class="res-top-info"><span class="res-symbol">' + symbol + '</span><span class="res-exchange">' + (current.exchange === "NS" ? "NSE" : "BSE") + '</span><span class="res-price">' + _fmt(price) + '</span><span class="res-day-chg ' + cls + '">' + sign + chgP + '%</span>';
  if (tInv > 0) {
    const tPL = tCur - tInv, tPLpct = (tPL / tInv * 100).toFixed(2), tCls = tPL >= 0 ? "profit" : "loss";
    h += '<span class="res-top-divider">|</span><span class="res-top-port"><span class="res-k">Inv</span> ' + _fmt(tInv) + '</span><span class="res-top-port"><span class="res-k">Cur</span> <span class="' + tCls + '">' + _fmt(tCur) + '</span></span><span class="res-top-port"><span class="res-k">P/L</span> <span class="' + tCls + '">' + (tPL >= 0 ? "+" : "") + _fmt(tPL) + ' (' + (tPL >= 0 ? "+" : "") + tPLpct + '%)</span></span>';
  }
  h += '</div>';
  h += '<div class="res-top-signal ' + sigCls + '"><span class="res-top-sig-text">' + sigText + '</span><span class="res-top-sig-sub">' + bull + '/' + total + ' bullish</span></div>';
  h += '</div></div>';

  // ── Gridstack Dashboard ──
  h += '<div class="grid-stack" id="resGridStack">';

  // AI Analysis
  h += _gsItem(12, 36, '<div class="res-ai-section"><div class="res-ai-header"><div class="res-block-title">AI Analysis</div><span class="res-ai-status" id="resAiStatus">analyzing...</span></div><div class="res-ai-body" id="resAiBody"><div class="res-ai-loading"><div class="res-spinner"></div>Tara is analyzing ' + symbol + '...</div></div></div>');

  // Pattern Detection
  if (pd) {
    const pillsHtml = pd.patterns.length > 0
      ? pd.patterns.map(p => {
          const cls = BULLISH_PATTERNS.has(p) ? "profit" : BEARISH_PATTERNS.has(p) ? "loss" : "neutral";
          return '<span class="res-pattern-pill ' + cls + '">' + (PATTERN_LABELS[p] || p) + '</span>';
        }).join("")
      : '<span class="res-pattern-none">No pattern detected today</span>';

    const setupHtml = pd.setup
      ? '<span class="res-k">Setup</span><span class="res-pattern-setup profit">' + (SETUP_LABELS[pd.setup] || pd.setup) + '</span>'
      : '<span class="res-k">Setup</span><span style="color:var(--text-3)">None</span>';

    const rsiCls  = pd.rsiZone === "oversold" || pd.rsiZone === "pullback_zone" ? "profit" : pd.rsiZone === "overbought" ? "loss" : "";
    const rsiHtml = '<span class="res-k">RSI Zone</span><span class="' + rsiCls + '">' + (RSI_ZONE_LABELS[pd.rsiZone] || pd.rsiZone) + '</span>';

    h += _gsItem(12, 20,
      '<div class="res-block res-pattern-block">' +
        '<div class="res-block-title">Pattern Detection</div>' +
        '<div class="res-pattern-pills">' + pillsHtml + '</div>' +
        '<div class="res-pattern-meta">' + setupHtml + '</div>' +
        '<div class="res-pattern-meta">' + rsiHtml + '</div>' +
      '</div>'
    );
  }

  // Simulator
  const amounts = [25000, 50000, 75000, 100000, 150000, 200000];
  const pcts = [-15, -10, -5, -3, 3, 5, 10, 15, 20];
  const avgM = tech?.avgDailyMove || 1;
  let simH = '<div class="res-sim-section"><div class="res-block-title">Investment Simulator</div><div class="res-sim-wrap"><table class="res-sim-table"><thead><tr><th class="res-sim-corner">Invest ↓ / Return →</th>';
  pcts.forEach(p => simH += '<th class="' + (p >= 0 ? "sim-profit" : "sim-loss") + '">' + (p >= 0 ? "+" : "") + p + '%</th>');
  simH += '</tr></thead><tbody>';
  amounts.forEach(amt => {
    simH += '<tr><td class="res-sim-amt">' + _fmtShort(amt) + '</td>';
    pcts.forEach(p => {
      const val = Math.round(amt * (1 + p / 100)), diff = val - amt;
      const intensity = Math.min(Math.abs(p) / 20, 1);
      const bg = p >= 0 ? 'rgba(40,200,128,' + (0.06 + intensity * 0.32) + ')' : 'rgba(220,53,69,' + (0.06 + intensity * 0.32) + ')';
      simH += '<td style="background:' + bg + '"><span class="sim-val">' + _fmtShort(val) + '</span><span class="sim-diff" style="color:' + (p >= 0 ? 'var(--profit)' : 'var(--loss)') + '">' + (diff >= 0 ? "+" : "") + _fmtShort(diff) + '</span></td>';
    });
    simH += '</tr>';
  });
  simH += '<tr class="res-sim-time"><td>Est. time</td>';
  pcts.forEach(p => simH += '<td>~' + (Math.abs(p) / avgM / 5).toFixed(1) + 'w</td>');
  simH += '</tr></tbody></table></div></div>';
  h += _gsItem(7, 54, simH);

  // News
  h += _gsItem(5, 54, '<div class="res-news-section"><div class="res-block-title">Latest News</div><div class="res-news-list" id="resNewsList"></div></div>');

  h += _gsItem(4, 24, _block("Price Overview", '<div class="res-block-grid">' + _kv("Prev Close", _fmt(prev)) + _kv("Day Low", _fmt(current.regularMarketDayLow)) + _kv("Day High", _fmt(current.regularMarketDayHigh)) + '</div>'));
  h += _gsItem(4, 24, _block("52-Week Range", '<div class="res-range-bar"><div class="res-range-fill" style="width:' + w52P + '%"></div><div class="res-range-dot" style="left:' + w52P + '%"></div></div><div class="res-range-labels"><span>' + _fmt(w52L) + '</span><span class="res-range-pct">' + w52P + '% from low</span><span>' + _fmt(w52H) + '</span></div>'));

  if (tech) {
    const rsi = tech.rsi14, rsiL = rsi > 70 ? "Overbought" : rsi > 60 ? "Bullish" : rsi > 40 ? "Neutral" : rsi > 30 ? "Bearish" : "Oversold";
    const rsiC = rsi > 60 ? "profit" : rsi < 40 ? "loss" : "neutral";
    const rsiD = rsi > 70 ? "Overbought. May pull back." : rsi > 60 ? "Healthy momentum. Good for swing." : rsi > 40 ? "Neutral. Wait for signal." : rsi > 30 ? "Weak. Be cautious." : "Oversold. Watch for bounce.";
    h += _gsItem(4, 36, _block("RSI (14)", '<div class="res-block-big ' + rsiC + '">' + rsi + '</div><div class="res-block-badge ' + rsiC + '">' + rsiL + '</div><div class="res-gauge"><div class="res-gauge-fill ' + rsiC + '" style="width:' + rsi + '%"></div></div><div class="res-gauge-labels"><span>0</span><span>30</span><span>50</span><span>70</span><span>100</span></div>', rsiD));

    const mC = tech.macd?.signal === "Bullish" ? "profit" : "loss";
    h += _gsItem(4, 36, _block("MACD", '<div class="res-block-big ' + mC + '">' + (tech.macd?.value ?? "–") + '</div><div class="res-block-badge ' + mC + '">' + (tech.macd?.signal ?? "–") + '</div>', tech.macd?.signal === "Bullish" ? "Momentum accelerating upward." : "Momentum weakening."));

    const vR = tech.avgVolume > 0 ? tech.latestVolume / tech.avgVolume : 0, vL = vR > 1.5 ? "High" : vR > 0.7 ? "Normal" : "Low", vC = vR > 1.5 ? "profit" : vR < 0.7 ? "loss" : "neutral";
    h += _gsItem(4, 36, _block("Volume", '<div class="res-vol-row"><div class="res-vol-item"><span class="res-k">Today</span><span class="res-v">' + _fmtVol(tech.latestVolume) + '</span></div><div class="res-vol-item"><span class="res-k">Avg 20d</span><span class="res-v">' + _fmtVol(tech.avgVolume) + '</span></div><div class="res-vol-item"><span class="res-k">Ratio</span><span class="res-v ' + vC + '">' + vR.toFixed(1) + 'x ' + vL + '</span></div></div>', vR > 1.5 ? "High volume confirms the move." : vR > 0.7 ? "Normal activity." : "Low volume. Move may not sustain."));

    h += _gsItem(4, 36, _block("Moving Averages", '<div class="res-ma-list">' + _maRow("20 EMA", tech.ema20, price, "Short-term") + _maRow("50 DMA", tech.sma50, price, "Medium-term") + _maRow("200 DMA", tech.sma200, price, "Long-term") + '</div>'));

    if (tech.momentum) {
      const m1C = tech.momentum.d10 >= 0 ? "profit" : "loss", m2C = tech.momentum.d20 >= 0 ? "profit" : "loss";
      h += _gsItem(4, 24, _block("Momentum", '<div class="res-mom-row"><div class="res-mom-item ' + m1C + '"><span class="res-mom-period">10-Day</span><span class="res-mom-val">' + (tech.momentum.d10 >= 0 ? "+" : "") + tech.momentum.d10 + '%</span></div><div class="res-mom-item ' + m2C + '"><span class="res-mom-period">20-Day</span><span class="res-mom-val">' + (tech.momentum.d20 >= 0 ? "+" : "") + tech.momentum.d20 + '%</span></div></div>', tech.momentum.d10 > 3 ? "Strong momentum. Trending well." : tech.momentum.d10 > 0 ? "Positive but moderate." : "Weak or negative momentum."));
    }

    const sD = ((price - tech.support) / price * 100).toFixed(1), rD = ((tech.resistance - price) / price * 100).toFixed(1);
    h += _gsItem(4, 36, _block("Support & Resistance", '<div class="res-sr-visual"><div class="res-sr-level res-sr-resistance"><span class="res-k">Resistance</span><span class="res-v">' + _fmt(tech.resistance) + '</span><span class="res-sr-dist loss">' + rD + '% away</span></div><div class="res-sr-level res-sr-current"><span class="res-k">Current</span><span class="res-v">' + _fmt(price) + '</span></div><div class="res-sr-level res-sr-support"><span class="res-k">Support</span><span class="res-v">' + _fmt(tech.support) + '</span><span class="res-sr-dist profit">' + sD + '% above</span></div></div>'));
  }

  h += '</div>'; // close grid-stack
  el.innerHTML = h;

  // Init gridstack
  if (typeof GridStack !== "undefined") {
    const grid = GridStack.init({ column: 12, cellHeight: 5, margin: 0, float: true, animate: true, resizable: { handles: "se,sw,ne,nw" } }, "#resGridStack");

    // Restore saved layout
    const saved = localStorage.getItem("resGridLayout_" + _currentFund);
    if (saved) {
      try {
        const layout = JSON.parse(saved);
        grid.getGridItems().forEach((el, i) => {
          if (layout[i]) grid.update(el, layout[i]);
        });
      } catch { /* ignore bad data */ }
    }

    // Save layout on any change
    grid.on("change", () => {
      const layout = grid.getGridItems().map(el => ({
        x: parseInt(el.getAttribute("gs-x")),
        y: parseInt(el.getAttribute("gs-y")),
        w: parseInt(el.getAttribute("gs-w")),
        h: parseInt(el.getAttribute("gs-h")),
      }));
      localStorage.setItem("resGridLayout_" + _currentFund, JSON.stringify(layout));
    });

    // Add corner curve indicators
    document.querySelectorAll("#resGridStack .grid-stack-item-content").forEach((el) => {
      ["corner-se","corner-sw","corner-ne","corner-nw"].forEach((c) => {
        const d = document.createElement("div");
        d.className = "gs-corner " + c;
        el.appendChild(d);
      });
    });
  }

  // Wire up inline search
  const inBtn = document.getElementById("resBtnInline"), inInp = document.getElementById("resSymInline");
  if (inBtn) inBtn.addEventListener("click", () => _analyze(inInp.value.trim()));
  if (inInp) inInp.addEventListener("keydown", e => { if (e.key === "Enter") _analyze(inInp.value.trim()); });

  // Render news links
  const newsEl = document.getElementById("resNewsList");
  if (newsEl) newsEl.innerHTML = _newsLinks(symbol);

  // Save analysis to history
  _saveAnalysisHistory(symbol, current, tech);

  // Auto-run AI analysis
  _askAI(symbol, current, tech, pd);
}

// ─── AI Analysis ──────────────────────────────────────────────────────────────
async function _askAI(symbol, current, tech, pd) {
  const body = document.getElementById("resAiBody"), status = document.getElementById("resAiStatus");
  if (!body) return;
  if (status) status.textContent = "analyzing...";
  body.innerHTML = '<div class="res-ai-loading"><div class="res-spinner"></div>Tara is analyzing ' + symbol + '...</div>';
  const price = current.regularMarketPrice, prev = current.chartPreviousClose || current.previousClose;
  const chgP = ((price - prev) / prev * 100).toFixed(2);
  let d = symbol + " on NSE\nPrice: ₹" + price + " (" + (chgP >= 0 ? "+" : "") + chgP + "%)\n52W: ₹" + current.fiftyTwoWeekLow + " - ₹" + current.fiftyTwoWeekHigh + "\nVol: " + current.regularMarketVolume + "\n";
  if (tech) d += "RSI: " + tech.rsi14 + "\nMACD: " + (tech.macd?.value ?? "-") + " (" + (tech.macd?.signal ?? "-") + ")\n20EMA: ₹" + tech.ema20 + " (" + (price > tech.ema20 ? "above" : "below") + ")\n50DMA: ₹" + tech.sma50 + "\n200DMA: ₹" + tech.sma200 + "\nSupport: ₹" + tech.support + " Resistance: ₹" + tech.resistance + "\n10d Mom: " + (tech.momentum?.d10 ?? "-") + "%\n20d Mom: " + (tech.momentum?.d20 ?? "-") + "%\n";
  if (pd) {
    if (pd.patterns.length > 0) d += "Candlestick patterns: " + pd.patterns.map(p => PATTERN_LABELS[p] || p).join(", ") + "\n";
    if (pd.setup)                d += "Swing setup: " + (SETUP_LABELS[pd.setup] || pd.setup) + "\n";
    if (pd.rsiZone !== "neutral") d += "RSI zone: " + (RSI_ZONE_LABELS[pd.rsiZone] || pd.rsiZone) + "\n";
  }
  const inP = _trades.filter(t => t.symbol === symbol && t.status === "open");
  if (inP.length > 0) { const ti = inP.reduce((s, t) => s + t.investedAmount, 0), tc = inP.reduce((s, t) => s + (t.livePrice ? t.livePrice * t.shares : t.investedAmount), 0); d += "\nHOLDING: Inv ₹" + ti.toFixed(0) + " Cur ₹" + tc.toFixed(0) + " P/L " + ((tc - ti) / ti * 100).toFixed(1) + "%\n"; }
  const prompt = d + "\nYou are advising a trader who primarily does swing trades but may hold longer if the setup is strong. Respond in EXACTLY this structured format — no intro, no disclaimer, no extra text:\n\nVERDICT: [BUY / HOLD / AVOID] — [one line reason]\nTIMING: [Buy now / Wait for dip to ₹X / Wait for breakout above ₹X] — [why this timing]\nENTRY: ₹[low] – ₹[high]\nSTOP LOSS: ₹[price] ([X]% from entry)\nTARGET 1: ₹[price] ([X]% upside) in [timeframe]\nTARGET 2: ₹[price] ([X]% upside) if held longer\nRISK: [Low/Medium/High] — [one line why]\nCONFIDENCE: [Low/Medium/High]\n\nKEY FACTORS:\n- [factor 1]\n- [factor 2]\n- [factor 3]";
  try {
    const res = await fetch(WORKER_URL + "?type=ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) });
    const data = await res.json();
    if (data.analysis) {
      body.innerHTML = '<div class="res-ai-result">' + _formatAI(data.analysis) + '</div>';
      _saveRecommendation(symbol, current.regularMarketPrice, data.analysis);
    }
    else body.innerHTML = '<div class="res-ai-error">Analysis failed.</div>';
  } catch { body.innerHTML = '<div class="res-ai-error">AI unavailable.</div>'; }
  if (status) status.textContent = "updated " + new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

function _formatAI(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/^(VERDICT|TIMING|ENTRY|STOP LOSS|TARGET 1|TARGET 2|TARGET|RISK|CONFIDENCE|KEY FACTORS):?\s*/gm, '<span class="ai-label">$1</span> ')
    .replace(/(BUY|STRONG BUY)/g, '<span class="ai-tag profit">$1</span>')
    .replace(/(SELL|STRONG SELL|AVOID|EXIT)/g, '<span class="ai-tag loss">$1</span>')
    .replace(/(HOLD|NEUTRAL)/g, '<span class="ai-tag neutral">$1</span>')
    .replace(/\n- /g, '\n<span class="ai-bullet">•</span> ')
    .replace(/\n/g, '<br>');
}

// ─── News Links ───────────────────────────────────────────────────────────────
function _newsLinks(symbol) {
  const q = encodeURIComponent(symbol + " NSE share price");
  const links = [
    { icon: "📰", name: "Google News", desc: "Latest news", url: "https://news.google.com/search?q=" + q + "&hl=en-IN&gl=IN" },
    { icon: "📊", name: "TradingView", desc: "Charts & ideas", url: "https://www.tradingview.com/symbols/NSE-" + symbol + "/" },
    { icon: "💹", name: "Screener.in", desc: "Financials & ratios", url: "https://www.screener.in/company/" + symbol + "/" },
    { icon: "🏦", name: "MoneyControl", desc: "Fundamentals", url: "https://www.moneycontrol.com/india/stockpricequote/" + symbol.toLowerCase() },
    { icon: "📋", name: "Economic Times", desc: "Business news", url: "https://economictimes.indiatimes.com/topic/" + symbol },
  ];
  return links.map(l => '<a class="res-news-item" href="' + l.url + '" target="_blank" rel="noopener"><div class="res-news-icon">' + l.icon + '</div><div class="res-news-body"><div class="res-news-headline">' + l.name + ' — ' + symbol + '</div><div class="res-news-meta"><span class="res-news-source">' + l.desc + '</span></div></div><span class="res-news-arrow">→</span></a>').join("");
}

// ─── Recommendation Track Record ──────────────────────────────────────────────
function _saveRecommendation(symbol, price, analysis) {
  const recs = JSON.parse(localStorage.getItem("taraRecs_" + _currentFund) || "[]");
  const verdict = _extractVerdict(analysis);
  const entry = {
    symbol,
    date: new Date().toISOString(),
    priceAt: price,
    verdict,
  };
  // Keep only the latest per symbol (overwrite previous)
  const filtered = recs.filter(r => r.symbol !== symbol);
  filtered.unshift(entry);
  localStorage.setItem("taraRecs_" + _currentFund, JSON.stringify(filtered.slice(0, 50)));
}

function _extractVerdict(analysis) {
  const t = analysis.toUpperCase();
  if (t.includes("STRONG BUY")) return "STRONG BUY";
  if (t.includes("BUY")) return "BUY";
  if (t.includes("STRONG SELL")) return "STRONG SELL";
  if (t.includes("SELL") || t.includes("AVOID") || t.includes("EXIT")) return "AVOID";
  if (t.includes("HOLD")) return "HOLD";
  return "NEUTRAL";
}

function _renderTrackRecord(el) {
  const recs = JSON.parse(localStorage.getItem("taraRecs_" + _currentFund) || "[]");
  if (recs.length === 0) return;

  let h = '<div class="res-empty-text" style="margin-top:16px">Tara\'s Track Record</div>';
  h += '<div class="track-record-section">';

  // Stats
  const withPrice = recs.filter(r => r.currentPrice != null);
  let correct = 0, total = withPrice.length;
  withPrice.forEach(r => {
    const moved = r.currentPrice - r.priceAt;
    if ((r.verdict.includes("BUY") && moved > 0) || (r.verdict === "AVOID" && moved < 0) || r.verdict === "HOLD") correct++;
  });

  if (total > 0) {
    const accuracy = Math.round((correct / total) * 100);
    const accCls = accuracy >= 60 ? "profit" : accuracy >= 40 ? "" : "loss";
    h += '<div class="track-stats">' +
      '<div class="track-stat"><span class="track-stat-val">' + recs.length + '</span><span class="track-stat-label">Analyses</span></div>' +
      '<div class="track-stat"><span class="track-stat-val ' + accCls + '">' + accuracy + '%</span><span class="track-stat-label">Accuracy</span></div>' +
      '<div class="track-stat"><span class="track-stat-val">' + total + '</span><span class="track-stat-label">Tracked</span></div>' +
    '</div>';
  }

  h += '<div class="track-list">';
  recs.slice(0, 15).forEach(r => {
    const date = new Date(r.date);
    const ago = _timeAgoShort(date);
    const vCls = r.verdict.includes("BUY") ? "profit" : r.verdict === "AVOID" ? "loss" : "";
    const change = r.currentPrice != null ? ((r.currentPrice - r.priceAt) / r.priceAt * 100).toFixed(1) : null;
    const changeCls = change != null ? (parseFloat(change) >= 0 ? "profit" : "loss") : "";
    const changeStr = change != null ? (parseFloat(change) >= 0 ? "+" : "") + change + "%" : "...";

    h += '<div class="track-row" data-symbol="' + r.symbol + '">' +
      '<span class="track-symbol">' + r.symbol + '</span>' +
      '<span class="track-verdict ' + vCls + '">' + r.verdict + '</span>' +
      '<span class="track-price">₹' + r.priceAt.toFixed(0) + '</span>' +
      '<span class="track-change ' + changeCls + '">' + changeStr + '</span>' +
      '<span class="track-ago">' + ago + '</span>' +
    '</div>';
  });
  h += '</div></div>';

  el.insertAdjacentHTML("beforeend", h);

  // Click to re-analyze
  el.querySelectorAll(".track-row").forEach(row => {
    row.addEventListener("click", () => {
      document.getElementById("researchSymbol").value = row.dataset.symbol;
      _analyze(row.dataset.symbol);
    });
  });

  // Fetch current prices for past recommendations (background)
  _updateTrackPrices();
}

async function _updateTrackPrices() {
  const recs = JSON.parse(localStorage.getItem("taraRecs_" + _currentFund) || "[]");
  let updated = false;

  for (const r of recs) {
    // Only update if older than 1 hour or no price yet
    if (r.currentPrice != null && Date.now() - new Date(r.lastChecked || 0).getTime() < 3600000) continue;
    try {
      const res = await fetch(WORKER_URL + "?symbol=" + encodeURIComponent(r.symbol + ".NS"));
      if (!res.ok) continue;
      const data = await res.json();
      const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price) {
        r.currentPrice = price;
        r.lastChecked = new Date().toISOString();
        updated = true;
      }
    } catch { /* skip */ }
  }

  if (updated) {
    localStorage.setItem("taraRecs_" + _currentFund, JSON.stringify(recs));
    // Re-render track record if visible
    const el = document.querySelector(".track-record-section");
    if (el) {
      const parent = el.parentElement;
      el.previousElementSibling?.remove(); // remove header
      el.remove();
      _renderTrackRecord(parent);
    }
  }
}

// ─── Analysis History ─────────────────────────────────────────────────────────
function _saveAnalysisHistory(symbol, current, tech) {
  const history = JSON.parse(localStorage.getItem("resAnalysisHistory_" + _currentFund) || "[]");
  const entry = {
    symbol,
    date: new Date().toISOString(),
    price: current.regularMarketPrice,
    rsi: tech?.rsi14 || null,
    signal: _getSignalText(tech, current.regularMarketPrice),
  };
  // Remove old entries for the same symbol (keep latest)
  const filtered = history.filter(h => h.symbol !== symbol);
  filtered.unshift(entry);
  // Keep max 20 entries
  localStorage.setItem("resAnalysisHistory_" + _currentFund, JSON.stringify(filtered.slice(0, 20)));
}

function _getSignalText(tech, price) {
  if (!tech) return "–";
  let bull = 0, total = 0;
  if (tech.rsi14 != null) { total++; if (tech.rsi14 > 50) bull++; }
  if (tech.macd) { total++; if (tech.macd.signal === "Bullish") bull++; }
  if (tech.sma50 && price > tech.sma50) { total++; bull++; } else if (tech.sma50) total++;
  if (tech.sma200 && price > tech.sma200) { total++; bull++; } else if (tech.sma200) total++;
  if (tech.ema20 && price > tech.ema20) { total++; bull++; } else if (tech.ema20) total++;
  if (tech.momentum) { total++; if (tech.momentum.d10 > 0) bull++; }
  if (bull >= 5) return "STRONG BUY";
  if (bull >= 4) return "BUY";
  if (bull >= 3) return "NEUTRAL";
  if (bull >= 2) return "SELL";
  return "STRONG SELL";
}

// ─── Watchlist ────────────────────────────────────────────────────────────────
let _wlEventsReady = false;
function _bindWatchlistEvents() {
  if (_wlEventsReady) return;
  _wlEventsReady = true;
  document.getElementById("wlAddBtn")?.addEventListener("click", _addWlSymbol);
  document.getElementById("wlSymInput")?.addEventListener("keydown", e => {
    if (e.key === "Enter") _addWlSymbol();
  });
}

async function _loadWatchlist() {
  const el = document.getElementById("wlItemList");
  if (el) el.innerHTML = '<div class="wl-state">Loading...</div>';
  try {
    const snap = await getDocs(collection(db, WL_COL));
    _watchlist = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _watchlist.sort((a, b) => (b.addedDate || "").localeCompare(a.addedDate || ""));
    _renderWatchlist();
    _updateWlCount();
  } catch {
    if (el) el.innerHTML = '<div class="wl-state wl-error">Could not load watchlist.</div>';
  }
}

async function _addWlSymbol() {
  const symEl  = document.getElementById("wlSymInput");
  const noteEl = document.getElementById("wlNoteInput");
  const sym    = (symEl?.value.trim().toUpperCase() || "").replace(/\.NS$|\.BO$/, "");
  if (!sym) return;
  if (_watchlist.find(w => w.symbol === sym)) { _wlToast(sym + " already in watchlist"); return; }

  const btn = document.getElementById("wlAddBtn");
  if (btn) { btn.textContent = "Adding..."; btn.disabled = true; }
  try {
    const today = new Date().toISOString().slice(0, 10);
    const data  = { symbol: sym, notes: noteEl?.value.trim() || "", addedDate: today, active: true, createdAt: serverTimestamp() };
    const ref   = await addDoc(collection(db, WL_COL), data);
    _watchlist.unshift({ id: ref.id, ...data });
    if (symEl)  symEl.value  = "";
    if (noteEl) noteEl.value = "";
    _renderWatchlist();
    _updateWlCount();
    _wlToast(sym + " added to watchlist");
  } catch { _wlToast("Could not add symbol", true); }
  finally  { if (btn) { btn.textContent = "Add"; btn.disabled = false; } }
}

async function _removeWlSymbol(id) {
  try {
    await deleteDoc(doc(db, WL_COL, id));
    _watchlist = _watchlist.filter(w => w.id !== id);
    _renderWatchlist();
    _updateWlCount();
  } catch { _wlToast("Could not remove", true); }
}

function _renderWatchlist() {
  const el = document.getElementById("wlItemList");
  if (!el) return;
  if (_watchlist.length === 0) {
    el.innerHTML = '<div class="wl-state">No symbols yet — add one above to start tracking.</div>';
    return;
  }
  el.innerHTML = _watchlist.map(w => `
    <div class="wl-item">
      <div class="wl-item-left">
        <div class="wl-item-sym">${w.symbol}</div>
        ${w.notes ? `<div class="wl-item-note">${w.notes}</div>` : ""}
        <div class="wl-item-date">Added ${w.addedDate || "—"}</div>
      </div>
      <div class="wl-item-actions">
        <button class="wl-analyze-btn" data-symbol="${w.symbol}">Analyze</button>
        <button class="wl-remove-btn" data-id="${w.id}" title="Remove">✕</button>
      </div>
    </div>`).join("");

  el.querySelectorAll(".wl-analyze-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const inp = document.getElementById("researchSymbol");
      if (inp) inp.value = btn.dataset.symbol;
      _analyze(btn.dataset.symbol);
    });
  });

  el.querySelectorAll(".wl-remove-btn").forEach(btn => {
    btn.addEventListener("click", () => _removeWlSymbol(btn.dataset.id));
  });
}

function _updateWlCount() {
  const el = document.getElementById("wlCount");
  if (!el) return;
  if (_watchlist.length > 0) {
    el.textContent = _watchlist.length + " symbol" + (_watchlist.length !== 1 ? "s" : "");
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

function _wlToast(msg, isError = false) {
  let wrap = document.querySelector(".toast-wrap");
  if (!wrap) { wrap = document.createElement("div"); wrap.className = "toast-wrap"; document.body.appendChild(wrap); }
  const t = document.createElement("div");
  t.className   = "toast " + (isError ? "error" : "success");
  t.textContent = msg;
  wrap.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add("visible")));
  setTimeout(() => { t.classList.remove("visible"); setTimeout(() => t.remove(), 280); }, 2600);
}

// ─── Signals Panel ────────────────────────────────────────────────────────────

async function _loadSignals() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const q     = query(collection(db, SIG_COL), where("date", "==", today));
    const snap  = await getDocs(q);
    const sigs  = snap.docs.map(d => d.data());
    _renderSignals(sigs, today);
  } catch { /* signals unavailable — fail silently */ }
}

function _renderSignals(sigs, today) {
  const section  = document.getElementById("signalsSection");
  const list     = document.getElementById("signalsList");
  const dateEl   = document.getElementById("signalsDate");
  const badge    = document.getElementById("signalsBadge");
  if (!section || !list) return;

  const flagged = sigs.filter(s => s.patterns?.length > 0 || s.setup);

  // Update nav badge
  if (badge) {
    if (flagged.length > 0) {
      badge.textContent = flagged.length;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  if (sigs.length === 0) { section.classList.add("hidden"); return; }

  section.classList.remove("hidden");
  if (dateEl) dateEl.textContent = new Date(today).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

  if (flagged.length === 0) {
    list.innerHTML = '<div class="sig-empty">Scanned ' + sigs.length + ' symbol' + (sigs.length !== 1 ? "s" : "") + ' — no patterns detected today.</div>';
    return;
  }

  list.innerHTML = flagged.map(s => {
    const pillsHtml = (s.patterns || []).map(p => {
      const cls = BULLISH_PATTERNS.has(p) ? "profit" : BEARISH_PATTERNS.has(p) ? "loss" : "neutral";
      return '<span class="sig-pill ' + cls + '">' + (PATTERN_LABELS[p] || p) + '</span>';
    }).join("");

    const setupHtml = s.setup
      ? '<span class="sig-meta-tag profit">' + (s.setup === "breakout_volume" ? "Breakout + Vol" : "Trend Pullback") + '</span>'
      : "";

    const rsiCls = s.rsiZone === "oversold" || s.rsiZone === "pullback_zone" ? "profit"
                 : s.rsiZone === "overbought" ? "loss" : "";
    const rsiLabel = { overbought: "Overbought", oversold: "Oversold", pullback_zone: "Pullback Zone", neutral: "Neutral" }[s.rsiZone] || s.rsiZone;

    const analysisHtml = s.analysis
      ? '<div class="sig-analysis">' + s.analysis + '</div>'
      : "";

    return '<div class="sig-card">' +
      '<div class="sig-card-top">' +
        '<span class="sig-sym">' + s.symbol + '</span>' +
        '<span class="sig-price">' + _fmt(s.price) + '</span>' +
      '</div>' +
      '<div class="sig-pills">' + pillsHtml + setupHtml + '</div>' +
      '<div class="sig-meta-row">' +
        '<span class="sig-meta-item ' + rsiCls + '">RSI ' + (s.rsi || "—") + ' · ' + rsiLabel + '</span>' +
        (s.ema20 ? '<span class="sig-meta-item">EMA20 ' + _fmt(s.ema20) + '</span>' : '') +
      '</div>' +
      analysisHtml +
      '<button class="sig-analyze-btn" data-symbol="' + s.symbol + '">Full Analysis →</button>' +
    '</div>';
  }).join("");

  list.querySelectorAll(".sig-analyze-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const inp = document.getElementById("researchSymbol");
      if (inp) inp.value = btn.dataset.symbol;
      _analyze(btn.dataset.symbol);
    });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _gsItem(w, h, content) { return '<div class="grid-stack-item" gs-w="' + w + '" gs-h="' + h + '"><div class="grid-stack-item-content">' + content + '</div></div>'; }
function _block(title, content, desc) { return '<div class="res-block"><div class="res-block-title">' + title + '</div>' + content + (desc ? '<div class="res-block-desc">' + desc + '</div>' : '') + '</div>'; }
function _kv(k, v) { return '<div class="res-kv"><span class="res-k">' + k + '</span><span class="res-v">' + v + '</span></div>'; }
function _maRow(label, maVal, price, desc) { const above = maVal && price > maVal; const c = above ? "profit" : "loss"; const pct = maVal ? ((price - maVal) / maVal * 100).toFixed(1) : "–"; return '<div class="res-ma-row"><div class="res-ma-info"><span class="res-ma-label">' + label + '</span><span class="res-ma-desc">' + desc + '</span></div><span class="res-ma-val">' + (maVal ? _fmt(maVal) : "–") + '</span><span class="res-ma-signal ' + c + '">' + (above ? "▲ +" + pct + "%" : "▼ " + pct + "%") + '</span></div>'; }
