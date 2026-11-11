import test from "node:test";
import assert from "node:assert/strict";
import { TwelveDataFeed } from "../src/twelve-data-feed.js";

test("Twelve Data cache does not mark a quote verified without an exchange timestamp", () => {
  const feed = new TwelveDataFeed({ symbols: ["EUR/USD"] });
  feed.last.set("EUR/USD", {
    symbol: "EURUSD",
    price: 1.1,
    timestamp: null,
    source: "test-websocket"
  });

  const [quote] = feed.quotes(["EURUSD"]);
  assert.equal(quote.available, false);
  assert.equal(quote.ageMs, null);
  assert.equal(quote.error, "TWELVE_DATA_QUOTE_TIMESTAMP_MISSING");
  feed.close();
});

test("Twelve Data cache rejects stale exchange timestamps", () => {
  const feed = new TwelveDataFeed({ symbols: ["EUR/USD"] });
  feed.last.set("EUR/USD", {
    symbol: "EURUSD",
    price: 1.1,
    timestamp: Date.now() - 5 * 60 * 1000,
    source: "test-websocket"
  });

  const [quote] = feed.quotes(["EURUSD"]);
  assert.equal(quote.available, false);
  assert.equal(quote.error, "TWELVE_DATA_QUOTE_STALE");
  feed.close();
});

test("Twelve Data cache accepts a fresh ISO exchange timestamp", () => {
  const feed = new TwelveDataFeed({ symbols: ["EUR/USD"] });
  feed.last.set("EUR/USD", {
    symbol: "EURUSD",
    price: 1.1,
    timestamp: new Date().toISOString(),
    source: "test-websocket"
  });

  const [quote] = feed.quotes(["EURUSD"]);
  assert.equal(quote.available, true);
  assert.ok(quote.ageMs >= 0 && quote.ageMs <= 120000);
  assert.equal(typeof quote.timestamp, "number");
  feed.close();
});
