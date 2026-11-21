import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMlFeedbackPayload } from "../src/ml-artifacts.js";

const decisionId = "550e8400-e29b-41d4-a716-446655440000";
const now = Date.parse("2026-11-21T10:00:00.000Z");

function validPayload(overrides = {}) {
  return {
    decisionId,
    botId: "strategic",
    symbol: "XAUUSD",
    timeframe: "5m",
    direction: "BUY",
    outcome: "WIN",
    features: Array.from({ length: 28 }, (_, index) => index / 10),
    marketAsOf: Date.parse("2026-11-21T09:55:00.000Z") / 1000,
    settledAt: "2026-11-21T09:58:00.000Z",
    pnl: 12.5,
    rMultiple: 1.25,
    ...overrides
  };
}

test("normalizes verified feedback and derives its directional label", () => {
  const feedback = normalizeMlFeedbackPayload(validPayload(), now);
  assert.equal(feedback.decisionId, decisionId);
  assert.equal(feedback.strategy, "strategic");
  assert.equal(feedback.symbol, "XAUUSD");
  assert.equal(feedback.label, 1);
  assert.equal(feedback.features.length, 28);
  assert.match(feedback.payloadHash, /^[a-f0-9]{64}$/);
});

test("normalization is stable for an identical decision payload", () => {
  const first = normalizeMlFeedbackPayload(validPayload(), now);
  const second = normalizeMlFeedbackPayload(validPayload(), now);
  assert.equal(first.payloadHash, second.payloadHash);
});

test("rejects a missing or invalid decision identifier", () => {
  assert.throws(
    () => normalizeMlFeedbackPayload(validPayload({ decisionId: "not-a-uuid" }), now),
    /ML_FEEDBACK_DECISION_ID_INVALID/
  );
});

test("rejects feedback when settlement is not later than market evidence", () => {
  assert.throws(
    () => normalizeMlFeedbackPayload(validPayload({
      settledAt: "2026-11-21T09:54:00.000Z"
    }), now),
    /ML_FEEDBACK_TIMESTAMP_ORDER_INVALID/
  );
});

test("rejects an outcome that contradicts realized PnL", () => {
  assert.throws(
    () => normalizeMlFeedbackPayload(validPayload({ outcome: "LOSS", pnl: 12.5 }), now),
    /ML_FEEDBACK_OUTCOME_PNL_MISMATCH/
  );
});

test("rejects non-finite feature values", () => {
  assert.throws(
    () => normalizeMlFeedbackPayload(validPayload({ features: [0, Number.NaN] }), now),
    /ML_FEEDBACK_FEATURES_INVALID/
  );
});

test("maps sell-side wins to a negative market-direction label", () => {
  const feedback = normalizeMlFeedbackPayload(validPayload({
    direction: "SELL",
    outcome: "WIN",
    pnl: 3.5
  }), now);
  assert.equal(feedback.label, -1);
});

test("maps breakeven outcomes to the neutral label", () => {
  const feedback = normalizeMlFeedbackPayload(validPayload({
    direction: "SELL",
    outcome: "BREAKEVEN",
    pnl: 0,
    rMultiple: 0
  }), now);
  assert.equal(feedback.label, 0);
});
