import { Router } from "express";
import { requireUser } from "./subscriptions.js";
import { evaluateRisk, authorizeOrder, normalizeRiskSettings } from "./risk-engine.js";

const BOT_DEFINITIONS = {
  strategic: {
    id: "strategic",
    name: "KINGBOT STRATEGIC",
    mode: "multi-strategy",
    strategies: ["trend-following", "mean-reversion", "volatility-regime", "multi-factor-consensus"],
    risk: { maxRiskPerTradePct: 1, maxPositions: 3, dailyDrawdownPct: 5, totalDrawdownPct: 10 }
  },
  flipper: {
    id: "flipper",
    name: "KINGBOT FLIPPER",
    mode: "high-speed-flipping",
    strategies: ["micro-momentum", "impulse-continuation", "rapid-reversal", "spread-filter"],
    risk: { maxRiskPerTradePct: 0.5, maxPositions: 2, dailyDrawdownPct: 5, totalDrawdownPct: 10 }
  },
  breakout: {
    id: "breakout",
    name: "KINGBOT BREAKOUT",
    mode: "breakout-momentum",
    strategies: ["range-compression", "level-breakout", "volatility-confirmation", "retest-continuation"],
    risk: { maxRiskPerTradePct: 0.75, maxPositions: 3, dailyDrawdownPct: 5, totalDrawdownPct: 10 }
  },
  "smc-pro": {
    id: "smc-pro",
    name: "KINGBOT SMC PRO",
    mode: "smart-money-concepts",
    strategies: ["market-structure", "liquidity-sweep", "order-block", "fair-value-gap", "displacement"],
    risk: { maxRiskPerTradePct: 1, maxPositions: 3, dailyDrawdownPct: 5, totalDrawdownPct: 10 }
  },
  "ladder-flip": {
    id: "ladder-flip",
    name: "KINGBOT LADDER FLIP V8",
    mode: "adaptive-ladder",
    strategies: ["adaptive-spacing", "ladder-levels", "exposure-controller", "reversal-logic", "emergency-unwind"],
    risk: { maxRiskPerTradePct: 0.5, maxPositions: 5, dailyDrawdownPct: 5, totalDrawdownPct: 10 }
  }
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const num = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;

function baseContext(snapshot = {}) {
  return {
    symbol: String(snapshot.symbol || "").toUpperCase(),
    timeframe: String(snapshot.timeframe || "unknown"),
    price: num(snapshot.price),
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
    displacement: Boolean(snapshot.displacement),
    breakout: Boolean(snapshot.breakout),
    retest: Boolean(snapshot.retest)
  };
}

function evaluateStrategic(c) {
  const trend = c.trend * 0.35;
  const momentum = c.momentum * 0.25;
  const meanReversion = -c.trend * (1 - c.volatility) * 0.15;
  const volatilityFit = (c.volatility >= 0.2 && c.volatility <= 0.8 ? 0.15 : -0.05);
  const score = clamp((trend + momentum + meanReversion + volatilityFit) * 100, -100, 100);
  return { score, reason: "Consensus of trend, momentum, mean-reversion and volatility regime." };
}

function evaluateFlipper(c) {
  const impulse = c.momentum * 0.45;
  const microTrend = c.trend * 0.3;
  const spreadPenalty = c.spread > 0 && c.atr > 0 ? Math.min(c.spread / c.atr, 1) * 0.25 : 0;
  const score = clamp((impulse + microTrend - spreadPenalty) * 100, -100, 100);
  return { score, reason: "Short-horizon momentum with spread and impulse filters." };
}

function evaluateBreakout(c) {
  const breakout = c.breakout ? 0.45 : 0;
  const retest = c.retest ? 0.2 : 0;
  const momentum = c.momentum * 0.2;
  const volume = c.volume * 0.15;
  const direction = c.trend >= 0 ? 1 : -1;
  const score = clamp((breakout + retest + momentum + volume) * 100 * direction, -100, 100);
  return { score, reason: "Breakout, retest, momentum and volume confirmation." };
}

function evaluateSmc(c) {
  let directional = c.trend * 0.2;
  if (c.liquiditySweep) directional += c.trend >= 0 ? 0.2 : -0.2;
  if (c.orderBlock) directional += c.trend * 0.2;
  if (c.fairValueGap) directional += c.trend * 0.15;
  if (c.displacement) directional += c.trend * 0.2;
  if (c.structure === "bullish") directional += 0.1;
  if (c.structure === "bearish") directional -= 0.1;
  return { score: clamp(directional * 100, -100, 100), reason: "Market structure, liquidity, order-block, FVG and displacement checks." };
}

function evaluateLadder(c) {
  const directional = c.momentum * 0.25 + c.trend * 0.25;
  const volatilityPenalty = c.volatility > 0.85 ? 0.35 : 0;
  const emergency = c.volatility > 0.95;
  const score = clamp((directional - volatilityPenalty) * 100, -100, 100);
  return { score, emergency, reason: "Adaptive ladder spacing with exposure and volatility controls." };
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
    signal: signalFromScore(evaluation.score),
    score: Math.round(evaluation.score * 100) / 100,
    reason: evaluation.reason,
    executionAuthorized: false,
    risk: bot.risk,
    market: { symbol: context.symbol, timeframe: context.timeframe, price: context.price }
  };
}

async function hasEntitlement(pool, userId, botId) {
  if (!pool) return false;
  const q = await pool.query(
    "SELECT 1 FROM kingbot_bot_entitlements e JOIN kingbot_subscriptions s ON s.id=e.subscription_id WHERE e.user_id=$1 AND e.bot_id=$2 AND e.active=TRUE AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at>NOW()) LIMIT 1",
    [userId, botId]
  );
  return q.rowCount > 0;
}

async function getRiskSettings(pool,userId,botId){
 if(!pool)return null;
 const q=await pool.query("SELECT daily_drawdown_pct,total_drawdown_pct,max_risk_per_trade_pct,max_positions,max_spread_atr_ratio,stale_data_ms,max_consecutive_losses,auto_pause_on_loss_streak,execution_mode,kill_switch,updated_at FROM kingbot_bot_risk_settings WHERE user_id=$1 AND bot_id=$2",[userId,botId]);
 if(!q.rowCount)return null;
 const x=q.rows[0];
 return {...normalizeRiskSettings({dailyDrawdownPct:x.daily_drawdown_pct,totalDrawdownPct:x.total_drawdown_pct,maxRiskPerTradePct:x.max_risk_per_trade_pct,maxPositions:x.max_positions,maxSpreadAtrRatio:x.max_spread_atr_ratio,staleDataMs:x.stale_data_ms,maxConsecutiveLosses:x.max_consecutive_losses,autoPauseOnLossStreak:x.auto_pause_on_loss_streak}),executionMode:String(x.execution_mode||"PAPER"),killSwitch:Boolean(x.kill_switch)};
}
function defaultRisk(bot){return normalizeRiskSettings(bot.risk);}
function validateUserRisk(body,bot){
 const s=normalizeRiskSettings(body||{},bot.risk);
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
      entitled: await hasEntitlement(pool, user.id, bot.id),
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
    const entitled = await hasEntitlement(pool, user.id, bot.id);
    res.json({ ok: true, bot: { ...bot, entitled, runtime: "STOPPED", executionMode: "NOT_CONNECTED", riskSettings: (await getRiskSettings(pool,user.id,bot.id)) || defaultRisk(bot) } });
  });

  router.post("/:botId/analyze", async (req, res) => {
    const user = await requireUser(pool, req, res);
    if (!user) return;
    const botId = req.params.botId;
    if (!BOT_DEFINITIONS[botId]) return res.status(404).json({ ok: false, error: "BOT_NOT_FOUND" });
    if (!(await hasEntitlement(pool, user.id, botId))) {
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
    if(!(await hasEntitlement(pool,user.id,bot.id)))return res.status(403).json({ok:false,allowed:false,reason:"BOT_NOT_INCLUDED_IN_SUBSCRIPTION"});
    const current=(await getRiskSettings(pool,user.id,bot.id))||defaultRisk(bot);
    res.json({ok:true,botId:bot.id,settings:current,defaults:defaultRisk(bot),executionMode:current.executionMode||"PAPER",killSwitch:Boolean(current.killSwitch)});
  });

  router.put("/:botId/risk", async (req,res)=>{
    const user=await requireUser(pool,req,res); if(!user)return;
    const bot=BOT_DEFINITIONS[req.params.botId]; if(!bot)return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    if(!(await hasEntitlement(pool,user.id,bot.id)))return res.status(403).json({ok:false,allowed:false,reason:"BOT_NOT_INCLUDED_IN_SUBSCRIPTION"});
    const checked=validateUserRisk(req.body,bot); if(checked.error)return res.status(400).json({ok:false,error:checked.error});
    const s=checked.settings;
    const mode=String(req.body?.executionMode||"PAPER").toUpperCase();
    if(!["PAPER","LIVE"].includes(mode))return res.status(400).json({ok:false,error:"INVALID_EXECUTION_MODE"});
    try{
      await pool.query("INSERT INTO kingbot_bot_risk_settings(user_id,bot_id,daily_drawdown_pct,total_drawdown_pct,max_risk_per_trade_pct,max_positions,max_spread_atr_ratio,stale_data_ms,max_consecutive_losses,auto_pause_on_loss_streak,execution_mode,kill_switch) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(user_id,bot_id) DO UPDATE SET daily_drawdown_pct=EXCLUDED.daily_drawdown_pct,total_drawdown_pct=EXCLUDED.total_drawdown_pct,max_risk_per_trade_pct=EXCLUDED.max_risk_per_trade_pct,max_positions=EXCLUDED.max_positions,max_spread_atr_ratio=EXCLUDED.max_spread_atr_ratio,stale_data_ms=EXCLUDED.stale_data_ms,max_consecutive_losses=EXCLUDED.max_consecutive_losses,auto_pause_on_loss_streak=EXCLUDED.auto_pause_on_loss_streak,execution_mode=EXCLUDED.execution_mode,kill_switch=EXCLUDED.kill_switch,updated_at=NOW()",[user.id,bot.id,s.dailyDrawdownPct,s.totalDrawdownPct,s.maxRiskPerTradePct,s.maxPositions,s.maxSpreadAtrRatio,s.staleDataMs,s.maxConsecutiveLosses,s.autoPauseOnLossStreak,mode,Boolean(req.body?.killSwitch)]);
      await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,'BOT_RISK_SETTINGS_UPDATED',$2::jsonb)",[user.id,JSON.stringify({botId:bot.id,executionMode:mode,settings:s,killSwitch:Boolean(req.body?.killSwitch)})]);
      res.json({ok:true,botId:bot.id,settings:s,executionMode:mode,killSwitch:Boolean(req.body?.killSwitch),message:"Risk profile saved to the KINGBOT risk engine."});
    }catch(err){console.error("[KINGBOT RISK]",err?.message||err);res.status(500).json({ok:false,error:"Risk settings could not be saved."});}
  });

  return router;
}

export async function ensureBotEngineSchema(pool){
 if(!pool)return;
 await pool.query("CREATE TABLE IF NOT EXISTS kingbot_bot_risk_settings (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE, bot_id TEXT NOT NULL, daily_drawdown_pct NUMERIC(6,2) NOT NULL DEFAULT 5, total_drawdown_pct NUMERIC(6,2) NOT NULL DEFAULT 10, max_risk_per_trade_pct NUMERIC(6,2) NOT NULL DEFAULT 1, max_positions INTEGER NOT NULL DEFAULT 3, max_spread_atr_ratio NUMERIC(6,3) NOT NULL DEFAULT 0.25, stale_data_ms INTEGER NOT NULL DEFAULT 5000, max_consecutive_losses INTEGER NOT NULL DEFAULT 3, auto_pause_on_loss_streak BOOLEAN NOT NULL DEFAULT TRUE, execution_mode TEXT NOT NULL DEFAULT 'PAPER', kill_switch BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id,bot_id))");
}
