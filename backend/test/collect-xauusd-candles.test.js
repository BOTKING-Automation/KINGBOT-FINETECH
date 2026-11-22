import assert from "node:assert/strict";
import test from "node:test";
import { buildXauusdDataset } from "../../research/kingbot-tech-pro/collect_xauusd_candles.mjs";

const NOW = 1795338000;

function rawCandles(times) {
  return times.map((epoch, i) => {
    const open = 4000 + i;
    const close = open + 0.4;
    return {
      epoch,
      open,
      high: close + 0.2,
      low: open - 0.2,
      close,
      tick_count: 25 + i,
    };
  });
}

test("XAU collector retains chronological closed candles and records source semantics", () => {
  const data = buildXauusdDataset(rawCandles([1795336800, 1795337100, 1795337400]), {
    timeframe: "5m",
    nowEpochSeconds: NOW,
    minBars: 3,
  });
  assert.equal(data.canonicalSymbol, "XAUUSD");
  assert.equal(data.sourceSymbol, "frxXAUUSD");
  assert.equal(data.closedCandlesOnly, true);
  assert.equal(data.retainedCandleCount, 3);
  assert.equal(data.priceUnit, "USD per troy ounce");
  assert.equal(data.volumeField, "tick_count");
  assert.equal(data.executionCostDataIncluded, false);
  assert.deepEqual(data.candles.map(x => x.time), [1795336800,1795337100,1795337400]);
});

test("XAU collector rejects still-open candles", () => {
  const data = buildXauusdDataset(rawCandles([1795336800,1795337100,1795337700]), {
    timeframe: "5m",
    nowEpochSeconds: NOW,
    minBars: 2,
  });
  assert.equal(data.retainedCandleCount, 2);
  assert.equal(data.discardedStillOpenCandles, 1);
});

test("XAU collector rejects duplicate timestamps rather than overwriting", () => {
  const rows = rawCandles([1795336800,1795337100,1795337400]);
  rows.push(rows[1]);
  assert.throws(() => buildXauusdDataset(rows, {
    timeframe: "5m",
    nowEpochSeconds: NOW,
    minBars: 3,
  }), /KINGBOT_XAU_DUPLICATE_CANDLE_TIMESTAMP/);
});

test("XAU collector rejects malformed OHLC relationships", () => {
  const rows = rawCandles([1795336800,1795337100,1795337400]);
  rows[1].high = rows[1].open - 1;
  assert.equal(buildXauusdDataset(rows, {
    timeframe: "5m",
    nowEpochSeconds: NOW,
    minBars: 2,
  }).discardedInvalidCandles, 1);
});

test("XAU collector fails closed if usable history is too short", () => {
  assert.throws(() => buildXauusdDataset(rawCandles([1795336800,1795337100]), {
    timeframe: "5m",
    nowEpochSeconds: NOW,
    minBars: 3,
  }), /KINGBOT_XAU_HISTORY_INSUFFICIENT/);
});

test("XAU collector rejects unsupported timeframes", () => {
  assert.throws(() => buildXauusdDataset(rawCandles([1795336800]), {
    timeframe: "2m",
    nowEpochSeconds: NOW,
    minBars: 1,
  }), /KINGBOT_XAU_TIMEFRAME_UNSUPPORTED/);
});
