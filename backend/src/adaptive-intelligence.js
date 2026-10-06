import crypto from "node:crypto";
import { buildFeatureVector, buildOutcomeLabel, KINGBOT_FEATURE_SCHEMA_VERSION } from "./kingbot-intelligence-training.js";

const DEFAULT_MIN_SAMPLES = Math.max(4, Number(process.env.KINGBOT_ADAPTIVE_MIN_SAMPLES || 8));
const PERFORMANCE_WINDOW_DAYS = Math.max(7, Number(process.env.KINGBOT_ADAPTIVE_WINDOW_DAYS || 90));
const MAX_HISTORY_ROWS = Math.max(100, Number(process.env.KINGBOT_ADAPTIVE_HISTORY_ROWS || 2000));

const num = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const upper = v => String(v || "").trim().toUpperCase();
const lower = v => String(v || "").trim().toLowerCase();

export function classifySetup(market = {}) {
  const tags = [];
  if (market.liquiditySweep) tags.push("LIQUIDITY_SWEEP");
  if (market.displacement) tags.push("DISPLACEMENT");
  if (market.orderBlock) tags.push("ORDER_BLOCK");
  if (market.fairValueGap) tags.push("FVG");
  if (market.breakout && market.retest) tags.push("BREAKOUT_RETEST");
  else if (market.breakout) tags.push("BREAKOUT");
  if (Math.abs(num(market.trend)) >= 0.55) tags.push("TREND");
  if (num(market.volatility) <= 0.12) tags.push("LOW_VOL");
  else if (num(market.volatility) >= 0.65) tags.push("HIGH_VOL");
  if (num(market.momentum) >= 0.55 || num(market.momentum) <= -0.55) tags.push("MOMENTUM");
  if (!tags.length) tags.push("NO_CLEAR_SETUP");
  return tags.join("+");
}

function regimeBucket(regime) {
  return upper(regime || "UNKNOWN").replace(/\\s+/g, "_");
}

function normalizedPerformanceRow(row) {
  const trades = Math.max(0, Math.trunc(num(row.trades)));
  const wins = Math.max(0, Math.trunc(num(row.wins)));
  const losses = Math.max(0, Math.trunc(num(row.losses)));
  const breakeven = Math.max(0, trades - wins - losses);
  const avgR = trades ? num(row.avg_r_multiple) : 0;
  const winRate = trades ? (wins / trades) * 100 : 0;
  const smoothedWinRate = ((wins + 4) / (trades + 8)) * 100;
  const expectancyScore = clamp(50 + avgR * 25, 0, 100);
  const reliability = clamp((smoothedWinRate * 0.55) + (expectancyScore * 0.45), 0, 100);
  const sampleWeight = Math.min(1, trades / 30);
  const adjustment = trades >= DEFAULT_MIN_SAMPLES
    ? clamp((reliability - 50) * 0.30 * sampleWeight, -12, 12)
    : 0;
  return {
    trades,
    wins,
    losses,
    breakeven,
    winRate: Number(winRate.toFixed(2)),
    smoothedWinRate: Number(smoothedWinRate.toFixed(2)),
    avgR: Number(avgR.toFixed(4)),
    reliability: Number(reliability.toFixed(2)),
    adjustment: Number(adjustment.toFixed(2)),
    sufficientSample: trades >= DEFAULT_MIN_SAMPLES
  };
}

export async function ensureAdaptiveIntelligenceSchema(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kingbot_ai_adaptive_decisions (
      decision_id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      setup_type TEXT NOT NULL,
      regime TEXT NOT NULL,
      direction TEXT NOT NULL,
      selected_engine TEXT,
      risk_amount NUMERIC,
      confidence NUMERIC(6,2),
      current_fit NUMERIC(6,2),
      historical_fit NUMERIC(6,2),
      adjusted_fit NUMERIC(6,2),
      state TEXT NOT NULL DEFAULT 'WATCH',
      decision_json JSONB NOT NULL,
      outcome_status TEXT NOT NULL DEFAULT 'UNSETTLED',
      pnl NUMERIC,
      r_multiple NUMERIC,
      mfe_r NUMERIC,
      mae_r NUMERIC,
      slippage NUMERIC,
      latency_ms NUMERIC,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_at TIMESTAMPTZ
    )
  `);
    CREATE TABLE IF NOT EXISTS kingbot_ai_training_samples (
      sample_id UUID PRIMARY KEY,
      decision_id UUID NOT NULL UNIQUE REFERENCES kingbot_ai_adaptive_decisions(decision_id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      bot_id TEXT,
      feature_schema_version TEXT NOT NULL,
      features JSONB NOT NULL,
      label JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_kb_training_samples_time ON kingbot_ai_training_samples(symbol,timeframe,created_at);
    CREATE INDEX IF NOT EXISTS idx_kb_training_samples_user ON kingbot_ai_training_samples(user_id,bot_id,created_at);
  await pool.query("ALTER TABLE kingbot_ai_adaptive_decisions ADD COLUMN IF NOT EXISTS risk_amount NUMERIC");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_kb_adaptive_perf ON kingbot_ai_adaptive_decisions(user_id,symbol,selected_engine,regime,setup_type,outcome_status,created_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_kb_adaptive_decision_user ON kingbot_ai_adaptive_decisions(user_id,decision_id)");
  await pool.query("ALTER TABLE kingbot_ai_training_samples ADD COLUMN IF NOT EXISTS label JSONB");
  await pool.query("ALTER TABLE kingbot_ai_training_samples ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ");
}

export async function loadAdaptivePerformance(pool, { userId, symbol } = {}) {
  if (!pool || !userId || !symbol) return {};
  const q = await pool.query(
    `
      SELECT
        selected_engine AS bot_id,
        COALESCE(NULLIF(regime,''),'UNKNOWN') AS regime,
        COALESCE(NULLIF(setup_type,''),'NO_CLEAR_SETUP') AS setup_type,
        COUNT(*)::int AS trades,
        COUNT(*) FILTER (WHERE r_multiple > 0)::int AS wins,
        COUNT(*) FILTER (WHERE r_multiple < 0)::int AS losses,
        AVG(r_multiple) AS avg_r_multiple
      FROM kingbot_ai_adaptive_decisions
      WHERE user_id=$1
        AND UPPER(symbol)=UPPER($2)
        AND outcome_status='SETTLED'
        AND r_multiple IS NOT NULL
        AND settled_at >= NOW() - ($3::text || ' days')::interval
        AND selected_engine IS NOT NULL
      GROUP BY selected_engine, regime, setup_type
      ORDER BY trades DESC
      LIMIT $4
    `,
    [userId, symbol, PERFORMANCE_WINDOW_DAYS, MAX_HISTORY_ROWS]
  );

  const result = {};
  for (const row of q.rows) {
    const metrics = normalizedPerformanceRow(row);
    const bot = String(row.bot_id);
    const regime = regimeBucket(row.regime);
    const setup = String(row.setup_type || "NO_CLEAR_SETUP");
    result[bot] ||= { byRegime: {}, bySetup: {}, overall: null };
    result[bot].byRegime[regime] = metrics;
    result[bot].bySetup[setup] = metrics;
  }

  for (const bot of Object.keys(result)) {
    const qOverall = await pool.query(
      `
        SELECT
          COUNT(*)::int AS trades,
          COUNT(*) FILTER (WHERE r_multiple > 0)::int AS wins,
          COUNT(*) FILTER (WHERE r_multiple < 0)::int AS losses,
          AVG(r_multiple) AS avg_r_multiple
        FROM kingbot_ai_adaptive_decisions
        WHERE user_id=$1
          AND UPPER(symbol)=UPPER($2)
          AND outcome_status='SETTLED'
          AND r_multiple IS NOT NULL
          AND settled_at >= NOW() - ($3::text || ' days')::interval
          AND selected_engine=$4
      `,
      [userId, symbol, PERFORMANCE_WINDOW_DAYS, bot]
    );
    result[bot].overall = normalizedPerformanceRow(qOverall.rows[0] || {});
  }
  return result;
}

function bestHistoricalMetrics(performance, regime, setup) {
  if (!performance) return null;
  const byRegime = performance.byRegime?.[regimeBucket(regime)];
  const bySetup = performance.bySetup?.[setup];
  const candidates = [byRegime, bySetup, performance.overall].filter(Boolean).sort((a, b) => {
    const aScore = (a.sufficientSample ? 1000000 : 0) + a.trades;
    const bScore = (b.sufficientSample ? 1000000 : 0) + b.trades;
    return bScore - aScore;
  });
  return candidates[0] || null;
}

export function applyAdaptivePerformance(engine, performance, { regime, setupType } = {}) {
  const currentFit = clamp(num(engine.currentFit ?? engine.fit), 0, 100);
  const historical = bestHistoricalMetrics(performance, regime, setupType);
  const historicalFit = historical ? historical.reliability : 50;
  const adjustment = historical ? historical.adjustment : 0;
  const adjustedFit = Number(clamp(currentFit + adjustment, 0, 100).toFixed(2));
  return {
    ...engine,
    fit: adjustedFit,
    currentFit: Number(currentFit.toFixed(2)),
    historicalFit: Number(historicalFit.toFixed(2)),
    adaptiveAdjustment: Number(adjustment.toFixed(2)),
    historicalSampleSize: Number(historical?.trades || 0),
    historicalWinRate: Number(historical?.winRate || 0),
    historicalAvgR: Number(historical?.avgR || 0),
    historicalReliable: Boolean(historical?.sufficientSample),
    adaptationState: historical?.sufficientSample ? "ADAPTIVE" : "BASELINE"
  };
}

export async function recordAdaptiveDecision(pool, userId, result) {
  if (!pool || !userId || !result?.market?.symbol) return null;
  const decisionId = result.adaptive?.decisionId || crypto.randomUUID();
  const engine = result.routing?.candidate || null;
  const state = result.adaptive?.decisionState || (
    result.riskCouncil?.blocks?.length
      ? "BLOCKED"
      : result.routing?.selectedEngine
        ? "TRADE_CANDIDATE"
        : (result.debate?.direction && result.debate.direction !== "NEUTRAL" ? "WATCH" : "STAND_ASIDE")
  );
  await pool.query(
    `
      INSERT INTO kingbot_ai_adaptive_decisions(
        decision_id,user_id,symbol,timeframe,setup_type,regime,direction,
        selected_engine,risk_amount,confidence,current_fit,historical_fit,adjusted_fit,state,decision_json
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
      ON CONFLICT(decision_id) DO NOTHING
    `,
    [
      decisionId,
      userId,
      upper(result.market.symbol),
      lower(result.market.timeframe || "15m"),
      classifySetup(result.market),
      regimeBucket(result.summary?.regime || result.debate?.regime || result.market.regime || "UNKNOWN"),
      upper(result.routing?.direction || result.summary?.bias || "HOLD"),
      engine?.botId || result.routing?.selectedEngine || null,
      result.execution?.riskAmount == null ? null : num(result.execution.riskAmount, null),
      num(result.summary?.confidence),
      num(engine?.currentFit ?? engine?.fit),
      num(engine?.historicalFit, 50),
      num(engine?.fit),
      state,
      JSON.stringify(result)
    ]
  );
  try {
    const features = buildFeatureVector(result.market, engine || {});
    await pool.query(
      `INSERT INTO kingbot_ai_training_samples(sample_id,decision_id,user_id,symbol,timeframe,bot_id,feature_schema_version,features)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT(decision_id) DO NOTHING`,
      [crypto.randomUUID(), decisionId, userId, upper(result.market.symbol), lower(result.market.timeframe || "15m"), engine?.botId || result.routing?.selectedEngine || null, KINGBOT_FEATURE_SCHEMA_VERSION, JSON.stringify(features.values)]
    );
  } catch (error) {
    console.warn("[KINGBOT AI TRAINING] feature capture skipped:", error?.message || error);
  }
  return decisionId;
}

export async function settleAdaptiveDecision(pool, userId, payload = {}) {
  if (!pool || !userId) throw new Error("DATABASE_REQUIRED");
  const decisionId = String(payload.decisionId || "").trim();
  if (!decisionId) throw new Error("DECISION_ID_REQUIRED");

  const existing = await pool.query(
    "SELECT decision_id,risk_amount,direction FROM kingbot_ai_adaptive_decisions WHERE decision_id=$1 AND user_id=$2",
    [decisionId, userId]
  );
  if (!existing.rowCount) throw new Error("ADAPTIVE_DECISION_NOT_FOUND");

  const outcome = upper(payload.outcome || "UNKNOWN");
  if (!["WIN","LOSS","BREAKEVEN","INVALIDATED","UNREALIZED"].includes(outcome)) {
    throw new Error("INVALID_OUTCOME_STATUS");
  }

  const pnl = payload.pnl == null ? null : num(payload.pnl, null);
  let rMultiple = payload.rMultiple == null ? null : num(payload.rMultiple, null);
  if (rMultiple == null && pnl != null && Number(existing.rows[0]?.risk_amount) > 0) {
    rMultiple = pnl / Number(existing.rows[0].risk_amount);
  }
  if (outcome !== "UNREALIZED" && rMultiple == null) throw new Error("R_MULTIPLE_REQUIRED");

  const trainingLabel = buildOutcomeLabel({ outcome, rMultiple, direction: payload.direction || existing.rows[0]?.direction, mfeR: payload.mfeR, maeR: payload.maeR });
  const result = await pool.query(
    `
      UPDATE kingbot_ai_adaptive_decisions
      SET outcome_status=$3,
          pnl=$4,
          r_multiple=$5,
          mfe_r=$6,
          mae_r=$7,
          slippage=$8,
          latency_ms=$9,
          settled_at=NOW()
      WHERE decision_id=$1 AND user_id=$2
        AND outcome_status='UNSETTLED'
      RETURNING decision_id, symbol, selected_engine, regime, setup_type, outcome_status, pnl, r_multiple, mfe_r, mae_r, slippage, latency_ms, settled_at
    `,
    [
      decisionId,
      userId,
      outcome,
      pnl,
      rMultiple,
      payload.mfeR == null ? null : num(payload.mfeR, null),
      payload.maeR == null ? null : num(payload.maeR, null),
      payload.slippage == null ? null : num(payload.slippage, null),
      payload.latencyMs == null ? null : num(payload.latencyMs, null)
    ]
  );
  if (trainingLabel) {
    await pool.query(
      `UPDATE kingbot_ai_training_samples
          SET label=$3::jsonb, settled_at=NOW()
        WHERE decision_id=$1 AND user_id=$2`,
      [decisionId, userId, JSON.stringify(trainingLabel)]
    );
  }
  return result.rows[0];
}

export function adaptiveDecisionState({ riskBlocks = [], selectedEngine, directionalBias = "NEUTRAL" } = {}) {
  if (riskBlocks.length) return "BLOCKED";
  if (selectedEngine) return "TRADE_CANDIDATE";
  if (["BULLISH","BEARISH"].includes(upper(directionalBias))) return "WATCH";
  return "STAND_ASIDE";
}
