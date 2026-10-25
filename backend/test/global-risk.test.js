import test from "node:test";
import assert from "node:assert/strict";
import { getGlobalRiskState, globalExecutionGate } from "../src/global-risk.js";

test("database unavailable fails closed", async () => {
  const state = await getGlobalRiskState(null);
  assert.equal(state.tradingPaused, true);
  assert.equal(state.globalKillSwitch, true);
  assert.deepEqual(globalExecutionGate(state), {
    allowed: false,
    reason: "DATABASE_UNAVAILABLE",
    level: "CRITICAL"
  });
});

test("missing singleton risk row fails closed", async () => {
  const state = await getGlobalRiskState({ query: async () => ({ rows: [] }) });
  assert.equal(state.tradingPaused, true);
  assert.equal(state.globalKillSwitch, true);
  assert.equal(globalExecutionGate(state).allowed, false);
  assert.equal(globalExecutionGate(state).reason, "GLOBAL_RISK_STATE_MISSING");
});

test("risk-store query failure fails closed", async () => {
  const state = await getGlobalRiskState({ query: async () => { throw new Error("database offline"); } });
  assert.equal(state.tradingPaused, true);
  assert.equal(state.globalKillSwitch, true);
  assert.equal(globalExecutionGate(state).allowed, false);
  assert.equal(globalExecutionGate(state).reason, "GLOBAL_RISK_STATE_UNAVAILABLE");
});

test("incomplete risk state cannot authorize execution", () => {
  assert.deepEqual(globalExecutionGate({}), {
    allowed: false,
    reason: "GLOBAL_RISK_STATE_UNAVAILABLE",
    level: "CRITICAL"
  });
  assert.equal(globalExecutionGate(null).allowed, false);
});

test("global kill switch blocks execution", () => {
  assert.deepEqual(globalExecutionGate({
    tradingPaused: false,
    globalKillSwitch: true,
    reason: "operator emergency stop"
  }), {
    allowed: false,
    reason: "GLOBAL_KILL_SWITCH_ACTIVE",
    level: "CRITICAL"
  });
});

test("trading pause blocks execution", () => {
  assert.deepEqual(globalExecutionGate({
    tradingPaused: true,
    globalKillSwitch: false,
    reason: "maintenance"
  }), {
    allowed: false,
    reason: "GLOBAL_TRADING_PAUSED",
    level: "HIGH"
  });
});

test("complete healthy risk state allows the global gate", () => {
  assert.deepEqual(globalExecutionGate({
    tradingPaused: false,
    globalKillSwitch: false,
    reason: "SYSTEM_INITIALIZED"
  }), {
    allowed: true,
    reason: null,
    level: "NORMAL"
  });
});
