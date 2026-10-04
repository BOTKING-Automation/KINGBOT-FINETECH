import test from "node:test";
import assert from "node:assert/strict";
import { MarketDataFabric, classifyMarketSymbol, normalizeMarketSymbol } from "../src/market-data-fabric.js";

test("normalizes provider aliases without changing existing USDT market ids", () => {
  assert.equal(normalizeMarketSymbol("XAU/USD"), "XAUUSD");
  assert.equal(normalizeMarketSymbol("gold"), "XAUUSD");
  assert.equal(normalizeMarketSymbol("BTC/USD"), "BTCUSD");
  assert.equal(normalizeMarketSymbol("BTCUSDT"), "BTCUSDT");
});

test("classifies core market families", () => {
  assert.equal(classifyMarketSymbol("XAUUSD"), "metals");
  assert.equal(classifyMarketSymbol("EURUSD"), "forex");
  assert.equal(classifyMarketSymbol("BTCUSDT"), "crypto");
  assert.equal(classifyMarketSymbol("SPX"), "indices");
  assert.equal(classifyMarketSymbol("AAPL"), "stocks");
});

test("uses direct gold provider before fallback providers", async () => {
  const fabric = new MarketDataFabric({
    goldFeed: {
      async getQuote() {
        return {
          symbol: "XAUUSD",
          price: 4142.25,
          timestamp: Date.now(),
          available: true,
          verified: true,
          source: "test-gold",
          provider: "gold-api.com"
        };
      }
    },
    twelveData: { enabled: false },
    derivFeed: {
      async getQuote() {
        throw new Error("DERIV_SHOULD_NOT_BE_USED");
      }
    }
  });

  const quote = await fabric.getQuote("XAUUSD");
  assert.equal(quote.ok, true);
  assert.equal(quote.symbol, "XAUUSD");
  assert.equal(quote.provider, "gold-api.com");
  assert.equal(quote.fallbackUsed, false);
  assert.equal(quote.executionAuthorized, false);
});

test("records failed primary providers and falls back to Deriv", async () => {
  const fabric = new MarketDataFabric({
    twelveData: { enabled: false },
    derivFeed: {
      async getQuote() {
        return {
          price: 1.1723,
          bid: 1.1722,
          ask: 1.1724,
          epoch: Math.floor(Date.now() / 1000),
          source: "test-deriv"
        };
      }
    },
    goldFeed: { async getQuote() { throw new Error("not-gold"); } }
  });

  const quote = await fabric.getQuote("EURUSD");
  assert.equal(quote.ok, true);
  assert.equal(quote.symbol, "EURUSD");
  assert.equal(quote.provider, "deriv");
  assert.equal(quote.fallbackUsed, true);
  assert.ok(quote.failedProviders.some(item => item.provider === "twelve-data"));
});

test("fails closed when no provider returns a fresh quote", async () => {
  const fabric = new MarketDataFabric({
    twelveData: { enabled: false },
    derivFeed: {
      async getQuote() {
        throw new Error("NO_DERIV");
      }
    },
    goldFeed: { async getQuote() { throw new Error("NO_GOLD"); } },
    massiveApiKey: ""
  });

  const quote = await fabric.getQuote("EURUSD");
  assert.equal(quote.ok, false);
  assert.equal(quote.available, false);
  assert.equal(quote.verified, false);
  assert.equal(quote.executionAuthority, "NONE");
  assert.ok(Array.isArray(quote.failures));
  assert.ok(quote.failures.length >= 2);
});

test("snapshot exposes provider and verification counts", async () => {
  const fabric = new MarketDataFabric({
    twelveData: { enabled: false },
    derivFeed: {
      async getQuote(symbol) {
        return {
          price: symbol === "EURUSD" ? 1.17 : 1.08,
          epoch: Math.floor(Date.now() / 1000),
          source: "test-deriv"
        };
      }
    },
    goldFeed: { async getQuote() { throw new Error("NO_GOLD"); } }
  });

  const snapshot = await fabric.snapshot(["EURUSD", "GBPUSD"]);
  assert.equal(snapshot.requestedCount, 2);
  assert.equal(snapshot.liveCount, 2);
  assert.equal(snapshot.verifiedCount, 2);
  assert.equal(snapshot.executionAuthority, undefined);
});
