// ─── NK Trade Tracker — Pattern & Setup Detection ──────────────────────────
// Pure module — no DOM, no Firebase. Works in browser and Cloudflare Worker.
// Input: ohlc = { open, high, low, close, volume } (arrays from _fetchHistorical)
//         indicators = output of _calcTechnicals in research.js

// ── Public API ────────────────────────────────────────────────────────────────

export function detectCandlePatterns(ohlc) {
  const cs = _candles(ohlc);
  if (cs.length < 3) return [];
  const c0 = cs[cs.length - 1]; // latest
  const c1 = cs[cs.length - 2];
  const c2 = cs[cs.length - 3];
  const out = [];

  if (_doji(c0))                 out.push("doji");
  if (_hammer(c0, cs))           out.push("hammer");
  if (_shootingStar(c0, cs))     out.push("shooting_star");
  if (_marubozu(c0))             out.push("marubozu");
  if (_bullEngulf(c0, c1))       out.push("bullish_engulfing");
  if (_bearEngulf(c0, c1))       out.push("bearish_engulfing");
  if (_morningStar(c0, c1, c2))  out.push("morning_star");
  if (_eveningStar(c0, c1, c2))  out.push("evening_star");

  return out;
}

export function detectSwingSetup(ohlc, indicators) {
  if (!ohlc || !indicators) return null;
  const cs = _candles(ohlc);
  if (cs.length < 5) return null;

  const c0    = cs[cs.length - 1];
  const c1    = cs[cs.length - 2];
  const price = c0.close;
  const { resistance, avgVolume, latestVolume, ema20 } = indicators;

  // Breakout: close above 20-day resistance on >= 1.5x average volume
  if (resistance && avgVolume && latestVolume) {
    if (price > resistance && latestVolume / avgVolume >= 1.5) {
      return "breakout_volume";
    }
  }

  // Trend pullback: price within 3% of a rising 20 EMA + bullish reversal candle
  if (ema20) {
    const pctFromEma = Math.abs(price - ema20) / ema20 * 100;
    const rising     = _emaRising(ohlc, 20);
    const reversal   = c0.bullish || (_doji(c0) && c1.bearish);
    if (pctFromEma <= 3 && rising && reversal) return "trend_pullback";
  }

  return null;
}

export function detectRsiZone(rsi) {
  if (rsi == null) return "neutral";
  if (rsi >= 70)               return "overbought";
  if (rsi <= 30)               return "oversold";
  if (rsi >= 40 && rsi <= 60) return "pullback_zone";
  return "neutral";
}

// ── Labels & classification for display ──────────────────────────────────────
export const PATTERN_LABELS = {
  doji:              "Doji",
  hammer:            "Hammer",
  shooting_star:     "Shooting Star",
  marubozu:         "Marubozu",
  bullish_engulfing: "Bullish Engulfing",
  bearish_engulfing: "Bearish Engulfing",
  morning_star:      "Morning Star",
  evening_star:      "Evening Star",
};

export const SETUP_LABELS = {
  trend_pullback:  "Trend Pullback",
  breakout_volume: "Breakout + Volume",
};

export const RSI_ZONE_LABELS = {
  overbought:    "Overbought",
  oversold:      "Oversold",
  pullback_zone: "Pullback Zone",
  neutral:       "Neutral",
};

export const BULLISH_PATTERNS = new Set(["hammer", "bullish_engulfing", "morning_star"]);
export const BEARISH_PATTERNS = new Set(["shooting_star", "bearish_engulfing", "evening_star"]);

// ── Candle builder ────────────────────────────────────────────────────────────
function _candles(ohlc) {
  const out = [];
  const n   = ohlc.close.length;
  for (let i = 0; i < n; i++) {
    const o = ohlc.open[i], h = ohlc.high[i], l = ohlc.low[i], c = ohlc.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    const body  = Math.abs(c - o);
    const range = h - l || 0.0001;
    out.push({
      open: o, high: h, low: l, close: c,
      volume: ohlc.volume?.[i] ?? 0,
      body, range,
      upper:   h - Math.max(o, c),
      lower:   Math.min(o, c) - l,
      bullish: c >= o,
      bearish: c < o,
    });
  }
  return out;
}

// ── Single-candle ─────────────────────────────────────────────────────────────
function _doji(c) {
  return c.body / c.range <= 0.1;
}

function _hammer(c, all) {
  // Long lower shadow (>= 2x body), small upper shadow (<= body), after downtrend
  if (c.lower < c.body * 2 || c.upper > c.body) return false;
  const prev = all.slice(-6, -1);
  return prev.length >= 4 && prev[prev.length - 1].close < prev[0].close;
}

function _shootingStar(c, all) {
  // Long upper shadow (>= 2x body), small lower shadow (<= body), after uptrend
  if (c.upper < c.body * 2 || c.lower > c.body) return false;
  const prev = all.slice(-6, -1);
  return prev.length >= 4 && prev[prev.length - 1].close > prev[0].close;
}

function _marubozu(c) {
  return c.body / c.range >= 0.9;
}

// ── Two-candle ────────────────────────────────────────────────────────────────
function _bullEngulf(c0, c1) {
  return c0.bullish && c1.bearish &&
    c0.open <= c1.close && c0.close >= c1.open;
}

function _bearEngulf(c0, c1) {
  return c0.bearish && c1.bullish &&
    c0.open >= c1.close && c0.close <= c1.open;
}

// ── Three-candle ──────────────────────────────────────────────────────────────
function _morningStar(c0, c1, c2) {
  const mid = (c2.open + c2.close) / 2;
  return c2.bearish && c1.body / c1.range <= 0.3 && c0.bullish && c0.close > mid;
}

function _eveningStar(c0, c1, c2) {
  const mid = (c2.open + c2.close) / 2;
  return c2.bullish && c1.body / c1.range <= 0.3 && c0.bearish && c0.close < mid;
}

// ── EMA direction helper ──────────────────────────────────────────────────────
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
