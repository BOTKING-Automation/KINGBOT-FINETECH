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
