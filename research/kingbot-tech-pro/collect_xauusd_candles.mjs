#!/usr/bin/env node
/**
 * KINGBOT XAUUSD historical candle collector.
 * Research-only; public Deriv feed, no account authentication, no order execution.
 * Node.js 22+ is required for the built-in WebSocket implementation.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DERIV_PUBLIC_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
export const CANONICAL_SYMBOL = "XAUUSD";
export const SOURCE_SYMBOL = "frxXAUUSD";

export const TIMEFRAME_SECONDS = Object.freeze({
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
});

let nextRequestId = 1;

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toEpochSeconds(value) {
  if (typeof value === "string" && !/^\d+(\.\d+)?$/.test(value.trim())) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  const n = finite(value);
  if (n === null || n <= 0) return null;
  return Math.floor(n > 1e12 ? n / 1000 : n);
}

function normalizeCandle(raw, intervalSeconds, nowEpochSeconds) {
  const time = toEpochSeconds(raw?.epoch ?? raw?.time ?? raw?.timestamp);
  if (time === null) return null;
  // Include only candles whose entire interval has elapsed.
  if (time + intervalSeconds > nowEpochSeconds) return null;

  const open = finite(raw.open);
  const high = finite(raw.high);
  const low = finite(raw.low);
  const close = finite(raw.close);
  const tickCount = Math.max(0, finite(raw.tick_count ?? raw.volume) ?? 0);

  if (![open, high, low, close].every(v => v !== null && v > 0)) return null;
  if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) return null;

  return { time, open, high, low, close, tick_count: tickCount };
}

/**
 * Pure function for deterministic testing and offline reuse.
 * Rejects duplicate candle timestamps; never fills gaps or invents bars.
 */
export function buildXauusdDataset(rawCandles, {
  timeframe = "5m",
  nowEpochSeconds = Date.now() / 1000,
  minBars = 200,
  createdAt = new Date(nowEpochSeconds * 1000).toISOString(),
} = {}) {
  const tf = String(timeframe).toLowerCase();
  const intervalSeconds = TIMEFRAME_SECONDS[tf];
  if (!intervalSeconds) throw new Error("KINGBOT_XAU_TIMEFRAME_UNSUPPORTED");
  if (!Array.isArray(rawCandles)) throw new Error("KINGBOT_XAU_CANDLES_NOT_ARRAY");

  const valid = [];
  const seen = new Set();
  let invalid = 0;
  let openBars = 0;

  for (const raw of rawCandles) {
    const rawTime = toEpochSeconds(raw?.epoch ?? raw?.time ?? raw?.timestamp);
    if (rawTime !== null && rawTime + intervalSeconds > nowEpochSeconds) {
      openBars += 1;
      continue;
    }
    const candle = normalizeCandle(raw, intervalSeconds, nowEpochSeconds);
    if (!candle) {
      invalid += 1;
      continue;
    }
    if (seen.has(candle.time)) {
      throw new Error("KINGBOT_XAU_DUPLICATE_CANDLE_TIMESTAMP:" + candle.time);
    }
    seen.add(candle.time);
    valid.push(candle);
  }

  valid.sort((a, b) => a.time - b.time);
  for (let i = 1; i < valid.length; i += 1) {
    if (valid[i].time <= valid[i - 1].time) {
      throw new Error("KINGBOT_XAU_CHRONOLOGY_INVALID");
    }
  }

  if (valid.length < minBars) {
    throw new Error("KINGBOT_XAU_HISTORY_INSUFFICIENT:" + valid.length + "/" + minBars);
  }

  return {
    schemaVersion: "kingbot-xauusd-closed-candles-v1",
    canonicalSymbol: CANONICAL_SYMBOL,
    sourceSymbol: SOURCE_SYMBOL,
    provider: "Deriv public historical candles",
    endpoint: DERIV_PUBLIC_WS,
    timeframe: tf,
    intervalSeconds,
    timestampUnit: "unix_epoch_seconds_utc",
    priceUnit: "USD per troy ounce",
    priceSide: "provider candle price; not guaranteed bid/ask or mid",
    volumeField: "tick_count",
    volumeSemantics: "tick count, not centralized traded volume",
    createdAt,
    closedCandlesOnly: true,
    gapPolicy: "preserve_missing_intervals; do_not_interpolate",
    rawCandleCount: rawCandles.length,
    retainedCandleCount: valid.length,
    discardedInvalidCandles: invalid,
    discardedStillOpenCandles: openBars,
    firstCandleTime: valid[0].time,
    lastCandleTime: valid.at(-1).time,
    candles: valid,
    executionCostDataIncluded: false,
    researchOnly: true,
    executionAuthority: "NONE"
  };
}

function connectSocket(timeoutMs = 10000) {
  if (typeof WebSocket !== "function") throw new Error("NODE_22_WEBSOCKET_REQUIRED");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(DERIV_PUBLIC_WS);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { socket.close(); } catch {}
      reject(new Error("KINGBOT_XAU_WS_CONNECT_TIMEOUT"));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      reject(new Error("KINGBOT_XAU_WS_CONNECT_FAILED"));
    }, { once: true });
    socket.addEventListener("close", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error("KINGBOT_XAU_WS_CLOSED_DURING_CONNECT"));
    }, { once: true });
  });
}

function requestHistory(socket, timeframe, count, timeoutMs = 15000) {
  const reqId = nextRequestId++;
  const granularity = TIMEFRAME_SECONDS[timeframe];
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("KINGBOT_XAU_HISTORY_TIMEOUT:" + timeframe));
    }, timeoutMs);
    const onClose = () => {
      cleanup();
      reject(new Error("KINGBOT_XAU_SOCKET_CLOSED:" + timeframe));
    };
    const onMessage = event => {
      let payload;
      try { payload = JSON.parse(String(event.data)); } catch { return; }
      const responseId = Number(payload?.req_id ?? payload?.echo_req?.req_id);
      if (responseId !== reqId) return;
      cleanup();
      if (payload?.error) {
        reject(new Error("KINGBOT_XAU_HISTORY_API_ERROR:" + String(payload.error.message || "UNKNOWN").slice(0, 140)));
        return;
      }
      if (!Array.isArray(payload?.candles)) {
        reject(new Error("KINGBOT_XAU_HISTORY_CANDLES_MISSING:" + timeframe));
        return;
      }
      resolve(payload.candles);
    };

    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    try {
      socket.send(JSON.stringify({
        ticks_history: SOURCE_SYMBOL,
        end: "latest",
        count,
        style: "candles",
        granularity,
        subscribe: 0,
        req_id: reqId,
      }));
    } catch (error) {
      cleanup();
      reject(new Error("KINGBOT_XAU_HISTORY_SEND_FAILED:" + String(error?.message || "SEND_FAILED")));
    }
  });
}

export async function collectXauusdTimeframes({
  timeframes = ["1m", "5m", "15m", "1h", "4h", "1d"],
  count = 1000,
  minBars = 200,
  nowEpochSeconds = Date.now() / 1000,
} = {}) {
  const normalizedTimeframes = [...new Set(timeframes.map(tf => String(tf).toLowerCase()))];
  if (!normalizedTimeframes.length || normalizedTimeframes.some(tf => !TIMEFRAME_SECONDS[tf])) {
    throw new Error("KINGBOT_XAU_TIMEFRAME_UNSUPPORTED");
  }
  // Keep collection within the public collector's known 1,000-bar per-request envelope.
  const requestCount = Math.max(120, Math.min(1000, Number(count) || 1000));
  const socket = await connectSocket();
  try {
    const datasets = [];
    for (const timeframe of normalizedTimeframes) {
      const raw = await requestHistory(socket, timeframe, requestCount);
      datasets.push(buildXauusdDataset(raw, {
        timeframe,
        nowEpochSeconds,
        minBars,
      }));
    }
    return {
      schemaVersion: "kingbot-xauusd-multitimeframe-collection-v1",
      canonicalSymbol: CANONICAL_SYMBOL,
      sourceSymbol: SOURCE_SYMBOL,
      provider: "Deriv public historical candles",
      collectedAtUtc: new Date(nowEpochSeconds * 1000).toISOString(),
      timeframes: datasets,
      researchOnly: true,
      executionAuthority: "NONE",
      warning: "Deriv public XAUUSD history is a research feed. It is not a substitute for the exact execution broker's XAUUSD contract, spread, commission or slippage history."
    };
  } finally {
    try { socket.close(); } catch {}
  }
}

function readArg(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const timeframes = readArg(args, "--timeframes", "1m,5m,15m,1h,4h,1d").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  const count = Number(readArg(args, "--count", "1000"));
  const minBars = Number(readArg(args, "--min-bars", "200"));
  const outputPath = path.resolve(readArg(args, "--output", "research/kingbot-tech-pro/data/xauusd-closed-candles.json"));

  const dataset = await collectXauusdTimeframes({ timeframes, count, minBars });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(dataset, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({
    ok: true,
    output: outputPath,
    symbol: dataset.canonicalSymbol,
    sourceSymbol: dataset.sourceSymbol,
    provider: dataset.provider,
    timeframes: dataset.timeframes.map(x => ({ timeframe:x.timeframe, candles:x.retainedCandleCount, first:x.firstCandleTime, last:x.lastCandleTime })),
    executionAuthority: dataset.executionAuthority,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error("KINGBOT_XAU_DATA_COLLECTION_FAILED:", error?.message || error);
    process.exitCode = 1;
  });
}
