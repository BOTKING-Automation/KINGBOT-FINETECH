import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExecutionQuote } from "../src/broker-market-contract.js";

test("normalizes broker-native bid/ask and ISO timestamps", () => {
  const nowMs = Date.parse("2026-10-25T10:00:00.000Z");
  const quote = normalizeExecutionQuote({
    connected: true,
    data: {
      symbol: "EUR_USD",
      instrument: "EUR_USD",
      bid: 1.08001,
      ask: 1.08013,
      time: "2026-10-25T09:59:59.500Z",
      tradeable: true
    }
  }, { requestedSymbol: "EURUSD", provider: "oanda", nowMs });
  assert.equal(quote.symbol, "EURUSD");
  assert.equal(quote.brokerSymbol, "EUR_USD");
  assert.ok(Math.abs(quote.spread - 0.00012) < 1e-9);
  assert.equal(quote.time, "2026-10-25T09:59:59.500Z");
  assert.equal(quote.fresh, true);
  assert.equal(quote.quoteQuality, "BROKER_NATIVE_BID_ASK");
});

test("accepts Unix-second epochs but does not invent quote timestamps", () => {
  const nowMs = 1_800_000_000_000;
  const quote = normalizeExecutionQuote({
    symbol: "XAUUSDm",
    bid: 4000,
    ask: 4000.2,
    epoch: Math.floor(nowMs / 1000)
  }, { requestedSymbol: "XAUUSDm", provider: "mt5-bridge", nowMs });
  assert.equal(Date.parse(quote.timestamp), Math.floor(nowMs / 1000) * 1000);
  assert.throws(() => normalizeExecutionQuote({
    symbol: "XAUUSD", bid: 4000, ask: 4000.2
  }, { requestedSymbol: "XAUUSD", provider: "client", nowMs }), {
    message: "BROKER_QUOTE_TIMESTAMP_REQUIRED"
  });
});

test("rejects a mid-price-only quote instead of manufacturing a zero spread", () => {
  assert.throws(() => normalizeExecutionQuote({
    symbol: "R_100",
    price: 1200,
    time: "2026-10-25T10:00:00.000Z"
  }, { requestedSymbol: "R_100", provider: "deriv", nowMs: Date.parse("2026-10-25T10:00:01Z") }), {
    message: "BROKER_EXECUTION_BID_ASK_REQUIRED"
  });
});

test("rejects crossed, non-tradeable, and implausibly future-dated quotes", () => {
  const nowMs = Date.parse("2026-10-25T10:00:00.000Z");
  const base = { symbol: "EURUSD", bid: 1.1, ask: 1.1002, time: "2026-10-25T10:00:00Z" };
  assert.throws(() => normalizeExecutionQuote({ ...base, bid: 1.1003 }, {
    requestedSymbol: "EURUSD", provider: "test", nowMs
  }), { message: "BROKER_EXECUTION_QUOTE_CROSSED" });
  assert.throws(() => normalizeExecutionQuote({ ...base, tradeable: false }, {
    requestedSymbol: "EURUSD", provider: "test", nowMs
  }), { message: "BROKER_INSTRUMENT_NOT_TRADEABLE" });
  assert.throws(() => normalizeExecutionQuote({ ...base, time: "2026-10-25T10:00:10Z" }, {
    requestedSymbol: "EURUSD", provider: "test", nowMs
  }), { message: "BROKER_QUOTE_TIMESTAMP_IN_FUTURE" });
});

test("reports stale broker quotes instead of refreshing their timestamp", () => {
  const nowMs = Date.parse("2026-10-25T10:00:00.000Z");
  const quote = normalizeExecutionQuote({
    symbol: "EURUSD", bid: 1.1, ask: 1.1002, time: "2026-10-25T09:59:00Z"
  }, { requestedSymbol: "EURUSD", provider: "test", nowMs, freshnessMaxAgeMs: 5000 });
  assert.equal(quote.fresh, false);
  assert.equal(quote.ageMs, 60000);
});
