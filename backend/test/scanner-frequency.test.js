import test from "node:test";
import assert from "node:assert/strict";
import { resolveScannerIntervalMs, evaluateScannerCoverage } from "../src/ai-market-scanner.js";

test("scanner defaults to a responsive 2.5-second target cadence", () => {
  assert.equal(resolveScannerIntervalMs(""), 2500);
  assert.equal(resolveScannerIntervalMs("2500"), 2500);
});

test("scanner interval is clamped to protect market-data providers", () => {
  assert.equal(resolveScannerIntervalMs("1000"), 2500);
  assert.equal(resolveScannerIntervalMs("1500"), 2500);
  assert.equal(resolveScannerIntervalMs("6000"), 6000);
  assert.equal(resolveScannerIntervalMs("60000"), 30000);
});

test("invalid scanner interval configuration fails to a safe default", () => {
  assert.equal(resolveScannerIntervalMs("fast"), 2500);
  assert.equal(resolveScannerIntervalMs("-100"), 2500);
});

test("scanner is LIVE only when quotes and verified technical data cover every requested symbol", () => {
  const result = evaluateScannerCoverage({
    ok: true,
    quoteCount: 2,
    technicalCount: 2,
    symbols: ["XAUUSD", "EURUSD"],
    quotes: [
      { symbol: "XAUUSD", available: true, ageMs: 300, freshnessMaxAgeMs: 3000 },
      { symbol: "EURUSD", available: true, ageMs: 700, freshnessMaxAgeMs: 3000 }
    ],
    technical: [
      { symbol: "XAUUSD", technicalVerified: true, technicalCacheAgeMs: 100 },
      { symbol: "EURUSD", technicalVerified: true, technicalCacheAgeMs: 500 }
    ]
  }, 2, 2500);

  assert.equal(result.state, "LIVE");
  assert.equal(result.quoteCoverage, "2/2");
  assert.equal(result.technicalCoverage, "2/2");
  assert.equal(result.staleQuoteCount, 0);
  assert.equal(result.staleTechnicalCount, 0);
});

test("partial verified data is reported as DEGRADED rather than LIVE", () => {
  const result = evaluateScannerCoverage({
    ok: true,
    quoteCount: 2,
    technicalCount: 1,
    symbols: ["XAUUSD", "EURUSD"],
    quotes: [
      { symbol: "XAUUSD", available: true },
      { symbol: "EURUSD", available: true }
    ],
    technical: [{ symbol: "XAUUSD", technicalVerified: true }]
  }, 2, 2500);

  assert.equal(result.state, "DEGRADED");
  assert.equal(result.technicalCoverage, "1/2");
});

test("stale quote or technical cache makes coverage DEGRADED", () => {
  const result = evaluateScannerCoverage({
    ok: true,
    quoteCount: 1,
    technicalCount: 1,
    symbols: ["XAUUSD"],
    quotes: [{ symbol: "XAUUSD", available: true, ageMs: 9000, freshnessMaxAgeMs: 3000 }],
    technical: [{ symbol: "XAUUSD", technicalVerified: true, technicalCacheAgeMs: 20000 }]
  }, 1, 2500);

  assert.equal(result.state, "DEGRADED");
  assert.equal(result.staleQuoteCount, 1);
  assert.equal(result.staleTechnicalCount, 1);
});

test("failed market-data result is UNAVAILABLE even when a partial quote count exists", () => {
  const result = evaluateScannerCoverage({
    ok: false,
    quoteCount: 1,
    technicalCount: 0,
    symbols: ["XAUUSD"],
    quotes: [{ symbol: "XAUUSD", available: true }]
  }, 1, 2500);

  assert.equal(result.state, "UNAVAILABLE");
});
