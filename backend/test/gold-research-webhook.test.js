import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeGoldResearchEvent,
  constantTimeTokenMatch
} from "../src/gold-research-webhook.js";

const NOW = Date.parse("2026-11-22T09:00:00.000Z");

function validBuy(overrides = {}) {
  return {
    schema_version: "1.0",
    event_type: "candidate_setup",
    event_id: "XAUUSD:5:1795337700000:BUY:V3",
    strategy: "KINGBOT_TECH_PRO",
    strategy_version: "V3-baseline",
    symbol: "XAUUSD",
    source_symbol: "XAUUSDm",
    timeframe: "5",
    bar_time_utc: "2026-11-22T08:55:00.000Z",
    event_time_utc: "2026-11-22T08:59:00.000Z",
    side: "BUY",
    bar_close: 4050.2,
    atr: 4.3,
    spread: 0.35,
    entry: 4050.2,
    stop_loss: 4046.0,
    tp1: 4054.4,
    tp2: 4058.6,
    tp3: 4065.0,
    score: 8,
    setup_state: "TRIGGER_CONFIRMED",
    reason_codes: ["HTF_BIAS_ALIGNED", "LIQUIDITY_SWEEP", "FVG_RETEST"],
    source: "tradingview_alert",
    ...overrides
  };
}

test("accepts a valid XAUUSD BUY research event", () => {
  const result = normalizeGoldResearchEvent(validBuy(), { nowMs: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.event.symbol, "XAUUSD");
  assert.equal(result.event.side, "BUY");
  assert.equal(result.event.reason_codes.length, 3);
});

test("rejects a non-canonical gold symbol", () => {
  const result = normalizeGoldResearchEvent(validBuy({ symbol: "EURUSD" }), { nowMs: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.error, "CANONICAL_SYMBOL_MUST_BE_XAUUSD");
});

test("rejects unsupported timeframes", () => {
  const result = normalizeGoldResearchEvent(validBuy({ timeframe: "3m" }), { nowMs: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.error, "UNSUPPORTED_TIMEFRAME");
});

test("rejects an invalid BUY stop/target ordering", () => {
  const result = normalizeGoldResearchEvent(validBuy({ stop_loss: 4051.0 }), { nowMs: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.error, "BUY_LEVEL_ORDER_INVALID");
});

test("rejects stale webhook events", () => {
  const result = normalizeGoldResearchEvent(
    validBuy({ event_time_utc: "2026-11-22T08:30:00.000Z" }),
    { nowMs: NOW, maxAgeMs: 900000 }
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "STALE_EVENT");
});

test("rejects future webhook events", () => {
  const result = normalizeGoldResearchEvent(
    validBuy({ event_time_utc: "2026-11-22T09:10:00.000Z" }),
    { nowMs: NOW }
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "EVENT_TIME_IN_FUTURE");
});

test("checks webhook URL token without leaking comparison timing", () => {
  assert.equal(constantTimeTokenMatch("a".repeat(40), "a".repeat(40)), true);
  assert.equal(constantTimeTokenMatch("a".repeat(40), "b".repeat(40)), false);
  assert.equal(constantTimeTokenMatch("short", "a".repeat(40)), false);
});
