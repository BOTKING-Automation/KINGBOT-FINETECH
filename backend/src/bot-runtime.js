import { Router } from "express";
import crypto from "node:crypto";
import { requireUser } from "./subscriptions.js";
import { evaluateBot, getBotDefinitions } from "./bot-engines.js";
import { authorizeOrder } from "./risk-engine.js";

const RUN_STATES = new Set(["STOPPED","RUNNING","PAUSED","ERROR"]);

async function entitlement(pool,userId,botId){
  if(!pool)return false;
  const q=await pool.query("SELECT 1 FROM kingbot_bot_entitlements e JOIN kingbot_subscriptions s ON s.id=e.subscription_id WHERE e.user_id=$1 AND e.bot_id=$2 AND e.active=TRUE AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at>NOW()) LIMIT 1",[userId,botId]);
  return q.rowCount>0;
}
async function settings(pool,userId,botId){
  const q=await pool.query("SELECT * FROM kingbot_bot_risk_settings WHERE user_id=$1 AND bot_id=$2",[userId,botId]);
  if(!q.rowCount)return {executionMode:"PAPER",killSwitch:false,dailyDrawdownPct:5,totalDrawdownPct:10,maxRiskPerTradePct:getBotDefinitions()[botId].risk.maxRiskPerTradePct,maxPositions:getBotDefinitions()[botId].risk.maxPositions,maxSpreadAtrRatio:.25,staleDataMs:5000,maxConsecutiveLosses:3,autoPauseOnLossStreak:true};
  const x=q.rows[0];
  return {dailyDrawdownPct:Number(x.daily_drawdown_pct),totalDrawdownPct:Number(x.total_drawdown_pct),maxRiskPerTradePct:Number(x.max_risk_per_trade_pct),maxPositions:Number(x.max_positions),maxSpreadAtrRatio:Number(x.max_spread_atr_ratio),staleDataMs:Number(x.stale_data_ms),maxConsecutiveLosses:Number(x.max_consecutive_losses),autoPauseOnLossStreak:Boolean(x.auto_pause_on_loss_streak),executionMode:String(x.execution_mode),killSwitch:Boolean(x.kill_switch)};
}
async function runtime(pool,userId,botId){
  const q=await pool.query("SELECT * FROM kingbot_bot_runtime WHERE user_id=$1 AND bot_id=$2",[userId,botId]);
  return q.rowCount?q.rows[0]:null;
}
async function audit(pool,userId,event,metadata){
  await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,$2,$3::jsonb)",[userId,event,JSON.stringify(metadata)]);
}

export function createBotRuntimeRouter({pool,broker}){
  const router=Router();

  router.get("/",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const bots=await Promise.all(Object.values(getBotDefinitions()).map(async b=>({botId:b.id,name:b.name,runtime:(await runtime(pool,user.id,b.id))?.state||"STOPPED",executionMode:(await settings(pool,user.id,b.id)).executionMode,killSwitch:(await settings(pool,user.id,b.id)).killSwitch})));
    res.json({ok:true,bots});
  });

  router.get("/:botId",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const b=getBotDefinitions()[req.params.botId];if(!b)return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    if(!(await entitlement(pool,user.id,b.id)))return res.status(403).json({ok:false,allowed:false,reason:"BOT_NOT_INCLUDED_IN_SUBSCRIPTION"});
    const r=await runtime(pool,user.id,b.id),s=await settings(pool,user.id,b.id);
    res.json({ok:true,botId:b.id,state:r?.state||"STOPPED",executionMode:s.executionMode,killSwitch:s.killSwitch,lastSignal:r?.last_signal||null,lastRunAt:r?.last_run_at||null,lastError:r?.last_error||null});
  });

  router.post("/:botId/start",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const b=getBotDefinitions()[req.params.botId];if(!b)return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    if(!(await entitlement(pool,user.id,b.id)))return res.status(403).json({ok:false,allowed:false,reason:"BOT_NOT_INCLUDED_IN_SUBSCRIPTION"});
    const s=await settings(pool,user.id,b.id);
    if(s.killSwitch)return res.status(409).json({ok:false,error:"KILL_SWITCH_ACTIVE"});
    if(!["PAPER","LIVE"].includes(s.executionMode))return res.status(400).json({ok:false,error:"INVALID_EXECUTION_MODE"});
    if(!broker.connected)return res.status(503).json({ok:false,error:"BROKER_NOT_CONNECTED",message:"Connect the verified broker before starting PAPER or LIVE execution. No order was submitted."});
    await pool.query("INSERT INTO kingbot_bot_runtime(user_id,bot_id,state,last_error,updated_at) VALUES($1,$2,'RUNNING',NULL,NOW()) ON CONFLICT(user_id,bot_id) DO UPDATE SET state='RUNNING',last_error=NULL,updated_at=NOW()",[user.id,b.id]);
    await audit(pool,user.id,"BOT_RUNTIME_STARTED",{botId:b.id,executionMode:s.executionMode});
    res.json({ok:true,botId:b.id,state:"RUNNING",executionMode:s.executionMode});
  });

  router.post("/:botId/stop",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const b=getBotDefinitions()[req.params.botId];if(!b)return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    if(!(await entitlement(pool,user.id,b.id)))return res.status(403).json({ok:false,allowed:false,reason:"BOT_NOT_INCLUDED_IN_SUBSCRIPTION"});
    await pool.query("INSERT INTO kingbot_bot_runtime(user_id,bot_id,state,updated_at) VALUES($1,$2,'STOPPED',NOW()) ON CONFLICT(user_id,bot_id) DO UPDATE SET state='STOPPED',updated_at=NOW()",[user.id,b.id]);
    await audit(pool,user.id,"BOT_RUNTIME_STOPPED",{botId:b.id});
    res.json({ok:true,botId:b.id,state:"STOPPED"});
  });

  router.post("/:botId/tick",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const b=getBotDefinitions()[req.params.botId];if(!b)return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    if(!(await entitlement(pool,user.id,b.id)))return res.status(403).json({ok:false,allowed:false,reason:"BOT_NOT_INCLUDED_IN_SUBSCRIPTION"});
    const r=await runtime(pool,user.id,b.id),s=await settings(pool,user.id,b.id);
    if(!r||r.state!=="RUNNING")return res.status(409).json({ok:false,error:"BOT_NOT_RUNNING"});
    if(s.killSwitch)return res.status(409).json({ok:false,error:"KILL_SWITCH_ACTIVE"});
    const market=req.body?.market||req.body||{};
    const analysis=evaluateBot(b.id,market);
    if(!analysis.ok)return res.status(400).json(analysis);
    const riskContext=req.body?.riskContext||{};
    const risk=authorizeOrder({...riskContext,limits:s,executionMode:s.executionMode,killSwitch:s.killSwitch,requestedRiskPct:Number(req.body?.requestedRiskPct??s.maxRiskPerTradePct)});
    const signal=analysis.signal;
    let action="NO_ACTION",order=null;
    if(signal!=="NO_SIGNAL"&&risk.allowed){
        if(!broker.connected)return res.status(503).json({ok:false,error:"BROKER_NOT_CONNECTED",analysis,risk});
        const side=signal==="LONG_CANDIDATE"?"BUY":"SELL";
        const volume=Number(req.body?.volume);
        if(!Number.isFinite(volume)||volume<=0)return res.status(400).json({ok:false,error:"ORDER_VOLUME_REQUIRED",message:"Supply a broker-valid order volume; no order was submitted.",analysis,risk});
        const clientId="kb_"+crypto.randomUUID();
        order=await broker.placeOrder({side,symbol:analysis.market.symbol,volume,stopLoss:req.body?.stopLoss,takeProfit:req.body?.takeProfit,comment:"KINGBOT",clientId,userId:user.id});
        action="ORDER_SUBMITTED";
    }else if(signal!=="NO_SIGNAL"&&!risk.allowed){action="RISK_BLOCKED";}
    await pool.query("UPDATE kingbot_bot_runtime SET last_signal=$3,last_run_at=NOW(),last_error=NULL,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[user.id,b.id,JSON.stringify({signal,score:analysis.score,action})]);
    await audit(pool,user.id,"BOT_RUNTIME_TICK",{botId:b.id,executionMode:s.executionMode,signal,action,score:analysis.score,riskAllowed:risk.allowed});
    res.json({ok:true,botId:b.id,executionMode:s.executionMode,analysis,risk,action,order});
  });

  return router;
}

export async function ensureBotRuntimeSchema(pool){
  if(!pool)return;
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_bot_runtime (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,bot_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'STOPPED',last_signal JSONB,last_run_at TIMESTAMPTZ,last_error TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(user_id,bot_id))");
}
