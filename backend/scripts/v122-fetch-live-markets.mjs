import fs from "node:fs/promises";
import path from "node:path";
import { getDerivMarketFeed } from "../src/deriv-market-feed.js";

const OUTPUT = process.argv[2] || "/tmp/kingbot-v122-input.json";
const HISTORY_LIMIT = Math.max(360, Math.min(3000, Number(process.env.KINGBOT_V9_HISTORY_LIMIT || 2500)));
const SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD"];
const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h"];
const BINANCE_KLINE_BASES = [
  // Binance documents this host specifically for public market-data endpoints.
  { name: "BINANCE_PUBLIC_MARKET_DATA", source: "BINANCE_DATA_API_SPOT_BTCUSDT", url: "https://data-api.binance.vision/api/v3/klines" },
  { name: "BINANCE_SPOT_API", source: "BINANCE_SPOT_BTCUSDT", url: "https://api.binance.com/api/v3/klines" },
  { name: "BINANCE_GCP_SPOT_API", source: "BINANCE_GCP_SPOT_BTCUSDT", url: "https://api-gcp.binance.com/api/v3/klines" }
];
const MIN_BINANCE_HISTORY = Math.min(HISTORY_LIMIT, Math.max(360, Math.ceil(HISTORY_LIMIT * 0.80)));
const KRAKEN_INTERVALS = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240 };
const YAHOO_TICKERS_1M = {
  XAUUSD: "XAUUSD=X",
  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  USDJPY: "JPY=X"
};

function toBars(rows, timeIndex, openIndex, highIndex, lowIndex, closeIndex, volumeIndex) {
  return rows.map(row => ({
    time: new Date(Number(row[timeIndex]) * (Number(row[timeIndex]) > 1e12 ? 1 : 1000)).toISOString(),
    open: Number(row[openIndex]),
    high: Number(row[highIndex]),
    low: Number(row[lowIndex]),
    close: Number(row[closeIndex]),
    volume: Number(row[volumeIndex])
  })).filter(bar => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
}

async function fetchBinanceBars(timeframe, baseUrl) {
  // Binance permits at most 1,000 klines per request. Page backwards by
  // endTime, deduplicate open times, and retain only fully closed candles.
  const merged = new Map();
  const nowMs = Date.now();
  let endTime = nowMs;
  let previousOldest = Infinity;
  const maxPages = Math.max(2, Math.ceil(HISTORY_LIMIT / 900) + 2);

  for (let page = 0; page < maxPages && merged.size < HISTORY_LIMIT; page++) {
    const url = baseUrl + "?symbol=BTCUSDT&interval=" + encodeURIComponent(timeframe) +
      "&limit=1000&endTime=" + endTime;
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20000)
    });
    const rows = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(rows)) {
      throw new Error("BINANCE_HISTORY_HTTP_" + response.status);
    }
    if (!rows.length) break;

    const closedRows = rows.filter(row => Array.isArray(row) && Number(row[6]) < nowMs);
    for (const bar of toBars(closedRows, 0, 1, 2, 3, 4, 5)) {
      const timestamp = Date.parse(bar.time);
      if (Number.isFinite(timestamp)) merged.set(timestamp, bar);
    }

    const oldestOpen = Number(rows[0][0]);
    if (!Number.isFinite(oldestOpen) || oldestOpen <= 0 || oldestOpen >= previousOldest) break;
    previousOldest = oldestOpen;
    if (rows.length < 1000) break;
    endTime = oldestOpen - 1;
  }

  return [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bar]) => bar)
    .slice(-HISTORY_LIMIT);
}

async function fetchKrakenBars(timeframe) {
  const interval = KRAKEN_INTERVALS[timeframe];
  if (!interval) throw new Error("KRAKEN_TIMEFRAME_UNSUPPORTED");
  const count = Math.min(720, HISTORY_LIMIT + 10);
  const since = Math.floor(Date.now() / 1000) - interval * 60 * count;
  const url = "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=" + interval + "&since=" + since;
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || !Array.isArray(payload.error) || payload.error.length || !payload.result) {
    throw new Error("KRAKEN_HISTORY_HTTP_" + response.status + ":" + JSON.stringify(payload?.error || []).slice(0, 120));
  }
  const key = Object.keys(payload.result).find(name => name !== "last");
  const rows = Array.isArray(payload.result[key]) ? payload.result[key] : [];
  // Kraken OHLC row: time, open, high, low, close, VWAP, volume, trades.
  return toBars(rows.slice(0, -1).slice(-HISTORY_LIMIT), 0, 1, 2, 3, 4, 6);
}

async function fetchBitcoinBars(timeframe) {
  const attempts = [];
  for (const provider of BINANCE_KLINE_BASES) {
    try {
      const bars = await fetchBinanceBars(timeframe, provider.url);
      if (bars.length < MIN_BINANCE_HISTORY) {
        attempts.push({
          provider: provider.name,
          status: "INSUFFICIENT_CLOSED_HISTORY",
          bars: bars.length,
          required: MIN_BINANCE_HISTORY
        });
        continue;
      }
      attempts.push({ provider: provider.name, status: "OK", bars: bars.length });
      return {
        bars,
        source: provider.source,
        quality: "FULL_DEPTH",
        providerAttempts: attempts
      };
    } catch (error) {
      attempts.push({
        provider: provider.name,
        status: "ERROR",
        error: String(error?.message || error).slice(0, 180)
      });
    }
  }

  try {
    const bars = await fetchKrakenBars(timeframe);
    if (bars.length < 360) throw new Error("KRAKEN_INSUFFICIENT_CLOSED_BARS:" + bars.length);
    const quality = bars.length >= MIN_BINANCE_HISTORY ? "FULL_DEPTH" : "DEGRADED_DEPTH";
    attempts.push({
      provider: "KRAKEN_OHLC",
      status: quality === "FULL_DEPTH" ? "OK" : "DEGRADED_FALLBACK",
      bars: bars.length,
      required: MIN_BINANCE_HISTORY
    });
    return {
      bars,
      source: "KRAKEN_SPOT_XBTUSD_FALLBACK",
      quality,
      providerAttempts: attempts
    };
  } catch (error) {
    attempts.push({
      provider: "KRAKEN_OHLC",
      status: "ERROR",
      error: String(error?.message || error).slice(0, 180)
    });
    throw new Error("BTC_HISTORY_FAILED:" + JSON.stringify(attempts).slice(0, 700));
  }
}

async function fetchDerivBars(feed, symbol, timeframe) {
  const merged = new Map();
  let end = "latest";
  let previousOldestEpoch = Infinity;
  const maxPages = Math.max(2, Math.ceil(HISTORY_LIMIT / 450) + 1);

  for (let page = 0; page < maxPages && merged.size < HISTORY_LIMIT; page++) {
    let chunk;
    try {
      chunk = await feed.getHistoricalCandles(symbol, {
        timeframe,
        limit: 500,
        timeoutMs: 15000,
        end
      });
    } catch (error) {
      if (merged.size >= 360) break;
      throw error;
    }
    if (!Array.isArray(chunk) || chunk.length < 20) {
      if (!merged.size) throw new Error("DERIV_HISTORICAL_CANDLES_INSUFFICIENT");
      break;
    }

    for (const bar of chunk) {
      const timestamp = Date.parse(bar.time);
      if (Number.isFinite(timestamp)) merged.set(timestamp, bar);
    }

    const oldestEpoch = Math.floor(Math.min(...chunk.map(bar => Date.parse(bar.time))) / 1000);
    if (!Number.isFinite(oldestEpoch) || oldestEpoch >= previousOldestEpoch) break;
    previousOldestEpoch = oldestEpoch;
    end = oldestEpoch - 1;
  }

  return [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bar]) => bar)
    .slice(-HISTORY_LIMIT);
}

async function fetchYahoo1mBars(symbol) {
  const ticker = YAHOO_TICKERS_1M[symbol];
  if (!ticker) throw new Error("YAHOO_1M_TICKER_NOT_CONFIGURED");
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(ticker) + "?range=7d&interval=1m&events=history";
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 KINGBOT-V12.2-Research/1.0"
    },
    signal: AbortSignal.timeout(20000)
  });
  const payload = await response.json().catch(() => null);
  const chart = payload?.chart?.result?.[0];
  if (!response.ok || !chart || payload?.chart?.error) {
    throw new Error("YAHOO_1M_HISTORY_HTTP_" + response.status + ":" +
      String(payload?.chart?.error?.description || "").slice(0, 120));
  }
  const timestamps = chart.timestamp || [];
  const quote = chart.indicators?.quote?.[0] || {};
  const rows = timestamps.map((timestamp, index) => ({
    time: new Date(Number(timestamp) * 1000).toISOString(),
    open: Number(quote.open?.[index]),
    high: Number(quote.high?.[index]),
    low: Number(quote.low?.[index]),
    close: Number(quote.close?.[index]),
    volume: Number(quote.volume?.[index] ?? 0)
  })).filter(bar => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
  const bars = rows.slice(0, -1).slice(-HISTORY_LIMIT);
  if (bars.length < 360) throw new Error("YAHOO_1M_INSUFFICIENT_CLOSED_BARS:" + bars.length);
  return { bars, source: "YAHOO_FINANCE_" + ticker + "_1M_SPOT" };
}

async function main() {
  const feed = getDerivMarketFeed();
  const marketsByTimeframe = {};
  const failures = [];
  const summary = [];
  const fetchWarnings = [];
  try {
    for (const timeframe of TIMEFRAMES) {
      marketsByTimeframe[timeframe] = [];
      for (const symbol of SYMBOLS) {
        try {
          let bars;
          let source;
          let providerAttempts = [];
          let quality = "STANDARD";
          if (symbol === "BTCUSD") {
            const fetched = await fetchBitcoinBars(timeframe);
            bars = fetched.bars;
            source = fetched.source;
            providerAttempts = fetched.providerAttempts || [];
            quality = fetched.quality || "UNKNOWN";
            if (quality !== "FULL_DEPTH") {
              fetchWarnings.push({
                type: "BTC_HISTORY_DEPTH_DEGRADED",
                timeframe,
                bars: bars.length,
                requested: HISTORY_LIMIT,
                attempts: providerAttempts
              });
            }
          } else {
            try {
              bars = await fetchDerivBars(feed, symbol, timeframe);
              bars = bars.slice(0, -1);
              source = "DERIV_PUBLIC_HISTORICAL_CANDLES_PAGED";
              if (timeframe === "1m" && bars.length < 360) {
                throw new Error("DERIV_1M_HISTORY_TOO_SHORT:" + bars.length);
              }
            } catch (derivError) {
              if (timeframe !== "1m") throw derivError;
              const fallback = await fetchYahoo1mBars(symbol);
              bars = fallback.bars;
              source = fallback.source;
            }
          }
          if (!Array.isArray(bars) || bars.length < 360) {
            throw new Error("INSUFFICIENT_CLOSED_BARS:" + (bars?.length || 0));
          }
          marketsByTimeframe[timeframe].push({ symbol, source, quality, providerAttempts, bars });
          summary.push({
            timeframe, symbol, source, quality, providerAttempts,
            bars: bars.length,
            historyCoverage: Number((bars.length / HISTORY_LIMIT).toFixed(4)),
            first: bars[0].time,
            last: bars[bars.length - 1].time
          });
          console.log("[KINGBOT V12.2 DATA] READY", JSON.stringify({ timeframe, symbol, source, bars: bars.length }));
        } catch (error) {
          const failure = { timeframe, symbol, error: String(error?.message || "HISTORY_FETCH_FAILED").slice(0, 300) };
          failures.push(failure);
          console.warn("[KINGBOT V12.2 DATA] FAILED", JSON.stringify(failure));
        }
      }
    }
  } finally {
    feed.close();
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    historyLimit: HISTORY_LIMIT,
    symbols: SYMBOLS,
    timeframes: TIMEFRAMES,
    marketsByTimeframe,
    fetchSummary: summary,
    fetchWarnings,
    fetchFailures: failures
  };
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, JSON.stringify(payload), "utf8");
  console.log("[KINGBOT V12.2 DATA] COMPLETE", JSON.stringify({
    output: OUTPUT,
    markets: summary.length,
    failures: failures.length,
    byTimeframe: Object.fromEntries(TIMEFRAMES.map(tf => [tf, marketsByTimeframe[tf].length]))
  }));
  if (summary.length === 0) process.exitCode = 2;
}

main().catch(error => {
  console.error("[KINGBOT V12.2 DATA] FATAL", error?.stack || error);
  process.exitCode = 1;
});
