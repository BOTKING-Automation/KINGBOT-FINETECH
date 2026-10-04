import { getDerivMarketFeed } from "./deriv-market-feed.js";
import { getGoldPriceFeed } from "./gold-price-feed.js";
import { syntheticCatalog, CORE_SYNTHETIC_FAMILIES } from "./synthetic-markets.js";
import { MarketDataFabric } from "./market-data-fabric.js";

const TRADITIONAL_MARKETS = [
  { id: "XAUUSD", name: "Gold / US Dollar", category: "metals", sourceSymbol: "XAUUSD" },
  { id: "XAGUSD", name: "Silver / US Dollar", category: "metals", sourceSymbol: "XAGUSD" },
  { id: "EURUSD", name: "Euro / US Dollar", category: "forex", sourceSymbol: "EURUSD" },
  { id: "GBPUSD", name: "British Pound / US Dollar", category: "forex", sourceSymbol: "GBPUSD" },
  { id: "USDJPY", name: "US Dollar / Japanese Yen", category: "forex", sourceSymbol: "USDJPY" },
  { id: "NASDAQ", name: "Nasdaq 100", category: "indices", sourceSymbol: "NASDAQ" }
];

const CRYPTO_MARKETS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT",
  "ADAUSDT","AVAXUSDT","LINKUSDT","LTCUSDT","TRXUSDT","UNIUSDT",
  "NEARUSDT","INJUSDT","SUIUSDT"
].map(id => ({
  id,
  name: id.replace("USDT","") + " / USDT",
  category: "crypto",
  binance: id
}));

const BINANCE_ENDPOINTS = [
  "https://api.binance.com/api/v3/ticker/24hr",
  "https://data-api.binance.vision/api/v3/ticker/24hr"
];

const DERIV = getDerivMarketFeed();
const GOLD = getGoldPriceFeed();
let snapshotCache = { at: 0, value: null, key: "" };
let refreshPromise = null;

const finite = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const ageMs = timestamp => {
  const t = Number(timestamp);
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : null;
};

async function fetchWithTimeout(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 4500));
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBinanceQuotes() {
  const symbols = CRYPTO_MARKETS.map(m => m.binance);
  const encoded = encodeURIComponent(JSON.stringify(symbols));
  let lastError = null;

  for (const base of BINANCE_ENDPOINTS) {
    try {
      const response = await fetchWithTimeout(base + "?symbols=" + encoded, 4500);
      if (!response.ok) throw new Error("BINANCE_HTTP_" + response.status);
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error("BINANCE_RESPONSE_INVALID");

      const map = new Map();
      for (const row of rows) {
        const market = CRYPTO_MARKETS.find(m => m.binance === String(row?.symbol || "").toUpperCase());
        if (!market) continue;

        const price = finite(row?.lastPrice);
        if (price === null) continue;

        const timestamp = finite(row?.closeTime) || Date.now();
        map.set(market.id, {
          symbol: market.id,
          name: market.name,
          category: market.category,
          price,
          change: finite(row?.priceChangePercent),
          volume: finite(row?.quoteVolume),
          high: finite(row?.highPrice),
          low: finite(row?.lowPrice),
          timestamp,
          time: new Date(timestamp).toISOString(),
          ageMs: ageMs(timestamp),
          available: true,
          source: "Binance public live ticker"
        });
      }

      return [...map.values()];
    } catch (error) {
      lastError = error;
    }
  }

  return CRYPTO_MARKETS.map(m => ({
    symbol: m.id,
    name: m.name,
    category: m.category,
    available: false,
    source: "Binance public live ticker",
    error: String(lastError?.message || "BINANCE_LIVE_DATA_UNAVAILABLE").slice(0, 120)
  }));
}

async function fetchTraditionalQuotes(twelveData) {
  const symbols = TRADITIONAL_MARKETS.map(m => m.id);
  let primary = [];
  let goldDirect = null;

  const [goldResult] = await Promise.all([
    GOLD.getQuote().catch(error => ({
      symbol:"XAUUSD",
      available:false,
      verified:false,
      source:"Gold API direct free XAU/USD price",
      error:String(error?.message || "GOLD_API_DIRECT_FEED_UNAVAILABLE").slice(0,140)
    })),
    Promise.resolve()
  ]);
  if (goldResult?.available) goldDirect = goldResult;

  if (twelveData?.enabled) {
    try {
      primary = await twelveData.latestQuotes(symbols, {
        allowRestFallback: true,
        restTimeoutMs: 1800
      });
    } catch {}
  }

  const bySymbol = new Map(
    primary.filter(q => q?.available).map(q => [String(q.symbol).toUpperCase(), q])
  );

  const missing = symbols.filter(symbol => !bySymbol.has(symbol));
  if (missing.length) {
    const derivRows = await Promise.all(missing.map(async symbol => {
      try {
        const quote = await DERIV.getQuote(symbol, { maxAgeMs: 3000, timeoutMs: 3500 });
        return {
          symbol,
          price: finite(quote.price),
          bid: finite(quote.bid),
          ask: finite(quote.ask),
          spread: finite(quote.bid) !== null && finite(quote.ask) !== null ? finite(quote.ask) - finite(quote.bid) : null,
          timestamp: finite(quote.epoch) !== null ? Number(quote.epoch) * 1000 : Date.now(),
          time: quote.time || null,
          ageMs: Number(quote.ageMs || Math.max(0, Date.now() - Number(quote.receivedAt || Date.now()))),
          available: true,
          quoteMode: "LIVE",
          source: quote.source || "Deriv shared live feed"
        };
      } catch (liveError) {
        try {
          const quote = await DERIV.getLatestAvailableQuote(symbol, { timeoutMs: 4500 });
          const timestamp = finite(quote.epoch) !== null ? Number(quote.epoch) * 1000 : Date.now();
          return {
            symbol,
            price: finite(quote.price),
            bid: finite(quote.bid),
            ask: finite(quote.ask),
            spread: null,
            timestamp,
            time: quote.time || null,
            ageMs: Math.max(0, Date.now() - Number(timestamp || Date.now())),
            available: false,
            quoteMode: "LAST_AVAILABLE",
            source: quote.source || "Deriv last available tick",
            error: String(liveError?.message || "DERIV_LIVE_QUOTE_UNAVAILABLE").slice(0, 120)
          };
        } catch (historyError) {
          return {
            symbol,
            available: false,
            quoteMode: "UNAVAILABLE",
            source: "Deriv market feed",
            error: String(historyError?.message || liveError?.message || "DERIV_MARKET_QUOTE_UNAVAILABLE").slice(0, 120)
          };
        }
      }
    }));
    for (const row of derivRows) {
      if (row.available) bySymbol.set(row.symbol, row);
      else if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, row);
    }
  }

  return TRADITIONAL_MARKETS.map(market => {
    const base = bySymbol.get(market.id) || { symbol: market.id, available: false };
    const quote = market.id === "XAUUSD" && goldDirect
      ? { ...base, ...goldDirect, change: base.change, volume: base.volume, high: base.high, low: base.low }
      : base;
    return {
      symbol: market.id,
      name: market.name,
      category: market.category,
      price: finite(quote.price),
      bid: finite(quote.bid),
      ask: finite(quote.ask),
      spread: finite(quote.spread),
      change: finite(quote.change),
      volume: finite(quote.volume),
      high: finite(quote.high),
      low: finite(quote.low),
      timestamp: finite(quote.timestamp) || Date.now(),
      time: quote.time || quote.computedAt || null,
      ageMs: Number(quote.ageMs ?? ageMs(quote.timestamp)),
      freshnessMaxAgeMs: finite(quote.freshnessMaxAgeMs),
      quoteVerified: Boolean(quote.verified),
      available: Boolean(quote.available && Number.isFinite(Number(quote.price))),
      quoteMode: quote.quoteMode || (quote.available ? "LIVE" : (Number.isFinite(Number(quote.price)) ? "LAST_AVAILABLE" : "UNAVAILABLE")),
      source: quote.source || "KINGBOT shared live market feed",
      error: quote.error || null
    };
  });
}

async function loadSyntheticUniverse() {
  try {
    const rows = await DERIV.getActiveSymbols({ timeoutMs: 7000 });
    return syntheticCatalog(rows).slice(0, 100);
  } catch {
    return [];
  }
}

async function fetchSyntheticQuotes(markets) {
  if (!markets.length) return [];

  return Promise.all(markets.map(async market => {
    try {
      const quote = await DERIV.getQuote(market.symbol, { maxAgeMs: 3000, timeoutMs: 3500 });
      const timestamp = finite(quote.epoch) !== null ? Number(quote.epoch) * 1000 : Date.now();
      return {
        symbol: String(market.symbol).toUpperCase(),
        brokerSymbol: quote.brokerSymbol || market.symbol,
        name: market.name || market.displayName || market.symbol,
        category: "synthetics",
        syntheticFamily: market.familyLabel || market.family || null,
        price: finite(quote.price),
        bid: finite(quote.bid),
        ask: finite(quote.ask),
        spread: finite(quote.bid) !== null && finite(quote.ask) !== null ? finite(quote.ask) - finite(quote.bid) : null,
        timestamp,
        time: quote.time || new Date(timestamp).toISOString(),
        ageMs: Number(quote.ageMs || Math.max(0, Date.now() - Number(quote.receivedAt || Date.now()))),
        available: true,
        source: quote.source || "Deriv shared synthetic live feed"
      };
    } catch (error) {
      return {
        symbol: String(market.symbol).toUpperCase(),
        brokerSymbol: market.symbol,
        name: market.name || market.displayName || market.symbol,
        category: "synthetics",
        syntheticFamily: market.familyLabel || market.family || null,
        available: false,
        source: "Deriv shared synthetic live feed",
        error: String(error?.message || "SYNTHETIC_LIVE_QUOTE_UNAVAILABLE").slice(0, 120)
      };
    }
  }));
}

function buildBreadth(quotes) {
  const tradable = quotes.filter(q => q.available && Number.isFinite(Number(q.change)));
  const up = tradable.filter(q => Number(q.change) > 0).length;
  const down = tradable.filter(q => Number(q.change) < 0).length;
  const flat = Math.max(0, tradable.length - up - down);
  const avgChange = tradable.length
    ? tradable.reduce((sum, q) => sum + Number(q.change), 0) / tradable.length
    : null;

  return {
    tracked: quotes.length,
    live: quotes.filter(q => q.available).length,
    changeAware: tradable.length,
    up,
    down,
    flat,
    avgChange
  };
}

function compactCrossMarket(quotes) {
  const live = quotes.filter(q => q.available && Number.isFinite(Number(q.price)));
  const movers = live
    .filter(q => Number.isFinite(Number(q.change)))
    .sort((a, b) => Math.abs(Number(b.change)) - Math.abs(Number(a.change)));

  return {
    breadth: buildBreadth(quotes),
    strongest: movers.filter(q => Number(q.change) > 0).slice(0, 5).map(q => ({
      symbol: q.symbol, change: Number(q.change), price: Number(q.price)
    })),
    weakest: movers.filter(q => Number(q.change) < 0).slice(0, 5).map(q => ({
      symbol: q.symbol, change: Number(q.change), price: Number(q.price)
    }))
  };
}

async function refreshSnapshot({ twelveData, includeSynthetics = true } = {}) {
  const fabric = new MarketDataFabric({ twelveData });
  const requested = [
    ...TRADITIONAL_MARKETS.map(m => m.id),
    ...CRYPTO_MARKETS.map(m => m.id)
  ];
  const [fabricQuotes, syntheticMarkets] = await Promise.all([
    fabric.getQuotes(requested),
    includeSynthetics ? loadSyntheticUniverse() : Promise.resolve([])
  ]);

  const quoteMap = new Map(fabricQuotes.map(q => [q.symbol, q]));
  const mapFabricQuote = (market, category) => {
    const q = quoteMap.get(market.id) || { symbol: market.id, available: false, verified: false, source: "KINGBOT market data fabric" };
    const parsedTimestamp = q.timestamp ? Date.parse(q.timestamp) : NaN;
    return {
      symbol: market.id,
      name: market.name,
      category,
      price: finite(q.price),
      bid: finite(q.bid),
      ask: finite(q.ask),
      spread: finite(q.spread),
      change: finite(q.change),
      volume: finite(q.volume),
      high: finite(q.high),
      low: finite(q.low),
      timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now(),
      time: q.timestamp || null,
      ageMs: Number(q.ageMs ?? 0),
      freshnessMaxAgeMs: finite(q.freshnessMaxAgeMs),
      quoteVerified: Boolean(q.verified),
      available: Boolean(q.available && Number.isFinite(Number(q.price))),
      quoteMode: q.available ? "LIVE" : "UNAVAILABLE",
      source: q.source || "KINGBOT market data fabric",
      provider: q.provider || null,
      fallbackUsed: Boolean(q.fallbackUsed),
      error: q.available ? null : (q.failures || []).map(x => x.provider + ":" + x.error).join(" | ").slice(0, 220) || null
    };
  };

  const traditional = TRADITIONAL_MARKETS.map(m => mapFabricQuote(m, m.category));
  const crypto = CRYPTO_MARKETS.map(m => mapFabricQuote(m, "crypto"));

  const synthetics = includeSynthetics
    ? await fetchSyntheticQuotes(syntheticMarkets)
    : [];

  const quotes = [...traditional, ...crypto, ...synthetics];
  const live = quotes.filter(q => q.available && Number.isFinite(Number(q.price)));

  return {
    ok: live.length > 0,
    provider: "KINGBOT_SHARED_MARKET_FEED",
    model: "KINGBOT-CORTEX-1",
    generatedAt: new Date().toISOString(),
    freshnessMs: 0,
    marketTypes: {
      traditional: traditional.map(q => q.symbol),
      crypto: crypto.map(q => q.symbol),
      synthetic: synthetics.map(q => q.symbol)
    },
    families: CORE_SYNTHETIC_FAMILIES,
    universe: quotes.map(q => ({
      symbol: q.symbol,
      name: q.name,
      category: q.category,
      syntheticFamily: q.syntheticFamily || null
    })),
    quotes,
    crossMarket: compactCrossMarket(quotes),
    sourcePolicy: {
      marketPage: "KINGBOT Market Data Fabric",
      traditional: "Gold API XAU/XAG -> Twelve Data -> Massive -> Deriv fallback",
      crypto: "Binance public spot -> Twelve Data -> Massive fallback",
      visualization: "TradingView widget only",
      synthetic: "Deriv public live feed",
      executionAuthority: "NONE"
    }
  };
}

export async function getMarketPageSnapshot({ twelveData, includeSynthetics = true, force = false } = {}) {
  const key = [
    Boolean(twelveData?.enabled),
    includeSynthetics ? "synthetics" : "nosynthetics"
  ].join(":");

  if (!force && snapshotCache.value && snapshotCache.key === key && Date.now() - snapshotCache.at <= 4000) {
    const age = Math.max(0, Date.now() - snapshotCache.at);
    return {
      ...snapshotCache.value,
      freshnessMs: age,
      cached: true
    };
  }

  if (refreshPromise && snapshotCache.key === key) {
    const value = await refreshPromise;
    return { ...value, freshnessMs: Math.max(0, Date.now() - snapshotCache.at), cached: true };
  }

  refreshPromise = refreshSnapshot({ twelveData, includeSynthetics })
    .then(value => {
      snapshotCache = { at: Date.now(), value, key };
      return value;
    })
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

export function marketPageSymbols({ includeSynthetics = false } = {}) {
  return [
    ...TRADITIONAL_MARKETS.map(m => m.id),
    ...CRYPTO_MARKETS.map(m => m.id),
    ...(includeSynthetics ? ["<dynamic-synthetics>"] : [])
  ];
}
