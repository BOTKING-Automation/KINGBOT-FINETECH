import test from "node:test";
import assert from "node:assert/strict";

process.env.KINGBOT_ML_SIGNAL_URL = "http://ml-service.test";
process.env.KINGBOT_ML_SIGNAL_SECRET = "test-secret";

test("configured ML service is not ready without a usable model", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true, configured: true, ready: false,
    readinessReason: "NO_FRESH_QUALITY_GATED_MODEL", modelsLoaded: 0, modelsReady: 0
  }), { status: 200, headers: { "content-type": "application/json" } });
  const { probeMlSignalService } = await import("../src/ml-signal-client.js?model-readiness-test");
  const result = await probeMlSignalService();
  assert.equal(result.ok, true);
  assert.equal(result.ready, false);
  assert.equal(result.status, "ML_SERVICE_DEGRADED");
});

test("explicit healthy model readiness is reflected by the client", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true, configured: true, ready: true, readinessReason: "READY", modelsLoaded: 1, modelsReady: 1
  }), { status: 200, headers: { "content-type": "application/json" } });
  const { probeMlSignalService } = await import("../src/ml-signal-client.js?model-readiness-test");
  const result = await probeMlSignalService();
  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(result.status, "ML_SERVICE_READY");
});


test("research backtest helper posts caller-supplied costs and bars to the protected endpoint", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  let sent = null;
  globalThis.fetch = async (url, options) => {
    sent = { url: String(url), options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      ok: true,
      status: "COMPLETED",
      evaluation: "EXPANDING_ROLLING_PURGED_WALK_FORWARD",
      profitabilityValidated: false,
      performance: { netPnlAccount: -2.5 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { runMlStrategyBacktest } = await import("../src/ml-signal-client.js?backtest-test");
  const bars = [{ timestamp: "2025-01-01T00:00:00Z", open: 1, high: 2, low: 0.5, close: 1.5 }];
  const costs = { spread_price: 0.1, slippage_price_per_side: 0.02 };
  const result = await runMlStrategyBacktest({
    botId: "strategic", symbol: "XAUUSD", timeframe: "5m", bars, costs, folds: 2, dataSource: "test fixture"
  });
  assert.equal(sent.url, "http://ml-service.test/backtest");
  assert.equal(sent.body.botId, "strategic");
  assert.equal(sent.body.symbol, "XAUUSD");
  assert.deepEqual(sent.body.costs, costs);
  assert.deepEqual(sent.body.bars, bars);
  assert.equal(result.profitabilityValidated, false);
});
