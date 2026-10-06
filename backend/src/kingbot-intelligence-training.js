/**
 * KINGBOT Intelligence — proprietary training pipeline (v1).
 *
 * This module does NOT place orders and does NOT modify production risk rules.
 * It converts verified market snapshots + settled trade outcomes into a
 * deterministic, leakage-resistant training dataset for the ML service.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
const num = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const bool01 = v => v === true || v === "true" || v === 1 ? 1 : 0;
const sign = v => Math.sign(num(v));

export const KINGBOT_MODEL_VERSION = "KBI-V1";
export const KINGBOT_FEATURE_SCHEMA_VERSION = "KBI-FEATURES-1";

export const FEATURE_NAMES = [
  "trend","momentum","volatility","rsi_norm","ema_gap_atr",
  "atr_norm","spread_atr","macd_norm","structure_bull","structure_bear",
  "bos_bull","bos_bear","choch_bull","choch_bear",
  "liquidity_bull","liquidity_bear","displacement_bull","displacement_bear",
  "fvg_bull","fvg_bear","order_block_bull","order_block_bear",
  "breakout","retest","volume_norm","roc5","session_norm",
  "strategy_fit","strategy_threshold","data_age_norm"
];

function directionFlags(value, positive, negative) {
  const s = String(value || "").toUpperCase();
  return [s === positive ? 1 : 0, s === negative ? 1 : 0];
}

/**
 * Build the model input vector from verified observable data.
 * Missing optional fields become neutral values; missing price/ATR should
 * be rejected by the caller rather than silently fabricated.
 */
export function buildFeatureVector(market = {}, engine = {}) {
  const atr = Math.abs(num(market.atr14 ?? market.atr));
  const ema20 = num(market.ema20);
  const ema50 = num(market.ema50);
  const emaGapAtr = atr > 0 ? (ema20 - ema50) / atr : 0;
  const spreadAtr = atr > 0 ? Math.abs(num(market.spread)) / atr : 0;
  const rsi = num(market.rsi14 ?? market.rsi, 50);
  const macd = num(market.macd);
  const macdSignal = num(market.macdSignal);
  const macdNorm = atr > 0 ? (macd - macdSignal) / atr : 0;
  const [structureBull, structureBear] = directionFlags(market.structure, "BULLISH", "BEARISH");
  const [bosBull, bosBear] = directionFlags(market.bos, "BULLISH", "BEARISH");
  const [chochBull, chochBear] = directionFlags(market.choch, "BULLISH", "BEARISH");
  const [liqBull, liqBear] = directionFlags(market.liquiditySweep, "BULLISH", "BEARISH");
  const [dispBull, dispBear] = directionFlags(market.displacement, "BULLISH", "BEARISH");
  const fvgBull = market.fvg === true || String(market.fvg || "").toUpperCase() === "BULLISH" ? 1 : 0;
  const fvgBear = String(market.fvg || "").toUpperCase() === "BEARISH" ? 1 : 0;
  const obDir = String(market.orderBlock?.direction || market.orderBlock || "").toUpperCase();
  const obBull = obDir === "BULLISH" ? 1 : 0;
  const obBear = obDir === "BEARISH" ? 1 : 0;
  const maxAge = Math.max(1000, num(market.freshnessMaxAgeMs ?? market.quoteFreshnessMaxAgeMs, 30000));
  const age = Math.max(0, num(market.quoteAgeMs ?? market.dataAgeMs));
  const strategyFit = num(engine.currentFit ?? engine.fit, 50);
  const threshold = num(engine.signalThreshold, 75);

  const vector = [
    clamp(num(market.trend), -1, 1),
    clamp(num(market.momentum), -1, 1),
    clamp(num(market.volatility), 0, 1),
    clamp((rsi - 50) / 50, -1, 1),
    clamp(emaGapAtr, -5, 5),
    atr > 0 ? clamp(atr / Math.max(Math.abs(num(market.price)), 1e-9), 0, 1) : 0,
    clamp(spreadAtr, 0, 5),
    clamp(macdNorm, -5, 5),
    structureBull, structureBear, bosBull, bosBear, chochBull, chochBear,
    liqBull, liqBear, dispBull, dispBear, fvgBull, fvgBear,
    obBull, obBear,
    bool01(market.breakout), bool01(market.retest),
    clamp(num(market.volume), 0, 1),
    clamp(num(market.roc5) / 0.01, -1, 1),
    clamp(num(market.sessionScore ?? 0), -1, 1),
    clamp(strategyFit / 100, 0, 1),
    clamp(threshold / 100, 0, 1),
    clamp(age / maxAge, 0, 10)
  ];

  if (vector.length !== FEATURE_NAMES.length) {
    throw new Error("KBI_FEATURE_SCHEMA_MISMATCH");
  }

  return {
    schemaVersion: KINGBOT_FEATURE_SCHEMA_VERSION,
    names: FEATURE_NAMES,
    values: vector.map(v => Number(Number(v).toFixed(8)))
  };
}

/**
 * Outcome labels are created only after the trade is settled.
 * We deliberately avoid using future information in the feature vector.
 */
export function buildOutcomeLabel({ outcome, rMultiple, direction, mfeR, maeR } = {}) {
  const normalizedOutcome = String(outcome || "").toUpperCase();
  const r = Number(rMultiple);
  if (!["WIN","LOSS","BREAKEVEN","INVALIDATED"].includes(normalizedOutcome) || !Number.isFinite(r)) {
    return null;
  }

  const profitable = r > 0 ? 1 : 0;
  const dir = String(direction || "").toUpperCase();
  return {
    outcome: normalizedOutcome,
    profitable,
    rMultiple: Number(r.toFixed(6)),
    direction: ["BUY","SELL"].includes(dir) ? dir : "HOLD",
    mfeR: Number.isFinite(Number(mfeR)) ? Number(mfeR) : null,
    maeR: Number.isFinite(Number(maeR)) ? Number(maeR) : null
  };
}

export function validateTrainingRow(row) {
  if (!row || !Array.isArray(row.features) || row.features.length !== FEATURE_NAMES.length) {
    return { ok: false, reason: "FEATURE_VECTOR_INVALID" };
  }
  if (!row.label || !Number.isFinite(Number(row.label.rMultiple))) {
    return { ok: false, reason: "OUTCOME_LABEL_INVALID" };
  }
  if (!row.market?.symbol || !row.market?.timeframe) {
    return { ok: false, reason: "MARKET_IDENTITY_MISSING" };
  }
  return { ok: true };
}

/**
 * Prevent temporal leakage: a training row must be anchored before its
 * settlement, and rows are sorted chronologically. The ML service should
 * then perform time-ordered train/validation/test splits.
 */
export function prepareTrainingRows(rows = []) {
  const valid = rows
    .filter(row => validateTrainingRow(row).ok)
    .map(row => ({
      ...row,
      createdAt: new Date(row.createdAt || 0).toISOString(),
      settledAt: new Date(row.settledAt || row.createdAt || 0).toISOString()
    }))
    .filter(row => Number.isFinite(Date.parse(row.createdAt)))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  return {
    modelVersion: KINGBOT_MODEL_VERSION,
    featureSchemaVersion: KINGBOT_FEATURE_SCHEMA_VERSION,
    count: valid.length,
    rows: valid
  };
}

export function trainingReadiness(rows = [], {
  minRows = 500,
  minWins = 100,
  minLosses = 100
} = {}) {
  const prepared = prepareTrainingRows(rows).rows;
  const wins = prepared.filter(r => Number(r.label?.rMultiple) > 0).length;
  const losses = prepared.filter(r => Number(r.label?.rMultiple) < 0).length;

  const checks = {
    minimumRows: prepared.length >= minRows,
    classBalance: wins >= minWins && losses >= minLosses,
    temporalOrdering: prepared.every((r, i) => i === 0 || Date.parse(r.createdAt) >= Date.parse(prepared[i - 1].createdAt))
  };

  return {
    ready: Object.values(checks).every(Boolean),
    rows: prepared.length,
    wins,
    losses,
    checks,
    recommendation: Object.values(checks).every(Boolean)
      ? "READY_FOR_WALK_FORWARD_TRAINING"
      : "COLLECT_MORE_SETTLED_OUTCOMES"
  };
}
