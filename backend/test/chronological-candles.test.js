import test from "node:test";
import assert from "node:assert/strict";
import { sortChronologicalCandles } from "../src/chronological-candles.js";

function candle(time, close) {
  return { time, open: close - 0.1, high: close + 0.2, low: close - 0.2, close, volume: 100 };
}

test("sorts newest-first broker candles into ascending chronological order", () => {
  const rows = [
    candle("2026-01-01T00:02:00Z", 102),
    candle("2026-01-01T00:01:00Z", 101),
    candle("2026-01-01T00:00:00Z", 100)
  ];
  const sorted = sortChronologicalCandles(rows);
  assert.deepEqual(sorted.map(x => x.close), [100, 101, 102]);
});

test("deduplicates equal timestamps and keeps the last source row", () => {
  const rows = [
    candle("2026-01-01T00:00:00Z", 100),
    candle("2026-01-01T00:01:00Z", 101),
    candle("2026-01-01T00:01:00Z", 101.5),
    candle("2026-01-01T00:02:00Z", 102)
  ];
  const sorted = sortChronologicalCandles(rows);
  assert.deepEqual(sorted.map(x => x.close), [100, 101.5, 102]);
});

test("sorts epoch seconds and milliseconds consistently", () => {
  const seconds = sortChronologicalCandles([
    candle(1_700_000_120, 102),
    candle(1_700_000_000, 100),
    candle(1_700_000_060, 101)
  ]);
  assert.deepEqual(seconds.map(x => x.close), [100, 101, 102]);
  const milliseconds = sortChronologicalCandles([
    candle(1_700_000_120_000, 102),
    candle(1_700_000_000_000, 100),
    candle(1_700_000_060_000, 101)
  ]);
  assert.deepEqual(milliseconds.map(x => x.close), [100, 101, 102]);
});

test("fails closed when only some candles have timestamps", () => {
  assert.throws(
    () => sortChronologicalCandles([
      candle("2026-01-01T00:00:00Z", 100),
      { open: 100, high: 101, low: 99, close: 100, volume: 100 }
    ]),
    /ML_CANDLE_TIMESTAMPS_INCONSISTENT/
  );
});

test("fails closed when timestamp values are malformed", () => {
  assert.throws(
    () => sortChronologicalCandles([
      candle("not-a-timestamp", 100),
      candle("also-not-a-timestamp", 101)
    ]),
    /ML_CANDLE_TIMESTAMP_INVALID/
  );
});

test("preserves provider order when no candle has a timestamp", () => {
  const rows = [
    { open: 101, high: 102, low: 100, close: 101, volume: 100 },
    { open: 100, high: 101, low: 99, close: 100, volume: 100 }
  ];
  assert.equal(sortChronologicalCandles(rows), rows);
});
