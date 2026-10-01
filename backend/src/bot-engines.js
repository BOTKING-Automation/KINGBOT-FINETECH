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
    timeframeProfile: { regime: "4h", setup: "15m", execution: "5m" },
    signalThreshold: 74,
    tradePlan: { slAtr: 1.5, tpAtr: 2.7, trailingTriggerR: 1.0, trailingLockR: 0.45, maxHoldBars: 28 },
    risk: { maxRiskPerTradePct: 1, maxPositions: 3, dailyDrawdownPct: 5, totalDrawdownPct: 10 }
  },
  "ladder-flip": {
    id: "ladder-flip",
    name: "KINGBOT LADDER FLIP V8",
    mode: "v8-adaptive-ladder",
    strategies: ["ema20-50-trend-gate", "adx-strength-gate", "rsi-confirmation", "velocity-pyramiding", "staircase-profit-lock", "risk-governor"],
    timeframeProfile: { regime: "1h", setup: "15m", execution: "5m" },
    signalThreshold: 78,
    tradePlan: { slAtr: 1.5, tpAtr: 0, trailingTriggerR: null, trailingLockR: null, maxHoldBars: 0, maxLadderLevels: 20 },
    risk: { maxRiskPerTradePct: 0.5, maxPositions: 20, dailyDrawdownPct: 6, totalDrawdownPct: 20, lotSize: 0.01 },
    v8: { ...LADDER_V8_DEFAULTS }
  }
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const num = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;

function baseContext(snapshot = {}) {
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
    structure: String(snapshot.structure || "unknown"),
    liquiditySweep: Boolean(snapshot.liquiditySweep),
    orderBlock: Boolean(snapshot.orderBlock),
    fairValueGap: Boolean(snapshot.fairValueGap),
    emaFast: num(snapshot.emaFast),
    emaSlow: num(snapshot.emaSlow),
    adx: num(snapshot.adx),
    rsi: num(snapshot.rsi),
    velocityPoints: num(snapshot.velocityPoints),
    brokerPoint: num(snapshot.brokerPoint),
    displacement: Boolean(snapshot.displacement),
    breakout: Boolean(snapshot.breakout),
    retest: Boolean(snapshot.retest)
  };
}

function evaluateStrategic(c) {
  const regime = c.volatility >= 0.82 ? -0.25 : c.volatility <= 0.08 ? -0.1 : 0.15;
  const trend = c.trend * 0.38;
  const momentum = c.momentum * 0.24;
  const structure = (c.structure === "bullish" ? 0.16 : c.structure === "bearish" ? -0.16 : 0);
  const breakout = c.breakout ? Math.sign(c.trend || 1) * 0.08 : 0;
  const meanReversion = (!c.breakout && c.volatility < 0.35) ? -c.trend * 0.12 : 0;
  const score = clamp((trend + momentum + structure + breakout + meanReversion + regime) * 100, -100, 100);
  return { score, reason: "Regime classification plus trend, structure, momentum and controlled mean-reversion fit." };
}

function evaluateFlipper(c) {
  const impulse = c.momentum * 0.5;
  const microTrend = c.trend * 0.28;
  const structure = c.structure === "bullish" ? 0.12 : c.structure === "bearish" ? -0.12 : 0;
  const spreadPenalty = c.spread > 0 && c.atr > 0 ? Math.min(c.spread / c.atr, 1) * 0.35 : 0;
  const volatilityGate = c.volatility > 0.9 ? -0.3 : c.volatility < 0.08 ? -0.12 : 0.08;
  const score = clamp((impulse + microTrend + structure - spreadPenalty + volatilityGate) * 100, -100, 100);
  return { score, reason: "Micro-momentum, impulse, structure and spread/volatility gates for short-horizon entries." };
}

function evaluateBreakout(c) {
  if (!c.breakout) return { score: 0, reason: "No structural breakout is currently detected." };
  const direction = c.trend >= 0 ? 1 : -1;
  const breakoutImpulse = 0.42;
  const retest = c.retest ? 0.28 : -0.08;
  const momentum = Math.abs(c.momentum) * 0.16;
  const volume = c.volume * 0.14;
  const volatilityFit = c.volatility >= 0.2 && c.volatility <= 0.9 ? 0.1 : -0.08;
  const score = clamp((breakoutImpulse + retest + momentum + volume + volatilityFit) * 100 * direction, -100, 100);
  return { score, reason: c.retest
    ? "Breakout confirmed with retest, momentum, activity and volatility expansion."
    : "Breakout detected; waiting for stronger retest confirmation." };
}

function evaluateSmc(c) {
  const bullish = c.structure === "bullish";
  const bearish = c.structure === "bearish";
  const directionalBias = bullish ? 1 : bearish ? -1 : Math.sign(c.trend || 0);
  if (!c.liquiditySweep || !c.displacement) {
    return { score: 0, reason: "SMC sequence incomplete: liquidity sweep and displacement confirmation are required." };
  }
  let quality = 0.46;
  if (c.orderBlock) quality += 0.16;
  if (c.fairValueGap) quality += 0.15;
  if (bullish || bearish) quality += 0.12;
  quality += Math.min(Math.abs(c.momentum), 1) * 0.1;
  quality -= c.volatility > 0.92 ? 0.2 : 0;
  return {
    score: clamp(quality * 100 * directionalBias, -100, 100),
    reason: "Liquidity sweep → displacement → structure alignment, with OB/FVG confirmation and volatility filter."
  };
}

function evaluateLadder(c) {
  const cfg=BOT_DEFINITIONS["ladder-flip"].v8;
  const adx=Number(c.adx);
  const rsi=Number(c.rsi);
  const emaFast=Number(c.emaFast);
  const emaSlow=Number(c.emaSlow);
  const price=Number(c.price);
  if(![adx,rsi,emaFast,emaSlow,price].every(Number.isFinite)){
    return {score:0,emergency:false,reason:"V8 entry gate waiting for EMA20/EMA50, ADX14 and RSI14 data."};
  }
  if(adx<cfg.adxMinStrength){
    return {score:0,emergency:false,reason:`V8 entry blocked: ADX14 ${adx.toFixed(2)} is below ${cfg.adxMinStrength.toFixed(2)} trend strength.`};
  }
  const bull=emaFast>emaSlow&&price>emaFast&&rsi>=cfg.rsiBullMin;
  const bear=emaFast<emaSlow&&price<emaFast&&rsi<=cfg.rsiBearMax;
  if(!bull&&!bear){
    return {score:0,emergency:false,reason:"V8 entry blocked: EMA20/EMA50, price location and RSI confirmation are not aligned."};
  }
  const adxBonus=Math.min(12,Math.max(0,(adx-cfg.adxMinStrength)*0.35));
  const rsiBonus=bull?Math.min(8,Math.max(0,rsi-cfg.rsiBullMin)*0.8):Math.min(8,Math.max(0,cfg.rsiBearMax-rsi)*0.8);
  const emaGap=Math.abs(emaFast-emaSlow);
  const gapBonus=c.atr>0?Math.min(5,(emaGap/c.atr)*2):0;
  const score=clamp(78+adxBonus+rsiBonus+gapBonus,0,100)*(bull?1:-1);
  return {
    score,
    emergency:Number(c.volatility)>0.95,
    reason:bull
      ? `V8 BUY gate confirmed: EMA20>EMA50, price>EMA20, RSI14 ${rsi.toFixed(2)}, ADX14 ${adx.toFixed(2)}.`
      : `V8 SELL gate confirmed: EMA20<EMA50, price<EMA20, RSI14 ${rsi.toFixed(2)}, ADX14 ${adx.toFixed(2)}.`
  };
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
  const context = baseContext(snapshot);
  const validation = validateSnapshot(context);
  if (!validation.ok) return { ok: false, bot: botId, status: "DATA_BLOCKED", reason: validation.reason };
  const evaluation = evaluators[botId](context);
  return {
    ok: true,
    bot: botId,
    name: bot.name,
    status: "ANALYSIS_ONLY",
    signal: Math.abs(evaluation.score) >= bot.signalThreshold ? signalFromScore(evaluation.score) : "NO_SIGNAL",
    threshold: bot.signalThreshold,
    score: Math.round(evaluation.score * 100) / 100,
    reason: evaluation.reason,
    executionAuthorized: false,
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
 const settings={...normalizeRiskSettings({dailyDrawdownPct:x.daily_drawdown_pct,totalDrawdownPct:x.total_drawdown_pct,maxRiskPerTradePct:x.max_risk_per_trade_pct,maxPositions:x.max_positions,lotSize:x.lot_size,maxSpreadAtrRatio:x.max_spread_atr_ratio,staleDataMs:x.stale_data_ms,maxConsecutiveLosses:x.max_consecutive_losses,autoPauseOnLossStreak:x.auto_pause_on_loss_streak}),executionMode:String(x.execution_mode||"PAPER"),killSwitch:Boolean(x.kill_switch)};
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
    const bots = await Promise.all(Object.values(BOT_DEFINITIONS).map(async bot => ({
      ...bot,
      entitled: await hasEntitlement(pool, user.id, bot.id, user.email),
      runtime: "STOPPED",
      executionMode: "NOT_CONNECTED"
    })));
    res.json({ ok: true, bots });
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
    res.json({ok:true,botId:bot.id,settings:current,defaults:defaultRisk(bot),executionMode:current.executionMode||"PAPER",killSwitch:Boolean(current.killSwitch)});
  });

  router.put("/:botId/risk", async (req,res)=>{
    const user=await requireUser(pool,req,res); if(!user)return;
    const bot=BOT_DEFINITIONS[req.params.botId]; if(!bot)return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    if(!(await hasEntitlement(pool,user.id,bot.id,user.email)))return res.status(403).json({ok:false,allowed:false,reason:"BOT_NOT_INCLUDED_IN_SUBSCRIPTION"});
    const checked=validateUserRisk(req.body,bot); if(checked.error)return res.status(400).json({ok:false,error:checked.error});
    const s=checked.settings;
    const mode=String(req.body?.executionMode||"PAPER").toUpperCase();
    if(!["PAPER","LIVE"].includes(mode))return res.status(400).json({ok:false,error:"INVALID_EXECUTION_MODE"});
    try{
      await pool.query("INSERT INTO kingbot_bot_risk_settings(user_id,bot_id,daily_drawdown_pct,total_drawdown_pct,max_risk_per_trade_pct,max_positions,lot_size,max_spread_atr_ratio,stale_data_ms,max_consecutive_losses,auto_pause_on_loss_streak,execution_mode,kill_switch) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(user_id,bot_id) DO UPDATE SET daily_drawdown_pct=EXCLUDED.daily_drawdown_pct,total_drawdown_pct=EXCLUDED.total_drawdown_pct,max_risk_per_trade_pct=EXCLUDED.max_risk_per_trade_pct,max_positions=EXCLUDED.max_positions,lot_size=EXCLUDED.lot_size,max_spread_atr_ratio=EXCLUDED.max_spread_atr_ratio,stale_data_ms=EXCLUDED.stale_data_ms,max_consecutive_losses=EXCLUDED.max_consecutive_losses,auto_pause_on_loss_streak=EXCLUDED.auto_pause_on_loss_streak,execution_mode=EXCLUDED.execution_mode,kill_switch=EXCLUDED.kill_switch,updated_at=NOW()",[user.id,bot.id,s.dailyDrawdownPct,s.totalDrawdownPct,s.maxRiskPerTradePct,s.maxPositions,s.lotSize,s.maxSpreadAtrRatio,s.staleDataMs,s.maxConsecutiveLosses,s.autoPauseOnLossStreak,mode,Boolean(req.body?.killSwitch)]);
      await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,'BOT_RISK_SETTINGS_UPDATED',$2::jsonb)",[user.id,JSON.stringify({botId:bot.id,executionMode:mode,settings:s,killSwitch:Boolean(req.body?.killSwitch)})]);
      res.json({ok:true,botId:bot.id,settings:s,executionMode:mode,killSwitch:Boolean(req.body?.killSwitch),message:"Risk profile saved to the KINGBOT risk engine."});
    }catch(err){console.error("[KINGBOT RISK]",err?.message||err);res.status(500).json({ok:false,error:"Risk settings could not be saved."});}
  });

  return router;
}

export async function ensureBotEngineSchema(pool){
 if(!pool)return;
 await pool.query("CREATE TABLE IF NOT EXISTS kingbot_bot_risk_settings (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE, bot_id TEXT NOT NULL, daily_drawdown_pct NUMERIC(6,2) NOT NULL DEFAULT 5, total_drawdown_pct NUMERIC(6,2) NOT NULL DEFAULT 10, max_risk_per_trade_pct NUMERIC(6,2) NOT NULL DEFAULT 1, max_positions INTEGER NOT NULL DEFAULT 3, lot_size NUMERIC(12,4) NOT NULL DEFAULT 0.01, max_spread_atr_ratio NUMERIC(6,3) NOT NULL DEFAULT 0.25, stale_data_ms INTEGER NOT NULL DEFAULT 5000, max_consecutive_losses INTEGER NOT NULL DEFAULT 3, auto_pause_on_loss_streak BOOLEAN NOT NULL DEFAULT TRUE, execution_mode TEXT NOT NULL DEFAULT 'PAPER', kill_switch BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id,bot_id))");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS daily_drawdown_pct NUMERIC(6,2) NOT NULL DEFAULT 5");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS total_drawdown_pct NUMERIC(6,2) NOT NULL DEFAULT 10");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS max_risk_per_trade_pct NUMERIC(6,2) NOT NULL DEFAULT 1");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS max_positions INTEGER NOT NULL DEFAULT 3");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS lot_size NUMERIC(12,4) NOT NULL DEFAULT 0.01");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS max_spread_atr_ratio NUMERIC(6,3) NOT NULL DEFAULT 0.25");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS stale_data_ms INTEGER NOT NULL DEFAULT 5000");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS max_consecutive_losses INTEGER NOT NULL DEFAULT 3");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS auto_pause_on_loss_streak BOOLEAN NOT NULL DEFAULT TRUE");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'PAPER'");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS kill_switch BOOLEAN NOT NULL DEFAULT FALSE");
 await pool.query("ALTER TABLE kingbot_bot_risk_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
}
