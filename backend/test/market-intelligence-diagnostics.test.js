import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketIntelligenceDiagnostics } from "../src/market-intelligence-diagnostics.js";

test("weighted MTF diagnostics prioritize higher timeframes without changing decisions", () => {
  const result = buildMarketIntelligenceDiagnostics({
    market: {
      bos: "BULLISH",
      liquiditySweepDirection: "BULLISH",
      displacementDirection: "BEARISH",
      orderBlock: { direction: "BULLISH" }
    },
    multiTimeframe: {
      requiredTimeframes: ["5m", "15m", "1h", "4h"],
      timeframes: [
        { timeframe: "5m", ok: true, trend: "BULLISH", bos: "BULLISH", displacement: "BULLISH" },
        { timeframe: "15m", ok: true, trend: "BULLISH", bos: "BULLISH", displacement: "BEARISH" },
        { timeframe: "1h", ok: true, trend: "BEARISH" },
        { timeframe: "4h", ok: true, trend: "BULLISH" }
      ]
    },
    specialists: [{ botId: "smc-pro", strategyMatch: false, conditions: ["Sweep"], missingConditions: ["FVG"], contradictions: ["HTF conflict"] }],
    evidence: { provenance: { verified: true }, evidenceQuality: 76, dataFlags: [] }
  });
  assert.equal(result.weightedMultiTimeframe.direction, "BULLISH");
  assert.equal(result.weightedMultiTimeframe.alignmentPct, 70);
  assert.equal(result.weightedMultiTimeframe.coveragePct, 100);
  assert.equal(result.lowerTimeframeTriggers.observedDirectionalTriggers, 4);
  assert.equal(result.lowerTimeframeTriggers.opposedTriggers, 1);
  assert.equal(result.patternConfluence.opposedToWeightedBias, 1);
  assert.equal(result.specialistReadiness[0].completionPct, 50);
  assert.equal(result.diagnosticOnly, true);
  assert.equal(result.executionAuthority, "NONE");
  assert.ok(result.warnings.includes("LOWER_TIMEFRAME_TRIGGER_DIVERGENCE"));
});

test("diagnostics report incomplete data instead of manufacturing directional confidence", () => {
  const result = buildMarketIntelligenceDiagnostics({
    market: { bos: "BULLISH" },
    multiTimeframe: { requiredTimeframes: ["5m", "15m", "1h", "4h"], timeframes: [] }
  });
  assert.equal(result.weightedMultiTimeframe.direction, "MIXED");
  assert.equal(result.weightedMultiTimeframe.alignmentPct, null);
  assert.equal(result.weightedMultiTimeframe.coveragePct, 0);
  assert.equal(result.patternConfluence.observedDirectionalPatterns, 1);
  assert.equal(result.patternConfluence.assessmentAvailable, false);
  assert.equal(result.patternConfluence.opposedToWeightedBias, null);
  assert.ok(!result.warnings.includes("PATTERN_EVIDENCE_CONFLICT"));
  assert.ok(result.warnings.includes("MTF_COVERAGE_INCOMPLETE"));
});


test("verified neutral timeframes count toward data coverage but not directional votes", () => {
  const result = buildMarketIntelligenceDiagnostics({
    multiTimeframe: {
      requiredTimeframes: ["5m", "15m", "1h", "4h"],
      timeframes: [
        { timeframe: "5m", ok: true, trend: "BULLISH" },
        { timeframe: "15m", ok: true, trend: "BULLISH" },
        { timeframe: "1h", ok: true, trend: "NEUTRAL" },
        { timeframe: "4h", ok: true, trend: "NEUTRAL" }
      ]
    }
  });
  assert.equal(result.weightedMultiTimeframe.coveragePct, 100);
  assert.deepEqual(result.weightedMultiTimeframe.verifiedTimeframes, ["5m", "15m", "1h", "4h"]);
  assert.deepEqual(result.weightedMultiTimeframe.usableTimeframes, ["5m", "15m"]);
  assert.equal(result.weightedMultiTimeframe.alignmentPct, 100);
  assert.ok(!result.warnings.includes("MTF_COVERAGE_INCOMPLETE"));
});
