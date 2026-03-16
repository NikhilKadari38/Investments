// ─── NK Trade Tracker — Live Price Fetcher ───────────────────────────────────
// Uses Yahoo Finance via corsproxy.io (free, no API key needed)
// Auto-detects NSE (.NS) vs BSE (.BO) suffix

const PROXY     = "https://corsproxy.io/?";
const YF_BASE   = "https://query1.finance.yahoo.com/v8/finance/chart/";
const TIMEOUT   = 9000;

/**
 * Fetch the live market price for a stock symbol.
 * Tries preferred exchange first; falls back to the other.
 *
 * @param {string}      symbol           — e.g. "RELIANCE", "TATAMOTORS"
 * @param {string|null} preferredExchange — "NS" | "BO" | null (auto-detect)
 * @returns {Promise<{ price: number|null, exchange: string|null }>}
 */
export async function fetchLivePrice(symbol, preferredExchange = null) {
  const primary   = preferredExchange ?? "NS";
  const secondary = primary === "NS" ? "BO" : "NS";
  const order     = preferredExchange ? [primary, secondary] : [primary, secondary];

  for (const suffix of order) {
    const result = await _tryFetch(symbol, suffix);
    if (result !== null) return { price: result, exchange: suffix };
  }

  return { price: null, exchange: null };
}

async function _tryFetch(symbol, suffix) {
  try {
    const ticker = symbol + "." + suffix;
    const url    = PROXY + encodeURIComponent(YF_BASE + ticker + "?interval=1m&range=1d");
    const ctrl   = new AbortController();
    const timer  = setTimeout(() => ctrl.abort(), TIMEOUT);

    const res  = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;

    const data  = await res.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return (price && price > 0) ? parseFloat(price.toFixed(2)) : null;
  } catch {
    return null;
  }
}
