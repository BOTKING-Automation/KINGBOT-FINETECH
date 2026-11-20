import test from "node:test";
import assert from "node:assert/strict";
import { TwelveDataFeed } from "../src/twelve-data-feed.js";

test("Twelve Data catalog returns paginated, normalized forex instruments and caches reference data", async () => {
  const previousKey = process.env.TWELVE_DATA_API_KEY;
  const previousFetch = globalThis.fetch;
  let requests = 0;
  process.env.TWELVE_DATA_API_KEY = "test-key";
  globalThis.fetch = async (url) => {
    requests += 1;
    assert.match(String(url), /api\.twelvedata\.com\/forex_pairs/);
    return new Response(JSON.stringify({
      data: [
        { symbol: "EUR/USD", currency_base: "Euro", currency_quote: "US Dollar", currency_group: "Major" },
        { symbol: "GBP/USD", currency_base: "Pound Sterling", currency_quote: "US Dollar", currency_group: "Major" }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const feed = new TwelveDataFeed();
    const firstPage = await feed.instrumentCatalog({ category: "forex", limit: 1, offset: 0 });
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.items[0].symbol, "EURUSD");
    assert.equal(firstPage.items[0].providerSymbol, "EUR/USD");
    assert.equal(firstPage.items[0].category, "FOREX");
    assert.equal(firstPage.hasMore, true);

    const secondPage = await feed.instrumentCatalog({ category: "forex", limit: 1, offset: 1 });
    assert.equal(secondPage.items[0].symbol, "GBPUSD");
    assert.equal(secondPage.hasMore, false);
    assert.equal(requests, 1, "the second page should reuse the cached reference catalogue");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = previousKey;
  }
});

test("Twelve Data catalog refuses to return an invented universe when no API key is configured", async () => {
  const previousKey = process.env.TWELVE_DATA_API_KEY;
  delete process.env.TWELVE_DATA_API_KEY;
  try {
    const feed = new TwelveDataFeed();
    await assert.rejects(
      feed.instrumentCatalog({ category: "all" }),
      /TWELVE_DATA_NOT_CONFIGURED/
    );
  } finally {
    if (previousKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = previousKey;
  }
});
