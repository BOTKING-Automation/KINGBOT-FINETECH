import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_STRATEGY_BOTS,
  BACKTEST_TIMEFRAME_SECONDS,
  isAllowedBacktestSymbol
} from "../src/backtest-validation.js";

test("backtest allow-list includes the five supported AI strategies", () => {
  assert.deepEqual(AI_STRATEGY_BOTS, ["strategic", "flipper", "breakout", "smc-pro", "ladder-flip"]);
});

test("backtest validates supported timeframes", () => {
  assert.equal(BACKTEST_TIMEFRAME_SECONDS["15m"], 900);
  assert.equal(BACKTEST_TIMEFRAME_SECONDS["4h"], 14400);
  assert.equal(BACKTEST_TIMEFRAME_SECONDS["bogus"], undefined);
});

test("backtest accepts real metals/forex symbols and rejects synthetic products", () => {
  assert.equal(isAllowedBacktestSymbol("XAUUSD"), true);
  assert.equal(isAllowedBacktestSymbol("XAUUSDm"), true);
  assert.equal(isAllowedBacktestSymbol("EURUSD"), true);
  assert.equal(isAllowedBacktestSymbol("R_100"), false);
  assert.equal(isAllowedBacktestSymbol("BOOM1000"), false);
  assert.equal(isAllowedBacktestSymbol("1HZ100V"), false);
  assert.equal(isAllowedBacktestSymbol(" "), false);
});
