import { Router } from "express";
import { requireUser } from "./subscriptions.js";
import { isAdminEmail } from "./admin-access.js";
import { evaluateRisk, authorizeOrder, normalizeRiskSettings } from "./risk-engine.js";
import { LADDER_V8_DEFAULTS } from "./ladder-v8.js";

const BOT_DEFINITIONS = {
  strategic: {
    id: "strategic",
    name: "KINGBOT STRATEGIC",
    mode: "multi-strategy",
    strategies: ["trend-following", "mean-reversion", "volatility-regime", "multi-factor-consensus"],
    aiStrategy: { modelKey:"strategic", learning:"ensemble", focus:["trend","momentum","volatility","structure"], decisionRole:"regime + multi-factor selection" },
    timeframeProfile: { regime: "4h", setup: "1h", execution: "15m" },
    signalThreshold: 75,
    tradePlan: { slAtr: 1.6, tpAtr: 2.8, trailingTriggerR: 1.0, trailingLockR: 0.5, maxHoldBars: 30 },
    risk: { maxRiskPerTradePct: 1, maxPositions: 3, dailyDrawdownPct: 5, totalDrawdownPct: 10, lotSize: 0.01 }
  },
  flipper: {
    id: "flipper",
    name: "KINGBOT FLIPPER",
    mode: "high-speed-flipping",
    strategies: ["micro-momentum", "impulse-continuation", "rapid-reversal", "spread-filter"],
    aiStrategy: { modelKey:"flipper", learning:"ensemble", focus:["momentum","velocity","spread","reversal"], decisionRole:"high-speed momentum/reversal selection" },
    timeframeProfile: { regime: "15m", setup: "5m", execution: "1m" },
    signalThreshold: 76,
    tradePlan: { slAtr: 0.75, tpAtr: 1.05, trailingTriggerR: 0.7, trailingLockR: 0.2, maxHoldBars: 8 },
    risk: { maxRiskPerTradePct: 0.5, maxPositions: 2, dailyDrawdownPct: 5, totalDrawdownPct: 10, lotSize: 0.01 }
  },
  breakout: {
    id: "breakout",
    name: "KINGBOT BREAKOUT",
    mode: "breakout-momentum",
    strategies: ["range-compression", "level-breakout", "volatility-confirmation", "retest-continuation"],
    aiStrategy: { modelKey:"breakout", learning:"ensemble", focus:["breakout","retest","volatility","momentum"], decisionRole:"breakout confirmation + continuation selection" },
    timeframeProfile: { regime: "1h", setup: "15m", execution: "5m" },
    signalThreshold: 72,
    tradePlan: { slAtr: 1.25, tpAtr: 2.5, trailingTriggerR: 1.0, trailingLockR: 0.45, maxHoldBars: 18 },
    risk: { maxRiskPerTradePct: 0.75, maxPositions: 3, dailyDrawdownPct: 5, totalDrawdownPct: 10, lotSize: 0.01 }
  },
  "smc-pro": {
    id: "smc-pro",
    name: "KINGBOT SMC PRO",
    mode: "smart-money-concepts",
    strategies: ["market-structure", "liquidity-sweep", "order-block", "fair-value-gap", "displacement"],
    aiStrategy: { modelKey:"smc-pro", learning:"ensemble", focus:["structure","liquiditySweep","orderBlock","fairValueGap","displacement"], decisionRole:"smart-money setup validation" },
    timeframeProfile: { regime: "4h", setup: "15m", execution: "5m" },
    signalThreshold: 74,
    tradePlan: { slAtr: 1.5, tpAtr: 2.7, trailingTriggerR: 1.0, trailingLockR: 0.45, maxHoldBars: 28 },
    risk: { maxRiskPerTradePct: 1, maxPositions: 3, dailyDrawdownPct: 5, totalDrawdownPct: 10, lotSize: 0.01 }
  },
  "ladder-flip": {
    id: "ladder-flip",
    name: "KINGBOT LADDER FLIP V8",
    mode: "v8-adaptive-ladder",
    strategies: ["ema20-50-trend-gate", "adx-strength-gate", "rsi-confirmation", "velocity-pyramiding", "staircase-profit-lock", "risk-governor"],
    aiStrategy: { modelKey:"ladder-flip", learning:"ensemble", focus:["ema_gap","adx_norm","rsi_norm","velocity","spread"], decisionRole:"trend + momentum ladder qualification" },
    timeframeProfile: { regime: "1h", setup: "15m", execution: "5m" },
    signalThreshold: 78,
    tradePlan: { slAtr: 1.5, tpAtr: 0, trailingTriggerR: null, trailingLockR: null, maxHoldBars: 0, maxLadderLevels: 20 },
    risk: { maxRiskPerTradePct: 0.5, maxPositions: 20, dailyDrawdownPct: 6, totalDrawdownPct: 20, lotSize: 0.01 },
    v8: { ...LADDER_V8_DEFAULTS }
  }
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const num = (v, fallback = 0) => v === null || v === undefined || v === ""
  ? fallback
  : Number.isFinite(Number(v)) ? Number(v) : fallback;

function directionOf(value) {
  const text = String(value ?? "").trim().toUpperCase();
  if (["BULLISH","BUY","LONG","UP"].includes(text)) return "BUY";
  if (["BEARISH","SELL","SHORT","DOWN"].includes(text)) return "SELL";
  if (["NONE","NEUTRAL","RANGE","MIXED","WAIT","UNKNOWN",""].includes(text)) return "WAIT";
  const valueNumber = Number(value);
  if (Number.isFinite(valueNumber)) return valueNumber > 0.12 ? "BUY" : valueNumber < -0.12 ? "SELL" : "WAIT";
  return "WAIT";
}

function frameContext(frame) {
  if (!frame || frame.available === false || frame.ok === false) return { available: false, direction: "WAIT", timeframe: frame?.timeframe || null };
  return {
    available: true,
    direction: directionOf(frame.trend ?? frame.structure),
    timeframe: frame.timeframe || null,
    atr: num(frame.atr, 0),
    rsi: num(frame.rsi, null),
    adx: num(frame.adx, null),
    momentum: num(frame.momentum, 0),
    structure: String(frame.structure || "unknown").toLowerCase()
  };
}

function baseContext(snapshot = {}, botId = null) {
  const mtf = snapshot.multiTimeframe || {};
  const profile = snapshot.timeframeProfile || BOT_DEFINITIONS[botId]?.timeframeProfile || {};
  const frames = Array.isArray(mtf.timeframes) ? mtf.timeframes : [];
  const byTimeframe = timeframe => frames.find(frame => String(frame?.timeframe || "").toLowerCase() === String(timeframe || "").toLowerCase());
  const regime = frameContext(mtf.regime || byTimeframe(profile.regime));
  const setup = frameContext(mtf.setup || byTimeframe(profile.setup));
  const execution = frameContext(mtf.execution || byTimeframe(profile.execution));
  const frames = [regime, setup, execution];
  const mtfReady = frames.every(frame => frame.available && frame.atr > 0);
  const mtfConflict = mtfReady && new Set(frames.map(frame => frame.direction).filter(x => x !== "WAIT")).size > 1;
  return {
    symbol: String(snapshot.symbol || "").toUpperCase(),
    timeframe: String(snapshot.timeframe || "unknown"),
    price: num(snapshot.price),
    entryPrice: num(snapshot.entryPrice, num(snapshot.price)),
    spread: num(snapshot.spread),
    atr: num(snapshot.atr),
    volatility: num(snapshot.volatility),
    trend: clamp(num(snapshot.trend), -1, 1),
    momentum: clamp(num(snapshot.momentum), -1, 1),
    volume: clamp(num(snapshot.volume), 0, 1),
    structure: String(snapshot.structure || "unknown").toLowerCase(),
    liquiditySweep: Boolean(snapshot.liquiditySweep),
    liquiditySweepDirection: directionOf(snapshot.rawLiquiditySweep ?? snapshot.liquiditySweepDirection),
    orderBlock: Boolean(snapshot.orderBlock),
    orderBlockDirection: directionOf(snapshot.orderBlock?.direction ?? snapshot.orderBlockDirection),
    fairValueGap: Boolean(snapshot.fairValueGap),
    fairValueGapDirection: directionOf(snapshot.fairValueGapDirection),
    emaFast: num(snapshot.emaFast, null),
    emaSlow: num(snapshot.emaSlow, null),
    adx: num(snapshot.adx, null),
    rsi: num(snapshot.rsi, null),
    velocityPoints: num(snapshot.velocityPoints),
    brokerPoint: num(snapshot.brokerPoint),
    displacement: Boolean(snapshot.displacement),
    displacementDirection: directionOf(snapshot.rawDisplacement ?? snapshot.displacementDirection),
    bosDirection: directionOf(snapshot.rawBos ?? snapshot.bosDirection),
    chochDirection: directionOf(snapshot.rawChoch ?? snapshot.chochDirection),
    breakout: Boolean(snapshot.breakout),
    breakoutDirection: directionOf(snapshot.breakoutDirection),
    retest: Boolean(snapshot.retest),
    retestDirection: directionOf(snapshot.retestDirection),
    candleCount: num(snapshot.candleCount, 0),
    mtf: {
      ready: mtfReady,
      conflict: mtfConflict,
      regime,
      setup,
      execution
    }
  };
}

function alignedMtf(c, direction) {
  if (!c.mtf.ready) return { ok: false, reason: "MULTI_TIMEFRAME_EVIDENCE_INCOMPLETE" };
  if (c.mtf.conflict) return { ok: false, reason: "MULTI_TIMEFRAME_DIRECTION_CONFLICT" };
  const required = [c.mtf.regime.direction, c.mtf.setup.direction, c.mtf.execution.direction];
  if (required.some(value => value !== direction)) {
    return { ok: false, reason: "MULTI_TIMEFRAME_DIRECTION_NOT_ALIGNED" };
  }
  return { ok: true, reason: null };
}

function evaluateStrategic(c) {
  const direction = directionOf(c.trend);
  if (direction === "WAIT") return { score: 0, qualified: false, reason: "Strategic engine is waiting for a measurable directional regime." };
  const aligned = alignedMtf(c, direction);
  const sign = direction === "BUY" ? 1 : -1;
  const trendStrength = Math.min(1, Math.abs(c.trend));
  const momentumStrength = Math.min(1, Math.abs(c.momentum));
  const emaDirection = c.emaFast !== null && c.emaSlow !== null
    ? (c.emaFast > c.emaSlow ? "BUY" : c.emaFast < c.emaSlow ? "SELL" : "WAIT")
    : "WAIT";
  const components = [
    { label: "trend regime", pass: trendStrength >= 0.45, weight: 24 },
    { label: "directional momentum", pass: Math.sign(c.momentum) === sign && momentumStrength >= 0.30, weight: 20 },
    { label: "market structure", pass: c.structure === (direction === "BUY" ? "bullish" : "bearish"), weight: 18 },
    { label: "EMA alignment", pass: emaDirection === direction, weight: 16 },
    { label: "higher-timeframe regime", pass: c.mtf.regime.direction === direction, weight: 12 },
    { label: "setup timeframe", pass: c.mtf.setup.direction === direction, weight: 10 }
  ];
  const score = Math.round(components.reduce((sum, x) => sum + (x.pass ? x.weight : 0), 0));
  const volatilityOk = c.volatility >= 0.08 && c.volatility <= 0.90;
  const qualified = aligned.ok && volatilityOk && components.filter(x => x.pass).length >= 5;
  const missing = components.filter(x => !x.pass).map(x => x.label);
  if (!volatilityOk) missing.push("volatility regime");
  if (!aligned.ok) missing.push(aligned.reason);
  return {
    score: (qualified ? score : Math.min(score, 74)) * (direction === "BUY" ? 1 : -1),
    qualified,
    direction,
    reason: qualified
      ? "Strategic confluence passed: trend, momentum, structure, EMA and all three decision timeframes agree."
      : "Strategic is waiting for complete multi-timeframe confluence. Missing: " + missing.join(", ") + "."
  };
}

function evaluateFlipper(c) {
  const sweepDirection = c.liquiditySweepDirection;
  const chochDirection = c.chochDirection;
  const displacementDirection = c.displacementDirection;
  const triggerDirection = sweepDirection !== "WAIT" ? sweepDirection : chochDirection;
  const direction = triggerDirection !== "WAIT" && triggerDirection === displacementDirection
    ? triggerDirection
    : "WAIT";
  if (direction === "WAIT") {
    return { score: 0, qualified: false, reason: "Flipper requires a same-direction liquidity sweep or CHOCH followed by displacement." };
  }
  const sign = direction === "BUY" ? 1 : -1;
  const rsiOk = c.rsi !== null && (direction === "BUY" ? c.rsi >= 30 && c.rsi <= 62 : c.rsi >= 38 && c.rsi <= 70);
  const momentumOk = Math.sign(c.momentum) === sign && Math.abs(c.momentum) >= 0.30;
  const velocityOk = Math.sign(c.velocityPoints) === sign && Math.abs(c.velocityPoints) >= 0.20;
  const spreadOk = c.atr > 0 && c.spread / c.atr <= 0.20;
  const volatilityOk = c.volatility >= 0.08 && c.volatility <= 0.90;
  const aligned = alignedMtf(c, direction);
  const checks = [
    ["reversal trigger", true, 24],
    ["RSI transition", rsiOk, 14],
    ["directional momentum", momentumOk, 18],
    ["micro-velocity", velocityOk, 16],
    ["spread efficiency", spreadOk, 12],
    ["volatility regime", volatilityOk, 8],
    ["multi-timeframe context", aligned.ok, 8]
  ];
  const score = checks.reduce((sum, item) => sum + (item[1] ? item[2] : 0), 0);
  const qualified = checks.every(item => item[1]);
  const missing = checks.filter(item => !item[1]).map(item => item[0]);
  return {
    score: (qualified ? score : Math.min(score, 74)) * (direction === "BUY" ? 1 : -1),
    qualified,
    direction,
    reason: qualified
      ? "Flipper reversal confirmed by sweep/CHOCH, displacement, RSI, momentum, velocity, spread and MTF."
      : "Flipper is waiting for: " + missing.join(", ") + "."
  };
}

function evaluateBreakout(c) {
  const direction = c.breakoutDirection;
  if (!c.breakout || direction === "WAIT") {
    return { score: 0, qualified: false, reason: "No directional range expansion has been confirmed." };
  }
  const sign = direction === "BUY" ? 1 : -1;
  const retestOk = c.retest && c.retestDirection === direction;
  const momentumOk = Math.sign(c.momentum) === sign && Math.abs(c.momentum) >= 0.30;
  const volumeOk = c.volume >= 0.30;
  const volatilityOk = c.volatility >= 0.20 && c.volatility <= 0.90;
  const aligned = alignedMtf(c, direction);
  const checks = [
    ["directional range break", true, 22],
    ["confirmed retest and acceptance", retestOk, 24],
    ["post-breakout momentum", momentumOk, 18],
    ["relative activity", volumeOk, 12],
    ["controlled volatility expansion", volatilityOk, 12],
    ["multi-timeframe alignment", aligned.ok, 12]
  ];
  const score = checks.reduce((sum, item) => sum + (item[1] ? item[2] : 0), 0);
  const qualified = checks.every(item => item[1]);
  const missing = checks.filter(item => !item[1]).map(item => item[0]);
  return {
    score: (qualified ? score : Math.min(score, 71)) * (direction === "BUY" ? 1 : -1),
    qualified,
    direction,
    reason: qualified
      ? "Breakout accepted after a separate retest with momentum, relative activity, controlled volatility and aligned timeframes."
      : "Breakout is not confirmed yet. Waiting for: " + missing.join(", ") + "."
  };
}

function evaluateSmc(c) {
  const sweep = c.liquiditySweepDirection;
  const displacement = c.displacementDirection;
  const direction = sweep !== "WAIT" && sweep === displacement ? sweep : "WAIT";
  if (direction === "WAIT") {
    return { score: 0, qualified: false, reason: "SMC requires a directional liquidity sweep followed by same-direction displacement." };
  }
  const bosOk = c.bosDirection === direction || c.chochDirection === direction ||
    c.structure === (direction === "BUY" ? "bullish" : "bearish");
  const orderBlockOk = c.orderBlock && c.orderBlockDirection === direction;
  const fvgOk = c.fairValueGap && c.fairValueGapDirection === direction;
  const aligned = alignedMtf(c, direction);
  const volatilityOk = c.volatility < 0.92;
  const checks = [
    ["liquidity sweep", true, 18],
    ["directional displacement", true, 18],
    ["BOS/CHOCH or structure shift", bosOk, 22],
    ["directional order block", orderBlockOk, 14],
    ["directional fair value gap", fvgOk, 12],
    ["multi-timeframe alignment", aligned.ok, 12],
    ["volatility filter", volatilityOk, 4]
  ];
  const score = checks.reduce((sum, item) => sum + (item[1] ? item[2] : 0), 0);
  const qualified = checks.every(item => item[1]);
  const missing = checks.filter(item => !item[1]).map(item => item[0]);
  return {
    score: (qualified ? score : Math.min(score, 73)) * (direction === "BUY" ? 1 : -1),
    qualified,
    direction,
    reason: qualified
      ? "SMC sequence validated: sweep → displacement → structure shift with directional OB/FVG and MTF confluence."
      : "SMC sequence is incomplete. Waiting for: " + missing.join(", ") + "."
  };
}

function evaluateLadder(c) {
  const cfg = BOT_DEFINITIONS["ladder-flip"].v8;
  const adx = c.adx, rsi = c.rsi, fast = c.emaFast, slow = c.emaSlow, price = c.price;
  if ([adx, rsi, fast, slow, price, c.atr].some(v => v === null || !Number.isFinite(v))) {
    return { score: 0, qualified: false, reason: "Ladder Flip is waiting for complete EMA20/EMA50, ADX14, RSI14 and ATR data." };
  }
  if (adx < cfg.adxMinStrength) {
    return { score: 0, qualified: false, reason: "Ladder Flip blocked: ADX14 is below the V8 trend-strength threshold." };
  }
  const direction = fast > slow && price > fast && rsi >= cfg.rsiBullMin
    ? "BUY"
    : fast < slow && price < fast && rsi <= cfg.rsiBearMax
      ? "SELL"
      : "WAIT";
  if (direction === "WAIT") {
    return { score: 0, qualified: false, reason: "Ladder Flip EMA, price-location and RSI gates are not aligned." };
  }
  const sign = direction === "BUY" ? 1 : -1;
  const emaGapAtr = Math.abs(fast - slow) / c.atr;
  const emaGapOk = emaGapAtr >= 0.02;
  const velocityOk = Math.sign(c.velocityPoints) === sign && Math.abs(c.velocityPoints) >= 0.10;
  const spreadOk = c.spread / c.atr <= 0.25;
  const aligned = alignedMtf(c, direction);
  const checks = [
    ["EMA20/EMA50 and price location", true, 26],
    ["ADX14", true, 18],
    ["RSI14", true, 16],
    ["EMA separation / ATR", emaGapOk, 12],
    ["directional velocity", velocityOk, 10],
    ["spread efficiency", spreadOk, 8],
    ["multi-timeframe trend", aligned.ok, 10]
  ];
  const score = checks.reduce((sum, item) => sum + (item[1] ? item[2] : 0), 0);
  const qualified = checks.every(item => item[1]);
  const missing = checks.filter(item => !item[1]).map(item => item[0]);
  return {
    score: (qualified ? score : Math.min(score, 77)) * (direction === "BUY" ? 1 : -1),
    qualified,
    direction,
    emergency: c.volatility > 0.95,
    reason: qualified
      ? "V8 trend gate confirmed with EMA, ADX, RSI, ATR separation, velocity, spread and MTF alignment."
      : "Ladder Flip is waiting for: " + missing.join(", ") + "."
  };
}

function evaluateEngine(botId, context) {
  return evaluators[botId](context);
}

const evaluators = {
  strategic: evaluateStrategic,
  flipper: evaluateFlipper,
  breakout: evaluateBreakout,
  "smc-pro": evaluateSmc,
  "ladder-flip": evaluateLadder
};

function signalFromScore(score) {
  if (score >= 60) return "LONG_CANDIDATE";
  if (score <= -60) return "SHORT_CANDIDATE";
  return "NO_SIGNAL";
}

function validateSnapshot(c) {
  if (!c.symbol || !Number.isFinite(c.price) || c.price <= 0) return { ok: false, reason: "MARKET_DATA_INCOMPLETE" };
  if (c.spread < 0 || c.atr < 0) return { ok: false, reason: "MARKET_DATA_INVALID" };
  return { ok: true };
}

export function getBotDefinitions() {
  return BOT_DEFINITIONS;
}

export function getTradePlan(botId, snapshot, side) {
  const bot = BOT_DEFINITIONS[botId];
  if (!bot) throw new Error("Unknown bot.");
  const c = baseContext(snapshot);
  if (!Number.isFinite(c.atr) || c.atr <= 0) return { ok: false, reason: "ATR_REQUIRED" };
  const plan = bot.tradePlan;
  const stopDistance = c.atr * plan.slAtr;
  const takeProfitDistance = plan.tpAtr > 0 ? c.atr * plan.tpAtr : 0;
  const entry = Number(c.entryPrice || c.price || 0);
  const normalizedSide = String(side || "").toUpperCase();
  if (!entry || !["BUY","SELL"].includes(normalizedSide)) return { ok: false, reason: "TRADE_PLAN_INPUT_INVALID" };
  return {
    ok: true,
    botId,
    side: normalizedSide,
    atr: c.atr,
    stopDistance,
    takeProfitDistance,
    riskReward: Number((plan.tpAtr / plan.slAtr).toFixed(2)),
    stopLoss: normalizedSide === "BUY" ? entry - stopDistance : entry + stopDistance,
    takeProfit: takeProfitDistance > 0 ? (normalizedSide === "BUY" ? entry + takeProfitDistance : entry - takeProfitDistance) : null,
    trailingTriggerR: plan.trailingTriggerR,
    trailingLockR: plan.trailingLockR,
    maxHoldBars: plan.maxHoldBars,
    maxLadderLevels: plan.maxLadderLevels || null
  };
}

export function evaluateBot(botId, snapshot) {
  const bot = BOT_DEFINITIONS[botId];
  if (!bot) throw new Error("Unknown bot.");
  const context = baseContext(snapshot, botId);
  const validation = validateSnapshot(context);
  if (!validation.ok) return { ok: false, bot: botId, status: "DATA_BLOCKED", reason: validation.reason };
  const evaluation = evaluators[botId](context);
  const score = Math.round(Number(evaluation.score || 0) * 100) / 100;
  const thresholdMet = Math.abs(score) >= bot.signalThreshold;
  const strategyQualified = evaluation.qualified !== false;
  const signal = thresholdMet && strategyQualified ? signalFromScore(score) : "NO_SIGNAL";
  return {
    ok: true,
    bot: botId,
    name: bot.name,
    status: signal === "NO_SIGNAL" ? "WAITING_FOR_CONFLUENCE" : "AI_STRATEGY_CANDIDATE",
    signal,
    direction: evaluation.direction || (signal === "LONG_CANDIDATE" ? "BUY" : signal === "SHORT_CANDIDATE" ? "SELL" : "WAIT"),
    threshold: bot.signalThreshold,
    score,
    fit: Math.abs(score),
    qualified: strategyQualified,
    reason: evaluation.reason,
    multiTimeframe: {
      ready: context.mtf.ready,
      conflict: context.mtf.conflict,
      regime: context.mtf.regime.direction,
      setup: context.mtf.setup.direction,
      execution: context.mtf.execution.direction
    },
    executionAuthorized: false,
    executionAuthority: "AI_STRATEGIES + RISK_ENGINE",
    risk: bot.risk,
    market: { symbol: context.symbol, timeframe: context.timeframe, price: context.price }
  };
}

async function hasEntitlement(pool, userId, botId, userEmail) {
  if (isAdminEmail(userEmail)) return true;
  if (!pool) return false;
  const q = await pool.query(
    "SELECT 1 FROM kingbot_bot_entitlements e JOIN kingbot_subscriptions s ON s.id=e.subscription_id WHERE e.user_id=$1 AND e.bot_id=$2 AND e.active=TRUE AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at>NOW()) LIMIT 1",
    [userId, botId]
  );
  return q.rowCount > 0;
}

async function getRiskSettings(pool,userId,botId){
 if(!pool)return null;
 const q=await pool.query("SELECT daily_drawdown_pct,total_drawdown_pct,max_risk_per_trade_pct,max_positions,lot_size,max_spread_atr_ratio,stale_data_ms,max_consecutive_losses,auto_pause_on_loss_streak,execution_mode,kill_switch,updated_at FROM kingbot_bot_risk_settings WHERE user_id=$1 AND bot_id=$2",[userId,botId]);
 if(!q.rowCount)return null;
 const x=q.rows[0];
 const settings={...normalizeRiskSettings({dailyDrawdownPct:x.daily_drawdown_pct,totalDrawdownPct:x.total_drawdown_pct,maxRiskPerTradePct:x.max_risk_per_trade_pct,maxPositions:x.max_positions,lotSize:x.lot_size,maxSpreadAtrRatio:x.max_spread_atr_ratio,staleDataMs:x.stale_data_ms,maxConsecutiveLosses:x.max_consecutive_losses,autoPauseOnLossStreak:x.auto_pause_on_loss_streak}),executionMode:(String(x.execution_mode||"DEMO")==="PAPER"?"DEMO":String(x.execution_mode||"DEMO")),killSwitch:Boolean(x.kill_switch)};
 if(botId==="ladder-flip")settings.maxPositions=Math.min(LADDER_V8_DEFAULTS.maxTotalRungs,Math.max(LADDER_V8_DEFAULTS.fixedRungCount,settings.maxPositions));
 return settings;
}
function defaultRisk(bot){return normalizeRiskSettings(bot.risk);}
function validateUserRisk(body,bot){
 const s=normalizeRiskSettings(body||{},bot.risk);
 if(!Number.isFinite(Number(s.lotSize))||Number(s.lotSize)<=0)return {error:"INVALID_LOT_SIZE"};
 if(s.totalDrawdownPct<s.dailyDrawdownPct)return {error:"TOTAL_DRAWDOWN_MUST_BE_AT_LEAST_DAILY_DRAWDOWN"};
 if(s.maxRiskPerTradePct>bot.risk.maxRiskPerTradePct*3)return {error:"MAX_RISK_PER_TRADE_EXCEEDS_BOT_SAFETY_CEILING"};
 return {settings:s};
}

export function createBotEngineRouter({ pool }) {
  const router = Router();

  router.get("/", async (req, res) => {
    const user = await requireUser(pool, req, res);
    if (!user) return;
    try {
      const entitlementQuery = await pool.query(
        "SELECT DISTINCT e.bot_id FROM kingbot_bot_entitlements e JOIN kingbot_subscriptions s ON s.id=e.subscription_id WHERE e.user_id=$1 AND e.active=TRUE AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at>NOW())",
        [user.id]
      );
      const entitledIds = new Set(entitlementQuery.rows.map(row => String(row.bot_id || "").toLowerCase()));
      const admin = isAdminEmail(user.email);
      const bots = Object.values(BOT_DEFINITIONS).map(bot => ({
        ...bot,
        entitled: admin || entitledIds.has(bot.id),
        runtime: "STOPPED",
        executionMode: "NOT_CONNECTED"
      }));
      res.json({ ok: true, bots });
    } catch (error) {
      console.error("[KINGBOT BOTS] catalog failed:", error?.message || error);
      res.status(503).json({ ok: false, error: "BOT_CATALOG_UNAVAILABLE", message: "Bot catalog is temporarily unavailable. Please retry." });
    }
  });

  router.get("/:botId", async (req, res) => {
    const user = await requireUser(pool, req, res);
    if (!user) return;
    const bot = BOT_DEFINITIONS[req.params.botId];
    if (!bot) return res.status(404).json({ ok: false, error: "BOT_NOT_FOUND" });
    const entitled = await hasEntitlement(pool, user.id, bot.id, user.email);
    res.json({ ok: true, bot: { ...bot, entitled, runtime: "STOPPED", executionMode: "NOT_CONNECTED", riskSettings: (await getRiskSettings(pool,user.id,bot.id)) || defaultRisk(bot) } });
  });

  router.post("/:botId/analyze", async (req, res) => {
    const user = await requireUser(pool, req, res);
    if (!user) return;
    const botId = req.params.botId;
    if (!BOT_DEFINITIONS[botId]) return res.status(404).json({ ok: false, error: "BOT_NOT_FOUND" });
    if (!(await hasEntitlement(pool, user.id, botId, user.email))) {
      return res.status(403).json({ ok: false, allowed: false, reason: "BOT_NOT_INCLUDED_IN_SUBSCRIPTION" });
    }
    const saved=(await getRiskSettings(pool,user.id,botId)) || defaultRisk(BOT_DEFINITIONS[botId]);
    const result=evaluateBot(botId, req.body?.market || req.body || {});
    result.riskSettings=saved;
    if(result.ok && req.body?.riskContext){ result.riskCheck=evaluateRisk({...req.body.riskContext,limits:saved}); }
    res.json(result);
  });

  router.get("/:botId/risk", async (req,res)=>{
    const user=await requireUser(pool,req,res); if(!user)return;
    const bot=BOT_DEFINITIONS[req.params.botId]; if(!bot)return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    if(!(await hasEntitlement(pool,user.id,bot.id,user.email)))return res.status(403).json({ok:false,allowed:false,reason:"BOT_NOT_INCLUDED_IN_SUBSCRIPTION"});
    const current=(await getRiskSettings(pool,user.id,bot.id))||defaultRisk(bot);
    res.json({ok:true,botId:bot.id,settings:current,defaults:defaultRisk(bot),executionMode:current.executionMode||"DEMO",killSwitch:Boolean(current.killSwitch)});
  });

  router.put("/:botId/risk", async (req,res)=>{
    const user=await requireUser(pool,req,res); if(!user)return;
    const bot=BOT_DEFINITIONS[req.params.botId]; if(!bot)return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    if(!(await hasEntitlement(pool,user.id,bot.id,user.email)))return res.status(403).json({ok:false,allowed:false,reason:"BOT_NOT_INCLUDED_IN_SUBSCRIPTION"});
    const checked=validateUserRisk(req.body,bot); if(checked.error)return res.status(400).json({ok:false,error:checked.error});
    const s=checked.settings;
    const requestedMode=String(req.body?.executionMode||"DEMO").toUpperCase();
    if(!["DEMO","LIVE"].includes(requestedMode))return res.status(400).json({ok:false,error:"INVALID_EXECUTION_MODE"});
    try{
      await pool.query("INSERT INTO kingbot_bot_risk_settings(user_id,bot_id,daily_drawdown_pct,total_drawdown_pct,max_risk_per_trade_pct,max_positions,lot_size,max_spread_atr_ratio,stale_data_ms,max_consecutive_losses,auto_pause_on_loss_streak,execution_mode,kill_switch) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(user_id,bot_id) DO UPDATE SET daily_drawdown_pct=EXCLUDED.daily_drawdown_pct,total_drawdown_pct=EXCLUDED.total_drawdown_pct,max_risk_per_trade_pct=EXCLUDED.max_risk_per_trade_pct,max_positions=EXCLUDED.max_positions,lot_size=EXCLUDED.lot_size,max_spread_atr_ratio=EXCLUDED.max_spread_atr_ratio,stale_data_ms=EXCLUDED.stale_data_ms,max_consecutive_losses=EXCLUDED.max_consecutive_losses,auto_pause_on_loss_streak=EXCLUDED.auto_pause_on_loss_streak,execution_mode=EXCLUDED.execution_mode,kill_switch=EXCLUDED.kill_switch,updated_at=NOW()",[user.id,bot.id,s.dailyDrawdownPct,s.totalDrawdownPct,s.maxRiskPerTradePct,s.maxPositions,s.lotSize,s.maxSpreadAtrRatio,s.staleDataMs,s.maxConsecutiveLosses,s.autoPauseOnLossStreak,requestedMode,Boolean(req.body?.killSwitch)]);
      await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,'BOT_RISK_SETTINGS_UPDATED',$2::jsonb)",[user.id,JSON.stringify({botId:bot.id,executionMode:requestedMode==="PAPER"?"DEMO":requestedMode,settings:s,killSwitch:Boolean(req.body?.killSwitch)})]);
      res.json({ok:true,botId:bot.id,settings:s,executionMode:requestedMode==="PAPER"?"DEMO":requestedMode,killSwitch:Boolean(req.body?.killSwitch),message:"Risk profile saved to the KINGBOT risk engine."});
    }catch(err){console.error("[KINGBOT RISK]",err?.message||err);res.status(500).json({ok:false,error:"Risk settings could not be saved."});}
  });

  return router;
}

export async function ensureBotEngineSchema(pool){
 if(!pool)return;
 await pool.query("CREATE TABLE IF NOT EXISTS kingbot_bot_risk_settings (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE, bot_id TEXT NOT NULL, daily_drawdown_pct NUMERIC(6,2) NOT NULL DEFAULT 5, total_drawdown_pct NUMERIC(6,2) NOT NULL DEFAULT 10, max_risk_per_trade_pct NUMERIC(6,2) NOT NULL DEFAULT 1, max_positions INTEGER NOT NULL DEFAULT 3, lot_size NUMERIC(12,4) NOT NULL DEFAULT 0.01, max_spread_atr_ratio NUMERIC(6,3) NOT NULL DEFAULT 0.25, stale_data_ms INTEGER NOT NULL DEFAULT 5000, max_consecutive_losses INTEGER NOT NULL DEFAULT 3, auto_pause_on_loss_streak BOOLEAN NOT NULL DEFAULT TRUE, execution_mode TEXT NOT NULL DEFAULT 'DEMO', kill_switch BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id,bot_id))");
 await pool.query("UPDATE kingbot_bot_risk_settings SET execution_mode='DEMO' WHERE execution_mode='PAPER'");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS daily_drawdown_pct NUMERIC(6,2) NOT NULL DEFAULT 5");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS total_drawdown_pct NUMERIC(6,2) NOT NULL DEFAULT 10");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS max_risk_per_trade_pct NUMERIC(6,2) NOT NULL DEFAULT 1");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS max_positions INTEGER NOT NULL DEFAULT 3");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS lot_size NUMERIC(12,4) NOT NULL DEFAULT 0.01");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS max_spread_atr_ratio NUMERIC(6,3) NOT NULL DEFAULT 0.25");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS stale_data_ms INTEGER NOT NULL DEFAULT 5000");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS max_consecutive_losses INTEGER NOT NULL DEFAULT 3");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS auto_pause_on_loss_streak BOOLEAN NOT NULL DEFAULT TRUE");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'DEMO'");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS kill_switch BOOLEAN NOT NULL DEFAULT FALSE");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
}
