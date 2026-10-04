const ENDPOINT = "https://api.goldprice.dev/v1/prices?symbol=XAU-USD-SPOT";
const FETCH_INTERVAL_MS = Math.max(45000, Number(process.env.KINGBOT_GOLDPRICE_POLL_MS || 60000));
const MAX_AGE_MS = Math.max(60000, Number(process.env.KINGBOT_GOLDPRICE_MAX_AGE_MS || 90000));
const TIMEOUT_MS = Math.max(2000, Number(process.env.KINGBOT_GOLDPRICE_TIMEOUT_MS || 8000));

let cache = null;
let inflight = null;

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseGoldPriceResponse(payload) {
  const row = Array.isArray(payload?.symbols) ? payload.symbols.find(x => String(x?.symbol || "").toUpperCase() === "XAU") || payload.symbols[0] : null;
  if (!row) throw new Error("GOLDPRICE_XAU_RESPONSE_EMPTY");

  const price = finite(row.price);
  const bid = finite(row.bid);
  const ask = finite(row.ask);
  const computedAt = row.computed_at ? new Date(row.computed_at).toISOString() : null;
  const ageMs = computedAt ? Math.max(0, Date.now() - Date.parse(computedAt)) : null;

  if (!(price > 0)) throw new Error("GOLDPRICE_XAU_PRICE_MISSING");
  if (!computedAt || !Number.isFinite(Date.parse(computedAt))) throw new Error("GOLDPRICE_XAU_TIMESTAMP_MISSING");
  if (row.is_stale === true) throw new Error("GOLDPRICE_XAU_PROVIDER_STALE");
  if (ageMs === null || ageMs > MAX_AGE_MS) throw new Error("GOLDPRICE_XAU_QUOTE_STALE");

  return {
    symbol: "XAUUSD",
    directSymbol: "XAU-USD-SPOT",
    price,
    bid,
    ask,
    spread: bid !== null && ask !== null ? Math.max(0, ask - bid) : null,
    timestamp: computedAt,
    computedAt,
    receivedAt: new Date().toISOString(),
    ageMs,
    available: true,
    verified: true,
    source: "GoldPrice.dev direct free XAU/USD spot",
    provider: "goldprice.dev",
    unit: row.unit || "troy_ounce",
    contractType: row.contract_type || "spot",
    isProviderStale: false,
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
      throw new Error(payload?.error || `GOLDPRICE_HTTP_${response.status}`);
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
      source: "GoldPrice.dev direct free XAU/USD spot",
      symbol: "XAUUSD",
      endpoint: ENDPOINT.split("?")[0],
      lastComputedAt: cache?.quote?.computedAt || null,
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
