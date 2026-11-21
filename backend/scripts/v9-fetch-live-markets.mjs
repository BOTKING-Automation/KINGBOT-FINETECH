import fs from "node:fs/promises";
import path from "node:path";
import { getDerivMarketFeed } from "../src/deriv-market-feed.js";

const OUTPUT = process.argv[2] || "/tmp/kingbot-v9-live-markets.json";
const HISTORY_LIMIT = Math.max(360, Math.min(3000, Number(process.env.KINGBOT_V9_HISTORY_LIMIT || 2500)));
const SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD"];
const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h"];
const API_BASE = "https://api.binance.com/api/v3/klines";
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

async function fetchBinanceBars(timeframe) {
  // Binance allows at most 1,000 klines per request. Page backwards so BTC
  // history has the same requested depth as the FX/gold panel where possible.
  const merged = new Map();
  const nowMs = Date.now();
  let endTime = nowMs;
  let previousOldest = Infinity;
  const maxPages = Math.max(2, Math.ceil(HISTORY_LIMIT / 900) + 2);

  for (let page = 0; page < maxPages && merged.size < HISTORY_LIMIT; page++) {
    const url = API_BASE + "?symbol=BTCUSDT&interval=" + encodeURIComponent(timeframe) +
      "&limit=1000&endTime=" + endTime;
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20000)
    });
    const rows = await response.json().catch(() => []);
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
  try {
    const bars = await fetchBinanceBars(timeframe);
    if (bars.length >= 360) return { bars, source: "BINANCE_SPOT_BTCUSDT" };
    throw new Error("BINANCE_INSUFFICIENT_CLOSED_BARS:" + bars.length);
  } catch (binanceError) {
    try {
      const bars = await fetchKrakenBars(timeframe);
      if (bars.length < 360) throw new Error("KRAKEN_INSUFFICIENT_CLOSED_BARS:" + bars.length);
      return { bars, source: "KRAKEN_SPOT_XBTUSD_FALLBACK" };
    } catch (krakenError) {
      throw new Error("BTC_HISTORY_FAILED:BINANCE=" + String(binanceError?.message || binanceError).slice(0, 100) +
        ";KRAKEN=" + String(krakenError?.message || krakenError).slice(0, 140));
    }
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
      "user-agent": "Mozilla/5.0 KINGBOT-V9-Audit/1.0"
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
  try {
    for (const timeframe of TIMEFRAMES) {
      marketsByTimeframe[timeframe] = [];
      for (const symbol of SYMBOLS) {
        try {
          let bars;
          let source;
          if (symbol === "BTCUSD") {
            const fetched = await fetchBitcoinBars(timeframe);
            bars = fetched.bars;
            source = fetched.source;
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
          marketsByTimeframe[timeframe].push({ symbol, source, bars });
          summary.push({ timeframe, symbol, source, bars: bars.length, first: bars[0].time, last: bars[bars.length - 1].time });
          console.log("[KINGBOT V9 DATA] READY", JSON.stringify({ timeframe, symbol, source, bars: bars.length }));
        } catch (error) {
          const failure = { timeframe, symbol, error: String(error?.message || "HISTORY_FETCH_FAILED").slice(0, 300) };
          failures.push(failure);
          console.warn("[KINGBOT V9 DATA] FAILED", JSON.stringify(failure));
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
    fetchFailures: failures
  };
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, JSON.stringify(payload), "utf8");
  console.log("[KINGBOT V9 DATA] COMPLETE", JSON.stringify({
    output: OUTPUT,
    markets: summary.length,
    failures: failures.length,
    byTimeframe: Object.fromEntries(TIMEFRAMES.map(tf => [tf, marketsByTimeframe[tf].length]))
  }));
  if (summary.length === 0) process.exitCode = 2;
}

main().catch(error => {
  console.error("[KINGBOT V9 DATA] FATAL", error?.stack || error);
  process.exitCode = 1;
});
