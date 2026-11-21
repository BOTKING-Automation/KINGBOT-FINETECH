import test from "node:test";
import assert from "node:assert/strict";
import { settleAdaptiveDecision } from "../src/adaptive-intelligence.js";

const settledRow = {
  decision_id: "550e8400-e29b-41d4-a716-446655440000",
  risk_amount: "10",
  outcome_status: "WIN",
  pnl: "15",
  r_multiple: "1.5",
  settled_at: "2026-11-21T10:00:00.000Z",
  symbol: "XAUUSD",
  selected_engine: "strategic",
  regime: "TRENDING",
  setup_type: "TREND",
  mfe_r: null,
  mae_r: null,
  slippage: null,
  latency_ms: null
};

function settledPool(row = settledRow) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("SELECT decision_id")) {
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      throw new Error("Unexpected query: " + sql);
    }
  };
}

test("same settled outcome is idempotently returned for worker recovery", async () => {
  const pool = settledPool();
  const result = await settleAdaptiveDecision(pool, "user-1", {
    decisionId: settledRow.decision_id,
    outcome: "WIN",
    pnl: 15
  });

  assert.equal(result.alreadySettled, true);
  assert.equal(result.outcome_status, "WIN");
  assert.equal(pool.calls.length, 1);
});

test("conflicting retry cannot rewrite an already settled outcome", async () => {
  const pool = settledPool();
  await assert.rejects(
    settleAdaptiveDecision(pool, "user-1", {
      decisionId: settledRow.decision_id,
      outcome: "LOSS",
      pnl: -15
    }),
    /ADAPTIVE_DECISION_ALREADY_SETTLED/
  );
  assert.equal(pool.calls.length, 1);
});
