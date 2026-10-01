import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { UserBrokerManager } from "./user-broker-manager.js";
import { evaluateBot, getBotDefinitions, getTradePlan } from "./bot-engines.js";
import { monitorBotDecision } from "./ai-bot-supervisor.js";
import { authorizeOrder, normalizeRiskSettings } from "./risk-engine.js";
import { ensureAuthSchema } from "./auth.js";
import { ensureSubscriptionSchema, expireStaleSubscriptions } from "./subscriptions.js";
import { isAdminUser } from "./admin-access.js";
import { ensureBotEngineSchema } from "./bot-engines.js";
import { ensureBotRuntimeSchema } from "./bot-runtime.js";

const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined }) : null;
const broker = new UserBrokerManager({pool});
let stopping = false;
let timer = null;
let lastSubscriptionSweep = 0;
const WORKER_POLL_MS = 750;
const MAX_PARALLEL_BOTS = 8;

const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const timeframeMinutes={"1m":1,"2m":2,"3m":3,"4m":4,"5m":5,"6m":6,"10m":10,"12m":12,"15m":15,"20m":20,"30m":30,"1h":60,"2h":120,"3h":180,"4h":240,"6h":360,"8h":480,"12h":720,"1d":1440,"1w":10080,"1mn":43200};

async function ensureWorkerSchema(){
  if(!pool) throw new Error("DATABASE_URL_REQUIRED");
  // Worker can boot before the HTTP service, so establish shared schemas in dependency order.
  await ensureAuthSchema(pool);
  await ensureSubscriptionSchema(pool);
  await ensureBotEngineSchema(pool);
  await ensureBotRuntimeSchema(pool);
  await broker.ensureSchema();
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_account_risk_state (user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,provider TEXT NOT NULL,account_id TEXT NOT NULL,baseline_date DATE NOT NULL,day_start_equity NUMERIC NOT NULL,peak_equity NUMERIC NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(user_id,provider,account_id))");
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_execution_journal (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,bot_id TEXT NOT NULL,client_id TEXT NOT NULL UNIQUE,execution_mode TEXT NOT NULL,symbol TEXT NOT NULL,side TEXT NOT NULL,volume NUMERIC NOT NULL,status TEXT NOT NULL,broker_result JSONB,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
}

async function audit(userId,event,metadata){
  await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,$2,$3::jsonb)",[userId,event,JSON.stringify(metadata)]);
}

function indicators(candles=[]){
  const rows=candles.filter(x=>Number.isFinite(Number(x.open))&&Number.isFinite(Number(x.high))&&Number.isFinite(Number(x.low))&&Number.isFinite(Number(x.close))).slice(-100);
  if(rows.length<20) throw new Error("INSUFFICIENT_HISTORICAL_CANDLES");
  const closes=rows.map(x=>Number(x.close));
  const highs=rows.map(x=>Number(x.high));
  const lows=rows.map(x=>Number(x.low));
  const ranges=rows.map(x=>Number(x.high)-Number(x.low)).filter(x=>x>=0);
  const atr=ranges.slice(-14).reduce((a,b)=>a+b,0)/Math.max(1,ranges.slice(-14).length);
  const fast=closes.slice(-10).reduce((a,b)=>a+b,0)/10;
  const slow=closes.slice(-30).reduce((a,b)=>a+b,0)/30;
  const price=closes.at(-1);
  const momentum=atr>0?Math.max(-1,Math.min(1,(price-closes[Math.max(0,closes.length-6)])/atr)):0;
  const trend=atr>0?Math.max(-1,Math.min(1,(fast-slow)/(atr*2))):0;
  const mean=Math.max(...highs.slice(-20))-Math.min(...lows.slice(-20));
  const volatility=mean>0?Math.max(0,Math.min(1,atr/(mean/10))):0;
  const recentHigh=Math.max(...highs.slice(-20,-1));
  const recentLow=Math.min(...lows.slice(-20,-1));
  const breakout=price>recentHigh||price<recentLow;
  const prevClose=closes.at(-2);
  const retest=(breakout&&((price>recentHigh&&prevClose<=recentHigh)||(price<recentLow&&prevClose>=recentLow)));
  let structure="unknown";
  const h1=highs.at(-1),h2=highs.at(-5),l1=lows.at(-1),l2=lows.at(-5);
  if(h1>h2&&l1>l2)structure="bullish";
  if(h1<h2&&l1<l2)structure="bearish";
  const prevRange=ranges.at(-2)||0;
  const displacement=prevRange>0 && (ranges.at(-1)>prevRange*1.5);
  const liquiditySweep=(lows.at(-1)<Math.min(...lows.slice(-6,-1))&&price>prevClose)||(highs.at(-1)>Math.max(...highs.slice(-6,-1))&&price<prevClose);
  const orderBlock=rows.length>=3 && Math.abs(Number(rows.at(-3).close)-Number(rows.at(-3).open))<ranges.slice(-3,-2)[0]*0.5;
  const fairValueGap=rows.length>=3 && (Number(rows.at(-1).low)>Number(rows.at(-3).high)||Number(rows.at(-1).high)<Number(rows.at(-3).low));
  const volumeValues=rows.map(x=>num(x.tickVolume,num(x.volume,0))).slice(-20);
  const avgVolume=volumeValues.reduce((a,b)=>a+b,0)/Math.max(1,volumeValues.length);
  const volume=avgVolume>0?Math.max(0,Math.min(1,num(volumeValues.at(-1))/avgVolume)):0;
  return {atr,trend,momentum,volatility,structure,breakout,retest,displacement,liquiditySweep,orderBlock,fairValueGap,volume};
}

async function consecutiveLosses(userId){
  try{
    const trades=await broker.getTrades({userId,startTime:new Date(Date.now()-7*86400000),endTime:new Date()});
    const deals=Array.isArray(trades?.data?.deals)?trades.data.deals:[];
    let count=0;
    for(const d of deals.sort((a,b)=>new Date(b.time||b.brokerTime||0)-new Date(a.time||a.brokerTime||0))){
      const profit=Number(d.profit);
      if(!Number.isFinite(profit)||profit===0)continue;
      if(profit<0)count++; else break;
    }
    return count;
  }catch{return 0;}
}

async function settings(userId,botId){
  const q=await pool.query("SELECT * FROM kingbot_bot_risk_settings WHERE user_id=$1 AND bot_id=$2",[userId,botId]);
  const bot=getBotDefinitions()[botId];
  if(!bot)throw new Error("BOT_NOT_FOUND");
  if(!q.rowCount)return {...normalizeRiskSettings(bot.risk),executionMode:"PAPER",killSwitch:false};
  const x=q.rows[0];
  return {...normalizeRiskSettings({dailyDrawdownPct:x.daily_drawdown_pct,totalDrawdownPct:x.total_drawdown_pct,maxRiskPerTradePct:x.max_risk_per_trade_pct,maxPositions:x.max_positions,maxSpreadAtrRatio:x.max_spread_atr_ratio,staleDataMs:x.stale_data_ms,maxConsecutiveLosses:x.max_consecutive_losses,autoPauseOnLossStreak:x.auto_pause_on_loss_streak}),executionMode:String(x.execution_mode||"PAPER"),killSwitch:Boolean(x.kill_switch)};
}

async function entitled(userId,botId){
  if(await isAdminUser(pool,userId))return true;
  const q=await pool.query("SELECT 1 FROM kingbot_bot_entitlements e JOIN kingbot_subscriptions s ON s.id=e.subscription_id WHERE e.user_id=$1 AND e.bot_id=$2 AND e.active=TRUE AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at>NOW()) LIMIT 1",[userId,botId]);
  return q.rowCount>0;
}

async function execute(row){
  const {user_id:userId,bot_id:botId}=row;
  if(!(await entitled(userId,botId))){
    await pool.query("UPDATE kingbot_bot_runtime SET state='ERROR',last_error='SUBSCRIPTION_NOT_ACTIVE',updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,botId]);
    return;
  }
  const config=(await pool.query("SELECT symbol,timeframe FROM kingbot_bot_runtime WHERE user_id=$1 AND bot_id=$2",[userId,botId])).rows[0];
  if(!config?.symbol){await pool.query("UPDATE kingbot_bot_runtime SET state='ERROR',last_error='SYMBOL_NOT_CONFIGURED',updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,botId]);return;}
  const s=await settings(userId,botId);
  if(s.killSwitch){await pool.query("UPDATE kingbot_bot_runtime SET state='PAUSED',last_error='KILL_SWITCH_ACTIVE',updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,botId]);return;}
  const status=await broker.getStatus(userId);
  if(!status.configured){await pool.query("UPDATE kingbot_bot_runtime SET state='ERROR',last_error='BROKER_ACCOUNT_NOT_MAPPED',updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,botId]);return;}
  if(!status.connected){const connected=await broker.connect(userId,s.executionMode);if(!connected.connected)throw new Error(connected.reason||"BROKER_CONNECTION_FAILED");}
  const account=(await broker.getAccount(userId)).data||{};
  const brokerName=String(status.broker||"").toLowerCase();
  if(brokerName==="exness"){
    if(s.executionMode==="PAPER")throw new Error("EXNESS_PAPER_MODE_REQUIRES_DEMO_API_ACCOUNT");
    if(account.trade_mode==="trading_disabled")throw new Error("EXNESS_TRADING_DISABLED");
    if(account.account_status==="close_only")throw new Error("EXNESS_ACCOUNT_CLOSE_ONLY");
  }
  const accountType=String(account.accountType||account.account_type||(brokerName==="oanda"?(s.executionMode==="LIVE"?"REAL":"DEMO"):"")||(String(account.type||"").toUpperCase().includes("DEMO")?"DEMO":"")||(String(account.type||"").toUpperCase().includes("REAL")?"REAL":"")).trim().toUpperCase();
  if(s.executionMode==="PAPER"&&accountType!=="DEMO")throw new Error("PAPER_REQUIRES_DEMO_ACCOUNT");
  if(s.executionMode==="LIVE"&&accountType!=="REAL")throw new Error("LIVE_REQUIRES_REAL_ACCOUNT");
  if(account.tradeAllowed===false)throw new Error("BROKER_TRADING_NOT_ALLOWED");
  const quote=(await broker.getQuote(config.symbol,userId)).data||{};
  const bid=Number(quote.bid),ask=Number(quote.ask),quoteTime=new Date(quote.time||0).getTime();
  if(!Number.isFinite(bid)||!Number.isFinite(ask)||ask<bid)throw new Error("INVALID_BROKER_QUOTE");
  if(!Number.isFinite(quoteTime)||Date.now()-quoteTime>s.staleDataMs)throw new Error("STALE_BROKER_QUOTE");
  const candles=(await broker.getHistoricalCandles(config.symbol,config.timeframe,userId,100)).data||[];
  const ind=indicators(candles);
  const spread=ask-bid;
  const analysis=evaluateBot(botId,{symbol:config.symbol,timeframe:config.timeframe,price:(bid+ask)/2,entryPrice:(bid+ask)/2,spread,atr:ind.atr,volatility:ind.volatility,trend:ind.trend,momentum:ind.momentum,volume:ind.volume,structure:ind.structure,liquiditySweep:ind.liquiditySweep,orderBlock:ind.orderBlock,fairValueGap:ind.fairValueGap,displacement:ind.displacement,breakout:ind.breakout,retest:ind.retest});
  const positions=(await broker.getPositions(userId)).data||[];
  const riskStateQ=await pool.query("SELECT baseline_date,day_start_equity,peak_equity FROM kingbot_account_risk_state WHERE user_id=$1 AND provider=$2 AND account_id=$3",[userId,status.broker,status.accountId]);
  const today=new Date().toISOString().slice(0,10);
  let dayStart=Number(account.equity),peak=Number(account.equity);
  if(riskStateQ.rowCount){dayStart=riskStateQ.rows[0].baseline_date===today?Number(riskStateQ.rows[0].day_start_equity):Number(account.equity);peak=Math.max(Number(riskStateQ.rows[0].peak_equity)||Number(account.equity),Number(account.equity));}
  await pool.query("INSERT INTO kingbot_account_risk_state(user_id,provider,account_id,baseline_date,day_start_equity,peak_equity,updated_at) VALUES($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT(user_id,provider,account_id) DO UPDATE SET baseline_date=EXCLUDED.baseline_date,day_start_equity=EXCLUDED.day_start_equity,peak_equity=EXCLUDED.peak_equity,updated_at=NOW()",[userId,status.broker,status.accountId,today,dayStart,peak]);
  const losses=await consecutiveLosses(userId);
  const risk=authorizeOrder({limits:s,executionMode:s.executionMode,killSwitch:s.killSwitch,equity:Number(account.equity),dayStartEquity:dayStart,peakEquity:peak,openPositions:positions.length,requestedRiskPct:s.maxRiskPerTradePct,spread,atr:ind.atr,dataAgeMs:Date.now()-quoteTime,consecutiveLosses:losses});
  let action="NO_ACTION",order=null,tradePlan=null;
  if(analysis.ok&&analysis.signal!=="NO_SIGNAL"&&risk.allowed){
    const side=analysis.signal==="LONG_CANDIDATE"?"BUY":"SELL";
    const spec=(await broker.getSymbolSpecification(config.symbol,userId)).data||{};
    const tickSize=Number(spec.tickSize),minVolume=Number(spec.minVolume),maxVolume=Number(spec.maxVolume),volumeStep=Number(spec.volumeStep),point=Number(spec.point),stopsLevel=Number(spec.stopsLevel);
    const tickValue=Number(side==="BUY"?quote.lossTickValue:quote.lossTickValue);
    if(![tickSize,minVolume,maxVolume,volumeStep,point,stopsLevel,tickValue].every(Number.isFinite)||tickSize<=0||minVolume<=0||maxVolume<minVolume||volumeStep<=0||tickValue<=0)throw new Error("BROKER_SIZING_DATA_UNAVAILABLE");

    tradePlan=getTradePlan(botId,{
      symbol:config.symbol,
      timeframe:config.timeframe,
      price:(bid+ask)/2,
      entryPrice:side==="BUY"?ask:bid,
      atr:ind.atr
    },side);
    if(!tradePlan.ok)throw new Error(tradePlan.reason||"TRADE_PLAN_UNAVAILABLE");

    const entry=side==="BUY"?ask:bid;
    const brokerMinDistance=stopsLevel*point*1.1;
    const stopDistance=Math.max(tradePlan.stopDistance,brokerMinDistance);
    const takeProfitDistance=Math.max(tradePlan.takeProfitDistance,stopDistance*1.05);
    const stopLoss=side==="BUY"?entry-stopDistance:entry+stopDistance;
    const takeProfit=side==="BUY"?entry+takeProfitDistance:entry-takeProfitDistance;
    const riskAmount=Number(account.equity)*(s.maxRiskPerTradePct/100);
    const rawVolume=riskAmount/((stopDistance/tickSize)*tickValue);
    const volume=Number((Math.floor(rawVolume/volumeStep)*volumeStep).toFixed(12));
    if(!Number.isFinite(volume)||volume<minVolume||volume>maxVolume)throw new Error("RISK_SIZED_VOLUME_OUT_OF_RANGE");
    if(positions.filter(p=>String(p.symbol||"").toUpperCase()===String(config.symbol).toUpperCase()).length>=s.maxPositions)throw new Error("MAX_SYMBOL_POSITIONS");
    const clientId="kb_"+crypto.randomUUID();
    const journal=await pool.query("INSERT INTO kingbot_execution_journal(user_id,bot_id,client_id,execution_mode,symbol,side,volume,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',NOW()) ON CONFLICT(client_id) DO NOTHING RETURNING id",[userId,botId,clientId,s.executionMode,config.symbol,side,volume]);
    if(!journal.rowCount)throw new Error("DUPLICATE_EXECUTION_REQUEST");
    try{
      order=await broker.placeOrder({side,symbol:config.symbol,volume,stopLoss,takeProfit,comment:"KINGBOT",clientId,userId});
      await pool.query("UPDATE kingbot_execution_journal SET status='SUBMITTED',broker_result=$2::jsonb,updated_at=NOW() WHERE id=$1",[journal.rows[0].id,JSON.stringify(order)]);
      action="ORDER_SUBMITTED";
    }catch(error){
      await pool.query("UPDATE kingbot_execution_journal SET status='REJECTED',error_message=$2,updated_at=NOW() WHERE id=$1",[journal.rows[0].id,String(error?.message||"ORDER_REJECTED").slice(0,500)]);
      throw error;
    }
  }else if(analysis.ok&&analysis.signal!=="NO_SIGNAL"&&!risk.allowed){action="RISK_BLOCKED";}
  const signalPayload={
    signal:analysis.signal,
    score:analysis.score,
    threshold:analysis.threshold,
    action,
    executionMode:s.executionMode,
    strategy:botId,
    tradePlan:analysis.signal!=="NO_SIGNAL" ? (typeof tradePlan!=="undefined" ? tradePlan : null) : null,
    riskAllowed:risk.allowed,
    updatedAt:new Date().toISOString()
  };
  await pool.query("UPDATE kingbot_bot_runtime SET last_signal=$3,last_run_at=NOW(),last_error=NULL,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,botId,JSON.stringify(signalPayload)]);
  await audit(userId,"BOT_WORKER_TICK",{botId,executionMode:s.executionMode,symbol:config.symbol,timeframe:config.timeframe,signal:analysis.signal,score:analysis.score,action,tradePlan:signalPayload.tradePlan});

  if(analysis.ok && analysis.signal!=="NO_SIGNAL"){
    void monitorBotDecision({
      userId,
      botId,
      analysis,
      market:{symbol:config.symbol,timeframe:config.timeframe,bid,ask,spread,atr:ind.atr,volatility:ind.volatility,trend:ind.trend,momentum:ind.momentum,structure:ind.structure},
      risk,
      tradePlan:signalPayload.tradePlan
    }).then(aiMonitor=>{
      if(!aiMonitor)return;
      const merged={...signalPayload,aiMonitor,updatedAt:new Date().toISOString()};
      return pool.query("UPDATE kingbot_bot_runtime SET last_signal=$3,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,botId,JSON.stringify(merged)]);
    }).catch(error=>console.error("[KINGBOT AI SUPERVISOR] persistence failed:",error?.message||error));
  }
}

async function cycle(){
  if(stopping||!pool)return;
  if(Date.now()-lastSubscriptionSweep>30000){
    lastSubscriptionSweep=Date.now();
    await expireStaleSubscriptions(pool);
  }
  const q=await pool.query("SELECT user_id,bot_id,state FROM kingbot_bot_runtime WHERE state='RUNNING' ORDER BY updated_at ASC LIMIT 100");

  for(let i=0;i<q.rows.length;i+=MAX_PARALLEL_BOTS){
    if(stopping)break;
    const batch=q.rows.slice(i,i+MAX_PARALLEL_BOTS);
    await Promise.allSettled(batch.map(async row=>{
      try{await execute(row);}
      catch(error){
        const message=String(error?.message||"WORKER_EXECUTION_FAILED").slice(0,500);
        await pool.query("UPDATE kingbot_bot_runtime SET state='RUNNING',last_error=$3,last_run_at=NOW(),updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[row.user_id,row.bot_id,message]);
        await audit(row.user_id,"BOT_WORKER_ERROR",{botId:row.bot_id,error:message,retryable:true});
      }
    }));
  }
}

export async function startWorker(){
  if(!pool){
    if(String(process.env.WORKER_STANDBY||"").trim()==="1"){
      console.log("[KINGBOT WORKER] standby mode: database is owned by the primary API service");
      return;
    }
    throw new Error("DATABASE_URL_REQUIRED");
  }
  await ensureWorkerSchema();
  console.log("[KINGBOT WORKER] real broker execution loop started");
  const loop=async()=>{try{await cycle();}catch(error){console.error("[KINGBOT WORKER]",error?.message||error);}if(!stopping)timer=setTimeout(loop,WORKER_POLL_MS);};
  await loop();
}
async function shutdown(){if(stopping)return;stopping=true;if(timer)clearTimeout(timer);try{if(pool)await pool.end();}finally{process.exit(0);}}
process.on("SIGTERM",shutdown);
process.on("SIGINT",shutdown);
const invokedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false;

if(invokedDirectly){
  startWorker().catch(error=>{
    console.error("[KINGBOT WORKER] startup failed",error?.message||error);
    process.exit(1);
  });
}
