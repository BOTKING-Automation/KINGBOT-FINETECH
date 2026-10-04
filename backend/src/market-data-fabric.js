import { getGoldPriceFeed } from "./gold-price-feed.js";
import { getDerivMarketFeed } from "./deriv-market-feed.js";

const DEFAULT_FRESHNESS_MS = Math.max(15000, Number(process.env.KINGBOT_MARKET_DATA_MAX_AGE_MS || 120000));
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.KINGBOT_MARKET_DATA_TIMEOUT_MS || 4500));

const CRYPTO_QUOTES = {
  BTCUSD: "BTCUSDT",
  ETHUSD: "ETHUSDT",
  SOLUSD: "SOLUSDT",
  BNBUSD: "BNBUSDT",
  XRPUSD: "XRPUSDT",
  DOGEUSD: "DOGEUSDT",
  ADAUSD: "ADAUSDT",
  AVAXUSD: "AVAXUSDT",
  LINKUSD: "LINKUSDT",
  LTCUSD: "LTCUSDT",
  TRXUSD: "TRXUSDT",
  UNIUSD: "UNIUSDT",
  NEARUSD: "NEARUSDT",
  INJUSD: "INJUSDT",
  SUIUSD: "SUIUSDT"
};

const GOLD_API_SYMBOLS = new Set(["XAUUSD", "XAGUSD"]);
const MAJOR_FOREX = /^[A-Z]{6}$/;

const SOURCE_ORDER = {
  metals: ["gold-api", "twelve-data", "deriv"],
  forex: ["twelve-data", "massive", "deriv"],
  crypto: ["binance", "twelve-data", "massive"],
  stocks: ["massive", "twelve-data"],
  indices: ["massive", "twelve-data", "deriv"],
  commodities: ["massive", "twelve-data", "deriv"],
  unknown: ["twelve-data", "massive", "deriv"]
};

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeMarketSymbol(value) {
  const raw = String(value || "").trim().toUpperCase().replace(/\s+/g, "");
  const aliases = {
    "XAU/USD": "XAUUSD",
    GOLD: "XAUUSD",
    "XAG/USD": "XAGUSD",
    SILVER: "XAGUSD",
    "BTC/USD": "BTCUSD",
    "BTC-USDT": "BTCUSDT",
    "S&P500": "SPX",
    "SP500": "SPX",
    "US500": "SPX",
    "US100": "NASDAQ",
    "NAS100": "NASDAQ",
    "US30": "DJI",
    "DOW": "DJI"
  };
  return aliases[raw] || raw.replace(/[/:_-]/g, "");
}

export function classifyMarketSymbol(symbol) {
  const s = normalizeMarketSymbol(symbol);
  if (GOLD_API_SYMBOLS.has(s)) return "metals";
  if (CRYPTO_QUOTES[s] || /^[A-Z]{2,8}USDT$/.test(s) || (/^[A-Z]{3}USD$/.test(s) && !MAJOR_FOREX.test(s))) return "crypto";
  if (MAJOR_FOREX.test(s)) return "forex";
  if (/^(SPX|NASDAQ|DJI|DAX|FTSE|NIKKEI|RUSSELL|VIX)$/.test(s)) return "indices";
  if (/^(USOIL|UKOIL|BRENT|WTI|NATGAS|COPPER|PLATINUM|PALLADIUM)$/.test(s)) return "commodities";
  if (/^[A-Z]{1,5}(\.[A-Z])?$/.test(s)) return "stocks";
  return "unknown";
}

function timestampMs(value) {
  const n = finite(value);
  if (n === null) return null;
  return n > 1e15 ? n / 1e6 : n;
}

function normalizeQuote({ symbol, category, price, bid = null, ask = null, change = null, volume = null, high = null, low = null, timestamp = null, source, provider, freshnessMaxAgeMs = DEFAULT_FRESHNESS_MS, raw = null }) {
  const normalized = normalizeMarketSymbol(symbol);
  const ts = timestampMs(timestamp) || Date.now();
  const age = Math.max(0, Date.now() - ts);
  const fresh = age <= freshnessMaxAgeMs && Number.isFinite(Number(price)) && Number(price) > 0;

  return {
    symbol: normalized,
    category,
    price: finite(price),
    bid: finite(bid),
    ask: finite(ask),
    spread: finite(bid) !== null && finite(ask) !== null ? finite(ask) - finite(bid) : null,
    change: finite(change),
    volume: finite(volume),
    high: finite(high),
    low: finite(low),
    timestamp: new Date(ts).toISOString(),
    ageMs: age,
    freshnessMaxAgeMs,
    available: fresh,
    verified: fresh,
    source,
    provider,
    quality: fresh ? "VERIFIED" : "STALE",
    executionAuthorized: false,
    executionAuthority: "NONE",
    raw: raw || undefined
  };
}

async function fetchJson(url, { timeoutMs = REQUEST_TIMEOUT_MS, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", ...headers },
      cache: "no-store"
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(body?.message || body?.error || `HTTP_${response.status}`));
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function cryptoTicker(symbol) {
  const s = normalizeMarketSymbol(symbol);\n  return s.endsWith("USDT") ? s : (CRYPTO_QUOTES[s] || `${s.replace(/USD$/, "")}USDT`);
}

async function readGoldApi(symbol, goldFeed) {
  if (!GOLD_API_SYMBOLS.has(symbol)) throw new Error("GOLD_API_SYMBOL_NOT_SUPPORTED");
  if (symbol === "XAUUSD") return goldFeed.getQuote();

  const payload = await fetchJson("https://api.gold-api.com/price/XAG", { timeoutMs: REQUEST_TIMEOUT_MS });
  const price = finite(payload?.price);
  const updatedAt = payload?.updatedAt ? Date.parse(payload.updatedAt) : NaN;
  if (!(price > 0) || !Number.isFinite(updatedAt)) throw new Error("GOLD_API_METAL_PRICE_INVALID");
  return {
    symbol,
    price,
    timestamp: updatedAt,
    updatedAt: payload.updatedAt,
    available: true,
    verified: true,
    source: "Gold API direct free metal price",
    provider: "gold-api.com"
  };
}

async function readBinance(symbol) {
  const ticker = cryptoTicker(symbol);
  const payload = await fetchJson("https://api.binance.com/api/v3/ticker/24hr?symbol=" + encodeURIComponent(ticker), { timeoutMs: REQUEST_TIMEOUT_MS });
  const timestamp = finite(payload?.closeTime) || Date.now();
  const price = finite(payload?.lastPrice);
  if (!(price > 0)) throw new Error("BINANCE_QUOTE_EMPTY");
  return {
    symbol,
    price,
    timestamp,
    change: finite(payload?.priceChangePercent),
    volume: finite(payload?.quoteVolume),
    high: finite(payload?.highPrice),
    low: finite(payload?.lowPrice),
    source: "Binance public spot ticker",
    provider: "binance"
  };
}

async function readTwelveData(symbol, twelveData) {
  if (!twelveData?.enabled) throw new Error("TWELVE_DATA_NOT_CONFIGURED");
  const rows = await twelveData.latestQuotes([symbol], { allowRestFallback: true, restTimeoutMs: 1800 });
  const quote = rows.find(row => normalizeMarketSymbol(row?.symbol) === normalizeMarketSymbol(symbol) && row?.available);
  if (!quote || !(Number(quote.price) > 0)) throw new Error("TWELVE_DATA_QUOTE_UNAVAILABLE");
  return {
    ...quote,
    symbol,
    timestamp: quote.timestamp || Date.now(),
    provider: "twelve-data"
  };
}

async function readMassive(symbol, category, apiKey) {
  if (!apiKey) throw new Error("MASSIVE_API_KEY_NOT_CONFIGURED");

  const base = "https://api.massive.com";
  const s = normalizeMarketSymbol(symbol);
  let payload;
  if (category === "stocks") {
    payload = await fetchJson(base + "/v2/last/trade/" + encodeURIComponent(s) + "?apiKey=" + encodeURIComponent(apiKey), { timeoutMs: REQUEST_TIMEOUT_MS });
    const result = payload?.results || {};
    return {
      symbol: s,
      price: finite(result?.p),
      timestamp: timestampMs(result?.t),
      source: "Massive stock last trade",
      provider: "massive"
    };
  }

  if (category === "forex") {
    const ticker = "C:" + s;
    payload = await fetchJson(base + "/v2/snapshot/locale/global/markets/forex/tickers/" + encodeURIComponent(ticker) + "?apiKey=" + encodeURIComponent(apiKey), { timeoutMs: REQUEST_TIMEOUT_MS });
  } else if (category === "crypto") {
    const ticker = "X:" + s.replace(/USDT$/, "USD");
    payload = await fetchJson(base + "/v2/snapshot/locale/global/markets/crypto/tickers/" + encodeURIComponent(ticker) + "?apiKey=" + encodeURIComponent(apiKey), { timeoutMs: REQUEST_TIMEOUT_MS });
  } else if (category === "indices") {
    const indexMap = { SPX: "I:SPX", NASDAQ: "I:NDX", DJI: "I:DJI", DAX: "I:DAX", FTSE: "I:UKX", NIKKEI: "I:NI225" };
    const ticker = indexMap[s] || ("I:" + s);
    payload = await fetchJson(base + "/v3/snapshot?ticker=" + encodeURIComponent(ticker) + "&apiKey=" + encodeURIComponent(apiKey), { timeoutMs: REQUEST_TIMEOUT_MS });
  } else {
    throw new Error("MASSIVE_CATEGORY_NOT_MAPPED");
  }

  const row = Array.isArray(payload?.tickers) ? payload.tickers[0] : Array.isArray(payload?.results) ? payload.results[0] : payload?.results || payload?.ticker || null;
  if (!row) throw new Error("MASSIVE_QUOTE_EMPTY");
  const lastQuote = row?.lastQuote || row?.last_quote || {};
  const day = row?.day || {};
  const lastTrade = row?.lastTrade || row?.last_trade || {};
  const price = finite(lastQuote?.mid ?? lastQuote?.a ?? lastQuote?.p ?? lastTrade?.p ?? row?.price ?? day?.c);
  const timestamp = timestampMs(row?.updated ?? lastQuote?.t ?? lastTrade?.t);
  if (!(price > 0)) throw new Error("MASSIVE_PRICE_EMPTY");
  return {
    symbol: s,
    price,
    bid: finite(lastQuote?.b ?? lastQuote?.p),
    ask: finite(lastQuote?.a ?? lastQuote?.P),
    change: finite(row?.todaysChangePerc),
    volume: finite(day?.v),
    high: finite(day?.h),
    low: finite(day?.l),
    timestamp,
    source: "Massive market snapshot",
    provider: "massive"
  };
}

async function readDeriv(symbol, derivFeed) {
  if (!derivFeed) throw new Error("DERIV_FEED_NOT_AVAILABLE");
  const quote = await derivFeed.getQuote(symbol, { maxAgeMs: DEFAULT_FRESHNESS_MS, timeoutMs: REQUEST_TIMEOUT_MS });
  if (!(Number(quote?.price) > 0)) throw new Error("DERIV_QUOTE_EMPTY");
  return {
    symbol,
    price: quote.price,
    bid: quote.bid,
    ask: quote.ask,
    timestamp: finite(quote.epoch) !== null ? Number(quote.epoch) * 1000 : Date.now(),
    source: quote.source || "Deriv public live feed",
    provider: "deriv"
  };
}

export class MarketDataFabric {
  constructor({ twelveData = null, goldFeed = getGoldPriceFeed(), derivFeed = getDerivMarketFeed(), massiveApiKey = process.env.MASSIVE_API_KEY || "" } = {}) {
    this.twelveData = twelveData;
    this.goldFeed = goldFeed;
    this.derivFeed = derivFeed;
    this.massiveApiKey = String(massiveApiKey || "").trim();
  }

  providerStatus() {
    return {
      "gold-api": { configured: true, capability: "XAU/XAG spot", tier: "FREE_PUBLIC" },
      "twelve-data": { configured: Boolean(this.twelveData?.enabled), capability: "FX/crypto/selected instruments + OHLC", tier: "API_KEY" },
      "binance": { configured: true, capability: "crypto spot", tier: "FREE_PUBLIC" },
      massive: { configured: Boolean(this.massiveApiKey), capability: "stocks/forex/crypto/indices", tier: this.massiveApiKey ? "API_KEY" : "OPTIONAL" },
      deriv: { configured: Boolean(this.derivFeed), capability: "broker/synthetic fallback", tier: "FREE_PUBLIC" }
    };
  }

  capabilities() {
    return {
      metals: ["XAUUSD", "XAGUSD"],
      forex: ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD", "EURGBP", "EURJPY", "GBPJPY"],
      crypto: Object.keys(CRYPTO_QUOTES),
      indices: ["SPX", "NASDAQ", "DJI", "DAX", "FTSE", "NIKKEI"],
      stocks: "Any supported US stock ticker via configured Massive/Twelve Data",
      commodities: ["USOIL", "UKOIL", "BRENT", "WTI", "NATGAS", "COPPER", "PLATINUM", "PALLADIUM"],
      synthetic: "Dynamic Deriv synthetic universe"
    };
  }

  async getQuote(input) {
    const symbol = normalizeMarketSymbol(input);
    if (!symbol || symbol.length < 3) {
      return { symbol, available: false, verified: false, error: "MARKET_SYMBOL_REQUIRED", provider: "KINGBOT_MARKET_DATA_FABRIC" };
    }

    const category = classifyMarketSymbol(symbol);
    const failures = [];
    const providerList = SOURCE_ORDER[category] || SOURCE_ORDER.unknown;

    for (const provider of providerList) {
      try {
        let raw;
        if (provider === "gold-api") raw = await readGoldApi(symbol, this.goldFeed);
        else if (provider === "binance") raw = await readBinance(symbol);
        else if (provider === "twelve-data") raw = await readTwelveData(symbol, this.twelveData);
        else if (provider === "massive") raw = await readMassive(symbol, category, this.massiveApiKey);
        else if (provider === "deriv") raw = await readDeriv(symbol, this.derivFeed);
        else continue;

        const quote = normalizeQuote({
          symbol,
          category,
          ...raw,
          freshnessMaxAgeMs: Number(raw?.freshnessMaxAgeMs) || (
            raw?.provider === "gold-api.com" || provider === "gold-api"
              ? Number(process.env.KINGBOT_GOLDPRICE_MAX_AGE_MS || 120000)
              : DEFAULT_FRESHNESS_MS
          )
        });

        if (quote.available) {
          return {
            ok: true,
            ...quote,
            fallbackUsed: failures.length > 0,
            failedProviders: failures
          };
        }
        failures.push({ provider, error: "STALE_QUOTE" });
      } catch (error) {
        failures.push({ provider, error: String(error?.message || "PROVIDER_UNAVAILABLE").slice(0, 160) });
      }
    }

    return {
      ok: false,
      symbol,
      category,
      available: false,
      verified: false,
      price: null,
      timestamp: null,
      ageMs: null,
      freshnessMaxAgeMs: DEFAULT_FRESHNESS_MS,
      provider: "KINGBOT_MARKET_DATA_FABRIC",
      source: "No configured provider returned a fresh verified quote",
      executionAuthorized: false,
      executionAuthority: "NONE",
      failures
    };
  }

  async getQuotes(symbols) {
    const requested = [...new Set((Array.isArray(symbols) ? symbols : String(symbols || "").split(",")).map(normalizeMarketSymbol).filter(Boolean))].slice(0, 60);
    const rows = await Promise.all(requested.map(symbol => this.getQuote(symbol)));
    return rows;
  }

  async snapshot(symbols) {
    const quotes = await this.getQuotes(symbols);
    return {
      ok: quotes.some(q => q.available),
      provider: "KINGBOT_MARKET_DATA_FABRIC",
      model: "KMF-1",
      generatedAt: new Date().toISOString(),
      sourcePolicy: "Primary specialist source with explicit fallback, freshness and verification; no provider silently authorizes execution.",
      providers: this.providerStatus(),
      quotes,
      liveCount: quotes.filter(q => q.available).length,
      verifiedCount: quotes.filter(q => q.verified).length,
      requestedCount: quotes.length
    };
  }
}

export function getMarketDataFabric(options = {}) {
  return new MarketDataFabric(options);
}
