import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBrokerHistoricalBars } from "../src/broker-history-contract.js";

function makeBars(count = 260) {
  const base = Date.parse("2025-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const open = 2000 + index * 0.1;
    const close = open + 0.05;
    return {
      time: new Date(base + index * 15 * 60_000).toISOString(),
      open,
      high: close + 0.1,
      low: open - 0.1,
      close,
      volume: 100 + index
    };
  });
}

test("normalizes wrapped connected-broker candle history into chronological OHLC bars", () => {
  const bars = normalizeBrokerHistoricalBars({ connected: true, data: makeBars() });
  assert.equal(bars.length, 260);
  assert.equal(bars[0].datetime, "2025-01-01T00:00:00.000Z");
  assert.equal(bars.at(-1).volume, 359);
  assert.ok(bars.every(bar => Number.isFinite(Date.parse(bar.datetime))));
});

test("rejects insufficient, timestamp-free, or malformed broker histories", () => {
  assert.throws(() => normalizeBrokerHistoricalBars(makeBars(259)), {
    message: "BROKER_HISTORICAL_BARS_INSUFFICIENT:259/260"
  });
  const missingTime = makeBars();
  delete missingTime[3].time;
  assert.throws(() => normalizeBrokerHistoricalBars(missingTime), {
    message: "BROKER_HISTORICAL_TIMESTAMP_INVALID"
  });
  const malformed = makeBars();
  malformed[8].high = malformed[8].open - 1;
  assert.throws(() => normalizeBrokerHistoricalBars(malformed), {
    message: "BROKER_HISTORICAL_OHLC_INCONSISTENT"
  });
});

test("rejects duplicates or out-of-order broker candles", () => {
  const duplicate = makeBars();
  duplicate[9].time = duplicate[8].time;
  assert.throws(() => normalizeBrokerHistoricalBars(duplicate), {
    message: "BROKER_HISTORICAL_TIMESTAMPS_NOT_INCREASING"
  });
  const descending = makeBars().reverse();
  assert.throws(() => normalizeBrokerHistoricalBars(descending), {
    message: "BROKER_HISTORICAL_TIMESTAMPS_NOT_INCREASING"
  });
});

test("keeps the most recent 1000 bars without changing their order", () => {
  const bars = normalizeBrokerHistoricalBars(makeBars(1200));
  assert.equal(bars.length, 1000);
  assert.equal(bars[0].datetime, "2025-01-03T02:00:00.000Z");
});
