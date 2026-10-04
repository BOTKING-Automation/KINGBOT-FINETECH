import test from "node:test";
import assert from "node:assert/strict";
import { parseGoldPriceResponse } from "../src/gold-price-feed.js";
import { buildMarketEvidence } from "../src/market-evidence-engine.js";

test("free XAU feed parser returns a verified quote with provider freshness metadata", () => {
  const computedAt = new Date(Date.now() - 30000).toISOString();
  const quote = parseGoldPriceResponse({
    price: 4148.22,
    symbol: "XAU",
    updatedAt: computedAt
  });

  assert.equal(quote.symbol, "XAUUSD");
  assert.equal(quote.price, 4148.22);
  assert.equal(quote.verified, true);
  assert.equal(quote.source, "Gold API direct free XAU/USD price");
  assert.equal(quote.freshnessMaxAgeMs, 90000);
});

test("source-aware freshness accepts a fresh free-feed quote beyond the old 5-second gate", () => {
  const computedAt = new Date(Date.now() - 30000).toISOString();
  const evidence = buildMarketEvidence({
    symbol: "XAUUSD",
    price: 4148.22,
    quoteTimestamp: computedAt,
    quoteFreshnessMaxAgeMs: 90000,
    source: "GoldPrice.dev direct free XAU/USD spot",
    trend: "BULLISH",
    structure: "bullish",
    bos: "BULLISH",
    rsi: 58,
    momentum: 0.6,
    ema20: 4147,
    ema50: 4140,
    multiTimeframe: {
      timeframes: [
        { timeframe: "5m", ok: true, trend: "BULLISH" },
        { timeframe: "15m", ok: true, trend: "BULLISH" },
        { timeframe: "1h", ok: true, trend: "BULLISH" }
      ]
    }
  }, { maxAgeMs: 5000 });

  assert.equal(evidence.freshness.quote.ok, true);
  assert.equal(evidence.provenance.verified, true);
  assert.notEqual(evidence.dataFlags.includes("STALE_MARKET_DATA"), true);
});

test("provider-stale quotes are rejected", () => {
  assert.throws(
    () => parseGoldPriceResponse({
      price: 4148.22,
      symbol: "XAU",
      updatedAt: new Date().toISOString()
    }),
    /GOLDPRICE_XAU_PROVIDER_STALE/
  );
});
