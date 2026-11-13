import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAlignedDataset,
  TIMEFRAME_SECONDS,
} from "./collect_deriv_candles.mjs";

function candles(times, offset = 0) {
  return times.map((time, index) => {
    const open = 2000 + offset + index * 0.1;
    const close = open + 0.05;
    return {
      epoch: time,
      open,
      high: close + 0.05,
      low: open - 0.05,
      close,
      tick_count: 10 + index,
    };
  });
}

test("V13 collector aligns all symbols to common closed candle timestamps", () => {
  const data = buildAlignedDataset([
    { symbol: "XAUUSD", candles: candles([300, 600, 900, 1200, 1500]) },
    { symbol: "EURUSD", candles: candles([300, 600, 1200, 1500], -100) },
    { symbol: "GBPUSD", candles: candles([300, 600, 900, 1200, 1500], -200) },
  ], {
    timeframe: "5m",
    nowEpochSeconds: 1800,
    minAlignedBars: 3,
  });

  assert.equal(data.provider, "Deriv public historical candles");
  assert.equal(data.intervalSeconds, 300);
  assert.equal(data.closedBarsOnly, true);
  assert.equal(data.alignedBars, 4);
  assert.deepEqual(data.markets.map(market => market.symbol), [
    "XAUUSD", "EURUSD", "GBPUSD",
  ]);
  for (const market of data.markets) {
    assert.deepEqual(market.bars.map(bar => bar.time), [300, 600, 1200, 1500]);
    assert.equal(market.bars.length, 4);
  }
});

test("V13 collector discards a still-open current candle", () => {
  const data = buildAlignedDataset([
    { symbol: "XAUUSD", candles: candles([300, 600, 900, 1200]) },
    { symbol: "EURUSD", candles: candles([300, 600, 900, 1200], -100) },
    { symbol: "GBPUSD", candles: candles([300, 600, 900, 1200], -200) },
  ], {
    timeframe: "5m",
    nowEpochSeconds: 1350,
    minAlignedBars: 3,
  });

  assert.equal(data.alignedBars, 3);
  assert.deepEqual(data.markets[0].bars.map(bar => bar.time), [300, 600, 900]);
});

test("V13 collector fails closed when common history is below its minimum", () => {
  assert.throws(
    () => buildAlignedDataset([
      { symbol: "XAUUSD", candles: candles([300, 600, 900]) },
      { symbol: "EURUSD", candles: candles([600, 900]) },
      { symbol: "GBPUSD", candles: candles([300, 600, 900]) },
    ], {
      timeframe: "5m",
      nowEpochSeconds: 1200,
      minAlignedBars: 3,
    }),
    /V13_DERIV_ALIGNED_HISTORY_INSUFFICIENT/,
  );
});

test("V13 collector accepts only configured timeframes and at least three markets", () => {
  assert.equal(TIMEFRAME_SECONDS["5m"], 300);
  assert.throws(() => buildAlignedDataset([], { timeframe: "5m" }),
    /V13_DERIV_REQUIRES_AT_LEAST_THREE_MARKETS/);
  assert.throws(() => buildAlignedDataset([
    { symbol: "XAUUSD", candles: candles([300, 600]) },
    { symbol: "EURUSD", candles: candles([300, 600]) },
    { symbol: "GBPUSD", candles: candles([300, 600]) },
  ], { timeframe: "2m" }), /V13_DERIV_TIMEFRAME_UNSUPPORTED/);
});
