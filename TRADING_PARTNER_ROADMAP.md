# NK Trading Partner — Implementation Roadmap

Turns Tara from reactive ("analyze this symbol I typed") into proactive: a Cloudflare Worker cron job scans your watchlist on a timer, detects candlestick/setup patterns, and writes alerts + opinions to Firestore — which your existing app then surfaces, in the research view and in Tara's chat.

This doc is meant to be opened in VS Code alongside the repo. Section 0 is a ready-to-paste brief if you want to hand the build to a coding agent; the rest is the detailed spec/reference.

---

## 0. Paste-ready brief for a coding agent

```
I'm extending an existing vanilla-JS trading tracker (Firebase Firestore backend,
a Cloudflare Worker at nk-price-proxy.<account>.workers.dev that proxies both
Yahoo Finance chart data and Claude API calls). Existing files: app.js (trade
CRUD, portfolio, "Tara" AI chat/auto-monitor), research.js (per-symbol analysis
dashboard, calls Worker "?type=ai" for a structured Claude verdict), intraday.js
(manual P&L journal), firebase-config.js (Firestore db + collection names),
prices.js (live price fetch helper), index.html, style.css.

Goal: make Tara proactive instead of reactive. Add:
1. Two new Firestore collections: nktt_watchlist (symbols being tracked) and
   nktt_signals (pattern/setup hits the scanner finds, with Tara's opinion).
2. A pure-JS pattern/setup detection module (candlestick patterns + trend
   pullback / breakout-with-volume / RSI-zone setups) with no DOM or Firebase
   dependency, so the same file can run in both the browser and the Worker.
3. Wire that module into research.js so per-symbol analysis shows detected
   patterns/setups and feeds them into Tara's existing AI prompt.
4. A new "Watchlist" tab (same page-routing pattern as the existing
   Networth/Parttime/Intraday tabs in app.js) — CRUD against nktt_watchlist.
5. A scheduled handler in the Cloudflare Worker (Cron Trigger) that: reads
   the watchlist from Firestore, fetches quotes/historical candles from
   Kite Connect (rate limits: 1 req/s quotes, ~3 req/s historical — sequence
   requests with small delays, do not fire them all at once), runs the
   pattern module, and for anything that flags, makes ONE batched Claude call
   summarizing the shortlist, then writes results to nktt_signals.
6. Surface nktt_signals in the app: a live-updating panel/badge, and include
   current signals in Tara's chat context (_buildPortfolioContext in app.js)
   so she can discuss them without being asked to re-analyze from scratch.

Kite Connect specifics: data endpoints need instrument_token, not ticker
symbols — map via Kite's instruments CSV, cached, not fetched per request.
Access tokens expire daily (~6am) and require either (a) a manual browser
login each morning, or (b) an unofficial but widely-used TOTP-based autologin
using stored credentials — flag the security tradeoff of (b) rather than
picking it silently.

Work in the order in TRADING_PARTNER_ROADMAP.md section 5. Each step should
be independently testable before the next starts — this touches a live
personal finance app with real trade data, so no big-bang rewrites.
```

---

## 1. Architecture

```
Kite Connect API (data)
        │  quotes + historical candles, rate-limited
        ▼
Cloudflare Worker — Cron Trigger (new, runs on a timer, independent of browser)
        │  reads nktt_watchlist, runs pattern/setup detection,
        │  1 batched Claude call per run for flagged candidates
        ▼
Firestore — nktt_signals (new)              Firestore — nktt_watchlist (new)
        │  read live                                  │  read/write from app
        ▼                                              ▼
Your existing app (app.js / research.js) ── displays signals, feeds Tara's
context, shows/edits watchlist. Tara's existing reactive chat still works
exactly as it does today — this is additive, not a replacement.
```

Key shift: today, "watching the market" only happens while your browser tab is open (`setInterval` in `_initAIMonitor`). The Cron Trigger moves that to Cloudflare's servers, so it runs whether or not your laptop is on.

---

## 2. New Firestore collections

**`nktt_watchlist`** — stocks you're tracking, separate from actual trades:
```js
{
  symbol: "TCS",
  addedDate: "2026-08-10",
  notes: "watching for pullback to 20EMA",
  active: true
}
```

**`nktt_signals`** — what the scanner finds:
```js
{
  symbol: "TCS",
  timestamp: <server timestamp>,
  patterns: ["bullish_engulfing"],        // from the pattern module
  setup: "trend_pullback",                 // or "breakout_volume", "rsi_oversold", null
  snapshot: { rsi14, macd, ema20, sma50, sma200, support, resistance, volumeRatio },
  opinion: "<Claude's write-up for this batch>",
  verdict: "BUY" | "HOLD" | "AVOID" | "WATCH"
}
```

Both are additive — nothing about `nktt_trades` or `nktt_intraday` changes.

---

## 3. Kite Connect integration notes

**Instrument token mapping.** Kite's data endpoints take a numeric `instrument_token`, not a symbol like "TCS". Download the instruments CSV once (`GET /instruments`), cache symbol→token, refresh weekly (tokens rarely change) — don't re-fetch this per scan.

**Rate limits** (per API key, combined):

| Endpoint | Limit |
|---|---|
| Quotes | 1 req/sec |
| Historical candles | ~3 req/sec (120/min) |
| Everything else | 10 req/sec |

For a watchlist of N symbols needing historical data, budget ~N/3 seconds minimum, sequenced — don't `Promise.all` the whole watchlist at once.

**Daily auth — two options, pick deliberately:**
- **Manual** (safer): each morning you log into Kite in a browser, get redirected to your GitHub Pages redirect URL with a `request_token`, and a small endpoint on the Worker exchanges it (with your API secret) for that day's `access_token`, storing it somewhere the cron job can read (Firestore doc or Cloudflare KV). Reliable, zero extra credential storage, but requires you to do this every trading day before the scanner can run.
- **TOTP autologin** (convenient, more exposure): a well-documented community pattern (`requests` + `pyotp` hitting Kite's actual login endpoints) fully automates this — but it means storing your Kite password and TOTP secret in the Worker's environment, and it's not the official Kite Connect API, so it can break if Zerodha changes their login flow. Don't do this silently; decide it consciously.

---

## 4. Pattern/setup detection module — spec

New file, e.g. `patterns.js`, pure functions, input = OHLCV arrays (same shape `research.js` already produces from `_fetchHistorical`), no side effects:

```js
export function detectCandlePatterns(ohlc) { /* returns array: "doji", "hammer",
  "bullish_engulfing", "bearish_engulfing", "morning_star", "evening_star",
  "shooting_star", "marubozu" — for the most recent 1-3 candles */ }

export function detectSwingSetup(ohlc, indicators) { /* returns one of:
  "trend_pullback" (price pulled back to rising 20/50 EMA + bullish reversal
   candle), "breakout_volume" (close above resistance on ≥1.5x avg volume),
  null */ }

export function detectRsiZone(rsi) { /* "overbought" | "oversold" |
  "pullback_zone" (40-60 in an uptrend) | "neutral" */ }
```

This is the file both `research.js` (browser) and the Worker (cron) import — write it once, keep it dependency-free so it works in both runtimes unchanged.

---

## 5. Build order

1. **Firestore schema** — no code yet, just start writing docs matching section 2's shape from a throwaway test script. Verify in Firebase console.
2. **`patterns.js`** — build and unit-test in isolation (a plain Node script feeding it sample OHLC arrays is enough). Nothing else depends on it yet.
3. **Wire into `research.js`** — import `patterns.js`, add detected patterns/setup to the existing `_calcTechnicals` output and to the AI prompt string in `_askAI`. This is your first visible change to a screen that already works — compare before/after on a couple of symbols.
4. **Watchlist tab** — new page in `app.js`'s router (`_navigateTo`/`_showPage`), CRUD against `nktt_watchlist`. Isolated from trade/portfolio logic.
5. **Kite auth exchange endpoint** — add to the Worker (or a new small one) that trades `request_token` → `access_token` and stores it. Test this manually end-to-end (log in, confirm token lands in storage) before touching the scanner.
6. **Cron Trigger handler** — the scanning job itself: read watchlist → map symbols to instrument tokens → fetch quotes/historical (respecting rate limits) → run `patterns.js` → batch-call Claude on flagged symbols → write `nktt_signals`. Test by triggering it manually first (Cloudflare lets you invoke a scheduled handler on demand) before trusting the timer.
7. **Surface signals in the app** — live read of `nktt_signals` (badge/toast on new entries), and extend `_buildPortfolioContext` in `app.js` to include current signals so Tara's chat is aware of them.
8. **Decide the Cowork daily lesson's fate** — once step 7 is live and you're seeing real signals, decide whether the daily lesson task retires or becomes a morning digest pulled from `nktt_signals`. Not a code step, a decision to revisit later.

Each step is independently testable — don't start step *N+1* until step *N* works on its own.

---

## 6. Open decisions (yours, not blocking the build, but worth deciding early)

- **Watchlist size** — how many symbols the cron job scans each run (affects run time and, if you ever add order placement later, isn't relevant since we're not automating orders).
- **Cron frequency** — every 15 min? 30 min? Only during market hours (9:15–3:30 IST), or also pre/post-market?
- **Auth method** — manual daily login vs. TOTP autologin (section 3).
- **Alert delivery** — in-app badge only, or also a push/notification channel (e.g. a Telegram bot, email via the Worker) for when you're away from the app.

---

## 7. Guardrail, restated

Nothing in this build places real orders. The scanner analyzes and writes opinions; every buy/sell decision and every order placement stays a manual action you take yourself.
