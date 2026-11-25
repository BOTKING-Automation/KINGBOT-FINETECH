import test from "node:test";
import assert from "node:assert/strict";
import {
  GOLD_JOURNEY_PROFILE,
  GOLD_JOURNEY_PROFILE_ID,
  applyGoldJourneyRiskProfile,
  goldJourneyRiskBudget,
  goldJourneyTargetPrice,
  isGoldJourneyExecutionValidated,
  isGoldJourneySymbol,
  normalizeGoldJourneyProfile,
  validateGoldJourneyOrder
} from "../src/gold-journey.js";
import { evaluateRisk, normalizeRiskSettings } from "../src/risk-engine.js";
import { getTradePlan } from "../src/bot-engines.js";

test("Gold Journey profile fixes the requested capital, risk and reward-to-risk", () => {
  assert.equal(GOLD_JOURNEY_PROFILE.startingCapitalUsd, 200);
  assert.equal(GOLD_JOURNEY_PROFILE.riskPerTradePct, 12.5);
  assert.equal(GOLD_JOURNEY_PROFILE.rewardToRisk, 4);
  assert.equal(GOLD_JOURNEY_PROFILE.dailyDrawdownPct, 12.5);
  assert.equal(GOLD_JOURNEY_PROFILE.totalDrawdownPct, 25);
  assert.equal(GOLD_JOURNEY_PROFILE.maxPositions, 1);
  assert.equal(GOLD_JOURNEY_PROFILE.maxConsecutiveLosses, 3);
  assert.equal(GOLD_JOURNEY_PROFILE.executionMode, "DEMO");
  assert.equal(goldJourneyRiskBudget(200), 25);
  assert.equal(goldJourneyRiskBudget(500), 62.5);
});

test("Gold symbol matching accepts common broker suffixes but not unrelated instruments", () => {
  assert.equal(isGoldJourneySymbol("XAUUSD"), true);
  assert.equal(isGoldJourneySymbol("XAUUSDm"), true);
  assert.equal(isGoldJourneySymbol("XAUUSD.pro"), true);
  assert.equal(isGoldJourneySymbol("EURUSD"), false);
});

test("journey activation is restricted to XAUUSD and excludes Ladder Flip", () => {
  const saved = { journeyProfile: GOLD_JOURNEY_PROFILE_ID, botId: "strategic" };
  assert.equal(applyGoldJourneyRiskProfile(saved, "XAUUSDm").goldJourneyEnabled, true);
  assert.equal(applyGoldJourneyRiskProfile(saved, "EURUSD").goldJourneyEnabled, false);
  assert.equal(applyGoldJourneyRiskProfile({ ...saved, botId: "ladder-flip" }, "XAUUSD").goldJourneyEnabled, false);
});

test("Gold Journey cannot silently change its $200 starting reference or 1:4 target", () => {
  assert.deepEqual(normalizeGoldJourneyProfile({
    journeyProfile: GOLD_JOURNEY_PROFILE_ID,
    journeyStartingCapitalUsd: 200,
    journeyRewardToRisk: 4
  }), {
    journeyProfile: GOLD_JOURNEY_PROFILE_ID,
    journeyStartingCapitalUsd: 200,
    journeyRewardToRisk: 4
  });
  assert.equal(normalizeGoldJourneyProfile({
    journeyProfile: GOLD_JOURNEY_PROFILE_ID,
    journeyStartingCapitalUsd: 250,
    journeyRewardToRisk: 4
  }).error, "GOLD_JOURNEY_STARTING_CAPITAL_MUST_BE_200_USD");
});

test("a saved Gold Journey profile is blocked after the bot changes away from XAUUSD", () => {
  const blocked = applyGoldJourneyRiskProfile({
    journeyProfile: GOLD_JOURNEY_PROFILE_ID, botId: "strategic"
  }, "EURUSD");
  assert.equal(blocked.goldJourneyConfigured, true);
  assert.equal(blocked.goldJourneyEnabled, false);
  assert.equal(blocked.goldJourneySymbolBlocked, true);
  const risk = evaluateRisk({
    equity: 200, dayStartEquity: 200, peakEquity: 200,
    openPositions: 0, requestedRiskPct: 12.5,
    requireGoldJourneySymbol: true, goldJourneySymbolVerified: false,
    limits: { maxRiskPerTradePct: 12.5, maxPositions: 1 }
  });
  assert.equal(risk.allowed, false);
  assert.ok(risk.blockedReasons.includes("GOLD_JOURNEY_SYMBOL_REQUIRED"));
});

test("Gold Journey sizes risk from current verified equity, not the reference capital", () => {
  assert.equal(goldJourneyRiskBudget(200), 25);
  assert.equal(goldJourneyRiskBudget(175), 21.88);
  assert.equal(goldJourneyRiskBudget(0), null);
});

test("Gold Journey target calculation produces a gross 1:4 target for both directions", () => {
  assert.equal(goldJourneyTargetPrice({ entryPrice: 2300, stopLoss: 2290, side: "BUY" }), 2340);
  assert.equal(goldJourneyTargetPrice({ entryPrice: 2300, stopLoss: 2310, side: "SELL" }), 2260);
  assert.equal(goldJourneyTargetPrice({ entryPrice: 2300, stopLoss: 2300, side: "BUY" }), null);
});

test("strategy trade plans override native targets to the Gold Journey 1:4 multiple", () => {
  const plan = getTradePlan("strategic", {
    symbol: "XAUUSD", timeframe: "5m", price: 2300, entryPrice: 2300, atr: 10
  }, "BUY", { rewardToRisk: 4 });
  assert.equal(plan.ok, true);
  assert.equal(plan.stopDistance, 16);
  assert.equal(plan.takeProfitDistance, 64);
  assert.equal(plan.riskReward, 4);
  assert.equal(plan.takeProfit, 2364);
});

test("final broker prices must still satisfy at least 1:4", () => {
  assert.equal(validateGoldJourneyOrder({
    symbol: "XAUUSDm", side: "BUY", entryPrice: 2300, stopLoss: 2290, takeProfit: 2340
  }).ok, true);
  assert.equal(validateGoldJourneyOrder({
    symbol: "XAUUSD", side: "SELL", entryPrice: 2300, stopLoss: 2310, takeProfit: 2260
  }).actualRewardToRisk, 4);
  assert.equal(validateGoldJourneyOrder({
    symbol: "XAUUSD", side: "BUY", entryPrice: 2300, stopLoss: 2290, takeProfit: 2330
  }).reason, "GOLD_JOURNEY_MINIMUM_RR_NOT_MET");
});

test("risk engine supports 12.5% but never normalizes above the requested hard cap", () => {
  assert.equal(normalizeRiskSettings({ maxRiskPerTradePct: 12.5 }).maxRiskPerTradePct, 12.5);
  assert.equal(normalizeRiskSettings({ maxRiskPerTradePct: 50 }).maxRiskPerTradePct, 12.5);
  const blocked = evaluateRisk({
    equity: 200, dayStartEquity: 200, peakEquity: 200,
    openPositions: 1, requestedRiskPct: 12.5,
    limits: { maxRiskPerTradePct: 12.5, maxPositions: 1 }
  });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.blockedReasons.includes("MAX_POSITIONS"));
});

test("projected stop loss blocks a trade that would breach total drawdown", () => {
  const first = evaluateRisk({
    equity: 200, dayStartEquity: 200, peakEquity: 200,
    openPositions: 0, requestedRiskPct: 12.5,
    requireProjectedDrawdownCheck: true,
    limits: { dailyDrawdownPct: 12.5, totalDrawdownPct: 25, maxRiskPerTradePct: 12.5, maxPositions: 1 }
  });
  assert.equal(first.allowed, true);
  assert.equal(first.projectedDailyDrawdownPct, 12.5);

  const thirdStop = evaluateRisk({
    equity: 153.125, dayStartEquity: 153.125, peakEquity: 200,
    openPositions: 0, requestedRiskPct: 12.5,
    requireProjectedDrawdownCheck: true,
    limits: { dailyDrawdownPct: 12.5, totalDrawdownPct: 25, maxRiskPerTradePct: 12.5, maxPositions: 1 }
  });
  assert.equal(thirdStop.allowed, false);
  assert.ok(thirdStop.blockedReasons.includes("PROJECTED_TOTAL_DRAWDOWN"));
  assert.ok(thirdStop.projectedTotalDrawdownPct > 25);
});

test("Gold Journey requires verified loss-streak data and an explicit validation flag", () => {
  assert.equal(isGoldJourneyExecutionValidated({}), false);
  assert.equal(isGoldJourneyExecutionValidated({ KINGBOT_GOLD_JOURNEY_VALIDATED: "true" }), true);
  const risk = evaluateRisk({
    equity: 200, dayStartEquity: 200, peakEquity: 200,
    openPositions: 0, requestedRiskPct: 12.5,
    requireLossStreakData: true, lossStreakVerified: false,
    limits: { maxRiskPerTradePct: 12.5, maxPositions: 1 }
  });
  assert.equal(risk.allowed, false);
  assert.ok(risk.blockedReasons.includes("LOSS_STREAK_DATA_UNAVAILABLE"));
});
