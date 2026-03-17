// ─── NK Trade Tracker — Live Price Fetcher ───────────────────────────────────
// Uses personal Cloudflare Worker → no CORS issues, no rate limits

const WORKER_URL = "https://nk-price-proxy.lotuswhite9392.workers.dev";

export async function fetchLivePrice(symbol, preferredExchange = null) {
  const primary   = preferredExchange ?? "NS";
  const secondary = primary === "NS" ? "BO" : "NS";

  for (const suffix of [primary, secondary]) {
    const result = await _fetchPrice(symbol, suffix);
    if (result !== null) return { ...result, exchange: suffix };
  }

  return { price: null, dayChangePct: null, exchange: null };
}

async function _fetchPrice(symbol, suffix) {
  try {
    const ticker = symbol + "." + suffix;
    const url    = WORKER_URL + "?symbol=" + encodeURIComponent(ticker);
    const res    = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const price = meta.regularMarketPrice;
    if (!price || price <= 0) return null;

    // Day % change using previousClose
    const prev         = meta.chartPreviousClose || meta.previousClose;
    const dayChangePct = prev && prev > 0
      ? parseFloat((((price - prev) / prev) * 100).toFixed(2))
      : null;

    return {
      price:       parseFloat(price.toFixed(2)),
      dayChangePct
    };
  } catch {
    return null;
  }
}
