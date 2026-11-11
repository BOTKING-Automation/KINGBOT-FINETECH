import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { buildScannerChartPayload, buildScannerChartStreamQuote } from "../src/ai-market-scanner.js";

const scannerPage = readFileSync(new URL("../../scanner.html", import.meta.url), "utf8");

function makeBars(count = 140) {
  return Array.from({ length: count }, (_, index) => {
    const close = 220 + index * 0.08 + Math.sin(index / 7) * 0.9;
    return {
      time: new Date((1700000000 + index * 300) * 1000).toISOString(),
      open: close - 0.12,
      high: close + 0.45,
      low: close - 0.46,
      close,
      volume: 100 + index,
    };
  });
}

test("chart payload sorts and normalizes verified OHLC candles", () => {
  const payload = buildScannerChartPayload(makeBars(140).reverse(), {
    symbol: "XAUUSD",
    timeframe: "5m",
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "chart");
  assert.equal(payload.symbol, "XAUUSD");
  assert.equal(payload.timeframe, "5m");
  assert.equal(payload.bars.length, 140);
  assert.equal(payload.bars[0].time, 1700000000);
  assert.equal(payload.bars.at(-1).time, 1700000000 + 139 * 300);
  assert.equal(payload.executionAuthority, "NONE");
  assert.equal(payload.brokerRequired, false);
  assert.equal(payload.metadata.verifiedOhlc, true);
  assert.equal(payload.metadata.barsCount, 140);
  assert.equal(payload.metadata.candleFresh, false);
  assert.ok(Number.isFinite(payload.technical.ema20));
  assert.ok(payload.signal);
  assert.ok(["ENTRY_CONFIRMING", "WAIT", "NO_TRADE"].includes(payload.signal.signal));
});

test("chart payload rejects insufficient verified candle history", () => {
  assert.throws(
    () => buildScannerChartPayload(makeBars(79), { symbol: "XAUUSD" }),
    /INSUFFICIENT_HISTORICAL_CANDLES/
  );
});

test("chart payload filters malformed OHLC rows instead of inventing candles", () => {
  const rows = makeBars(100);
  rows[50] = { ...rows[50], high: rows[50].low - 1 };

  const payload = buildScannerChartPayload(rows, { symbol: "EURUSD", timeframe: "15m" });
  assert.equal(payload.bars.length, 99);
  assert.equal(payload.bars.some(bar => bar.time === 1700000000 + 50 * 300), false);
  assert.equal(payload.metadata.verifiedOhlc, true);
});

test("chart payload deduplicates repeated candle timestamps", () => {
  const rows = makeBars(100);
  rows.push({ ...rows[99], close: rows[99].close + 0.01 });

  const payload = buildScannerChartPayload(rows, { symbol: "GBPUSD", timeframe: "1h" });
  assert.equal(payload.bars.length, 100);
  assert.equal(payload.bars.at(-1).close, rows[99].close + 0.01);
});

test("chart payload marks a current timeframe candle as fresh", () => {
  const intervalSeconds = 300;
  const currentBucket = Math.floor(Date.now() / (intervalSeconds * 1000)) * intervalSeconds;
  const bars = makeBars(120).map((bar, index) => ({
    ...bar,
    time: new Date((currentBucket - (119 - index) * intervalSeconds) * 1000).toISOString(),
  }));

  const payload = buildScannerChartPayload(bars, { symbol: "XAUUSD", timeframe: "5m" });
  assert.equal(payload.metadata.candleFresh, true);
  assert.equal(payload.metadata.ageSinceCloseMs, 0);
  assert.equal(payload.metadata.verifiedOhlc, true);
});


test("chart stream quote separates venue age from server-to-client pipeline age", () => {
  const payload = buildScannerChartStreamQuote("XAUUSD", {
    price: 4142.25,
    bid: 4142.20,
    ask: 4142.30,
    epoch: 1700000000,
    receivedAt: 1700000000850,
    time: "2023-11-14T22:13:20.000Z",
    source: "deriv-shared-live-feed"
  }, 1700000001200);

  assert.equal(payload.symbol, "XAUUSD");
  assert.equal(payload.timestamp, 1700000000000);
  assert.equal(payload.exchangeAgeMs, 1200);
  assert.equal(payload.transportAgeMs, 350);
  assert.equal(payload.ageMs, 350);
  assert.equal(payload.price, 4142.25);
});

test("chart stream does not invent an exchange timestamp when provider time is missing", () => {
  const payload = buildScannerChartStreamQuote("EURUSD", {
    price: 1.1725,
    receivedAt: 1700000000100,
    source: "deriv-shared-live-feed"
  }, 1700000000200);

  assert.equal(payload.timestamp, null);
  assert.equal(payload.exchangeAgeMs, null);
  assert.equal(payload.transportAgeMs, 100);
});

test("scanner live chart batches candle painting and keeps quote cards incremental", () => {
  const start = scannerPage.indexOf("  function updateLiveChartQuote(incoming){");
  const end = scannerPage.indexOf("\n  function syncChartFromScan", start);
  assert.ok(start >= 0 && end > start, "live chart quote handler must exist");
  const handler = scannerPage.slice(start, end);

  assert.match(scannerPage, /function scheduleChartLiveFrame\(chartState\)/);
  assert.match(scannerPage, /window\.requestAnimationFrame/);
  assert.match(scannerPage, /id="chartTickRate"/);
  assert.match(scannerPage, /id="chartTickAge"/);
  assert.match(scannerPage, /id="chartTickPipe"/);
  assert.doesNotMatch(handler, /setChartIndicators\(\)|buildChartZones\(\)|drawChartZones\(\)/);
  assert.match(scannerPage, /function scheduleQuoteCardUpdate\(quote\)/);
  assert.doesNotMatch(scannerPage.slice(
    scannerPage.indexOf("  function mergeLiveQuote(incoming){"),
    scannerPage.indexOf("\n  function websocketUrl", scannerPage.indexOf("  function mergeLiveQuote(incoming){"))
  ), /renderQuotes\(\)/);
});
