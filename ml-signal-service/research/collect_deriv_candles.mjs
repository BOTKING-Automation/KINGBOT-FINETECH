#!/usr/bin/env node
/**
 * Export synchronized, closed OHLC candles from KINGBOT's existing public
 * Deriv market-data endpoint. This utility is offline research support only:
 * it does not authenticate a trading account, place orders, or touch live models.
 *
 * Node.js 22+ is required for the built-in WebSocket implementation.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DERIV_PUBLIC_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
export const DERIV_SYMBOLS = Object.freeze({
  XAUUSD: "frxXAUUSD",
  EURUSD: "frxEURUSD",
  GBPUSD: "frxGBPUSD",
  USDJPY: "frxUSDJPY",
  AUDUSD: "frxAUDUSD",
  USDCAD: "frxUSDCAD",
  USDCHF: "frxUSDCHF",
  NZDUSD: "frxNZDUSD",
});

export const TIMEFRAME_SECONDS = Object.freeze({
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
});

let nextRequestId = 1;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function epochSeconds(value) {
  if (typeof value === "string" && !/^\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  }
  const number = finite(value);
  if (number === null || number <= 0) return null;
  return number > 1e12 ? number / 1000 : number;
}

function normalizeClosedCandles(
  symbol,
  candles,
  intervalSeconds,
  nowEpochSeconds,
) {
  if (!Array.isArray(candles)) {
    throw new Error("DERIV_CANDLE_RESPONSE_INVALID");
  }
  const byTime = new Map();
  for (const candle of candles) {
    if (!candle || typeof candle !== "object") continue;
    const time = epochSeconds(candle.epoch ?? candle.time ?? candle.timestamp);
    if (time === null) continue;
    const epoch = Math.floor(time);
    // A candle is eligible only after its complete timeframe has elapsed.
    if (epoch + intervalSeconds > nowEpochSeconds) continue;

    const open = finite(candle.open);
    const high = finite(candle.high);
    const low = finite(candle.low);
    const close = finite(candle.close);
    const volume = Math.max(0, finite(candle.tick_count ?? candle.volume) ?? 0);
    if (
      ![open, high, low, close].every(value => value !== null && value > 0)
      || high < Math.max(open, low, close)
      || low > Math.min(open, high, close)
    ) continue;

    byTime.set(epoch, {
      time: epoch,
      open,
      high,
      low,
      close,
      volume,
    });
  }
  return { symbol, byTime };
}

/**
 * Pure alignment helper, also covered by offline tests.
 * All markets are restricted to their shared timestamps and fully closed bars.
 */
export function buildAlignedDataset(
  marketRows,
  {
    timeframe = "5m",
    nowEpochSeconds = Date.now() / 1000,
    minAlignedBars = 360,
  } = {},
) {
  const normalizedTimeframe = String(timeframe).toLowerCase();
  const intervalSeconds = TIMEFRAME_SECONDS[normalizedTimeframe];
  if (!intervalSeconds) throw new Error("V13_DERIV_TIMEFRAME_UNSUPPORTED");
  if (!Array.isArray(marketRows) || marketRows.length < 3) {
    throw new Error("V13_DERIV_REQUIRES_AT_LEAST_THREE_MARKETS");
  }

  const seenSymbols = new Set();
  const normalized = marketRows.map(row => {
    const symbol = String(row?.symbol || "").trim().toUpperCase();
    if (!DERIV_SYMBOLS[symbol]) {
      throw new Error("V13_DERIV_SYMBOL_UNSUPPORTED:" + symbol);
    }
    if (seenSymbols.has(symbol)) {
      throw new Error("V13_DERIV_DUPLICATE_SYMBOL:" + symbol);
    }
    seenSymbols.add(symbol);
    return normalizeClosedCandles(
      symbol,
      row.candles,
      intervalSeconds,
      Number(nowEpochSeconds),
    );
  });

  let commonTimes = null;
  for (const market of normalized) {
    const times = new Set(market.byTime.keys());
    commonTimes = commonTimes === null
      ? times
      : new Set([...commonTimes].filter(time => times.has(time)));
  }
  const alignedTimes = [...(commonTimes || [])].sort((a, b) => a - b);
  if (alignedTimes.length < minAlignedBars) {
    throw new Error(
      "V13_DERIV_ALIGNED_HISTORY_INSUFFICIENT:"
      + alignedTimes.length
      + "/"
      + minAlignedBars,
    );
  }

  const markets = normalized.map(market => ({
    symbol: market.symbol,
    bars: alignedTimes.map(time => market.byTime.get(time)),
  }));
  return {
    schemaVersion: "kingbot-v13-closed-candles-v1",
    provider: "Deriv public historical candles",
    endpoint: DERIV_PUBLIC_WS,
    timeframe: normalizedTimeframe,
    intervalSeconds,
    createdAt: new Date(Number(nowEpochSeconds) * 1000).toISOString(),
    closedBarsOnly: true,
    alignment: "exact_common_utc_candle_open_timestamps",
    alignedBars: alignedTimes.length,
    firstBarTime: alignedTimes[0],
    lastBarTime: alignedTimes.at(-1),
    symbols: normalized.map(market => market.symbol),
    markets,
  };
}

function connectPublicSocket(timeoutMs = 10000) {
  if (typeof WebSocket !== "function") {
    throw new Error("V13_DERIV_NODE_22_WEBSOCKET_REQUIRED");
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(DERIV_PUBLIC_WS);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch {}
      reject(new Error("V13_DERIV_WEBSOCKET_CONNECT_TIMEOUT"));
    }, timeoutMs);

    socket.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      reject(new Error("V13_DERIV_WEBSOCKET_CONNECT_FAILED"));
    }, { once: true });
    socket.addEventListener("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("V13_DERIV_WEBSOCKET_CLOSED_DURING_CONNECT"));
    }, { once: true });
  });
}

function requestCandles(
  socket,
  symbol,
  intervalSeconds,
  count,
  timeoutMs = 12000,
) {
  const requestId = nextRequestId++;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("V13_DERIV_HISTORY_REQUEST_TIMEOUT:" + symbol));
    }, timeoutMs);
    const onClose = () => {
      cleanup();
      reject(new Error("V13_DERIV_SOCKET_CLOSED:" + symbol));
    };
    const onMessage = event => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const responseId = Number(payload?.req_id ?? payload?.echo_req?.req_id);
      if (responseId !== requestId) return;
      cleanup();
      if (payload?.error) {
        reject(new Error(
          "V13_DERIV_HISTORY_API_ERROR:"
          + symbol
          + ":"
          + String(payload.error.message || "UNKNOWN").slice(0, 160),
        ));
        return;
      }
      if (!Array.isArray(payload?.candles)) {
        reject(new Error("V13_DERIV_HISTORY_RESPONSE_MISSING_CANDLES:" + symbol));
        return;
      }
      resolve(payload.candles);
    };

    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    try {
      socket.send(JSON.stringify({
        ticks_history: DERIV_SYMBOLS[symbol],
        end: "latest",
        count,
        style: "candles",
        granularity: intervalSeconds,
        subscribe: 0,
        req_id: requestId,
      }));
    } catch (error) {
      cleanup();
      reject(new Error("V13_DERIV_HISTORY_SEND_FAILED:" + symbol + ":" + error.message));
    }
  });
}

export async function collectDerivDataset({
  symbols = ["XAUUSD", "EURUSD", "GBPUSD"],
  timeframe = "5m",
  count = 1000,
  minAlignedBars = 360,
  nowEpochSeconds = Date.now() / 1000,
} = {}) {
  const normalizedSymbols = [...new Set(
    symbols.map(symbol => String(symbol).trim().toUpperCase()),
  )];
  if (normalizedSymbols.length < 3) {
    throw new Error("V13_DERIV_REQUIRES_AT_LEAST_THREE_MARKETS");
  }
  const intervalSeconds = TIMEFRAME_SECONDS[String(timeframe).toLowerCase()];
  if (!intervalSeconds) throw new Error("V13_DERIV_TIMEFRAME_UNSUPPORTED");
  const requestCount = Math.max(120, Math.min(1000, Number(count) || 1000));

  const socket = await connectPublicSocket();
  try {
    const marketRows = [];
    // Query sequentially to respect the public websocket's request budget.
    for (const symbol of normalizedSymbols) {
      if (!DERIV_SYMBOLS[symbol]) {
        throw new Error("V13_DERIV_SYMBOL_UNSUPPORTED:" + symbol);
      }
      const candles = await requestCandles(
        socket,
        symbol,
        intervalSeconds,
        requestCount,
      );
      marketRows.push({ symbol, candles });
    }
    return buildAlignedDataset(marketRows, {
      timeframe,
      nowEpochSeconds,
      minAlignedBars,
    });
  } finally {
    try { socket.close(); } catch {}
  }
}

function readArg(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const symbols = readArg(args, "--symbols", "XAUUSD,EURUSD,GBPUSD")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  const timeframe = readArg(args, "--timeframe", "5m").toLowerCase();
  const count = Number(readArg(args, "--count", "1000"));
  const minAlignedBars = Number(readArg(args, "--min-aligned", "360"));
  const outputPath = path.resolve(
    readArg(args, "--output", "v13-deriv-5m-closed-candles.json"),
  );

  const dataset = await collectDerivDataset({
    symbols,
    timeframe,
    count,
    minAlignedBars,
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(dataset, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({
    ok: true,
    output: outputPath,
    provider: dataset.provider,
    timeframe: dataset.timeframe,
    symbols: dataset.symbols,
    alignedBars: dataset.alignedBars,
    firstBarTime: dataset.firstBarTime,
    lastBarTime: dataset.lastBarTime,
    closedBarsOnly: dataset.closedBarsOnly,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error("V13_DERIV_DATA_COLLECTION_FAILED:", error.message || error);
    process.exitCode = 1;
  });
}
