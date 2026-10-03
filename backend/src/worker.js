import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { UserBrokerManager } from "./user-broker-manager.js";
import { evaluateBot, getBotDefinitions, getTradePlan } from "./bot-engines.js";
import { monitorBotDecision } from "./ai-bot-supervisor.js";
import { getAiStrategySignal, warmAiStrategySignal, routeAiSignalToEngine, aiExecutionGateEnabled } from "./ai-trade-gate.js";
import { authorizeOrder, normalizeRiskSettings } from "./risk-engine.js";
import { calculateLadderV8Indicators, ladderRungLot, brokerLadderLots, normalizeLot, ladderLockStepPrice, ladderLockPrice, updateVelocitySamples, velocityPoints, withinLadderSession, ladderBasketRisk, LADDER_V8_DEFAULTS } from "./ladder-v8.js";
import { ensureAuthSchema } from "./auth.js";
import { ensureSubscriptionSchema, expireStaleSubscriptions } from "./subscriptions.js";
import { isAdminUser } from "./admin-access.js";
import { ensureBotEngineSchema } from "./bot-engines.js";
import { ensureBotRuntimeSchema } from "./bot-runtime.js";
import { ensureGlobalRiskSchema, getGlobalRiskState, globalExecutionGate, recordWorkerHeartbeat } from "./global-risk.js";

const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined }) : null;
const broker = new UserBrokerManager({pool});
let stopping = false;
let timer = null;
let lastSubscriptionSweep = 0;
const WORKER_POLL_MS = 750;
const MAX_PARALLEL_BOTS = 8;
const activeExecutionKeys = new Set();
let lastWorkerHeartbeat = 0;

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
  await ensureGlobalRiskSchema(pool);
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_account_risk_state (user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,provider TEXT NOT NULL,account_id TEXT NOT NULL,baseline_date DATE NOT NULL,day_start_equity NUMERIC NOT NULL,peak_equity NUMERIC NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(user_id,provider,account_id))");
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_execution_journal (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,bot_id TEXT NOT NULL,client_id TEXT NOT NULL UNIQUE,execution_mode TEXT NOT NULL,symbol TEXT NOT NULL,side TEXT NOT NULL,volume NUMERIC NOT NULL,status TEXT NOT NULL,broker_result JSONB,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
}

async function audit(userId,event,metadata){
  await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,$2,$3::jsonb)",[userId,event,JSON.stringify(metadata)]);
}

async function getGlobalRisk(){
  const now=Date.now();
  if(now-globalRiskCacheAt<GLOBAL_RISK_CACHE_MS)return globalRiskCache;
  globalRiskCache=await getGlobalRiskState(pool);
  globalRiskCacheAt=now;
  return globalRiskCache;
}

async function heartbeat(details={}){
  const now=Date.now();
  if(now-lastHeartbeatWrite<HEARTBEAT_MS)return;
  lastHeartbeatWrite=now;
  await recordWorkerHeartbeat(pool,{workerId:WORKER_ID,workerRole:"execution",status:stopping?"STOPPING":"RUNNING",details:{
    pollMs:WORKER_POLL_MS,maxParallelBots:MAX_PARALLEL_BOTS,
    activeExecutions:activeExecutionKeys.size,
    ...details
  }}).catch(error=>console.warn("[KINGBOT HEARTBEAT] failed:",error?.message||error));
}


function indicators(candles=[]){
  const rows=candles.filter(x=>Number.isFinite(Number(x.open))&&Number.isFinite(Number(x.high))&&Number.isFinite(Number(x.low))&&Number.isFinite(Number(x.close))).slice(-100);
  if(rows.length<20)throw new Error("INSUFFICIENT_HISTORICAL_CANDLES");
  const closes=rows.map(x=>Number(x.close));
  const highs=rows.map(x=>Number(x.high));
  const lows=rows.map(x=>Number(x.low));
  const ranges=rows.map(x=>Number(x.high)-Number(x.low)).filter(x=>x>=0);
  const atrLegacy=ranges.slice(-14).reduce((a,b)=>a+b,0)/Math.max(1,ranges.slice(-14).length);
  const fast=closes.slice(-10).reduce((a,b)=>a+b,0)/10;
  const slow=closes.slice(-30).reduce((a,b)=>a+b,0)/30;
  const price=closes.at(-1);
  const momentum=atrLegacy>0?Math.max(-1,Math.min(1,(price-closes[Math.max(0,closes.length-6)])/atrLegacy)):0;
  const trend=atrLegacy>0?Math.max(-1,Math.min(1,(fast-slow)/(atrLegacy*2))):0;
  const mean=Math.max(...highs.slice(-20))-Math.min(...lows.slice(-20));
  const volatility=mean>0?Math.max(0,Math.min(1,atrLegacy/(mean/10))):0;
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
  const orderBlock=rows.length>=3 && Math.abs(Number(rows.at(-3).close)-Number(rows.at(-3).open))<(ranges.slice(-3,-2)[0]||0)*0.5;
  const fairValueGap=rows.length>=3 && (Number(rows.at(-1).low)>Number(rows.at(-3).high)||Number(rows.at(-1).high)<Number(rows.at(-3).low));
  const volumeValues=rows.map(x=>num(x.tickVolume,num(x.volume,0))).slice(-20);
  const avgVolume=volumeValues.reduce((a,b)=>a+b,0)/Math.max(1,volumeValues.length);
  const volume=avgVolume>0?Math.max(0,Math.min(1,num(volumeValues.at(-1))/avgVolume)):0;
  const v8=rows.length>=60?calculateLadderV8Indicators(rows,LADDER_V8_DEFAULTS):null;
  return {
    atr:atrLegacy,trend,momentum,volatility,structure,breakout,retest,displacement,liquiditySweep,orderBlock,fairValueGap,volume,
    v8Atr:v8?.atr??null,emaFast:v8?.emaFast??null,emaSlow:v8?.emaSlow??null,adx:v8?.adx??null,rsi:v8?.rsi??null,
    v8Price:v8?.price??price,v8EntryQualified:Boolean(v8?.entryQualified),v8Direction:Number(v8?.direction||0)
  };
}

function strategyTimeframeProfile(botId,executionTimeframe){
  const bot=getBotDefinitions()[botId];
  const profile=bot?.timeframeProfile||{};
  return {
    regime:String(profile.regime||executionTimeframe||"1h"),
    setup:String(profile.setup||executionTimeframe||"15m"),
    execution:String(executionTimeframe||profile.execution||"5m")
  };
}

function timeframeSeconds(tf){
  const map={"1m":60,"2m":120,"3m":180,"4m":240,"5m":300,"6m":360,"10m":600,"12m":720,"15m":900,"20m":1200,"30m":1800,"1h":3600,"2h":7200,"3h":10800,"4h":14400,"6h":21600,"8h":28800,"12h":43200,"1d":86400,"1w":604800,"1mn":2592000};
  return Number(map[String(tf||"").trim()])||60;
}
function aggregateCandles(candles,targetTimeframe){
  const targetSec=timeframeSeconds(targetTimeframe);
  if(!Array.isArray(candles)||!candles.length)return [];
  const buckets=new Map();
  for(const row of candles){
    const t=Math.floor(new Date(row.time).getTime()/1000);
    if(!Number.isFinite(t))continue;
    const key=Math.floor(t/targetSec)*targetSec;
    const existing=buckets.get(key);
    if(!existing){
      buckets.set(key,{time:new Date(key*1000).toISOString(),open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume)||0});
    }else{
      existing.high=Math.max(existing.high,Number(row.high));
      existing.low=Math.min(existing.low,Number(row.low));
      existing.close=Number(row.close);
      existing.volume+=(Number(row.volume)||0);
    }
  }
  return [...buckets.values()].sort((a,b)=>new Date(a.time)-new Date(b.time));
}
async function getMultiTimeframeContext(userId,symbol,botId,executionTimeframe){
  const profile=strategyTimeframeProfile(botId,executionTimeframe);
  const unique=[...new Set([profile.regime,profile.setup,profile.execution])];
  const baseTimeframe=profile.execution;
  const maxRatio=Math.max(...unique.map(tf=>Math.ceil(timeframeSeconds(tf)/timeframeSeconds(baseTimeframe))));
  const baseLimit=Math.min(1000,Math.max(120,Math.min(1000,maxRatio*25)));
  let baseCandles;
  try{
    baseCandles=await getWorkerCandles(userId,symbol,baseTimeframe,baseLimit);
  }catch(error){
    const reason=String(error?.message||"BASE_TIMEFRAME_DATA_UNAVAILABLE").slice(0,160);
    console.warn("[KINGBOT MTF] base history unavailable",JSON.stringify({botId,symbol,timeframe:baseTimeframe,reason}));
    return {profile,ready:false,regime:{timeframe:profile.regime,available:false,reason},setup:{timeframe:profile.setup,available:false,reason},execution:{timeframe:profile.execution,available:false,reason}};
  }

  const byTimeframe={};
  for(const timeframe of unique){
    try{
      const candles=timeframe===baseTimeframe?baseCandles:aggregateCandles(baseCandles,timeframe);
      const data=indicators(candles);
      byTimeframe[timeframe]={timeframe,available:true,...data,candleCount:candles.length};
    }catch(error){
      const reason=String(error?.message||"TIMEFRAME_DATA_UNAVAILABLE").slice(0,160);
      console.warn("[KINGBOT MTF] timeframe unavailable",JSON.stringify({botId,symbol,timeframe,baseTimeframe,reason,candleCount:timeframe===baseTimeframe?baseCandles.length:aggregateCandles(baseCandles,timeframe).length}));
      byTimeframe[timeframe]={timeframe,available:false,reason};
    }
  }
  const ready=unique.every(tf=>Boolean(byTimeframe[tf]?.available));
  return {
    profile,
    ready,
    sourceTimeframe:baseTimeframe,
    sourceCandles:baseCandles.length,
    regime:byTimeframe[profile.regime]||null,
    setup:byTimeframe[profile.setup]||null,
    execution:byTimeframe[profile.execution]||null
  };
}

async function consecutiveLosses(userId){
  const cached=workerLossCache.get(String(userId));
  if(cached && Date.now()-cached.at<LOSS_CACHE_MS)return cached.value;
  try{
    const trades=await broker.getTrades({userId,startTime:new Date(Date.now()-7*86400000),endTime:new Date()});
    const deals=Array.isArray(trades?.data?.deals)?trades.data.deals:[];
    let count=0;
    for(const d of deals.sort((a,b)=>new Date(b.time||b.brokerTime||0)-new Date(a.time||a.brokerTime||0))){
      const profit=Number(d.profit);
      if(!Number.isFinite(profit)||profit===0)continue;
      if(profit<0)count++; else break;
    }
    workerLossCache.set(String(userId),{at:Date.now(),value:count});
    return count;
  }catch{
    if(cached)return cached.value;
    return 0;
  }
}

async function settings(userId,botId){
  const q=await pool.query("SELECT * FROM kingbot_bot_risk_settings WHERE user_id=$1 AND bot_id=$2",[userId,botId]);
  const bot=getBotDefinitions()[botId];
  if(!bot)throw new Error("BOT_NOT_FOUND");
  const base=!q.rowCount
    ? {...normalizeRiskSettings(bot.risk),executionMode:"DEMO",killSwitch:false}
    : (()=>{const x=q.rows[0];return {...normalizeRiskSettings({dailyDrawdownPct:x.daily_drawdown_pct,totalDrawdownPct:x.total_drawdown_pct,maxRiskPerTradePct:x.max_risk_per_trade_pct,maxPositions:x.max_positions,lotSize:x.lot_size,maxSpreadAtrRatio:x.max_spread_atr_ratio,staleDataMs:x.stale_data_ms,maxConsecutiveLosses:x.max_consecutive_losses,autoPauseOnLossStreak:x.auto_pause_on_loss_streak}),executionMode:(String(x.execution_mode||"DEMO")==="PAPER"?"DEMO":String(x.execution_mode||"DEMO")),killSwitch:Boolean(x.kill_switch)};})();
  if(botId==="ladder-flip")base.maxPositions=Math.min(LADDER_V8_DEFAULTS.maxTotalRungs,Math.max(LADDER_V8_DEFAULTS.fixedRungCount,base.maxPositions));
  return base;
}

async function entitled(userId,botId){
  if(await isAdminUser(pool,userId))return true;
  const q=await pool.query("SELECT 1 FROM kingbot_bot_entitlements e JOIN kingbot_subscriptions s ON s.id=e.subscription_id WHERE e.user_id=$1 AND e.bot_id=$2 AND e.active=TRUE AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at>NOW()) LIMIT 1",[userId,botId]);
  return q.rowCount>0;
}

const ladderVelocityBuffers=new Map();
const workerAccountCache=new Map();
const workerPositionCache=new Map();
const workerCandleCache=new Map();
const workerLossCache=new Map();
const ACCOUNT_CACHE_MS=2500;
const POSITION_CACHE_MS=5000;
const LOSS_CACHE_MS=5000;
const CANDLE_CACHE_MIN_MS=5000;
const GLOBAL_RISK_CACHE_MS=Math.max(500,Number(process.env.KINGBOT_GLOBAL_RISK_CACHE_MS||1500));
const HEARTBEAT_MS=Math.max(2000,Number(process.env.KINGBOT_HEARTBEAT_MS||5000));
const RECONCILIATION_MS=Math.max(5000,Number(process.env.KINGBOT_RECONCILIATION_MS||15000));
const WORKER_ID=String(process.env.KINGBOT_WORKER_ID||process.env.RENDER_INSTANCE_ID||"execution-"+process.pid).trim();
let globalRiskCache={tradingPaused:false,globalKillSwitch:false,reason:null};
let globalRiskCacheAt=0;
let lastHeartbeatWrite=0;
const reconciliationCache=new Map();

function ladderKey(userId,botId){return String(userId)+":"+String(botId);}
function accountCacheKey(userId){return String(userId);}
function candleCacheKey(userId,symbol,timeframe){return String(userId)+":"+String(symbol).toUpperCase()+":"+String(timeframe);}
async function getWorkerAccount(userId){
  const key=accountCacheKey(userId);
  const cached=workerAccountCache.get(key);
  if(cached && Date.now()-cached.at<ACCOUNT_CACHE_MS)return cached.data;
  const data=(await broker.getAccount(userId)).data||{};
  workerAccountCache.set(key,{at:Date.now(),data});
  return data;
}
async function getWorkerPositions(userId){
  const key=String(userId);
  const cached=workerPositionCache.get(key);
  if(cached && Date.now()-cached.at<POSITION_CACHE_MS)return cached.data;
  const data=(await broker.getPositions(userId)).data||[];
  workerPositionCache.set(key,{at:Date.now(),data});
  return data;
}

async function reconcileBrokerState(userId,status,positions){
  const provider=String(status?.broker||"").toLowerCase();
  const accountId=String(status?.accountId||"");
  if(!provider||!accountId)return {status:"UNKNOWN",checked:false};
  const key=String(userId)+":"+provider+":"+accountId;
  const cached=reconciliationCache.get(key);
  if(cached&&Date.now()-cached.at<RECONCILIATION_MS)return cached.data;
  const journal=await pool.query(
    "SELECT client_id,bot_id,symbol,side,status,broker_result,created_at FROM kingbot_execution_journal WHERE user_id=$1 AND status IN ('SUBMITTED','PENDING') AND created_at>NOW()-INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 200",
    [userId]
  );
  const brokerPositionIds=new Set(positions.flatMap(positionIdentities).map(String));
  let journalOpen=journal.rowCount;
  let knownMatches=0;
  const unresolved=[];
  for(const row of journal.rows){
    const refs=orderExecutionIds(row.broker_result);
    if(refs.some(ref=>brokerPositionIds.has(String(ref)))){knownMatches++;continue;}
    if(refs.length)unresolved.push({clientId:row.client_id,botId:row.bot_id,symbol:row.symbol,refs:refs.slice(0,12)});
  }
  const mismatch=unresolved.length;
  const data={
    checked:true,
    status:mismatch===0?"MATCHED":"MISMATCH",
    brokerPositions:positions.length,
    journalOpen,
    knownPositionMatches:knownMatches,
    unresolvedReferences:mismatch,
    checkedAt:new Date().toISOString()
  };
  await pool.query(
    `INSERT INTO kingbot_broker_reconciliation(user_id,provider,account_id,status,broker_positions,journal_open,known_position_matches,unresolved_references,details,checked_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW())
     ON CONFLICT(user_id,provider,account_id) DO UPDATE SET status=EXCLUDED.status,broker_positions=EXCLUDED.broker_positions,
       journal_open=EXCLUDED.journal_open,known_position_matches=EXCLUDED.known_position_matches,
       unresolved_references=EXCLUDED.unresolved_references,details=EXCLUDED.details,checked_at=NOW()`,
    [userId,provider,accountId,data.status,data.brokerPositions,data.journalOpen,data.knownPositionMatches,data.unresolvedReferences,JSON.stringify({unresolved})]
  );
  if(mismatch>0){
    await audit(userId,"BROKER_RECONCILIATION_MISMATCH",{provider,accountId,...data,unresolved:unresolved.slice(0,20)});
  }
  reconciliationCache.set(key,{at:Date.now(),data});
  return data;
}
async function getWorkerCandles(userId,symbol,timeframe,limit=100){
  const key=candleCacheKey(userId,symbol,timeframe);
  const ttl=Math.max(CANDLE_CACHE_MIN_MS,Math.min(60000,Math.max(5000,Number(timeframeMinutes[timeframe]||1)*2500)));
  const cached=workerCandleCache.get(key);
  if(cached && Date.now()-cached.at<ttl)return cached.data;
  const response=await broker.getHistoricalCandles(symbol,timeframe,userId,limit);
  const data=Array.isArray(response)?response:(Array.isArray(response?.data)?response.data:[]);
  if(data.length===0)throw new Error("EMPTY_HISTORICAL_CANDLES");
  workerCandleCache.set(key,{at:Date.now(),data});
  return data;
}
function currentLadderState(row){
  if(!row)return null;
  return {
    ...row,
    positionIds:Array.isArray(row.position_ids)?row.position_ids.map(String):[],
    rungLots:Array.isArray(row.rung_lots)?row.rung_lots.map(Number):[],
    velocitySamples:Array.isArray(row.velocity_samples)?row.velocity_samples:[],
    lockedProfits:Array.isArray(row.locked_profits)?row.locked_profits.map(Number):[],
    lotScale:Number(row.lot_scale||1),
    derivMultiplier:Number(row.deriv_multiplier||0)||null,
    derivContractType:row.deriv_contract_type||null
  };
}
async function getLadderState(userId,botId){
  const q=await pool.query("SELECT * FROM kingbot_ladder_v8_state WHERE user_id=$1 AND bot_id=$2",[userId,botId]);
  return currentLadderState(q.rowCount?q.rows[0]:null);
}
async function saveLadderState(userId,botId,state){
  const x=state||{};
  await pool.query(
    "INSERT INTO kingbot_ladder_v8_state(user_id,bot_id,symbol,timeframe,active,direction,anchor_price,initial_stop_distance,step_price,lock_level,last_lock_price,last_pyramid_price,rungs_opened,aggressive_entry,position_ids,rung_lots,velocity_samples,cycle_id,lot_scale,deriv_contract_type,deriv_multiplier,locked_profits,last_action,last_action_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19,$20,$21,$22::jsonb,$23,$24,NOW()) ON CONFLICT(user_id,bot_id) DO UPDATE SET symbol=EXCLUDED.symbol,timeframe=EXCLUDED.timeframe,active=EXCLUDED.active,direction=EXCLUDED.direction,anchor_price=EXCLUDED.anchor_price,initial_stop_distance=EXCLUDED.initial_stop_distance,step_price=EXCLUDED.step_price,lock_level=EXCLUDED.lock_level,last_lock_price=EXCLUDED.last_lock_price,last_pyramid_price=EXCLUDED.last_pyramid_price,rungs_opened=EXCLUDED.rungs_opened,aggressive_entry=EXCLUDED.aggressive_entry,position_ids=EXCLUDED.position_ids,rung_lots=EXCLUDED.rung_lots,velocity_samples=EXCLUDED.velocity_samples,cycle_id=EXCLUDED.cycle_id,lot_scale=EXCLUDED.lot_scale,deriv_contract_type=EXCLUDED.deriv_contract_type,deriv_multiplier=EXCLUDED.deriv_multiplier,locked_profits=EXCLUDED.locked_profits,last_action=EXCLUDED.last_action,last_action_at=EXCLUDED.last_action_at,updated_at=NOW()",
    [userId,botId,String(x.symbol||""),String(x.timeframe||"5m"),Boolean(x.active),Number(x.direction||0),x.anchorPrice??null,x.initialStopDistance??null,x.stepPrice??null,Number(x.lockLevel||0),x.lastLockPrice??null,x.lastPyramidPrice??null,Number(x.rungsOpened||0),Boolean(x.aggressiveEntry),JSON.stringify(Array.isArray(x.positionIds)?x.positionIds.map(String):[]),JSON.stringify(Array.isArray(x.rungLots)?x.rungLots.map(Number):[]),JSON.stringify(Array.isArray(x.velocitySamples)?x.velocitySamples:[]),x.cycleId||null,Number(x.lotScale||1),x.derivContractType||null,x.derivMultiplier??null,JSON.stringify(Array.isArray(x.lockedProfits)?x.lockedProfits.map(Number):[]),x.lastAction||null,x.lastActionAt?new Date(x.lastActionAt):new Date()]
  );
}
async function closeLadderState(userId,botId,state,action="LADDER_CYCLE_CLOSED"){
  await saveLadderState(userId,botId,{...state,active:false,direction:0,positionIds:[],rungLots:[],lockedProfits:[],velocitySamples:[],rungsOpened:0,lockLevel:0,anchorPrice:null,stepPrice:null,lastLockPrice:null,lastPyramidPrice:null,aggressiveEntry:false,derivContractType:null,derivMultiplier:null,lastAction:action});
}
function positionIdentities(position){
  const ids=[];
  const add=v=>{const s=String(v||"").trim();if(s)ids.push(s);};
  add(position?.id);add(position?.positionId);add(position?.position_id);add(position?.tradeId);add(position?.tradeID);
  if(Array.isArray(position?.tradeIds))for(const id of position.tradeIds)add(id);
  return [...new Set(ids)];
}
function orderExecutionIds(value,out=new Set(),depth=0){
  if(depth>6||value==null)return [...out];
  if(Array.isArray(value)){for(const item of value)orderExecutionIds(item,out,depth+1);return [...out];}
  if(typeof value!=="object")return [...out];
  for(const [key,val] of Object.entries(value)){
    const k=key.toLowerCase();
    if((k.includes("positionid")||k.includes("position_id")||k==="tradeid"||k==="trade_id"||k==="orderid"||k==="order_id"||k==="dealid"||k==="deal_id"||k==="contractid"||k==="contract_id"||k==="ticket")&&(typeof val==="string"||typeof val==="number"))out.add(String(val));
    if(typeof val==="object")orderExecutionIds(val,out,depth+1);
  }
  return [...out];
}
async function discoverNewLadderPositionIds(userId,symbol,side,beforeIds,order){
  const ids=new Set(orderExecutionIds(order));
  for(let attempt=0;attempt<4;attempt++){
    try{
      const rows=(await broker.getPositions(userId)).data||[];
      for(const p of rows){
        if(String(p?.symbol||"").toUpperCase()!==String(symbol).toUpperCase())continue;
        if(side && String(p?.side||p?.type||"").toUpperCase() && String(p?.side||p?.type||"").toUpperCase()!==side)continue;
        for(const id of positionIdentities(p))if(!beforeIds.has(String(id)))ids.add(String(id));
      }
      if(ids.size)return [...ids];
    }catch{}
    if(attempt<3)await new Promise(resolve=>setTimeout(resolve,250));
  }
  return [...ids];
}
function ladderSpec(spec,quote={}){
  const pointRaw=Number(spec?.point);
  const point=Number.isFinite(pointRaw)&&pointRaw>0?pointRaw:(Number.isFinite(Number(spec?.point_digits))?Math.pow(10,-Number(spec.point_digits)):null);
  const tickSizeRaw=Number(spec?.tickSize??spec?.tradeTickSize??spec?.tick_size??spec?.trade_tick_size);
  const tickSize=Number.isFinite(tickSizeRaw)&&tickSizeRaw>0?tickSizeRaw:point;
  const tickValueRaw=Number(spec?.tickValue??spec?.tradeTickValue??spec?.tick_value??spec?.trade_tick_value??quote?.lossTickValue);
  const tickValue=Number.isFinite(tickValueRaw)&&tickValueRaw>0?tickValueRaw:null;
  const minVolume=Number(spec?.minVolume??spec?.volume_min??spec?.volumeMin??spec?.tradeVolumeMin);
  const maxVolume=Number(spec?.maxVolume??spec?.volume_max??spec?.volumeMax??spec?.tradeVolumeMax);
  const volumeStep=Number(spec?.volumeStep??spec?.volume_step??spec?.volumeStepSize??spec?.tradeVolumeStep);
  const stopsLevel=Number(spec?.stopsLevel??spec?.stopLevel??spec?.stops_level??0);
  return {point,tickSize,tickValue,minVolume,maxVolume,volumeStep,stopsLevel};
}
function ladderPrice(price,point){
  const p=Number(price),pt=Number(point);
  if(!Number.isFinite(p))return null;
  if(!Number.isFinite(pt)||pt<=0)return p;
  return Number((Math.round(p/pt)*pt).toFixed(12));
}
function ladderRiskForLots(lots,stopDistance,spec){
  return ladderBasketRisk({volumes:lots,stopDistance,tickSize:spec.tickSize,tickValue:spec.tickValue});
}
function ladderTodayOrders(userId,botId){
  return pool.query("SELECT COUNT(*)::int AS count FROM kingbot_execution_journal WHERE user_id=$1 AND bot_id=$2 AND status='SUBMITTED' AND created_at>=CURRENT_DATE",[userId,botId]).then(q=>Number(q.rows?.[0]?.count||0));
}
function ladderPriceSide(position,state){
  const side=Number(state?.direction)>0?"BUY":"SELL";
  return String(position?.side||position?.type||"").toUpperCase()===side;
}
function collectDerivContractTypes(value,out=new Set(),depth=0){
  if(depth>8||value==null)return out;
  if(Array.isArray(value)){for(const x of value)collectDerivContractTypes(x,out,depth+1);return out;}
  if(typeof value!=="object")return out;
  for(const [k,v] of Object.entries(value)){
    if(k.toLowerCase().includes("contract_type")&&typeof v==="string")out.add(v.toUpperCase());
    if(typeof v==="object")collectDerivContractTypes(v,out,depth+1);
    if(typeof v==="string"&&/^(MULTUP|MULTDOWN|CALL|PUT|CALLE|PUTE|HIGHER|LOWER)$/.test(v.toUpperCase()))out.add(v.toUpperCase());
  }
  return out;
}
function derivStakePlan(rawLots,budget,minStake=1){
  const totalWeight=rawLots.reduce((sum,x)=>sum+Number(x||0),0);
  const floor=Math.max(0.01,Number(minStake)||0.35);
  if(!(budget>0)||!(totalWeight>0)||!rawLots.length)return [];
  // A small account must be allowed to open the first affordable rung.
  // Do not require the full ladder budget up front; later rungs are added
  // only when the available risk budget supports them.
  const maxAffordable=Math.min(rawLots.length,Math.floor(budget/floor+1e-9));
  if(maxAffordable<1)return [];
  const lots=rawLots.slice(0,maxAffordable);
  const weight=lots.reduce((sum,x)=>sum+Number(x||0),0);
  const distributable=Math.max(0,budget-floor*maxAffordable);
  return lots.map(x=>floor+distributable*(Number(x||0)/Math.max(weight,1e-12)));
}
async function executeLadderV8DerivStart({userId,botId,config,s,account,quote,ind,positions,spec,velocity}){
  const baseCfg=getBotDefinitions()[botId].v8||LADDER_V8_DEFAULTS;
  const cfg={...baseCfg,baseLot:Number(s.lotSize)||Number(baseCfg.baseLot)||LADDER_V8_DEFAULTS.baseLot};
  if(!withinLadderSession(new Date(),cfg))return {action:"SESSION_BLOCKED",state:null};
  const side=ind.v8Direction>0?"BUY":"SELL";
  const contractType=side==="BUY"?"MULTUP":"MULTDOWN";
  const contracts=await (async()=>{
    const entry=await broker.connectionFor(userId);
    if(entry.provider!=="deriv")throw new Error("DERIV_LADDER_EXECUTOR_PROVIDER_MISMATCH");
    return entry.api.getContractsFor(config.symbol);
  })();
  const types=collectDerivContractTypes(contracts);
  if(types.size>0&&!types.has(contractType))return {action:"DERIV_V8_CONTRACT_TYPE_UNAVAILABLE",state:null,details:{requested:contractType,available:[...types].slice(0,30)}};
  const point=Number(spec.point);
  if(!Number.isFinite(point)||point<=0)throw new Error("DERIV_V8_POINT_SIZE_UNAVAILABLE");
  const multiplier=100;
  const accountCurrency=String(account.currency||"USD").toUpperCase();
  const budget=Number(account.equity)*(Number(s.maxRiskPerTradePct)/100);
  const rawLots=[];
  const rungCount=Math.min(cfg.fixedRungCount,cfg.maxTotalRungs);
  for(let i=0;i<rungCount;i++)rawLots.push(ladderRungLot(i,cfg));
  const minStake=Math.max(1,Number(spec.minVolume)||1);
  const desiredStakes=derivStakePlan(rawLots,budget,minStake);
  if(!desiredStakes.length)return {action:"DERIV_V8_STAKE_BUDGET_BLOCKED",state:null};
  const probeIndex=desiredStakes.findIndex(x=>Number(x)>0);
  if(probeIndex<0)return {action:"DERIV_V8_STAKE_BUDGET_BLOCKED",state:null};

  const stakes=[];
  const contractIds=[];
  let opened=0;
  const entryPrice=Number((Number(quote.bid)+Number(quote.ask))/2);
  const atrStop=Math.max(Number(ind.v8Atr||ind.atr)*cfg.atrSLMult,point);
  const baseStake=desiredStakes[0];
  const lockedProfits=[];
  const cycleId="kbv8d_"+crypto.randomUUID();

  for(let i=0;i<desiredStakes.length;i++){
    const rawStake=Math.max(0,Number(desiredStakes[i]));
    const stake=Number(rawStake.toFixed(2));
    if(!(stake>0))continue;
    const clientId="kbv8d_"+crypto.randomUUID();
    const sideName=side;
    // Deriv MULTUP/MULTDOWN limit_order monetary values accept max 2 decimals.
    // Round before the API request so Gemini-confirmed trades are not rejected by broker precision rules.
    const stopLoss=Number(Math.max(0.01,Math.min(stake*0.9,atrStop*multiplier)).toFixed(2));
    const takeProfit=Number(Math.max(stake*1.05,stake+stopLoss*Number(cfg.takeProfitRR||2.0)).toFixed(2));
    const journal=await pool.query("INSERT INTO kingbot_execution_journal(user_id,bot_id,client_id,execution_mode,symbol,side,volume,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',NOW()) ON CONFLICT(client_id) DO NOTHING RETURNING id",[userId,botId,clientId,s.executionMode,config.symbol,sideName,stake]);
    if(!journal.rowCount)continue;
    try{
      await broker.assertExecutionAuthorized(userId);
      const order=await broker.placeOrder({side:sideName,symbol:config.symbol,volume:stake,stopLoss,takeProfit,comment:"KINGBOT V8 DERIV R"+i,clientId,userId,currency:accountCurrency,multiplier,derivContractType:contractType});
      await pool.query("UPDATE kingbot_execution_journal SET status='SUBMITTED',broker_result=$2::jsonb,updated_at=NOW() WHERE id=$1",[journal.rows[0].id,JSON.stringify(order)]);
      if(order?.contractId)contractIds.push(String(order.contractId));
      stakes.push(stake);
      lockedProfits.push(0);
      opened++;
      await audit(userId,"LADDER_V8_DERIV_RUNG_OPENED",{botId,symbol:config.symbol,side:sideName,rung:i+1,stake,stopLoss,contractId:order?.contractId,cycleId,contractType,multiplier});
    }catch(error){
      await pool.query("UPDATE kingbot_execution_journal SET status='REJECTED',error_message=$2,updated_at=NOW() WHERE id=$1",[journal.rows[0].id,String(error?.message||"DERIV_ORDER_REJECTED").slice(0,500)]);
      if(opened===0)throw error;
      break;
    }
  }
  if(opened===0)return {action:"DERIV_V8_NO_CONTRACT_OPENED",state:null};
  const state={
    symbol:config.symbol,timeframe:config.timeframe,active:true,direction:side==="BUY"?1:-1,anchorPrice:entryPrice,
    initialStopDistance:atrStop,stepPrice:point*cfg.pyramidStepPoints,lockLevel:0,lastLockPrice:null,lastPyramidPrice:entryPrice,
    rungsOpened:opened,aggressiveEntry:velocity>=cfg.velocityHighPoints,positionIds:[...new Set(contractIds)],rungLots:stakes,
    lockedProfits,velocitySamples:updateVelocitySamples([],entryPrice,Date.now(),cfg),cycleId,lotScale:baseStake>0?baseStake/Math.max(rawLots[0],0.0000001):1,
    derivContractType:contractType,derivMultiplier:multiplier,lastAction:"DERIV_V8_STARTED"
  };
  await saveLadderState(userId,botId,state);
  await audit(userId,"LADDER_V8_DERIV_STARTED",{botId,symbol:config.symbol,side,rungsOpened:opened,stakes,cycleId,contractType,multiplier,budget});
  return {action:"LADDER_V8_DERIV_STARTED",state};
}
async function executeLadderV8DerivManage({userId,botId,config,s,account,quote,positions,ind,spec,state,velocity,riskAllowed}){
  const cfg=getBotDefinitions()[botId].v8||LADDER_V8_DEFAULTS;
  const tracked=positions.filter(p=>String(p?.symbol||"").toUpperCase()===String(state.symbol||config.symbol).toUpperCase()
    &&state.positionIds.includes(String(p?.contractId||p?.id||""))
    &&String(p?.status||"open").toLowerCase()==="open");
  if(!tracked.length){
    await closeLadderState(userId,botId,state,"DERIV_V8_CYCLE_CLOSED");
    await audit(userId,"LADDER_V8_DERIV_CLOSED",{botId,symbol:state.symbol,cycleId:state.cycleId});
    return {action:"DERIV_V8_CYCLE_CLOSED",state:{...state,active:false}};
  }
  const mid=(Number(quote.bid)+Number(quote.ask))/2;
  const key=ladderKey(userId,botId);
  const samples=updateVelocitySamples(ladderVelocityBuffers.get(key)||state.velocitySamples||[],mid,Date.now(),cfg);
  ladderVelocityBuffers.set(key,samples);
  const v=velocityPoints(samples,spec.point,cfg);
  let lockLevel=Number(state.lockLevel||0);
  const stakes=Array.isArray(state.rungLots)?state.rungLots.map(Number):[];
  const locks=Array.isArray(state.lockedProfits)?state.lockedProfits.map(Number):stakes.map(()=>0);
  const nextLocks=locks.slice();
  let action="DERIV_V8_MONITORING";
  let anyClosed=false;

  // Cash-based staircase for Deriv multiplier contracts. Deriv's contract_update
  // supports monetary stop/take-profit limits; a true ratcheting profit floor
  // is enforced by the worker with market sell when a previously achieved floor
  // is lost.
  for(let i=0;i<state.positionIds.length;i++){
    const id=String(state.positionIds[i]);
    const p=positions.find(x=>String(x?.contractId||x?.id||"")===id);
    if(!p)continue;
    const profit=Number(p.profit);
    const stake=Number(stakes[i]||0);
    const stepCash=cfg.profitLockUSD*(stake>0?(stake/Math.max(stakes[0]||stake,0.0000001)):1);
    if(!Number.isFinite(profit)||stake<=0||stepCash<=0)continue;
    const newLevel=Math.floor(profit/stepCash);
    if(newLevel>lockLevel)lockLevel=newLevel;
    const desiredLock=Math.max(0,newLevel)*stepCash;
    if(desiredLock>Number(nextLocks[i]||0))nextLocks[i]=desiredLock;
    const floor=Number(nextLocks[i]||0);
    if(floor>0&&profit<=floor-0.01){
      try{
        await (async()=>{
          const entry=await broker.connectionFor(userId);
          if(entry.provider!=="deriv")throw new Error("DERIV_LADDER_EXECUTOR_PROVIDER_MISMATCH");
          await entry.api.sellContract(Number(id),0);
        })();
        anyClosed=true;
        action="DERIV_V8_PROFIT_LOCK_EXIT";
        await audit(userId,"LADDER_V8_DERIV_PROFIT_LOCK_EXIT",{botId,symbol:config.symbol,contractId:id,profit,lockedProfit:floor,cycleId:state.cycle_id});
      }catch(error){
        console.warn("[KINGBOT LADDER V8] Deriv profit-lock exit failed:",error?.message||error);
      }
    }
  }

  const positionCap=Math.min(cfg.maxTotalRungs,Math.max(cfg.fixedRungCount,Number(s.maxPositions)||cfg.fixedRungCount));
  const extendedSince=Number(state.direction)>0?Number(quote.bid)-Number(state.lastPyramidPrice||state.anchorPrice):Number(state.lastPyramidPrice||state.anchorPrice)-Number(quote.ask);
  const highMomentum=v>=cfg.velocityHighPoints;
  const emergency=Number(ind.volatility)>0.95;
  const currentStakeRisk=stakes.reduce((a,b)=>a+Math.max(0,Number(b)||0),0);
  const budget=Number(account.equity)*(Number(s.maxRiskPerTradePct)/100);
  if(highMomentum&&!emergency&&riskAllowed&&state.rungsOpened<positionCap&&extendedSince>=cfg.pyramidStepPoints*spec.point){
    const growth=Math.max(1.01,Number(cfg.lotGrowthFactor)||2.0);
    const priorStake=stakes.length?Number(stakes.at(-1)):Number(state.lotScale||1);
    const nextStake=Number(Math.max(1,priorStake*growth).toFixed(2));
    if(nextStake>0&&currentStakeRisk+nextStake<=budget*1.000001){
      const side=Number(state.direction)>0?"BUY":"SELL";
      try{
        const clientId="kbv8d_"+crypto.randomUUID();
        const pyramidStopLoss=Number(Math.max(0.01,Math.min(nextStake*0.9,Number(ind.v8Atr||ind.atr)*cfg.atrSLMult*Number(state.deriv_multiplier||100))).toFixed(2));
        const pyramidTakeProfit=Number(Math.max(nextStake*1.05,nextStake+pyramidStopLoss*Number(cfg.takeProfitRR||2.0)).toFixed(2));
        await broker.assertExecutionAuthorized(userId);
      const order=await broker.placeOrder({side,symbol:config.symbol,volume:nextStake,stopLoss:pyramidStopLoss,takeProfit:pyramidTakeProfit,comment:"KINGBOT V8 DERIV PYRAMID R"+state.rungsOpened,clientId,userId,currency:String(account.currency||"USD"),multiplier:Number(state.deriv_multiplier||100),derivContractType:state.deriv_contract_type});
        if(order?.contractId){
          state.positionIds=[...state.positionIds.map(String),String(order.contractId)];
          stakes.push(nextStake);
          nextLocks.push(0);
          state.rungsOpened++;
          state.lastPyramidPrice=Number(state.direction)>0?Number(quote.bid):Number(quote.ask);
          action="DERIV_V8_PYRAMID";
          await audit(userId,"LADDER_V8_DERIV_PYRAMID",{botId,symbol:config.symbol,rung:state.rungsOpened,stake:nextStake,contractId:order.contractId,velocity:v,cycleId:state.cycle_id});
        }
      }catch(error){
        action="DERIV_V8_PYRAMID_REJECTED";
      }
    }else if(nextStake>0){
      action="DERIV_V8_PYRAMID_RISK_GATED";
    }
  }

  const nextState={...state,rungLots:stakes,lockedProfits:nextLocks,lockLevel,lastLockPrice:Math.max(...nextLocks,0),velocitySamples:samples,lastAction:action,lastActionAt:new Date().toISOString()};
  await saveLadderState(userId,botId,nextState);
  return {action,state:nextState,velocity:v};
}

async function executeLadderV8Start({userId,botId,config,s,account,quote,ind,positions,spec,velocity}){
  const cfg=getBotDefinitions()[botId].v8||LADDER_V8_DEFAULTS;
  if(!withinLadderSession(new Date(),cfg))return {action:"SESSION_BLOCKED",state:null};
  if(quote.ask<=quote.bid||!Number.isFinite(quote.ask)||!Number.isFinite(quote.bid))return {action:"INVALID_BROKER_QUOTE",state:null};
  const ls=ladderSpec(spec,quote);
  if(![ls.point,ls.tickSize,ls.tickValue,ls.minVolume,ls.maxVolume,ls.volumeStep].every(Number.isFinite)||ls.point<=0||ls.tickSize<=0||ls.tickValue<=0||ls.minVolume<=0||ls.maxVolume<ls.minVolume||ls.volumeStep<=0)throw new Error("LADDER_V8_SIZING_DATA_UNAVAILABLE");
  const side=ind.v8Direction>0?"BUY":"SELL";
  const anchor=side==="BUY"?Number(quote.ask):Number(quote.bid);
  const stopDistance=Math.max(Number(ind.v8Atr)*cfg.atrSLMult,ls.stopsLevel*ls.point*1.1);
  if(!Number.isFinite(stopDistance)||stopDistance<=0)throw new Error("LADDER_V8_STOP_DISTANCE_UNAVAILABLE");
  const budget=Number(account.equity)*(Number(s.maxRiskPerTradePct)/100);
  const rungCount=Math.min(cfg.fixedRungCount,cfg.maxTotalRungs);
  const plannedLots=brokerLadderLots({
    minLot:ls.minVolume,
    maxLot:Math.min(ls.maxVolume,Number(cfg.maxLadderLot)||ls.maxVolume),
    step:ls.volumeStep,
    maxRungs:rungCount,
    growthFactor:Number(cfg.lotGrowthFactor)||2.0
  });
  const volumes=[];
  let basketRisk=0;
  for(const lot of plannedLots){
    const candidateRisk=ladderRiskForLots([...volumes,lot],stopDistance,ls);
    if(!Number.isFinite(candidateRisk)||candidateRisk>budget*1.000001)break;
    volumes.push(lot);
    basketRisk=candidateRisk;
  }
  if(!volumes.length)return {action:"LADDER_RISK_BUDGET_BLOCKED",state:null,details:{budget,plannedLots,basketRisk}};
  const positionCap=Math.min(cfg.maxTotalRungs,Math.max(cfg.fixedRungCount,Number(s.maxPositions)||cfg.fixedRungCount));
  if(positions.length+volumes.length>positionCap)return {action:"LADDER_MAX_POSITION_CAP",state:null,details:{positionCap,affordableRungs:volumes.length}};
  const cycleId="kbv8_"+crypto.randomUUID();
  let opened=0;
  const positionIds=[];
  const openedLots=[];
  // Snapshot positions and the daily order count once. The old implementation
  // made a broker round-trip before every rung, which unnecessarily delayed the
  // ladder and could leave later rungs waiting on telemetry.
  const initialPositions=Array.isArray(positions)?positions:[];
  const initialPositionIds=new Set(initialPositions.flatMap(positionIdentities).map(String));
  const todayOrderCount=await ladderTodayOrders(userId,botId);

  for(let i=0;i<volumes.length;i++){
    if(todayOrderCount+opened>=cfg.maxTradesPerDay)break;
    const entry=side==="BUY"?Number(quote.ask):Number(quote.bid);
    const sl=ladderPrice(side==="BUY"?entry-stopDistance:entry+stopDistance,ls.point);
    const clientId="kbv8_"+crypto.randomUUID();
    const volume=volumes[i];
    const journal=await pool.query("INSERT INTO kingbot_execution_journal(user_id,bot_id,client_id,execution_mode,symbol,side,volume,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',NOW()) ON CONFLICT(client_id) DO NOTHING RETURNING id",[userId,botId,clientId,s.executionMode,config.symbol,side,volume]);
    if(!journal.rowCount)continue;
    try{
      await broker.assertExecutionAuthorized(userId);
      const order=await broker.placeOrder({side,symbol:config.symbol,volume,stopLoss:sl,takeProfit:null,comment:"KINGBOT V8 LADDER R"+i,clientId,userId});
      await pool.query("UPDATE kingbot_execution_journal SET status='SUBMITTED',broker_result=$2::jsonb,updated_at=NOW() WHERE id=$1",[journal.rows[0].id,JSON.stringify(order)]);
      const id=order?.contractId!=null?String(order.contractId):"";
      if(id)positionIds.push(id);
      openedLots.push(volume);
      opened++;
      await audit(userId,"LADDER_V8_RUNG_OPENED",{botId,symbol:config.symbol,side,rung:i+1,volume,stopLoss:sl,contractId:id||null,cycleId});
    }catch(error){
      await pool.query("UPDATE kingbot_execution_journal SET status='REJECTED',error_message=$2,updated_at=NOW() WHERE id=$1",[journal.rows[0].id,String(error?.message||"ORDER_REJECTED").slice(0,500)]);
      if(opened===0)throw error;
      break;
    }
  }

  // Deriv normally returns contractId directly. Only do one telemetry lookup
  // when a broker response did not include an execution identifier.
  if(opened>0&&positionIds.length<opened){
    try{
      const finalPositions=(await broker.getPositions(userId)).data||[];
      const discovered=finalPositions.filter(p=>{
        if(String(p?.symbol||"").toUpperCase()!==String(config.symbol).toUpperCase())return false;
        const ps=String(p?.side||p?.type||"").toUpperCase();
        return !ps||ps===side;
      }).flatMap(positionIdentities).map(String).filter(id=>!initialPositionIds.has(id));
      for(const id of discovered)if(!positionIds.includes(id))positionIds.push(id);
    }catch(error){
      console.warn("[KINGBOT V8] post-execution contract discovery failed:",error?.message||error);
    }
  }
  if(opened===0)return {action:"LADDER_NO_RUNG_OPENED",state:null};
  const effectiveSmallestLot=openedLots[0]||cfg.baseLot;
  const stepPrice=ladderLockStepPrice({baseLot:effectiveSmallestLot,profitLockUSD:cfg.profitLockUSD,tickValue:ls.tickValue,tickSize:ls.tickSize,point:ls.point});
  const state={
    symbol:config.symbol,timeframe:config.timeframe,active:true,direction:side==="BUY"?1:-1,anchorPrice:anchor,
    initialStopDistance:stopDistance,stepPrice,lockLevel:0,lastLockPrice:null,lastPyramidPrice:anchor,
    rungsOpened:opened,aggressiveEntry:velocity>=cfg.velocityHighPoints,positionIds:[...new Set(positionIds.map(String))],
    rungLots:openedLots,velocitySamples:updateVelocitySamples([],Number((quote.bid+quote.ask)/2),Date.now(),cfg),
    cycleId,lotScale:1,plannedLots:plannedLots.slice(),executedLots:openedLots.slice(),lotGrowthFactor:Number(cfg.lotGrowthFactor)||2,brokerMinLot:ls.minVolume,brokerLotStep:ls.volumeStep,lastAction:"LADDER_V8_STARTED"
  };
  await saveLadderState(userId,botId,state);
  await audit(userId,"LADDER_V8_STARTED",{botId,symbol:config.symbol,side,rungsOpened:opened,plannedLots,executedLots:openedLots,lotGrowthFactor:Number(cfg.lotGrowthFactor)||2,brokerMinLot:ls.minVolume,brokerMaxLot:ls.maxVolume,brokerLotStep:ls.volumeStep,stepPrice,cycleId});
  return {action:"LADDER_V8_STARTED",state};
}
async function executeLadderV8Manage({userId,botId,config,s,account,quote,positions,ind,spec,state,velocity,riskAllowed}){
  const cfg=getBotDefinitions()[botId].v8||LADDER_V8_DEFAULTS;
  const tracked=positions.filter(p=>ladderPriceSide(p,state)&&positionIdentities(p).some(id=>state.positionIds.includes(String(id))));
  if(!tracked.length){
    await closeLadderState(userId,botId,state,"LADDER_CYCLE_CLOSED");
    await audit(userId,"LADDER_V8_CLOSED",{botId,symbol:state.symbol,cycleId:state.cycle_id||state.cycleId});
    return {action:"LADDER_CYCLE_CLOSED",state:{...state,active:false}};
  }
  const mid=(Number(quote.bid)+Number(quote.ask))/2;
  const key=ladderKey(userId,botId);
  const existingSamples=ladderVelocityBuffers.get(key)||state.velocitySamples||[];
  const samples=updateVelocitySamples(existingSamples,mid,Date.now(),cfg);
  ladderVelocityBuffers.set(key,samples);
  const v=velocityPoints(samples,spec.point,cfg);
  const favorable=Number(state.direction)>0?Number(quote.bid)-Number(state.anchor_price):Number(state.anchor_price)-Number(quote.ask);
  const step=Number(state.step_price);
  let lockLevel=Number(state.lock_level||0);
  let lastLockPrice=Number(state.last_lock_price||0)||null;
  let action="LADDER_V8_MONITORING";
  let lastPyramidPrice=Number(state.last_pyramid_price||state.anchor_price);
  if(step>0&&favorable>=0){
    const newLevel=Math.floor(favorable/step);
    if(newLevel>lockLevel){
      const newLockPrice=ladderLockPrice({anchorPrice:Number(state.anchor_price),stepPrice:step,lockLevel:newLevel,isBuy:Number(state.direction)>0});
      const safePrice=ladderPrice(newLockPrice,spec.point);
      const distanceOk=Number(state.direction)>0?safePrice<Number(quote.bid)-Math.max(0,spec.stopsLevel*spec.point):safePrice>Number(quote.ask)+Math.max(0,spec.stopsLevel*spec.point);
      if(distanceOk){
        let modified=0;
        for(const p of tracked){
          for(const id of positionIdentities(p).filter(x=>state.positionIds.includes(String(x)))){
            try{
              await broker.modifyPositionStops({userId,positionId:id,symbol:config.symbol,stopLoss:safePrice,takeProfit:null});
              modified++;
            }catch(error){
              console.warn("[KINGBOT LADDER V8] stop ratchet failed:",error?.message||error);
            }
          }
        }
        if(modified>0){
          lockLevel=newLevel;
          lastLockPrice=safePrice;
          action="LADDER_V8_LOCK_RATCHET";
          await audit(userId,"LADDER_V8_LOCK_RATCHET",{botId,symbol:config.symbol,cycleId:state.cycle_id,lockLevel,newStop:safePrice,modified,lockedBaseLotUsd:cfg.profitLockUSD});
        }
      }
    }
  }
  const extendedSince=Number(state.direction)>0?Number(quote.bid)-lastPyramidPrice:lastPyramidPrice-Number(quote.ask);
  const highMomentum=v>=cfg.velocityHighPoints;
  const emergency=Number(ind.volatility)>0.95;
  let rungsOpened=Number(state.rungs_opened||0);
  let rungLots=Array.isArray(state.rung_lots)?state.rung_lots.map(Number):[];
  let positionIds=[...state.positionIds];
  const positionCap=Math.min(cfg.maxTotalRungs,Math.max(cfg.fixedRungCount,Number(s.maxPositions)||cfg.fixedRungCount));
  if(highMomentum&&!emergency&&rungsOpened<positionCap&&extendedSince>=cfg.pyramidStepPoints*spec.point&&riskAllowed){
    const nextRaw=ladderRungLot(rungsOpened,cfg)*(Number(state.lot_scale||1));
    const nextLot=normalizeLot(nextRaw,{minLot:spec.minVolume,maxLot:spec.maxVolume,step:spec.volumeStep});
    const existingRisk=ladderRiskForLots(rungLots,Number(state.initial_stop_distance),spec);
    const nextStopDistance=Math.max(Number(ind.v8Atr)*cfg.atrSLMult,Number(spec.stopsLevel||0)*spec.point*1.1);
    const budget=Number(account.equity)*(Number(s.maxRiskPerTradePct)/100);
    const newRisk=existingRisk+ladderRiskForLots([nextLot],nextStopDistance,spec);
    if(newRisk<=budget*1.000001){
      const before=(await broker.getPositions(userId)).data||[];
      const beforeIds=new Set(before.flatMap(positionIdentities).map(String));
      const entry=Number(state.direction)>0?Number(quote.ask):Number(quote.bid);
      const sl=ladderPrice(Number(state.direction)>0?entry-nextStopDistance:entry+nextStopDistance,spec.point);
      const clientId="kbv8_"+crypto.randomUUID();
      const journal=await pool.query("INSERT INTO kingbot_execution_journal(user_id,bot_id,client_id,execution_mode,symbol,side,volume,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',NOW()) ON CONFLICT(client_id) DO NOTHING RETURNING id",[userId,botId,clientId,s.executionMode,config.symbol,Number(state.direction)>0?"BUY":"SELL",nextLot]);
      if(journal.rowCount){
        try{
          await broker.assertExecutionAuthorized(userId);
      const order=await broker.placeOrder({side:Number(state.direction)>0?"BUY":"SELL",symbol:config.symbol,volume:nextLot,stopLoss:sl,takeProfit:null,comment:"KINGBOT V8 PYRAMID R"+rungsOpened,clientId,userId});
          await pool.query("UPDATE kingbot_execution_journal SET status='SUBMITTED',broker_result=$2::jsonb,updated_at=NOW() WHERE id=$1",[journal.rows[0].id,JSON.stringify(order)]);
          const ids=await discoverNewLadderPositionIds(userId,config.symbol,Number(state.direction)>0?"BUY":"SELL",beforeIds,order);
          positionIds.push(...ids);
          rungLots.push(nextLot);
          rungsOpened++;
          lastPyramidPrice=Number(state.direction)>0?Number(quote.bid):Number(quote.ask);
          action="LADDER_V8_PYRAMID";
          await audit(userId,"LADDER_V8_PYRAMID",{botId,symbol:config.symbol,rung:rungsOpened,volume:nextLot,velocity:v,positionIds:ids,cycleId:state.cycle_id});
        }catch(error){
          await pool.query("UPDATE kingbot_execution_journal SET status='REJECTED',error_message=$2,updated_at=NOW() WHERE id=$1",[journal.rows[0].id,String(error?.message||"ORDER_REJECTED").slice(0,500)]);
        }
      }
    }else action="LADDER_V8_PYRAMID_RISK_GATED";
  }
  const nextState={
    ...state,
    active:true,
    positionIds:[...new Set(positionIds.map(String))],
    rungLots,
    rungsOpened,
    lockLevel,
    lastLockPrice,
    lastPyramidPrice,
    velocitySamples:samples,
    lastAction:action,
    lastActionAt:new Date().toISOString()
  };
  await saveLadderState(userId,botId,nextState);
  return {action,state:nextState,velocity:v};
}

async function execute(row){
  const {user_id:userId,bot_id:botId}=row;
  const trace=(stage,extra={})=>console.log("[KINGBOT EXEC]",JSON.stringify({botId,stage,symbol:row.symbol||null,...extra,at:new Date().toISOString()}));
  trace("START");
  if(!(await entitled(userId,botId))){
    await pool.query("UPDATE kingbot_bot_runtime SET state='ERROR',last_error='SUBSCRIPTION_NOT_ACTIVE',updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,botId]);
    return;
  }
  const config=(await pool.query("SELECT symbol,timeframe FROM kingbot_bot_runtime WHERE user_id=$1 AND bot_id=$2",[userId,botId])).rows[0];
  if(!config?.symbol){await pool.query("UPDATE kingbot_bot_runtime SET state='RUNNING',last_error='SYMBOL_NOT_CONFIGURED_RETRYING',last_run_at=NOW(),updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,botId]);return;}
  const s=await settings(userId,botId);
  if(s.killSwitch){await pool.query("UPDATE kingbot_bot_runtime SET state='PAUSED',last_error='KILL_SWITCH_ACTIVE',updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,botId]);return;}
  const status=await broker.getStatus(userId);
  if(!status.configured){await pool.query("UPDATE kingbot_bot_runtime SET state='RUNNING',last_error='BROKER_ACCOUNT_NOT_MAPPED_RETRYING',last_run_at=NOW(),updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,botId]);return;}
  if(!status.connected){
    const connected=await broker.connect(userId,s.executionMode);
    if(!connected.connected)throw new Error(connected.reason||"BROKER_CONNECTION_FAILED");
  }
  const account=await getWorkerAccount(userId);
  trace("ACCOUNT_READY",{broker:status.broker,accountId:status.accountId,executionMode:s.executionMode});
  const brokerName=String(status.broker||"").toLowerCase();
  if(brokerName==="deriv")throw new Error("DERIV_OPTIONS_NOT_VALID_FOR_MT5_BOTS");
  if(brokerName==="exness"){
    if(s.executionMode==="PAPER")s.executionMode="DEMO";
    if(account.trade_mode==="trading_disabled")throw new Error("EXNESS_TRADING_DISABLED");
    if(account.account_status==="close_only")throw new Error("EXNESS_ACCOUNT_CLOSE_ONLY");
  }
  const accountType=String(account.accountType||account.account_type||status.accountSnapshot?.accountType||(brokerName==="oanda"?(s.executionMode==="LIVE"?"REAL":"DEMO"):"")||(String(account.type||"").toUpperCase().includes("DEMO")?"DEMO":"")||(String(account.type||"").toUpperCase().includes("REAL")?"REAL":"")).trim().toUpperCase();
  if(s.executionMode==="DEMO"&&accountType!=="DEMO")throw new Error("DEMO_REQUIRES_DEMO_ACCOUNT");
  if(s.executionMode==="LIVE"&&accountType!=="REAL")throw new Error("LIVE_REQUIRES_REAL_ACCOUNT");
  if(account.tradeAllowed===false)throw new Error("BROKER_TRADING_NOT_ALLOWED");

  const quote=(await broker.getQuote(config.symbol,userId)).data||{};
  trace("QUOTE_READY",{symbol:config.symbol,quoteFresh:Boolean(quote.fresh),ageMs:Number(quote.ageMs||0)});
  const bid=Number(quote.bid),ask=Number(quote.ask),quoteTime=new Date(quote.time||0).getTime();
  if(!Number.isFinite(bid)||!Number.isFinite(ask)||ask<bid)throw new Error("INVALID_BROKER_QUOTE");
  if(!Number.isFinite(quoteTime)||Date.now()-quoteTime>s.staleDataMs)throw new Error("STALE_BROKER_QUOTE");

  const executionTimeframe=String(config.timeframe||getBotDefinitions()[botId]?.timeframeProfile?.execution||"5m");
  const multiTimeframe=await getMultiTimeframeContext(userId,config.symbol,botId,executionTimeframe);
  trace("MULTI_TF_READY",{ready:Boolean(multiTimeframe.ready),profile:multiTimeframe.profile});
  if(!multiTimeframe.ready){
    const reason="MULTI_TIMEFRAME_DATA_UNAVAILABLE:"+[multiTimeframe.regime,multiTimeframe.setup,multiTimeframe.execution]
      .filter(x=>x&&!x.available)
      .map(x=>x.timeframe+":"+(x.reason||"UNAVAILABLE")).join("|");
    await pool.query("UPDATE kingbot_bot_runtime SET last_signal=$3,last_run_at=NOW(),last_error=$4,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",
      [userId,botId,JSON.stringify({signal:"NO_SIGNAL",action:"MULTI_TIMEFRAME_BLOCKED",strategy:botId,timeframeProfile:multiTimeframe.profile,updatedAt:new Date().toISOString()}),reason.slice(0,500)]);
    return;
  }
  const ind=multiTimeframe.execution;
  const spread=ask-bid;
  const velocityKey=ladderKey(userId,botId);
  const ladderCfg=getBotDefinitions()[botId]?.v8||LADDER_V8_DEFAULTS;
  if(botId==="ladder-flip"){
    const sampleList=updateVelocitySamples(ladderVelocityBuffers.get(velocityKey)||[],(bid+ask)/2,Date.now(),ladderCfg);
    ladderVelocityBuffers.set(velocityKey,sampleList);
  }
  const v8Velocity=botId==="ladder-flip"
    ? velocityPoints(ladderVelocityBuffers.get(velocityKey)||[],Math.max(Number(ind.v8Atr||ind.atr)/1000,1e-12),ladderCfg)
    : 0;

  const analysis=evaluateBot(botId,{
    symbol:config.symbol,timeframe:executionTimeframe,price:(bid+ask)/2,entryPrice:(bid+ask)/2,spread,atr:botId==="ladder-flip"?(ind.v8Atr||ind.atr):ind.atr,
    timeframeProfile:multiTimeframe.profile,
    multiTimeframe:{regime:multiTimeframe.regime,setup:multiTimeframe.setup,execution:multiTimeframe.execution},
    volatility:ind.volatility,trend:ind.trend,momentum:ind.momentum,volume:ind.volume,structure:ind.structure,
    liquiditySweep:ind.liquiditySweep,orderBlock:ind.orderBlock,fairValueGap:ind.fairValueGap,displacement:ind.displacement,breakout:ind.breakout,retest:ind.retest,
    emaFast:ind.emaFast,emaSlow:ind.emaSlow,adx:ind.adx,rsi:ind.rsi,velocityPoints:v8Velocity,brokerPoint:0
  });
  const positions=await getWorkerPositions(userId);
  trace("POSITIONS_READY",{count:positions.length});

  const riskStateQ=await pool.query("SELECT baseline_date,day_start_equity,peak_equity FROM kingbot_account_risk_state WHERE user_id=$1 AND provider=$2 AND account_id=$3",[userId,status.broker,status.accountId]);
  const today=new Date().toISOString().slice(0,10);
  let dayStart=Number(account.equity),peak=Number(account.equity);
  if(riskStateQ.rowCount){dayStart=riskStateQ.rows[0].baseline_date===today?Number(riskStateQ.rows[0].day_start_equity):Number(account.equity);peak=Math.max(Number(riskStateQ.rows[0].peak_equity)||Number(account.equity),Number(account.equity));}
  await pool.query("INSERT INTO kingbot_account_risk_state(user_id,provider,account_id,baseline_date,day_start_equity,peak_equity,updated_at) VALUES($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT(user_id,provider,account_id) DO UPDATE SET baseline_date=EXCLUDED.baseline_date,day_start_equity=EXCLUDED.day_start_equity,peak_equity=EXCLUDED.peak_equity,updated_at=NOW()",[userId,status.broker,status.accountId,today,dayStart,peak]);
  const losses=await consecutiveLosses(userId);
  const globalRisk=await getGlobalRisk();
  const globalGate=globalExecutionGate(globalRisk);
  const reconciliation=await reconcileBrokerState(userId,status,positions).catch(error=>({
    checked:false,status:"ERROR",reason:String(error?.message||"BROKER_RECONCILIATION_FAILED").slice(0,180)
  }));
  const authorization=authorizeOrder({limits:s,executionMode:s.executionMode,killSwitch:s.killSwitch,globalKillSwitch:globalRisk.globalKillSwitch,globalTradingPaused:globalRisk.tradingPaused,equity:Number(account.equity),dayStartEquity:dayStart,peakEquity:peak,openPositions:positions.length,requestedRiskPct:s.maxRiskPerTradePct,spread,atr:botId==="ladder-flip"?(ind.v8Atr||ind.atr):ind.atr,dataAgeMs:Date.now()-quoteTime,consecutiveLosses:losses,skipSpreadAtr:botId==="ladder-flip"&&String(status.broker||"").toLowerCase()==="deriv"});
  const risk=authorization?.risk
    ? {...authorization.risk,allowed:Boolean(authorization.allowed),reason:authorization.reason||null}
    : authorization;
  trace("RISK_EVALUATED",{signal:analysis.signal,score:analysis.score,riskAllowed:Boolean(risk?.allowed),blocked:risk?.blockedReasons||[],reason:risk?.reason||null,globalExecution:globalGate,brokerReconciliation:reconciliation?.status||"UNKNOWN"});

  const aiMarket={
    symbol:config.symbol,timeframe:executionTimeframe,price:(bid+ask)/2,bid,ask,
    spread,atr:botId==="ladder-flip"?(ind.v8Atr||ind.atr):ind.atr,
    volatility:ind.volatility,trend:ind.trend,momentum:ind.momentum,
    structure:ind.structure,adx:ind.adx,rsi:ind.rsi,emaFast:ind.emaFast,emaSlow:ind.emaSlow,
    velocityPoints:v8Velocity,
    timeframeProfile:multiTimeframe.profile,
    multiTimeframe:{
      regime:multiTimeframe.regime,
      setup:multiTimeframe.setup,
      execution:multiTimeframe.execution
    }
  };
  const aiStrategySignal=getAiStrategySignal({userId,botId,market:aiMarket,analysis});
  const aiTradeGate=aiStrategySignal
    ? routeAiSignalToEngine({botId,signal:aiStrategySignal,candidateSignal:analysis.signal})
    : null;
  if(analysis.ok){
    void warmAiStrategySignal({userId,botId,market:aiMarket,analysis,risk,tradePlan:null})
      .catch(error=>console.error("[KINGBOT AI SIGNAL] warm failed:",error?.message||error));
  }

  if(botId==="ladder-flip"){
    const specResult=await broker.getSymbolSpecification(config.symbol,userId);
    const rawSpec=specResult?.data??specResult??{};
    const spec=ladderSpec(rawSpec,quote);
    if(!Number.isFinite(spec.point)||spec.point<=0)throw new Error("LADDER_V8_BROKER_POINT_UNAVAILABLE");
    const state=await getLadderState(userId,botId);
    if(String(status.broker||"").toLowerCase()==="deriv"){
      const sampleList=ladderVelocityBuffers.get(velocityKey)||[];
      const velocity=velocityPoints(sampleList,spec.point,ladderCfg);
      if(state?.active){
        const managed=await executeLadderV8DerivManage({userId,botId,config,s,account,quote,positions,ind,spec,state,velocity,riskAllowed:risk.allowed});
        const v8d={contractType:state.deriv_contract_type||null,multiplier:state.deriv_multiplier||null,contractsTracked:managed.state?.positionIds?.length||0,rungsOpened:managed.state?.rungsOpened||0,lockLevel:managed.state?.lockLevel||0,lockedProfit:Number(managed.state?.lastLockPrice||0),velocityPoints:managed.velocity??velocity,ema20:ind.emaFast,ema50:ind.emaSlow,adx14:ind.adx,rsi14:ind.rsi};
        const signalPayload={signal:analysis.signal,score:analysis.score,threshold:analysis.threshold,action:managed.action,executionMode:s.executionMode,strategy:botId,tradePlan:null,riskAllowed:risk.allowed,analysisReason:analysis.reason,riskReason:risk.reason||risk.blockedReasons,v8:v8d,updatedAt:new Date().toISOString()};
        await pool.query("UPDATE kingbot_bot_runtime SET last_signal=$3,last_run_at=NOW(),last_error=NULL,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,botId,JSON.stringify(signalPayload)]);
        await audit(userId,"BOT_WORKER_TICK",{botId,executionMode:s.executionMode,symbol:config.symbol,timeframe:config.timeframe,signal:analysis.signal,score:analysis.score,action:managed.action,v8:v8d,riskAllowed:risk.allowed});
        return;
      }
      let action="NO_ACTION",started=null,startDetails=null;
      const derivBroker=String(status.broker||"").toLowerCase()==="deriv";
      const spreadPoints=spec.point>0?spread/spec.point:Infinity;
      const spreadOk=derivBroker||spreadPoints<=ladderCfg.maxSpreadPoints;
      if(analysis.ok&&analysis.signal!=="NO_SIGNAL"&&risk.allowed&&spreadOk&&(!aiExecutionGateEnabled()||aiTradeGate?.confirm)){
        try{
          const start=await executeLadderV8DerivStart({userId,botId,config,s,account,quote,ind,positions,spec,velocity});
          action=start.action;started=start.state;startDetails=start.details||null;
        }catch(error){
          action="DERIV_V8_EXECUTION_REJECTED";
          startDetails={error:String(error?.message||"DERIV_V8_EXECUTION_REJECTED").slice(0,500)};
          console.error("[KINGBOT V8] execution rejected:",startDetails.error);
          await audit(userId,"LADDER_V8_DERIV_EXECUTION_REJECTED",{botId,symbol:config.symbol,error:startDetails.error,score:analysis.score,signal:analysis.signal});
        }
      }else if(!analysis.ok)action="SIGNAL_GATE_BLOCKED";
      else if(analysis.signal==="NO_SIGNAL")action="SIGNAL_BELOW_THRESHOLD";
      else if(!risk.allowed)action="RISK_BLOCKED";
      else if(!derivBroker&&spreadPoints>ladderCfg.maxSpreadPoints)action="V8_SPREAD_FILTER_BLOCKED";
      else if(!aiTradeGate)action="AI_CONFIRMATION_PENDING";
      else action="AI_CONFIRMATION_REJECTED";
      console.log("[KINGBOT V8] cycle",JSON.stringify({botId,symbol:config.symbol,signal:analysis.signal,score:analysis.score,threshold:analysis.threshold,riskAllowed:risk.allowed,spreadPoints,maxSpreadPoints:ladderCfg.maxSpreadPoints,spreadGate:"BROKER_NATIVE",entryQualified:Boolean(ind.v8EntryQualified),aiSignal:aiStrategySignal?.direction||"HOLD",aiEngine:aiStrategySignal?.engine||null,aiStrategyMatch:Boolean(aiStrategySignal?.strategyMatch),aiStatus:aiTradeGate?.status||"AI_SIGNAL_PENDING",action}));
      const v8d={contractType:started?.derivContractType||null,multiplier:started?.derivMultiplier||null,entryQualified:Boolean(ind.v8EntryQualified),spreadGate:derivBroker?"PROPOSAL_NATIVE":"POINT_LIMIT",rungsOpened:started?.rungsOpened||0,lotScale:started?.lotScale||null,velocityPoints:velocity,spreadPoints,spreadMaxPoints:ladderCfg.maxSpreadPoints,startDetails,aiConfirmed:Boolean(aiTradeGate?.confirm),aiSignal:aiStrategySignal?.direction||"HOLD",aiEngine:aiStrategySignal?.engine||null,aiStrategyMatch:Boolean(aiStrategySignal?.strategyMatch),aiTrigger:aiStrategySignal?.trigger||null,aiStatus:aiTradeGate?.status||"AI_SIGNAL_PENDING"};
      const signalPayload={signal:analysis.signal,score:analysis.score,threshold:analysis.threshold,action,executionMode:s.executionMode,strategy:botId,tradePlan:null,riskAllowed:risk.allowed,riskBlockedReasons:risk.blockedReasons||[],analysisReason:analysis.reason,riskReason:risk.reason||risk.blockedReasons,aiTradeGate:aiTradeGate?{confirm:Boolean(aiTradeGate.confirm),direction:aiTradeGate.direction,engine:aiTradeGate.engine||null,strategyMatch:Boolean(aiTradeGate.strategyMatch),status:aiTradeGate.status,trigger:aiTradeGate.trigger,reason:aiTradeGate.reason,expiresAt:aiTradeGate.expiresAt}:null,v8:v8d,updatedAt:new Date().toISOString()};
      await pool.query("UPDATE kingbot_bot_runtime SET last_signal=$3,last_run_at=NOW(),last_error=NULL,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,botId,JSON.stringify(signalPayload)]);
      await audit(userId,"BOT_WORKER_TICK",{botId,executionMode:s.executionMode,symbol:config.symbol,timeframe:executionTimeframe,timeframeProfile:multiTimeframe.profile,signal:analysis.signal,score:analysis.score,action,v8:v8d,riskAllowed:risk.allowed});
      return;
    }
    const sampleList=ladderVelocityBuffers.get(velocityKey)||[];
    const velocity=velocityPoints(sampleList,spec.point,ladderCfg);
    const spreadPoints=spread/spec.point;
    const spreadOk=Number.isFinite(spreadPoints)&&spreadPoints<=ladderCfg.maxSpreadPoints;
    if(state?.active){
      const managed=await executeLadderV8Manage({userId,botId,config,s,account,quote,positions,ind,spec,state,velocity,riskAllowed:risk.allowed&&spreadOk});
      const signalPayload={
        signal:analysis.signal,score:analysis.score,threshold:analysis.threshold,action:managed.action,executionMode:s.executionMode,strategy:botId,
        tradePlan:null,riskAllowed:risk.allowed,analysisReason:analysis.reason,riskReason:risk.reason||risk.blockedReasons,
        v8:{ema20:ind.emaFast,ema50:ind.emaSlow,adx14:ind.adx,rsi14:ind.rsi,velocityPoints:managed.velocity??velocity,
          direction:state.direction>0?"BUY":"SELL",rungsOpened:managed.state?.rungsOpened??state.rungsOpened,lockLevel:managed.state?.lockLevel??state.lockLevel,
          anchorPrice:state.anchor_price,stepPrice:state.step_price,aggressiveEntry:state.aggressive_entry},
        updatedAt:new Date().toISOString()
      };
      await pool.query("UPDATE kingbot_bot_runtime SET last_signal=$3,last_run_at=NOW(),last_error=NULL,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,botId,JSON.stringify(signalPayload)]);
      await audit(userId,"BOT_WORKER_TICK",{botId,executionMode:s.executionMode,symbol:config.symbol,timeframe:config.timeframe,signal:analysis.signal,score:analysis.score,action:managed.action,v8:signalPayload.v8,riskAllowed:risk.allowed});
      return;
    }
    let action="NO_ACTION";
    let started=null;
    if(analysis.ok&&analysis.signal!=="NO_SIGNAL"&&risk.allowed&&spreadOk&&(!aiExecutionGateEnabled()||aiTradeGate?.confirm)){
      const start=await executeLadderV8Start({userId,botId,config,s,account,quote,ind,positions,spec,velocity});
      action=start.action;started=start.state;
    }else if(analysis.ok&&analysis.signal!=="NO_SIGNAL"&&!spreadOk)action="V8_SPREAD_FILTER_BLOCKED";
    else if(analysis.ok&&analysis.signal!=="NO_SIGNAL"&&!risk.allowed)action="RISK_BLOCKED";
    const v8Payload={
      ema20:ind.emaFast,ema50:ind.emaSlow,adx14:ind.adx,rsi14:ind.rsi,velocityPoints:velocity,direction:ind.v8Direction>0?"BUY":ind.v8Direction<0?"SELL":"NONE",
      entryQualified:Boolean(ind.v8EntryQualified),spreadPoints,rungsOpened:started?.rungsOpened||0,plannedLots:started?.plannedLots||[],executedLots:started?.executedLots||[],lotGrowthFactor:started?.lotGrowthFactor||Number(ladderCfg.lotGrowthFactor)||2,brokerMinLot:started?.brokerMinLot||null,brokerLotStep:started?.brokerLotStep||null
    };
    const signalPayload={signal:analysis.signal,score:analysis.score,threshold:analysis.threshold,action,executionMode:s.executionMode,strategy:botId,tradePlan:null,riskAllowed:risk.allowed,analysisReason:analysis.reason,riskReason:risk.reason||risk.blockedReasons,v8:v8Payload,updatedAt:new Date().toISOString()};
    await pool.query("UPDATE kingbot_bot_runtime SET last_signal=$3,last_run_at=NOW(),last_error=NULL,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,botId,JSON.stringify(signalPayload)]);
    await audit(userId,"BOT_WORKER_TICK",{botId,executionMode:s.executionMode,symbol:config.symbol,timeframe:config.timeframe,signal:analysis.signal,score:analysis.score,action,v8:v8Payload,riskAllowed:risk.allowed});
    if(analysis.ok&&analysis.signal!=="NO_SIGNAL"){
      void monitorBotDecision({userId,botId,analysis,market:{symbol:config.symbol,timeframe:config.timeframe,bid,ask,spread,atr:ind.v8Atr||ind.atr,volatility:ind.volatility,trend:ind.trend,momentum:ind.momentum,structure:ind.structure},risk,tradePlan:null}).catch(error=>console.error("[KINGBOT AI SUPERVISOR] persistence failed:",error?.message||error));
    }
    return;
  }

  let action="NO_ACTION",order=null,tradePlan=null;
  if(analysis.ok&&analysis.signal!=="NO_SIGNAL"&&risk.allowed&&(!aiExecutionGateEnabled()||aiTradeGate?.confirm)){
    const side=analysis.signal==="LONG_CANDIDATE"?"BUY":"SELL";
    const specResult=await broker.getSymbolSpecification(config.symbol,userId); const spec=specResult?.data??specResult??{};
    const tickSize=Number(spec.tickSize),minVolume=Number(spec.minVolume),maxVolume=Number(spec.maxVolume),volumeStep=Number(spec.volumeStep),point=Number(spec.point),stopsLevel=Number(spec.stopsLevel);
    const tickValue=Number(side==="BUY"?quote.lossTickValue:quote.lossTickValue);
    if(![tickSize,minVolume,maxVolume,volumeStep,point,stopsLevel,tickValue].every(Number.isFinite)||tickSize<=0||minVolume<=0||maxVolume<minVolume||volumeStep<=0||tickValue<=0)throw new Error("BROKER_SIZING_DATA_UNAVAILABLE");
    tradePlan=getTradePlan(botId,{symbol:config.symbol,timeframe:config.timeframe,price:(bid+ask)/2,entryPrice:side==="BUY"?ask:bid,atr:ind.atr},side);
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
      order=await broker.placeOrder({side,symbol:config.symbol,volume,stopLoss,takeProfit,comment:"KINGBOT",clientId,userId,multiplier:String(status.broker||"").toLowerCase()==="deriv"?100:undefined});
      await pool.query("UPDATE kingbot_execution_journal SET status='SUBMITTED',broker_result=$2::jsonb,updated_at=NOW() WHERE id=$1",[journal.rows[0].id,JSON.stringify(order)]);
      action="ORDER_SUBMITTED";
    }catch(error){
      await pool.query("UPDATE kingbot_execution_journal SET status='REJECTED',error_message=$2,updated_at=NOW() WHERE id=$1",[journal.rows[0].id,String(error?.message||"ORDER_REJECTED").slice(0,500)]);
      throw error;
    }
  }else if(analysis.ok&&analysis.signal!=="NO_SIGNAL"&&!risk.allowed){action="RISK_BLOCKED";}
  else if(analysis.ok&&analysis.signal!=="NO_SIGNAL"&&!aiTradeGate){action="AI_SIGNAL_PENDING";}
  else if(analysis.ok&&analysis.signal!=="NO_SIGNAL"&&risk.allowed&&!aiTradeGate?.confirm){action=aiTradeGate?.status||"AI_SIGNAL_REJECTED";}
  const signalPayload={signal:analysis.signal,score:analysis.score,threshold:analysis.threshold,action,executionMode:s.executionMode,strategy:botId,tradePlan:analysis.signal!=="NO_SIGNAL"?(typeof tradePlan!=="undefined"?tradePlan:null):null,riskAllowed:risk.allowed,analysisReason:analysis.reason||null,riskReason:risk.reason||risk.reasons||null,aiTradeGate:aiTradeGate?{confirm:Boolean(aiTradeGate.confirm),direction:aiTradeGate.direction,engine:aiTradeGate.engine||null,strategyMatch:Boolean(aiTradeGate.strategyMatch),status:aiTradeGate.status,trigger:aiTradeGate.trigger,reason:aiTradeGate.reason,expiresAt:aiTradeGate.expiresAt}:null,aiSignal:aiStrategySignal?{direction:aiStrategySignal.direction,engine:aiStrategySignal.engine,strategyMatch:Boolean(aiStrategySignal.strategyMatch),trigger:aiStrategySignal.trigger,reason:aiStrategySignal.reason}:null,updatedAt:new Date().toISOString()};
  await pool.query("UPDATE kingbot_bot_runtime SET last_signal=$3,last_run_at=NOW(),last_error=NULL,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,botId,JSON.stringify(signalPayload)]);
  await audit(userId,"BOT_WORKER_TICK",{botId,executionMode:s.executionMode,symbol:config.symbol,timeframe:config.timeframe,signal:analysis.signal,score:analysis.score,action,tradePlan:signalPayload.tradePlan,aiSignal:signalPayload.aiSignal,aiStatus:aiTradeGate?.status||"AI_SIGNAL_PENDING"});
  if(analysis.ok && analysis.signal!=="NO_SIGNAL"){
    void monitorBotDecision({userId,botId,analysis,market:{symbol:config.symbol,timeframe:config.timeframe,bid,ask,spread,atr:ind.atr,volatility:ind.volatility,trend:ind.trend,momentum:ind.momentum,structure:ind.structure},risk,tradePlan:signalPayload.tradePlan}).then(aiMonitor=>{
      if(!aiMonitor)return;
      const merged={...signalPayload,aiMonitor,updatedAt:new Date().toISOString()};
      return pool.query("UPDATE kingbot_bot_runtime SET last_signal=$3,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,botId,JSON.stringify(merged)]);
    }).catch(error=>console.error("[KINGBOT AI SUPERVISOR] persistence failed:",error?.message||error));
  }
}

async function cycle(){
  if(stopping||!pool)return;
  await heartbeat();
  await getGlobalRisk();
  if(Date.now()-lastSubscriptionSweep>30000){
    lastSubscriptionSweep=Date.now();
    await expireStaleSubscriptions(pool);
  }
  const q=await pool.query("SELECT user_id,bot_id,state FROM kingbot_bot_runtime WHERE state='RUNNING' ORDER BY updated_at ASC LIMIT 100");
  if(Date.now()-lastWorkerHeartbeat>15000){
    lastWorkerHeartbeat=Date.now();
    console.log("[KINGBOT WORKER] heartbeat",JSON.stringify({runningBots:q.rows.length,bots:q.rows.map(x=>String(x.bot_id)).slice(0,25),pollMs:WORKER_POLL_MS}));
  }

  let launched=0;
  for(const row of q.rows){
    if(stopping||launched>=MAX_PARALLEL_BOTS)break;
    const executionKey=String(row.user_id)+":"+String(row.bot_id);
    if(activeExecutionKeys.has(executionKey))continue;
    activeExecutionKeys.add(executionKey);
    launched++;
    void execute(row).catch(async error=>{
      console.error("[KINGBOT WORKER] execution error",JSON.stringify({botId:row.bot_id,error:String(error?.message||"WORKER_EXECUTION_FAILED").slice(0,500),at:new Date().toISOString()}));
      const message=String(error?.message||"WORKER_EXECUTION_FAILED").slice(0,500);
      try{
        await pool.query("UPDATE kingbot_bot_runtime SET state='RUNNING',last_error=$3,last_run_at=NOW(),updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[row.user_id,row.bot_id,message]);
        await audit(row.user_id,"BOT_WORKER_ERROR",{botId:row.bot_id,error:message,retryable:true});
      }catch(dbError){
        console.error("[KINGBOT WORKER] failure state persistence error",dbError?.message||dbError);
      }
    }).finally(()=>{
      activeExecutionKeys.delete(executionKey);
    });
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
  await heartbeat({startup:true});
  console.log("[KINGBOT WORKER] real broker execution loop started with centralized risk control");
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
