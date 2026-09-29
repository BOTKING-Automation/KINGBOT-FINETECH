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
    if(!broker.connected)return res.status(503).json({ok:false,error:"BROKER_NOT_CONNECTED",message:"Verified broker connection is required before market validation. No order was submitted."});
    const requestedSymbol=String(req.body?.symbol||"").trim().toUpperCase();
    if(!requestedSymbol)return res.status(400).json({ok:false,error:"SYMBOL_REQUIRED",message:"A broker symbol is required."});
    let quote;
    try{ quote=await broker.getQuote(requestedSymbol,user.id); }
    catch(error){ return res.status(503).json({ok:false,error:"MARKET_DATA_UNAVAILABLE",reason:error?.message||"BROKER_QUOTE_FAILED",message:"Broker market data could not be verified. No order was submitted."}); }
    const quoteData=quote?.data||{};
    const bid=Number(quoteData.bid);
    const ask=Number(quoteData.ask);
    if(!Number.isFinite(bid)||!Number.isFinite(ask)||bid<=0||ask<=0||ask<bid)return res.status(503).json({ok:false,error:"INVALID_BROKER_QUOTE",message:"Broker returned an invalid market quote. No order was submitted."});
    const market={...req.body?.market,symbol:requestedSymbol,bid,ask,price:Number(req.body?.price)||ask};
    const analysis=evaluateBot(b.id,market);
    if(!analysis.ok)return res.status(400).json(analysis);
    let account;
    let positions;
    try {
      [account,positions]=await Promise.all([broker.getAccount(user.id),broker.getPositions(user.id)]);
    } catch(error) {
      return res.status(503).json({ok:false,error:"ACCOUNT_RISK_DATA_UNAVAILABLE",reason:error?.message||"BROKER_TELEMETRY_FAILED",message:"Authoritative account and position data could not be verified. No order was submitted."});
    }
    const accountData=account?.data||{};
    const positionData=Array.isArray(positions?.data)?positions.data:[];
    const equity=Number(accountData.equity);
    const balance=Number(accountData.balance);
    if(!Number.isFinite(equity)||!Number.isFinite(balance)||equity<=0)return res.status(503).json({ok:false,error:"INVALID_ACCOUNT_TELEMETRY",message:"Broker account telemetry is incomplete. No order was submitted."});
    const symbolPositions=positionData.filter(p=>String(p.symbol||"").toUpperCase()===requestedSymbol);
    const spread=ask-bid;
    const requestedRiskPct=Number(req.body?.requestedRiskPct??s.maxRiskPerTradePct);
    const risk=authorizeOrder({
      limits:s,
      executionMode:s.executionMode,
      killSwitch:s.killSwitch,
      equity,
      dayStartEquity:equity,
      peakEquity:equity,
      openPositions:positionData.length,
      requestedRiskPct,
      spread,
      atr:Number(req.body?.atr)
    });
    const signal=analysis.signal;
    let action="NO_ACTION",order=null;
    if(signal!=="NO_SIGNAL"&&risk.allowed){
        const side=signal==="LONG_CANDIDATE"?"BUY":"SELL";
        const volume=Number(req.body?.volume);
        if(!Number.isFinite(volume)||volume<=0)return res.status(400).json({ok:false,error:"ORDER_VOLUME_REQUIRED",message:"Supply a broker-valid order volume; no order was submitted.",analysis,risk});
        if(symbolPositions.length>=s.maxPositions)return res.status(409).json({ok:false,error:"MAX_SYMBOL_POSITIONS",message:"Maximum positions for this symbol are already open. No order was submitted.",analysis,risk});
        const clientId="kb_"+crypto.randomUUID();
        const journal=await pool.query("INSERT INTO kingbot_execution_journal(user_id,bot_id,client_id,execution_mode,symbol,side,volume,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',NOW()) ON CONFLICT(client_id) DO NOTHING RETURNING id",[user.id,b.id,clientId,s.executionMode,analysis.market.symbol,side,volume]);
        if(!journal.rowCount)return res.status(409).json({ok:false,error:"DUPLICATE_EXECUTION_REQUEST",message:"Duplicate execution request blocked. No order was submitted.",analysis,risk});
        try{
          order=await broker.placeOrder({side,symbol:analysis.market.symbol,volume,stopLoss:req.body?.stopLoss,takeProfit:req.body?.takeProfit,comment:"KINGBOT",clientId,userId:user.id});
          await pool.query("UPDATE kingbot_execution_journal SET status='SUBMITTED',broker_result=$2::jsonb,updated_at=NOW() WHERE id=$1",[journal.rows[0].id,JSON.stringify(order)]);
          action="ORDER_SUBMITTED";
        }catch(error){
          await pool.query("UPDATE kingbot_execution_journal SET status='REJECTED',error_message=$2,updated_at=NOW() WHERE id=$1",[journal.rows[0].id,String(error?.message||"ORDER_REJECTED").slice(0,500)]);
          throw error;
        }
    }else if(signal!=="NO_SIGNAL"&&!risk.allowed){action="RISK_BLOCKED";}
    await pool.query("UPDATE kingbot_bot_runtime SET last_signal=$3,last_run_at=NOW(),last_error=NULL,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[user.id,b.id,JSON.stringify({signal,score:analysis.score,action})]);
    await audit(pool,user.id,"BOT_RUNTIME_TICK",{botId:b.id,executionMode:s.executionMode,signal,action,score:analysis.score,riskAllowed:risk.allowed});
    res.json({ok:true,botId:b.id,executionMode:s.executionMode,analysis,risk,action,order});
  });

  return router;
}

export async function ensureBotRuntimeSchema(pool){
  if(!pool)return;
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_execution_journal (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,bot_id TEXT NOT NULL,client_id TEXT NOT NULL UNIQUE,execution_mode TEXT NOT NULL,symbol TEXT NOT NULL,side TEXT NOT NULL,volume NUMERIC NOT NULL,status TEXT NOT NULL,broker_result JSONB,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_bot_runtime (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,bot_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'STOPPED',last_signal JSONB,last_run_at TIMESTAMPTZ,last_error TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(user_id,bot_id))");
}
