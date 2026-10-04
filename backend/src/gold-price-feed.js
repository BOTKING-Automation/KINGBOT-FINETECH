const ENDPOINT = "https://api.gold-api.com/price/XAU";
const FETCH_INTERVAL_MS = Math.max(30000, Number(process.env.KINGBOT_GOLDPRICE_POLL_MS || 30000));
const MAX_AGE_MS = Math.max(60000, Number(process.env.KINGBOT_GOLDPRICE_MAX_AGE_MS || 120000));
const TIMEOUT_MS = Math.max(2000, Number(process.env.KINGBOT_GOLDPRICE_TIMEOUT_MS || 8000));

let cache = null;
let inflight = null;

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseGoldPriceResponse(payload) {
  const price = finite(payload?.price);
  const rawUpdatedAt = payload?.updatedAt || null;
  const parsedTimestamp = rawUpdatedAt ? Date.parse(rawUpdatedAt) : NaN;
  if (!(price > 0)) throw new Error("GOLD_API_XAU_PRICE_MISSING");
  if (!Number.isFinite(parsedTimestamp)) throw new Error("GOLD_API_XAU_TIMESTAMP_MISSING");

  const updatedAt = new Date(parsedTimestamp).toISOString();
  const ageMs = Math.max(0, Date.now() - parsedTimestamp);
  if (ageMs > MAX_AGE_MS) throw new Error("GOLD_API_XAU_QUOTE_STALE");

  return {
    symbol: "XAUUSD",
    directSymbol: "XAU",
    price,
    bid: null,
    ask: null,
    spread: null,
    timestamp: updatedAt,
    updatedAt,
    receivedAt: new Date().toISOString(),
    ageMs,
    available: true,
    verified: true,
    source: "Gold API direct free XAU/USD price",
    provider: "gold-api.com",
    unit: "troy_ounce",
    contractType: "spot",
    freshnessMaxAgeMs: MAX_AGE_MS
  };
}

async function fetchDirectGoldQuote() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "KINGBOT-FINETECH/1.0" }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || `GOLD_API_HTTP_${response.status}`);
    }
    return parseGoldPriceResponse(payload);
  } finally {
    clearTimeout(timer);
  }
}

export class GoldPriceFeed {
  get enabled() {
    return true;
  }

  async getQuote({ force = false } = {}) {
    const age = cache?.fetchedAt ? Date.now() - cache.fetchedAt : Infinity;
    if (!force && cache?.quote && age < FETCH_INTERVAL_MS) {
      return { ...cache.quote, cacheAgeMs: Math.max(0, age), cached: true };
    }
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        const quote = await fetchDirectGoldQuote();
        cache = { quote, fetchedAt: Date.now() };
        return { ...quote, cacheAgeMs: 0, cached: false };
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  }

  status() {
    const age = cache?.fetchedAt ? Math.max(0, Date.now() - cache.fetchedAt) : null;
    return {
      configured: true,
      connected: Boolean(cache?.quote),
      source: "Gold API direct free XAU/USD price",
      symbol: "XAUUSD",
      endpoint: ENDPOINT,
      lastUpdatedAt: cache?.quote?.updatedAt || null,
      lastFetchedAt: cache?.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
      cacheAgeMs: age,
      maxAgeMs: MAX_AGE_MS,
      pollIntervalMs: FETCH_INTERVAL_MS,
      quoteVerified: Boolean(cache?.quote?.verified)
    };
  }
}

const singleton = new GoldPriceFeed();

export function getGoldPriceFeed() {
  return singleton;
}
