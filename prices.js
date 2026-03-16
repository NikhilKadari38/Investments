// ─── NK Trade Tracker — Live Price Fetcher ───────────────────────────────────
// Uses Yahoo Finance via multiple strategies with fallback

const YF_QUERY1 = "https://query1.finance.yahoo.com/v8/finance/chart/";
const YF_QUERY2 = "https://query2.finance.yahoo.com/v8/finance/chart/";
const TIMEOUT   = 10000;

// allorigins /get wraps response in { contents: "..." }
// allorigins /raw returns raw but has CORS issues on some servers
const STRATEGIES = [
  (url) => "https://api.allorigins.win/get?url=" + encodeURIComponent(url),
  (url) => "https://corsproxy.io/?" + encodeURIComponent(url),
  (url) => "https://thingproxy.freeboard.io/fetch/" + url,
];

export async function fetchLivePrice(symbol, preferredExchange = null) {
  const primary   = preferredExchange ?? "NS";
  const secondary = primary === "NS" ? "BO" : "NS";

  for (const suffix of [primary, secondary]) {
    const result = await _tryAllStrategies(symbol, suffix);
    if (result !== null) return { price: result, exchange: suffix };
  }

  return { price: null, exchange: null };
}

async function _tryAllStrategies(symbol, suffix) {
  const ticker  = symbol + "." + suffix;
  const targets = [
    YF_QUERY1 + ticker + "?interval=1m&range=1d",
    YF_QUERY2 + ticker + "?interval=1m&range=1d",
  ];

  for (const target of targets) {
    for (const buildUrl of STRATEGIES) {
      const price = await _tryFetch(buildUrl(target), target.includes("allorigins.win/get"));
      if (price !== null) return price;
    }
  }
  return null;
}

async function _tryFetch(url, isWrapped = false) {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    const res   = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;

    const raw  = await res.json();
    // allorigins /get wraps in { contents: "..." }
    const data = isWrapped ? JSON.parse(raw.contents) : raw;
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return (price && price > 0) ? parseFloat(price.toFixed(2)) : null;
  } catch {
    return null;
  }
}
