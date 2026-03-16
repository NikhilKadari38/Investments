// ─── NK Trade Tracker — Live Price Fetcher ───────────────────────────────────
// Uses Twelve Data API (free: 800 calls/day)

const TWELVE_DATA_KEY = "3de7bd923b4e42e78ebc3249c62914bf";
const TWELVE_DATA_URL = "https://api.twelvedata.com/price";

const EXCHANGE_MAP = { NS: "NSE", BO: "BSE" };

export async function fetchLivePrice(symbol, preferredExchange = null) {
  const primary   = preferredExchange ?? "NS";
  const secondary = primary === "NS" ? "BO" : "NS";

  for (const suffix of [primary, secondary]) {
    const result = await _fetchPrice(symbol, EXCHANGE_MAP[suffix]);
    if (result !== null) return { price: result, exchange: suffix };
  }

  return { price: null, exchange: null };
}

async function _fetchPrice(symbol, exchange) {
  try {
    const params = new URLSearchParams({
      symbol: symbol + ":" + exchange,
      apikey: TWELVE_DATA_KEY,
    });
    const res = await fetch(TWELVE_DATA_URL + "?" + params.toString());
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code || !data.price) return null;
    const price = parseFloat(data.price);
    return price > 0 ? parseFloat(price.toFixed(2)) : null;
  } catch {
    return null;
  }
}
