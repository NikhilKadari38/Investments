// ─── NK Trade Tracker — Live Price Fetcher ───────────────────────────────────
// Tries multiple CORS proxies in order until one works

const PROXIES = [
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?",
  "https://api.codetabs.com/v1/proxy?quest=",
];
const YF_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";
const TIMEOUT = 9000;

export async function fetchLivePrice(symbol, preferredExchange = null) {
  const primary   = preferredExchange ?? "NS";
  const secondary = primary === "NS" ? "BO" : "NS";
  const order     = [primary, secondary];

  for (const suffix of order) {
    const result = await _tryFetchAllProxies(symbol, suffix);
    if (result !== null) return { price: result, exchange: suffix };
  }

  return { price: null, exchange: null };
}

async function _tryFetchAllProxies(symbol, suffix) {
  for (const proxy of PROXIES) {
    const result = await _tryFetch(proxy, symbol, suffix);
    if (result !== null) return result;
  }
  return null;
}

async function _tryFetch(proxy, symbol, suffix) {
  try {
    const ticker = symbol + "." + suffix;
    const target = YF_BASE + ticker + "?interval=1m&range=1d";
    const url    = proxy + encodeURIComponent(target);
    const ctrl   = new AbortController();
    const timer  = setTimeout(() => ctrl.abort(), TIMEOUT);

    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;

    const data  = await res.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return (price && price > 0) ? parseFloat(price.toFixed(2)) : null;
  } catch {
    return null;
  }
}
