import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";

let server;
let baseUrl = "";
let busyRemaining = 0;
let rateLimitRemaining = 0;
let requestCount = 0;
let trainMlStrategyModel;

before(async () => {
  server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/train") {
      res.writeHead(404).end();
      return;
    }
    requestCount += 1;
    req.resume();

    if (rateLimitRemaining > 0) {
      rateLimitRemaining -= 1;
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "0.001",
      }).end(JSON.stringify({ ok: false, error: "RATE_LIMITED" }));
      return;
    }
    if (busyRemaining > 0) {
      busyRemaining -= 1;
      res.writeHead(409, {
        "content-type": "application/json",
        "retry-after": "0.001",
      }).end(JSON.stringify({ ok: false, error: "ML_TRAINING_CAPACITY_BUSY" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      ok: true,
      ready: true,
      status: "TRAINED",
      key: "strategic:15m",
      dataset: { samples: 180 },
    }));
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.KINGBOT_ML_SIGNAL_URL = baseUrl;
  process.env.KINGBOT_ML_SIGNAL_SECRET = "ml-client-test-secret";
  process.env.KINGBOT_ML_TRAIN_TIMEOUT_MS = "30000";
  process.env.KINGBOT_ML_SIGNAL_TIMEOUT_MS = "5000";
  ({ trainMlStrategyModel } = await import("../src/ml-signal-client.js?test=busy-retry"));
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  delete process.env.KINGBOT_ML_SIGNAL_URL;
  delete process.env.KINGBOT_ML_SIGNAL_SECRET;
  delete process.env.KINGBOT_ML_TRAIN_TIMEOUT_MS;
  delete process.env.KINGBOT_ML_SIGNAL_TIMEOUT_MS;
});

test("training client waits and retries trainer capacity responses", async () => {
  busyRemaining = 2;
  requestCount = 0;

  const result = await trainMlStrategyModel({
    botId: "strategic",
    timeframe: "15m",
    markets: [{ symbol: "XAUUSD", bars: [{ open: 1, high: 2, low: 1, close: 2 }] }],
  });

  assert.equal(result?.ok, true);
  assert.equal(result?.ready, true);
  assert.equal(requestCount, 3);
});

test("training client still retries HTTP 429 responses", async () => {
  rateLimitRemaining = 1;
  requestCount = 0;

  const result = await trainMlStrategyModel({
    botId: "strategic",
    timeframe: "15m",
    markets: [{ symbol: "XAUUSD", bars: [{ open: 1, high: 2, low: 1, close: 2 }] }],
  });

  assert.equal(result?.ok, true);
  assert.equal(result?.ready, true);
  assert.equal(requestCount, 2);
});
