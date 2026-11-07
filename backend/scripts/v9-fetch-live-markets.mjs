import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDerivMarketFeed } from "../src/deriv-market-feed.js";

const OUTPUT = process.argv[2] || "/tmp/kingbot-v9-live-markets.json";
const HISTORY_LIMIT = Math.max(360, Math.min(1000, Number(process.env.KINGBOT_V9_HISTORY_LIMIT || 600)));
const SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD"];
const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h"];
const BINANCE_INTERVALS = new Set(TIMEFRAMES);
const API_BASE = "https://api.binance.com/api/v3/klines";

async function fetchBinanceBars(timeframe) {
  if (!BINANCE_INTERVALS.has(timeframe)) throw new Error("BINANCE_TIMEFRAME_UNSUPPORTED");
  const url = API_BASE + "?symbol=BTCUSDT&interval=" + encodeURIComponent(timeframe) + "&limit=1000";
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  const rows = await response.json().catch(() => []);
  if (!response.ok || !Array.isArray(rows)) throw new Error("BINANCE_HISTORY_HTTP_" + response.status);
  // Exclude the latest still-forming candle and retain the most recent closed candles.
  return rows.slice(0, -1).slice(-HISTORY_LIMIT).map(row => ({
    time: new Date(Number(row[0])).toISOString(),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5])
  })).filter(bar => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
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
            bars = await fetchBinanceBars(timeframe);
            source = "BINANCE_SPOT_BTCUSDT";
          } else {
            bars = await feed.getHistoricalCandles(symbol, {
              timeframe,
              limit: HISTORY_LIMIT,
              timeoutMs: 15000
            });
            // Avoid training on the current candle if the upstream includes it.
            bars = bars.slice(0, -1);
            source = "DERIV_PUBLIC_HISTORICAL_CANDLES";
          }
          if (!Array.isArray(bars) || bars.length < 360) {
            throw new Error("INSUFFICIENT_CLOSED_BARS:" + (bars?.length || 0));
          }
          marketsByTimeframe[timeframe].push({ symbol, source, bars });
          summary.push({ timeframe, symbol, source, bars: bars.length, first: bars[0].time, last: bars[bars.length - 1].time });
          console.log("[KINGBOT V9 DATA] READY", JSON.stringify({ timeframe, symbol, source, bars: bars.length }));
        } catch (error) {
          const failure = { timeframe, symbol, error: String(error?.message || "HISTORY_FETCH_FAILED").slice(0, 240) };
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
