import assert from "node:assert/strict";
import test from "node:test";

import { buildScannerChartPayload } from "../src/ai-market-scanner.js";

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
