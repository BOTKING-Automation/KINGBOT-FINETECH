import test from "node:test";
import assert from "node:assert/strict";
import {
  loadAiLearningSnapshot,
  registerAiLearningMonitor
} from "../src/ai-learning-monitor.js";

function makePool() {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (sql.includes("FROM kingbot_private.ml_trade_feedback") && sql.includes("GROUP BY strategy")) {
        return { rows: [{
          strategy: "strategic",
          total: 8,
          wins: 5,
          losses: 1,
          invalidated: 1,
          breakeven: 1,
          average_r: "0.74",
          last_settled_at: "2026-11-21T09:00:00.000Z"
        }] };
      }
      if (sql.includes("FROM kingbot_private.ml_feedback_outbox")) {
        return { rows: [{
          pending: 2,
          processing: 1,
          delivered: 8,
          failed: 0,
          oldest_pending_at: "2026-11-21T08:00:00.000Z"
        }] };
      }
      if (sql.includes("ORDER BY received_at DESC")) {
        return { rows: [{
          strategy: "strategic",
          symbol: "XAUUSD",
          direction: "BUY",
          outcome: "WIN",
          pnl: "12.5",
          r_multiple: "1.25",
          settled_at: "2026-11-21T09:00:00.000Z",
          received_at: "2026-11-21T09:00:01.000Z"
        }] };
      }
      return { rows: [{
        total: 12,
        wins: 7,
        losses: 2,
        invalidated: 1,
        breakeven: 2,
        last_24h: 4,
        average_r: "0.41",
        last_received_at: "2026-11-21T09:00:01.000Z",
        last_settled_at: "2026-11-21T09:00:00.000Z"
      }] };
    }
  };
}

test("learning monitor derives outcomes from persisted PostgreSQL rows", async () => {
  const pool = makePool();
  const snapshot = await loadAiLearningSnapshot(pool, {
    now: new Date("2026-11-21T10:00:00.000Z"),
    mlService: {
      ok: true,
      configured: true,
      status: "ML_SERVICE_READY",
      remote: {
        ready: true,
        modelRestoreStatus: "RESTORED",
        feedbackRestoreStatus: "RESTORED",
        feedbackRows: 12,
        persistedFeedbackRows: 12,
        feedbackPersistenceConfigured: true,
        modelsLoaded: 3,
        training: 0
      }
    },
    modelRegistry: {
      ok: true,
      status: "AVAILABLE",
      models: [{
        key: "strategic:5m",
        strategy: "strategic",
        timeframe: "5m",
        symbols: ["XAUUSD"],
        trainedAt: "2026-11-21T08:00:00.000Z",
        samples: 1200,
        trainSamples: 900,
        testSamples: 300,
        ensembleAccuracy: 61.2,
        ensembleBalancedAccuracy: 58.4,
        ensembleMacroF1: 57.1,
        qualityGate: true,
        validationType: "WALK_FORWARD",
        promotion: "CHAMPION",
        feedbackRowsUsed: 8,
        featureVersion: "feature-v10"
      }]
    }
  });

  assert.equal(pool.calls.length, 4);
  assert.equal(snapshot.dataSource, "POSTGRESQL_SETTLED_TRADE_FEEDBACK");
  assert.equal(snapshot.outcomes.total, 12);
  assert.equal(snapshot.outcomes.wins, 7);
  assert.equal(snapshot.outcomes.losses, 2);
  assert.equal(snapshot.outcomes.invalidated, 1);
  assert.equal(snapshot.outcomes.breakeven, 2);
  assert.equal(snapshot.outcomes.decisiveTrades, 10);
  assert.equal(snapshot.outcomes.winRate, 70);
  assert.equal(snapshot.outbox.pending, 2);
  assert.equal(snapshot.outbox.processing, 1);
  assert.equal(snapshot.strategies[0].winRate, 71.43);
  assert.equal(snapshot.recent[0].symbol, "XAUUSD");
  assert.equal(snapshot.mlService.feedbackRestoreStatus, "RESTORED");
  assert.equal(snapshot.modelRegistry.models[0].ensembleAccuracy, 61.2);
  assert.equal(snapshot.modelRegistry.models[0].qualityGate, true);
});

test("learning monitor leaves unavailable ML metrics unavailable instead of fabricating values", async () => {
  const snapshot = await loadAiLearningSnapshot(makePool(), {
    mlService: { ok: false, configured: false, status: "ML_SERVICE_NOT_CONFIGURED" },
    modelRegistry: { ok: false, status: "ML_SERVICE_NOT_CONFIGURED", models: [] }
  });

  assert.equal(snapshot.mlService.configured, false);
  assert.equal(snapshot.mlService.ready, false);
  assert.equal(snapshot.modelRegistry.available, false);
  assert.equal(snapshot.modelRegistry.count, 0);
  assert.equal(snapshot.modelRegistry.models.length, 0);
});

test("learning monitor endpoint blocks non-administrators before querying metrics", async () => {
  let handler;
  const app = { get(path, callback) { assert.equal(path, "/api/admin/ai-learning-monitor"); handler = callback; } };
  const pool = { query: async () => { throw new Error("database should not be queried"); } };
  registerAiLearningMonitor(app, {
    pool,
    requireUser: async () => ({ id: "user-1", email: "customer@example.test" }),
    isAdminEmail: () => false,
    probeMlSignalService: async () => ({ ok: true }),
    listMlSignalModels: async () => ({ ok: true, models: [] })
  });

  const response = {
    code: 200,
    body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader() {}
  };
  await handler({}, response);

  assert.equal(response.code, 403);
  assert.equal(response.body.error, "Administrator access required.");
});

test("learning monitor endpoint returns a no-store snapshot for an administrator", async () => {
  let handler;
  const app = { get(_path, callback) { handler = callback; } };
  const pool = makePool();
  registerAiLearningMonitor(app, {
    pool,
    requireUser: async () => ({ id: "admin-1", email: "admin@example.test" }),
    isAdminEmail: email => email === "admin@example.test",
    probeMlSignalService: async () => ({ ok: true, configured: true, status: "ML_SERVICE_READY", remote: { ready: true } }),
    listMlSignalModels: async () => ({ ok: true, status: "AVAILABLE", models: [] })
  });

  const headers = {};
  const response = {
    code: 200,
    body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(key, value) { headers[key] = value; }
  };
  await handler({}, response);

  assert.equal(response.code, 200);
  assert.equal(headers["Cache-Control"], "no-store");
  assert.equal(response.body.ok, true);
  assert.equal(response.body.outcomes.total, 12);
});
