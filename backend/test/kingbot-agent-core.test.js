import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKingbotAgentPlan,
  createKingbotAgent,
  agentCapabilitySnapshot
} from "../src/kingbot-agent-core.js";

test("Cortex 2.1 builds contextual reasoning priorities", () => {
  const plan = buildKingbotAgentPlan({
    question: "why did it reject that?",
    originalQuestion: "why did it reject that?",
    intent: "RISK_REVIEW",
    frame: {
      topic: "MARKET",
      entities: ["XAUUSD"],
      userGoals: ["DIAGNOSE", "VERIFY"],
      responseMode: "DIAGNOSTIC",
      contextResolved: true,
      historyDepth: 4,
      resolvedUtterance: "Regarding XAUUSD, why did it reject that?"
    },
    memorySummary: [
      { type: "TRADING_PREFERENCE", key: "usual_market", value: "XAUUSD", confidence: 1 }
    ]
  });

  assert.equal(plan.version, "2.1.0");
  assert.equal(plan.context.referenceResolved, true);
  assert.equal(plan.reasoningContext.contextResolved, true);
  assert.deepEqual(plan.reasoningContext.entities, ["XAUUSD"]);
  assert.equal(plan.reasoningContext.memory[0].value, "XAUUSD");
  assert.deepEqual(plan.reasoningContext.priority.slice(0, 3), [
    "CURRENT_USER_MESSAGE",
    "RESOLVED_CONVERSATION_CONTEXT",
    "EXPLICIT_USER_MEMORY"
  ]);
  assert.equal(plan.reasoningContext.executionAuthority, "NONE");
  assert.equal(plan.reasoningContext.liveDataRule, "REQUIRE_VERIFIED_SOURCE");
});

test("agent remains execution-free and memory-aware", () => {
  const agent = createKingbotAgent({
    question: "what about it?",
    intent: "MARKET_INTELLIGENCE",
    frame: {
      topic: "MARKET",
      entities: ["XAUUSD"],
      userGoals: ["UNDERSTAND"],
      responseMode: "EXPLANATORY",
      contextResolved: true,
      historyDepth: 2
    },
    memory: [{ memory_type: "TRADING_PREFERENCE", memory_key: "usual_market", memory_value: { value: "XAUUSD" }, confidence: 1 }],
    memorySummary: [{ type: "TRADING_PREFERENCE", key: "usual_market", value: "XAUUSD", confidence: 1 }]
  });

  assert.equal(agent.snapshot.executionAuthority, "NONE");
  assert.equal(agent.snapshot.memoryAware, true);
  assert.equal(agent.plan.reasoningContext.liveDataRule, "REQUIRE_VERIFIED_SOURCE");
});

test("capability snapshot declares verified-source policy", () => {
  const snapshot = agentCapabilitySnapshot({
    intent: "MARKET_INTELLIGENCE",
    frame: { userGoals: ["VERIFY"], responseMode: "EVIDENCE_FIRST" },
    verified: {}
  });

  assert.equal(snapshot.version, "2.1.0");
  assert.equal(snapshot.executionAuthority, "NONE");
  assert.equal(snapshot.liveDataPolicy, "REQUIRE_VERIFIED_SOURCE");
});
