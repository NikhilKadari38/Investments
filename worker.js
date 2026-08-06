// ─── NK Trade Tracker — Cloudflare Worker v9 (AI Brain + Kite Auth + Scanner) ──
// Cron: 15 10 * * 1-5  →  3:45 PM IST (Mon–Fri, 15 min after NSE close)

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(_runScanner(env));
  },

  async fetch(request, env) {
    const url    = new URL(request.url);
    const symbol = url.searchParams.get("symbol");
    const type   = url.searchParams.get("type");

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: _cors() });
    }

    const nonSymbolTypes = ["news", "ai", "kite-callback", "kite-status"];
    if (!symbol && !nonSymbolTypes.includes(type)) {
      return _json({ error: "Missing symbol" }, 400);
    }

    try {

      // ── Kite Auth — callback from Kite login redirect ──────────────────────
      // Kite redirects here after the user logs in:
      //   ?type=kite-callback&request_token=XXX&action=login&status=success
      // We exchange the request_token for an access_token and store it in KV.
      if (type === "kite-callback") {
        const requestToken = url.searchParams.get("request_token");
        const status       = url.searchParams.get("status");

        if (status !== "success" || !requestToken) {
          return _html(_authPage("Login Cancelled", "Kite login was cancelled or failed. Try again.", false));
        }

        const apiKey    = env.KITE_API_KEY;
        const apiSecret = env.KITE_API_SECRET;
        if (!apiKey || !apiSecret) {
          return _html(_authPage("Config Error", "KITE_API_KEY or KITE_API_SECRET not set in Worker environment.", false));
        }

        const checksum = await _sha256(apiKey + requestToken + apiSecret);
        const kiteRes  = await fetch("https://api.kite.trade/session/token", {
          method: "POST",
          headers: {
            "X-Kite-Version": "3",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }),
        });

        const kiteData = await kiteRes.json();
        if (!kiteData.data?.access_token) {
          const msg = kiteData.message || kiteData.error_type || "Token exchange failed";
          return _html(_authPage("Exchange Failed", msg, false));
        }

        const payload = {
          token:    kiteData.data.access_token,
          userId:   kiteData.data.user_id || "",
          storedAt: new Date().toISOString(),
        };
        await env.KITE_KV.put("kite_access_token", JSON.stringify(payload));
        return _html(_authPage(
          "Authenticated",
          "Access token stored. Scanner is active for today, " + (payload.userId || "trader") + ". You can close this tab.",
          true
        ));
      }

      // ── Kite Status — check whether today's token is still live ───────────
      if (type === "kite-status") {
        if (!env.KITE_KV) return _json({ active: false, message: "KV not bound" }, 200);
        const raw = await env.KITE_KV.get("kite_access_token");
        if (!raw) return _json({ active: false, message: "No token stored" }, 200);
        const { token, userId, storedAt } = JSON.parse(raw);
        const ageMs    = Date.now() - new Date(storedAt).getTime();
        const ageHours = ageMs / 3_600_000;
        // Kite tokens expire around 6am next day — treat >20h as stale
        const active = ageHours < 20;
        return _json({ active, userId, storedAt, ageHours: parseFloat(ageHours.toFixed(1)) }, 200);
      }

      // ── AI Analysis ────────────────────────────────────────────────────────
      if (type === "ai") {
        const body = await request.json();
        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) return _json({ error: "API key not configured" }, 500);

        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            max_tokens: 1024,
            system: `You are an expert Indian stock market trading analyst. You analyze stocks primarily for swing trades but the trader may hold longer if the trade is working. Be direct, concise, and actionable. Include specific entry price ranges, stop loss, and target prices. Suggest the BEST TIME TO BUY — whether to enter now, wait for a dip to a specific level, or wait for a breakout above a specific resistance. Analyze momentum, volume confirmation, and trend strength to judge timing. Always mention risk level. Never give guarantees — frame as analysis, not advice. Keep your response under 400 words.`,
            messages: [{ role: "user", content: body.prompt }],
          }),
        });

        const data = await res.json();
        const text = data?.content?.[0]?.text || "Analysis unavailable.";
        return _json({ analysis: text }, 200);
      }

      // ── News (Google News RSS + Yahoo fallback) ────────────────────────────
      if (type === "news") {
        const query = url.searchParams.get("q") || symbol || "";
        const gUrl  = "https://news.google.com/rss/search?q=" +
          encodeURIComponent(query) + "&hl=en-IN&gl=IN&ceid=IN:en";
        const gRes = await fetch(gUrl, {
          headers: {
            "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept":          "application/rss+xml, application/xml, text/xml, */*",
            "Accept-Language": "en-IN,en;q=0.9",
          },
          redirect: "follow",
        });
        const xml      = await gRes.text();
        const articles = parseRSS(xml);
        if (articles.length > 0) return _json({ articles, source: "google" }, 200);

        const yUrl  = "https://query1.finance.yahoo.com/v1/finance/search?q=" +
          encodeURIComponent(query) + "&newsCount=8&quotesCount=0";
        const yRes  = await fetch(yUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        const yData = await yRes.json();
        const yNews = (yData.news || []).map(n => ({
          title:   n.title   || "",
          link:    n.link    || "",
          pubDate: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toUTCString() : "",
          source:  n.publisher || "",
        }));
        return _json({ articles: yNews, source: "yahoo" }, 200);
      }

      // ── Price / chart data ─────────────────────────────────────────────────
      const range    = url.searchParams.get("range")    || "1d";
      const interval = url.searchParams.get("interval") || "1m";
      const yUrl = "https://query1.finance.yahoo.com/v8/finance/chart/" +
        encodeURIComponent(symbol) + "?range=" + range + "&interval=" + interval;
      const res  = await fetch(yUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await res.text();
      return new Response(data, { headers: _cors() });

    } catch (err) {
      return _json({ error: String(err), articles: [] }, 500);
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function _authPage(title, message, success) {
  const color = success ? "#4ade80" : "#f87171";
  return `<!DOCTYPE html><html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>NK Trade Tracker — Kite Auth</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#060d1a;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;
         display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{background:#0f172a;border:1px solid #1e293b;border-radius:20px;
          padding:48px 40px;max-width:400px;width:100%;text-align:center}
    .icon{font-size:52px;margin-bottom:20px}
    h2{font-size:22px;font-weight:700;color:${color};margin-bottom:10px}
    p{color:#94a3b8;font-size:14px;line-height:1.7}
    .sub{margin-top:20px;color:#475569;font-size:12px}
  </style></head>
  <body><div class="card">
    <div class="icon">${success ? "✅" : "❌"}</div>
    <h2>${title}</h2>
    <p>${message}</p>
    <p class="sub">NK Trade Tracker · Kite Connect</p>
  </div></body></html>`;
}

function _html(body) {
  return new Response(body, { headers: { "Content-Type": "text/html;charset=utf-8" } });
}

function parseRSS(xml) {
  const articles = [];
  const parts = xml.split("<item>");
  for (let i = 1; i < parts.length && articles.length < 8; i++) {
    const item    = parts[i].split("</item>")[0];
    const title   = getTag(item, "title");
    const pubDate = getTag(item, "pubDate");
    const source  = getTag(item, "source");
    const linkM   = item.match(/<link\s*>([\s\S]*?)(?:<\/link>|<)/);
    const link    = linkM ? linkM[1].trim() : "";
    if (title) articles.push({ title, link, pubDate, source });
  }
  return articles;
}

function getTag(xml, name) {
  const re = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i");
  const m  = xml.match(re);
  if (!m) return "";
  return m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function _cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "public, max-age=60",
  };
}

function _json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: _cors() });
}

// ── Cron Scanner ──────────────────────────────────────────────────────────────

async function _runScanner(env) {
  // 1. Check Kite auth
  if (!env.KITE_KV) { console.log("[scanner] KV not bound"); return; }
  const raw = await env.KITE_KV.get("kite_access_token");
  if (!raw) { console.log("[scanner] No Kite token — log in first"); return; }
  const { token: kiteToken, storedAt } = JSON.parse(raw);
  const ageH = (Date.now() - new Date(storedAt).getTime()) / 3_600_000;
  if (ageH >= 20) { console.log("[scanner] Token stale (" + ageH.toFixed(1) + "h)"); return; }

  // 2. Read watchlist (open Firestore rules — API key only, no auth token needed)
  const watchlist = await _fsGetWatchlist(env);
  if (!watchlist.length) { console.log("[scanner] Watchlist empty"); return; }
  console.log("[scanner] Symbols: " + watchlist.map(w => w.symbol).join(", "));

  // 4. Batch Kite quote (price + instrument_token in one call)
  const symbols  = watchlist.map(w => w.symbol);
  const quoteMap = await _kiteQuotes(symbols, kiteToken, env.KITE_API_KEY);

  // 5. Historical candles + pattern detection per symbol
  const today   = new Date().toISOString().slice(0, 10);
  const fromDay = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const results = [];

  for (const { symbol, note } of watchlist) {
    try {
      const q = quoteMap["NSE:" + symbol];
      if (!q) { console.log("[scanner] No quote: " + symbol); continue; }

      await _sleep(400);
      const ohlc = await _kiteHistorical(q.instrument_token, kiteToken, env.KITE_API_KEY, fromDay, today);
      if (!ohlc || ohlc.close.length < 10) { console.log("[scanner] Thin history: " + symbol); continue; }

      const indicators = _calcIndicators(ohlc);
      const patterns   = _detectCandlePatterns(ohlc);
      const setup      = _detectSwingSetup(ohlc, indicators);
      const rsiZone    = _detectRsiZone(indicators.rsi);

      results.push({ symbol, note, q, ohlc, indicators, patterns, setup, rsiZone, date: today });
      console.log("[scanner] " + symbol + ": " +
        (patterns.length ? patterns.join(",") : "none") + (setup ? " | " + setup : ""));
    } catch (e) {
      console.log("[scanner] Error " + symbol + ": " + e);
    }
  }

  // 6. Batch Claude call for flagged symbols only
  const flagged = results.filter(r => r.patterns.length > 0 || r.setup);
  let aiMap = {};
  if (flagged.length > 0 && env.ANTHROPIC_API_KEY) {
    aiMap = await _batchClaude(flagged, env.ANTHROPIC_API_KEY);
  }

  // 7. Write each result to nktt_signals (doc ID = date_SYMBOL, idempotent)
  for (const r of results) {
    try {
      await _fsWriteSignal(env, {
        symbol:    r.symbol,
        note:      r.note || "",
        date:      r.date,
        price:     r.q.last_price,
        patterns:  r.patterns,
        setup:     r.setup || "",
        rsiZone:   r.rsiZone,
        rsi:       r.indicators.rsi   != null ? parseFloat(r.indicators.rsi.toFixed(1))   : 0,
        ema20:     r.indicators.ema20 != null ? parseFloat(r.indicators.ema20.toFixed(2)) : 0,
        analysis:  aiMap[r.symbol] || "",
        scannedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.log("[scanner] Write failed " + r.symbol + ": " + e);
    }
  }

  console.log("[scanner] Done — scanned " + results.length + ", flagged " + flagged.length);
}

// ── Firebase / Firestore helpers (open rules — API key only) ─────────────────

function _fsBase(env) {
  return "https://firestore.googleapis.com/v1/projects/" + env.FIREBASE_PROJECT_ID +
         "/databases/(default)/documents";
}

async function _fsGetWatchlist(env) {
  const url = _fsBase(env) + "/nktt_watchlist?key=" + env.FIREBASE_API_KEY;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (!data.documents) return [];
    return data.documents
      .map(d => ({ symbol: d.fields?.symbol?.stringValue || "", note: d.fields?.note?.stringValue || "" }))
      .filter(w => w.symbol);
  } catch (e) { console.log("[scanner] FS read err: " + e); return []; }
}

async function _fsWriteSignal(env, sig) {
  const docId = sig.date + "_" + sig.symbol;
  const url   = _fsBase(env) + "/nktt_signals/" + docId + "?key=" + env.FIREBASE_API_KEY;
  await fetch(url, {
    method:  "PATCH",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(_fsDoc({
      symbol: sig.symbol, note: sig.note, date: sig.date, price: sig.price,
      patterns: sig.patterns, setup: sig.setup, rsiZone: sig.rsiZone,
      rsi: sig.rsi, ema20: sig.ema20, analysis: sig.analysis, scannedAt: sig.scannedAt,
    })),
  });
}

function _fsDoc(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) out[k] = { nullValue: null };
    else if (typeof v === "number")    out[k] = { doubleValue: v };
    else if (typeof v === "boolean")   out[k] = { booleanValue: v };
    else if (Array.isArray(v))         out[k] = { arrayValue: { values: v.map(x => ({ stringValue: String(x) })) } };
    else                               out[k] = { stringValue: String(v) };
  }
  return { fields: out };
}

// ── Kite API helpers ──────────────────────────────────────────────────────────

async function _kiteQuotes(symbols, kiteToken, apiKey) {
  const params = symbols.map(s => "i=NSE:" + encodeURIComponent(s)).join("&");
  try {
    const res  = await fetch("https://api.kite.trade/quote?" + params, {
      headers: { "Authorization": "token " + apiKey + ":" + kiteToken, "X-Kite-Version": "3" },
    });
    const data = await res.json();
    return data.data || {};
  } catch (e) { console.log("[scanner] Kite quote err: " + e); return {}; }
}

async function _kiteHistorical(instrumentToken, kiteToken, apiKey, from, to) {
  const url = "https://api.kite.trade/instruments/historical/" +
              instrumentToken + "/day?from=" + from + "&to=" + to;
  try {
    const res     = await fetch(url, {
      headers: { "Authorization": "token " + apiKey + ":" + kiteToken, "X-Kite-Version": "3" },
    });
    const data    = await res.json();
    const candles = data.data?.candles || [];
    if (!candles.length) return null;
    return {
      open:   candles.map(c => c[1]),
      high:   candles.map(c => c[2]),
      low:    candles.map(c => c[3]),
      close:  candles.map(c => c[4]),
      volume: candles.map(c => c[5]),
    };
  } catch (e) { console.log("[scanner] Kite hist err: " + e); return null; }
}

// ── Indicators ────────────────────────────────────────────────────────────────

function _calcIndicators(ohlc) {
  const closes  = ohlc.close.filter(c => c != null);
  const highs   = ohlc.high.filter(h => h != null);
  const volumes = (ohlc.volume || []).filter(v => v != null);
  const n       = closes.length;

  // EMA20
  let ema20 = null;
  if (n >= 20) {
    const k = 2 / 21;
    let e = closes.slice(0, 20).reduce((s, v) => s + v, 0) / 20;
    for (let i = 20; i < n; i++) e = (closes[i] - e) * k + e;
    ema20 = e;
  }

  // RSI14 (simple, sufficient for zone detection)
  let rsi = null;
  if (n >= 15) {
    let gains = 0, losses = 0;
    for (let i = n - 14; i < n; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gains += d; else losses -= d;
    }
    const ag = gains / 14, al = losses / 14;
    rsi = al === 0 ? 100 : 100 - (100 / (1 + ag / al));
  }

  // Resistance: highest high in last 20 bars
  const resistance = highs.length >= 20
    ? Math.max(...highs.slice(-20))
    : highs.length ? Math.max(...highs) : null;

  // Volume: 20-bar average (excluding last bar) and last bar
  const avgVolume = volumes.length >= 21
    ? volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20
    : volumes.length > 1 ? volumes.slice(0, -1).reduce((s, v) => s + v, 0) / (volumes.length - 1) : null;
  const latestVolume = volumes.length ? volumes[volumes.length - 1] : null;

  return { ema20, rsi, resistance, avgVolume, latestVolume };
}

// ── Batch Claude call ─────────────────────────────────────────────────────────

async function _batchClaude(flagged, apiKey) {
  const lines = flagged.map(r => {
    const { rsi, ema20 } = r.indicators;
    const pts = r.patterns.map(p => _PATTERN_LABELS[p] || p).join(", ") || "none";
    const st  = r.setup ? " | Setup: " + (_SETUP_LABELS[r.setup] || r.setup) : "";
    const ri  = rsi  != null ? " | RSI "   + rsi.toFixed(0)   : "";
    const em  = ema20 != null ? " | EMA20 ₹" + ema20.toFixed(0) : "";
    return r.symbol + ": ₹" + r.q.last_price + ri + em + " | Patterns: " + pts + st;
  }).join("\n");

  const prompt =
    "You are a swing trade signal generator for Indian NSE stocks.\n" +
    "For each stock, respond with a 60-80 word signal: key pattern/setup, entry range, stop loss, 1-2 targets. Be direct.\n" +
    "Respond ONLY as JSON: { \"SYMBOL\": \"signal text\", ... }\n\n" + lines;

  try {
    const res  = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json();
    const text = data?.content?.[0]?.text || "{}";
    const m    = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : {};
  } catch (e) { console.log("[scanner] Claude batch err: " + e); return {}; }
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Patterns (inlined from patterns.js — keep in sync) ───────────────────────

const _PATTERN_LABELS = {
  doji: "Doji", hammer: "Hammer", shooting_star: "Shooting Star",
  marubozu: "Marubozu", bullish_engulfing: "Bullish Engulfing",
  bearish_engulfing: "Bearish Engulfing", morning_star: "Morning Star",
  evening_star: "Evening Star",
};
const _SETUP_LABELS = { trend_pullback: "Trend Pullback", breakout_volume: "Breakout + Volume" };

function _detectCandlePatterns(ohlc) {
  const cs = _buildCandles(ohlc);
  if (cs.length < 3) return [];
  const c0 = cs[cs.length - 1], c1 = cs[cs.length - 2], c2 = cs[cs.length - 3];
  const out = [];
  if (_wDoji(c0))                  out.push("doji");
  if (_wHammer(c0, cs))            out.push("hammer");
  if (_wShootingStar(c0, cs))      out.push("shooting_star");
  if (_wMarubozu(c0))              out.push("marubozu");
  if (_wBullEngulf(c0, c1))        out.push("bullish_engulfing");
  if (_wBearEngulf(c0, c1))        out.push("bearish_engulfing");
  if (_wMorningStar(c0, c1, c2))   out.push("morning_star");
  if (_wEveningStar(c0, c1, c2))   out.push("evening_star");
  return out;
}

function _detectSwingSetup(ohlc, indicators) {
  if (!ohlc || !indicators) return null;
  const cs = _buildCandles(ohlc);
  if (cs.length < 5) return null;
  const c0 = cs[cs.length - 1], c1 = cs[cs.length - 2];
  const { resistance, avgVolume, latestVolume, ema20 } = indicators;
  if (resistance && avgVolume && latestVolume && c0.close > resistance && latestVolume / avgVolume >= 1.5)
    return "breakout_volume";
  if (ema20) {
    const pct     = Math.abs(c0.close - ema20) / ema20 * 100;
    const reversal = c0.bullish || (_wDoji(c0) && c1.bearish);
    if (pct <= 3 && _emaRising(ohlc, 20) && reversal) return "trend_pullback";
  }
  return null;
}

function _detectRsiZone(rsi) {
  if (rsi == null)             return "neutral";
  if (rsi >= 70)               return "overbought";
  if (rsi <= 30)               return "oversold";
  if (rsi >= 40 && rsi <= 60) return "pullback_zone";
  return "neutral";
}

function _buildCandles(ohlc) {
  const out = [], n = ohlc.close.length;
  for (let i = 0; i < n; i++) {
    const o = ohlc.open[i], h = ohlc.high[i], l = ohlc.low[i], c = ohlc.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    const body = Math.abs(c - o), range = h - l || 0.0001;
    out.push({ open: o, high: h, low: l, close: c, volume: ohlc.volume?.[i] ?? 0,
      body, range, upper: h - Math.max(o, c), lower: Math.min(o, c) - l,
      bullish: c >= o, bearish: c < o });
  }
  return out;
}

function _wDoji(c)     { return c.body / c.range <= 0.1; }
function _wMarubozu(c) { return c.body / c.range >= 0.9; }

function _wHammer(c, all) {
  if (c.lower < c.body * 2 || c.upper > c.body) return false;
  const prev = all.slice(-6, -1);
  return prev.length >= 4 && prev[prev.length - 1].close < prev[0].close;
}
function _wShootingStar(c, all) {
  if (c.upper < c.body * 2 || c.lower > c.body) return false;
  const prev = all.slice(-6, -1);
  return prev.length >= 4 && prev[prev.length - 1].close > prev[0].close;
}
function _wBullEngulf(c0, c1) {
  return c0.bullish && c1.bearish && c0.open <= c1.close && c0.close >= c1.open;
}
function _wBearEngulf(c0, c1) {
  return c0.bearish && c1.bullish && c0.open >= c1.close && c0.close <= c1.open;
}
function _wMorningStar(c0, c1, c2) {
  return c2.bearish && c1.body / c1.range <= 0.3 && c0.bullish && c0.close > (c2.open + c2.close) / 2;
}
function _wEveningStar(c0, c1, c2) {
  return c2.bullish && c1.body / c1.range <= 0.3 && c0.bearish && c0.close < (c2.open + c2.close) / 2;
}
function _emaRising(ohlc, period) {
  const closes = ohlc.close.filter(c => c != null);
  if (closes.length < period + 5) return false;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const tail = [];
  for (let i = period; i < closes.length; i++) {
    e = (closes[i] - e) * k + e;
    if (i >= closes.length - 5) tail.push(e);
  }
  return tail.length >= 2 && tail[tail.length - 1] > tail[0];
}
