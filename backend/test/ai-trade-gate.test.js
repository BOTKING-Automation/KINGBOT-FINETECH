import test from "node:test";
import assert from "node:assert/strict";

import { routeAiSignalToEngine } from "../src/ai-trade-gate.js";

test("temporal model direction wins over an opposing legacy candidate", () => {
  const routed = routeAiSignalToEngine({
    botId: "strategic",
    candidateSignal: "SHORT_CANDIDATE",
    signal: {
      engine: "strategic",
      engineAccepted: true,
      direction: "BUY",
      strategyMatch: true,
      riskApproved: true
    }
  });

  assert.equal(routed.confirm, true);
  assert.equal(routed.direction, "BUY");
  assert.equal(routed.candidateDirection, "SELL");
  assert.equal(routed.candidateDirectionUsedForDecision, false);
});

test("model direction cannot bypass a failed risk authorization", () => {
  const routed = routeAiSignalToEngine({
    botId: "strategic",
    candidateSignal: "LONG_CANDIDATE",
    signal: {
      engine: "strategic",
      engineAccepted: true,
      direction: "BUY",
      strategyMatch: true,
      riskApproved: false
    }
  });

  assert.equal(routed.confirm, false);
  assert.equal(routed.status, "RISK_GOVERNOR_BLOCKED");
});

test("HOLD is never routed as an order direction", () => {
  const routed = routeAiSignalToEngine({
    botId: "strategic",
    signal: {
      engine: "strategic",
      engineAccepted: true,
      direction: "HOLD",
      strategyMatch: false,
      riskApproved: true
    }
  });

  assert.equal(routed.confirm, false);
  assert.equal(routed.status, "CORTEX_SIGNAL_HOLD");
});
