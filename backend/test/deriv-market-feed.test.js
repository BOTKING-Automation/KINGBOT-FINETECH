import assert from "node:assert/strict";
import { test } from "node:test";
import { DerivMarketFeed } from "../src/deriv-market-feed.js";

test("Deriv normalizes the supported major and cross FX symbols", () => {
  const feed = new DerivMarketFeed();
  assert.equal(feed.normalize("EURUSD"), "frxEURUSD");
  assert.equal(feed.normalize("GBPUSD"), "frxGBPUSD");
  assert.equal(feed.normalize("USDJPY"), "frxUSDJPY");
  assert.equal(feed.normalize("EURGBP"), "frxEURGBP");
  assert.equal(feed.normalize("EURJPY"), "frxEURJPY");
  assert.equal(feed.normalize("GBPJPY"), "frxGBPJPY");
  feed.close();
});

test("Deriv quote path falls back to a fresh exchange-timestamped latest tick", async () => {
  const feed = new DerivMarketFeed({ maxAgeMs: 5000 });
  const now = Math.floor(Date.now() / 1000);
  feed.subscribe = async () => "frxEURUSD";
  feed.ticks.set("frxEURUSD", {
    symbol: "frxEURUSD",
    price: 1.1,
    epoch: now - 60,
    receivedAt: Date.now(),
    source: "stale-test-tick",
  });
  feed.requestSnapshot = async () => ({
    symbol: "frxEURUSD",
    price: 1.1,
    epoch: now - 60,
    receivedAt: Date.now(),
    source: "stale-test-snapshot",
  });
  feed.getLatestAvailableQuote = async () => ({
    symbol: "frxEURUSD",
    price: 1.10125,
    epoch: Math.floor(Date.now() / 1000),
    receivedAt: Date.now(),
    source: "deriv-last-available-tick",
  });
  feed.forceReconnect = async () => {
    throw new Error("RECONNECT_SHOULD_NOT_BE_NEEDED");
  };

  const quote = await feed.getQuote("EURUSD", { maxAgeMs: 5000, timeoutMs: 3000 });
  assert.equal(quote.price, 1.10125);
  assert.equal(quote.source, "deriv-last-available-tick");
  assert.ok(quote.ageMs >= 0 && quote.ageMs <= 5000);
  feed.close();
});
