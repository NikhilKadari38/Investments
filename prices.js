// ─── NK Trade Tracker — Live Price Fetcher ───────────────────────────────────
// Uses personal Cloudflare Worker to fetch Yahoo Finance prices
// Worker URL: https://nk-price-proxy.lotuswhite9392.workers.dev

const WORKER_URL = "https://nk-price-proxy.lotuswhite9392.workers.dev";

/**
 * Fetch the live market price for a stock symbol.
 * Tries NSE first, then BSE as fallback.
 *
 * @param {string}      symbol           — e.g. "RELIANCE", "TATAMOTORS"
 * @param {string|null} preferredExchange — "NS" | "BO" | null (auto-detect)
 * @returns {Promise<{ price: number|null, exchange: string|null }>}
 */
export async function fetchLivePrice(symbol, preferredExchange = null) {
  const primary   = preferredExchange ?? "NS";
  const secondary = primary === "NS" ? "BO" : "NS";

  for (const suffix of [primary, secondary]) {
    const result = await _fetchPrice(symbol, suffix);
    if (result !== null) return { price: result, exchange: suffix };
  }

  return { price: null, exchange: null };
}

async function _fetchPrice(symbol, suffix) {
  try {
    const ticker = symbol + "." + suffix;
    const url    = WORKER_URL + "?symbol=" + encodeURIComponent(ticker);
    const res    = await fetch(url);
    if (!res.ok) return null;

    const data  = await res.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return (price && price > 0) ? parseFloat(price.toFixed(2)) : null;
  } catch {
    return null;
  }
}
