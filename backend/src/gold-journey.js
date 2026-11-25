export const GOLD_JOURNEY_PROFILE_ID = "GOLD_JOURNEY_200";

export const GOLD_JOURNEY_PROFILE = Object.freeze({
  id: GOLD_JOURNEY_PROFILE_ID,
  label: "$200 XAUUSD Gold Journey",
  startingCapitalUsd: 200,
  prioritySymbol: "XAUUSD",
  riskPerTradePct: 12.5,
  rewardToRisk: 4,
  dailyDrawdownPct: 12.5,
  totalDrawdownPct: 25,
  maxPositions: 1,
  maxConsecutiveLosses: 3,
  autoPauseOnLossStreak: true,
  maxSpreadAtrRatio: 0.2,
  staleDataMs: 5000,
  executionMode: "DEMO"
});

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

export function isGoldJourneySymbol(symbol) {
  const normalized = String(symbol || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized.startsWith("XAUUSD") || normalized === "FRXXAUUSD";
}

export function normalizeGoldJourneyProfile(input = {}) {
  const requested = String(input.journeyProfile || "STANDARD").trim().toUpperCase();
  if (requested !== GOLD_JOURNEY_PROFILE_ID) {
    return {
      journeyProfile: "STANDARD",
      journeyStartingCapitalUsd: finite(input.journeyStartingCapitalUsd) ?? GOLD_JOURNEY_PROFILE.startingCapitalUsd,
      journeyRewardToRisk: finite(input.journeyRewardToRisk) ?? GOLD_JOURNEY_PROFILE.rewardToRisk
    };
  }

  const startingCapital = finite(input.journeyStartingCapitalUsd);
  const rewardToRisk = finite(input.journeyRewardToRisk);
  if (startingCapital !== GOLD_JOURNEY_PROFILE.startingCapitalUsd) {
    return { error: "GOLD_JOURNEY_STARTING_CAPITAL_MUST_BE_200_USD" };
  }
  if (rewardToRisk !== GOLD_JOURNEY_PROFILE.rewardToRisk) {
    return { error: "GOLD_JOURNEY_REWARD_TO_RISK_MUST_BE_4" };
  }

  return {
    journeyProfile: GOLD_JOURNEY_PROFILE_ID,
    journeyStartingCapitalUsd: GOLD_JOURNEY_PROFILE.startingCapitalUsd,
    journeyRewardToRisk: GOLD_JOURNEY_PROFILE.rewardToRisk
  };
}

export function applyGoldJourneyRiskProfile(settings = {}, symbol = "") {
  const configured = String(settings.journeyProfile || "STANDARD").toUpperCase() === GOLD_JOURNEY_PROFILE_ID;
  const symbolVerified = isGoldJourneySymbol(symbol);
  const engineSupported = String(settings.botId || "").toLowerCase() !== "ladder-flip";
  const enabled = configured && symbolVerified && engineSupported;

  if (!enabled) {
    return {
      ...settings,
      goldJourneyConfigured: configured,
      goldJourneyEnabled: false,
      goldJourneySymbolBlocked: configured && (!symbolVerified || !engineSupported)
    };
  }

  return {
    ...settings,
    dailyDrawdownPct: GOLD_JOURNEY_PROFILE.dailyDrawdownPct,
    totalDrawdownPct: GOLD_JOURNEY_PROFILE.totalDrawdownPct,
    maxRiskPerTradePct: GOLD_JOURNEY_PROFILE.riskPerTradePct,
    maxPositions: GOLD_JOURNEY_PROFILE.maxPositions,
    maxSpreadAtrRatio: GOLD_JOURNEY_PROFILE.maxSpreadAtrRatio,
    staleDataMs: GOLD_JOURNEY_PROFILE.staleDataMs,
    maxConsecutiveLosses: GOLD_JOURNEY_PROFILE.maxConsecutiveLosses,
    autoPauseOnLossStreak: GOLD_JOURNEY_PROFILE.autoPauseOnLossStreak,
    journeyStartingCapitalUsd: GOLD_JOURNEY_PROFILE.startingCapitalUsd,
    journeyRewardToRisk: GOLD_JOURNEY_PROFILE.rewardToRisk,
    goldJourneyConfigured: true,
    goldJourneyEnabled: true,
    goldJourneySymbolBlocked: false
  };
}

export function goldJourneyRiskBudget(equityUsd) {
  const equity = finite(equityUsd);
  if (equity === null || equity <= 0) return null;
  return Number((equity * GOLD_JOURNEY_PROFILE.riskPerTradePct / 100).toFixed(2));
}

export function goldJourneyTargetPrice({ entryPrice, stopLoss, side, rewardToRisk = GOLD_JOURNEY_PROFILE.rewardToRisk } = {}) {
  const entry = finite(entryPrice);
  const stop = finite(stopLoss);
  const rr = finite(rewardToRisk);
  const direction = String(side || "").trim().toUpperCase();
  if (entry === null || stop === null || rr === null || entry <= 0 || stop <= 0 || rr < 1) return null;
  if (direction === "BUY" && stop < entry) return Number((entry + (entry - stop) * rr).toFixed(10));
  if (direction === "SELL" && stop > entry) return Number((entry - (stop - entry) * rr).toFixed(10));
  return null;
}

export function isGoldJourneyExecutionValidated(env = process.env) {
  return String(env?.KINGBOT_GOLD_JOURNEY_VALIDATED || "").trim().toLowerCase() === "true";
}

export function validateGoldJourneyOrder({ symbol, side, entryPrice, stopLoss, takeProfit } = {}) {
  if (!isGoldJourneySymbol(symbol)) return { ok: false, reason: "GOLD_JOURNEY_XAUUSD_ONLY" };
  const entry = finite(entryPrice);
  const stop = finite(stopLoss);
  const target = finite(takeProfit);
  const direction = String(side || "").trim().toUpperCase();
  if (entry === null || stop === null || target === null || entry <= 0 || stop <= 0 || target <= 0) {
    return { ok: false, reason: "GOLD_JOURNEY_PRICE_LEVELS_INVALID" };
  }
  const riskDistance = Math.abs(entry - stop);
  const rewardDistance = Math.abs(target - entry);
  if (!(riskDistance > 0) || (direction === "BUY" ? !(stop < entry && target > entry) : direction === "SELL" ? !(stop > entry && target < entry) : true)) {
    return { ok: false, reason: "GOLD_JOURNEY_PRICE_DIRECTION_INVALID" };
  }
  const actualRewardToRisk = rewardDistance / riskDistance;
  if (actualRewardToRisk + 1e-9 < GOLD_JOURNEY_PROFILE.rewardToRisk) {
    return { ok: false, reason: "GOLD_JOURNEY_MINIMUM_RR_NOT_MET", actualRewardToRisk };
  }
  return { ok: true, actualRewardToRisk };
}
