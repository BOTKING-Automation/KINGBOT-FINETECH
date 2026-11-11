import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";

let server;
let baseUrl = "";
let busyRemaining = 0;
let rateLimitRemaining = 0;
let gatewayFailureRemaining = 0;
let requestCount = 0;
let healthRequestCount = 0;
let trainMlStrategyModel;
let probeMlSignalService;

before(async () => {
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      healthRequestCount += 1;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        ok: true, ready: true, modelsLoaded: 1,
      }));
      return;
    }
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
        "retry-after": "60",
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
    if (gatewayFailureRemaining > 0) {
      gatewayFailureRemaining -= 1;
      res.writeHead(502, {
        "content-type": "text/plain",
        "retry-after": "0.001",
      }).end("bad gateway");
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
  ({ trainMlStrategyModel, probeMlSignalService } = await import("../src/ml-signal-client.js?test=busy-retry"));
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

test("ML health probe coalesces and caches successful responses", async () => {
  healthRequestCount = 0;

  const first = await probeMlSignalService();
  const second = await probeMlSignalService();

  assert.equal(first?.ready, true);
  assert.equal(second?.ready, true);
  assert.equal(healthRequestCount, 1);
});

test("training client retries transient ML gateway 502 responses", async () => {
  gatewayFailureRemaining = 1;
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

test("training client stops on HTTP 429 and shares cooldown with health probes", async () => {
  rateLimitRemaining = 1;
  requestCount = 0;
  healthRequestCount = 0;

  const result = await trainMlStrategyModel({
    botId: "strategic",
    timeframe: "15m",
    markets: [{ symbol: "XAUUSD", bars: [{ open: 1, high: 2, low: 1, close: 2 }] }],
  });

  assert.equal(result?.ok, false);
  assert.equal(result?.error, "ML_SIGNAL_HTTP_429");
  assert.ok(result?.retryAfterMs > 0);
  assert.equal(requestCount, 1);

  const status = await probeMlSignalService();
  assert.equal(status?.status, "ML_SERVICE_RATE_LIMITED");
  assert.equal(healthRequestCount, 0);

  const skipped = await trainMlStrategyModel({
    botId: "strategic",
    timeframe: "15m",
    markets: [{ symbol: "XAUUSD", bars: [{ open: 1, high: 2, low: 1, close: 2 }] }],
  });
  assert.equal(skipped?.error, "ML_SIGNAL_HTTP_429");
  assert.equal(requestCount, 1);
});

