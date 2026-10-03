import { Router } from "express";
import crypto from "node:crypto";
import { requireUser } from "./subscriptions.js";
import { isAdminEmail } from "./admin-access.js";
import { evaluateBot, getBotDefinitions } from "./bot-engines.js";
import { authorizeOrder } from "./risk-engine.js";

const RUN_STATES = new Set(["STOPPED","RUNNING","PAUSED","ERROR"]);

async function entitlement(pool,userId,botId,userEmail){
  if(isAdminEmail(userEmail))return true;
  if(!pool)return false;
  const q=await pool.query("SELECT 1 FROM kingbot_bot_entitlements e JOIN kingbot_subscriptions s ON s.id=e.subscription_id WHERE e.user_id=$1 AND e.bot_id=$2 AND e.active=TRUE AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at>NOW()) LIMIT 1",[userId,botId]);
  return q.rowCount>0;
}
async function settings(pool,userId,botId){
  const q=await pool.query("SELECT * FROM kingbot_bot_risk_settings WHERE user_id=$1 AND bot_id=$2",[userId,botId]);
  if(!q.rowCount)return {executionMode:"DEMO",killSwitch:false,dailyDrawdownPct:5,totalDrawdownPct:10,maxRiskPerTradePct:getBotDefinitions()[botId].risk.maxRiskPerTradePct,maxPositions:getBotDefinitions()[botId].risk.maxPositions,maxSpreadAtrRatio:.25,staleDataMs:5000,maxConsecutiveLosses:3,autoPauseOnLossStreak:true};
  const x=q.rows[0];
  return {dailyDrawdownPct:Number(x.daily_drawdown_pct),totalDrawdownPct:Number(x.total_drawdown_pct),maxRiskPerTradePct:Number(x.max_risk_per_trade_pct),maxPositions:Number(x.max_positions),maxSpreadAtrRatio:Number(x.max_spread_atr_ratio),staleDataMs:Number(x.stale_data_ms),maxConsecutiveLosses:Number(x.max_consecutive_losses),autoPauseOnLossStreak:Boolean(x.auto_pause_on_loss_streak),executionMode:String(x.execution_mode||"DEMO"),killSwitch:Boolean(x.kill_switch)};
}
async function runtime(pool,userId,botId){
  const q=await pool.query("SELECT * FROM kingbot_bot_runtime WHERE user_id=$1 AND bot_id=$2",[userId,botId]);
  return q.rowCount?q.rows[0]:null;
}
async function audit(pool,userId,event,metadata){
  await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,$2,$3::jsonb)",[userId,event,JSON.stringify(metadata)]);
}
async function claimActiveBot(pool,userId,botId){
  await pool.query(
    "UPDATE kingbot_bot_runtime SET state='STOPPED',updated_at=NOW() WHERE user_id=$1 AND bot_id<>$2 AND state='RUNNING'",
    [userId,botId]
  );
  await pool.query(
    "INSERT INTO kingbot_user_bot_selection(user_id,selected_bot_id,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(user_id) DO UPDATE SET selected_bot_id=EXCLUDED.selected_bot_id,updated_at=NOW()",
    [userId,botId]
  );
}

export function createBotRuntimeRouter({pool,broker}){
  const router=Router();

  router.get("/",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const bots=await Promise.all(Object.values(getBotDefinitions()).map(async b=>{const r=await runtime(pool,user.id,b.id),s=await settings(pool,user.id,b.id),entitled=await entitlement(pool,user.id,b.id,user.email);return {botId:b.id,name:b.name,mode:b.mode||null,entitled,runtime:r?.state||"STOPPED",executionMode:s.executionMode,killSwitch:s.killSwitch,symbol:r?.symbol||null,timeframe:r?.timeframe||bot.timeframeProfile?.execution||"5m",lastSignal:r?.last_signal||null,lastRunAt:r?.last_run_at||null,lastError:r?.last_error||null,signalThreshold:b.signalThreshold||null,tradePlan:b.tradePlan||null,strategies:b.strategies||[]};}));
    res.json({ok:true,bots});
  });

  router.get("/selection/current",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const q=await pool.query("SELECT selected_bot_id,updated_at FROM kingbot_user_bot_selection WHERE user_id=$1",[user.id]);
    const selectedBotId=q.rowCount?String(q.rows[0].selected_bot_id):null;
    if(!selectedBotId){
      return res.json({ok:true,selectedBotId:null,updatedAt:null,bot:null});
    }
    const bot=getBotDefinitions()[selectedBotId];
    if(!bot){
      await pool.query("DELETE FROM kingbot_user_bot_selection WHERE user_id=$1",[user.id]);
      return res.json({ok:true,selectedBotId:null,updatedAt:null,bot:null});
    }
    const entitled=await entitlement(pool,user.id,selectedBotId,user.email);
    if(!entitled){
      return res.json({ok:true,selectedBotId:null,updatedAt:q.rows[0].updated_at,bot:null,reason:"SELECTED_BOT_NO_LONGER_ENTITLED"});
    }
    const r=await runtime(pool,user.id,selectedBotId),s=await settings(pool,user.id,selectedBotId);
    return res.json({
      ok:true,
      selectedBotId,
      updatedAt:q.rows[0].updated_at,
      bot:{botId:bot.id,name:bot.name,state:r?.state||"STOPPED",executionMode:s.executionMode,symbol:r?.symbol||null,timeframe:r?.timeframe||b.timeframeProfile?.execution||"5m",lastSignal:r?.last_signal||null,lastRunAt:r?.last_run_at||null,lastError:r?.last_error||null}
    });
  });

  router.post("/selection",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const botId=String(req.body?.botId||"").trim();
    if(!getBotDefinitions()[botId])return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    if(!(await entitlement(pool,user.id,botId,user.email)))return res.status(403).json({ok:false,error:"BOT_NOT_INCLUDED_IN_SUBSCRIPTION"});
    await claimActiveBot(pool,user.id,botId);
    await audit(pool,user.id,"BOT_SELECTION_SAVED",{botId});
    const r=await runtime(pool,user.id,botId),s=await settings(pool,user.id,botId);
    res.json({ok:true,selectedBotId:botId,state:r?.state||"STOPPED",executionMode:s.executionMode,symbol:r?.symbol||null,timeframe:r?.timeframe||b.timeframeProfile?.execution||"5m"});
  });
  router.get("/:botId",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const b=getBotDefinitions()[req.params.botId];if(!b)return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    if(!(await entitlement(pool,user.id,b.id,user.email)))return res.status(403).json({ok:false,allowed:false,reason:"BOT_NOT_INCLUDED_IN_SUBSCRIPTION"});
    const r=await runtime(pool,user.id,b.id),s=await settings(pool,user.id,b.id);
    res.json({ok:true,botId:b.id,state:r?.state||"STOPPED",executionMode:s.executionMode,killSwitch:s.killSwitch,symbol:r?.symbol||null,timeframe:r?.timeframe||b.timeframeProfile?.execution||"5m",lastSignal:r?.last_signal||null,lastRunAt:r?.last_run_at||null,lastError:r?.last_error||null,signalThreshold:b.signalThreshold||null,tradePlan:b.tradePlan||null,strategies:b.strategies||[]});
  });

  router.post("/:botId/start",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const b=getBotDefinitions()[req.params.botId];if(!b)return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    if(!(await entitlement(pool,user.id,b.id,user.email)))return res.status(403).json({ok:false,allowed:false,reason:"BOT_NOT_INCLUDED_IN_SUBSCRIPTION"});
    const s=await settings(pool,user.id,b.id);
    if(s.killSwitch)return res.status(409).json({ok:false,error:"KILL_SWITCH_ACTIVE"});
    if(!["DEMO","LIVE"].includes(s.executionMode))return res.status(400).json({ok:false,error:"INVALID_EXECUTION_MODE"});
    if(!(await broker.isConnected(user.id)))return res.status(503).json({ok:false,error:"BROKER_NOT_CONNECTED",message:"Connect the verified broker before starting DEMO or LIVE execution. No order was submitted."});
    const brokerStatus=await broker.getStatus(user.id);
    if(String(brokerStatus.broker||"").toLowerCase()==="deriv")return res.status(409).json({ok:false,error:"DERIV_OPTIONS_NOT_VALID_FOR_MT5_BOTS",message:"The connected account is Deriv Options. These bot engines use MT5 lots and require KINGBOT MT5 BRIDGE on the selected Deriv MT5 account."});
    await pool.query("ALTER TABLE kingbot_bot_runtime ADD COLUMN IF NOT EXISTS symbol TEXT, ADD COLUMN IF NOT EXISTS timeframe TEXT DEFAULT '5m'");
    const configured=await pool.query("SELECT symbol,timeframe FROM kingbot_bot_runtime WHERE user_id=$1 AND bot_id=$2",[user.id,b.id]);
    const requestedSymbol=String(req.body?.symbol||"").trim().toUpperCase();
    const requestedTimeframe=String(req.body?.timeframe||"").trim();
    let symbol=requestedSymbol || String(configured.rows?.[0]?.symbol||"").trim().toUpperCase();
    let timeframe=requestedTimeframe || String(configured.rows?.[0]?.timeframe||b.timeframeProfile?.execution||"5m").trim();
    if(!symbol){
      return res.status(400).json({ok:false,error:"BROKER_MARKET_REQUIRED",message:"Select a market from the connected broker catalog before starting the engine. No order was submitted."});
    }
    try{
      const marketCheck=await broker.validateMarket(user.id,symbol);
      if(!marketCheck.ok)return res.status(400).json({ok:false,error:marketCheck.error,message:"The selected market is not available for the connected broker account. Choose a market from the broker catalog. No order was submitted."});
    }catch(error){
      return res.status(503).json({ok:false,error:"BROKER_MARKET_VALIDATION_UNAVAILABLE",reason:error?.message||"BROKER_MARKET_VALIDATION_FAILED",message:"KINGBOT could not verify the selected market against the connected broker. No order was submitted."});
    }
    const allowedTimeframes=["1m","2m","3m","4m","5m","6m","10m","12m","15m","20m","30m","1h","2h","3h","4h","6h","8h","12h","1d","1w","1mn"];
    if(!allowedTimeframes.includes(timeframe))return res.status(400).json({ok:false,error:"INVALID_TIMEFRAME"});
    if(requestedSymbol || requestedTimeframe){
      await pool.query("INSERT INTO kingbot_bot_runtime(user_id,bot_id,state,symbol,timeframe,last_error,updated_at) VALUES($1,$2,'STOPPED',$3,$4,NULL,NOW()) ON CONFLICT(user_id,bot_id) DO UPDATE SET symbol=EXCLUDED.symbol,timeframe=EXCLUDED.timeframe,updated_at=NOW()",[user.id,b.id,symbol,timeframe]);
    }
    await claimActiveBot(pool,user.id,b.id);
    await pool.query("INSERT INTO kingbot_bot_runtime(user_id,bot_id,state,symbol,timeframe,last_error,updated_at) VALUES($1,$2,'RUNNING',$3,$4,NULL,NOW()) ON CONFLICT(user_id,bot_id) DO UPDATE SET state='RUNNING',symbol=EXCLUDED.symbol,timeframe=EXCLUDED.timeframe,last_error=NULL,updated_at=NOW()",[user.id,b.id,symbol,timeframe]);
    await audit(pool,user.id,"BOT_RUNTIME_STARTED",{botId:b.id,executionMode:s.executionMode,exclusiveActiveEngine:true});
    res.json({ok:true,botId:b.id,state:"RUNNING",executionMode:s.executionMode,exclusiveActiveEngine:true});
  });

  router.post("/:botId/stop",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const b=getBotDefinitions()[req.params.botId];if(!b)return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    if(!(await entitlement(pool,user.id,b.id,user.email)))return res.status(403).json({ok:false,allowed:false,reason:"BOT_NOT_INCLUDED_IN_SUBSCRIPTION"});
    await pool.query("INSERT INTO kingbot_bot_runtime(user_id,bot_id,state,updated_at) VALUES($1,$2,'STOPPED',NOW()) ON CONFLICT(user_id,bot_id) DO UPDATE SET state='STOPPED',updated_at=NOW()",[user.id,b.id]);
    await audit(pool,user.id,"BOT_RUNTIME_STOPPED",{botId:b.id});
    res.json({ok:true,botId:b.id,state:"STOPPED"});
  });

  router.post("/:botId/config",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const b=getBotDefinitions()[req.params.botId];if(!b)return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    if(!(await entitlement(pool,user.id,b.id,user.email)))return res.status(403).json({ok:false,allowed:false,reason:"BOT_NOT_INCLUDED_IN_SUBSCRIPTION"});
    const symbol=String(req.body?.symbol||"").trim().toUpperCase();
    const timeframe=String(req.body?.timeframe||b.timeframeProfile?.execution||"5m").trim();
    if(!/^[A-Z0-9._-]{3,30}$/.test(symbol))return res.status(400).json({ok:false,error:"INVALID_SYMBOL"});
    if(!(await broker.isConnected(user.id)))return res.status(503).json({ok:false,error:"BROKER_NOT_CONNECTED",message:"Connect the verified broker before selecting a market. No bot configuration was saved."});
    const brokerStatus=await broker.getStatus(user.id);
    if(String(brokerStatus.broker||"").toLowerCase()==="deriv")return res.status(409).json({ok:false,error:"DERIV_OPTIONS_NOT_VALID_FOR_MT5_BOTS",message:"Use KINGBOT MT5 BRIDGE for MT5 lot-based bot execution."});
    try{
      const marketCheck=await broker.validateMarket(user.id,symbol);
      if(!marketCheck.ok)return res.status(400).json({ok:false,error:marketCheck.error,message:"The selected market is not available for the connected broker account. Choose a market from the broker catalog."});
    }catch(error){
      return res.status(503).json({ok:false,error:"BROKER_MARKET_VALIDATION_UNAVAILABLE",reason:error?.message||"BROKER_MARKET_VALIDATION_FAILED",message:"KINGBOT could not verify the selected market against the connected broker. No bot configuration was saved."});
    }
    const allowed=["1m","2m","3m","4m","5m","6m","10m","12m","15m","20m","30m","1h","2h","3h","4h","6h","8h","12h","1d","1w","1mn"];
    if(!allowed.includes(timeframe))return res.status(400).json({ok:false,error:"INVALID_TIMEFRAME"});
    await pool.query("ALTER TABLE kingbot_bot_runtime ADD COLUMN IF NOT EXISTS symbol TEXT, ADD COLUMN IF NOT EXISTS timeframe TEXT DEFAULT '5m'");
    await pool.query("INSERT INTO kingbot_bot_runtime(user_id,bot_id,state,symbol,timeframe,updated_at) VALUES($1,$2,'STOPPED',$3,$4,NOW()) ON CONFLICT(user_id,bot_id) DO UPDATE SET symbol=EXCLUDED.symbol,timeframe=EXCLUDED.timeframe,updated_at=NOW()",[user.id,b.id,symbol,timeframe]);
    await audit(pool,user.id,"BOT_RUNTIME_CONFIG_UPDATED",{botId:b.id,symbol,timeframe});
    res.json({ok:true,botId:b.id,symbol,timeframe});
  });

  router.post("/:botId/tick",async(req,res)=>{
    return res.status(409).json({ok:false,error:"WORKER_EXECUTION_ONLY",message:"Autonomous orders are produced only by the worker from broker-verified market data. No order was submitted."});
    const user=await requireUser(pool,req,res);if(!user)return;
    const b=getBotDefinitions()[req.params.botId];if(!b)return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    if(!(await entitlement(pool,user.id,b.id,user.email)))return res.status(403).json({ok:false,allowed:false,reason:"BOT_NOT_INCLUDED_IN_SUBSCRIPTION"});
    const r=await runtime(pool,user.id,b.id),s=await settings(pool,user.id,b.id);
    if(!r||r.state!=="RUNNING")return res.status(409).json({ok:false,error:"BOT_NOT_RUNNING"});
    if(s.killSwitch)return res.status(409).json({ok:false,error:"KILL_SWITCH_ACTIVE"});
    if(!(await broker.isConnected(user.id)))return res.status(503).json({ok:false,error:"BROKER_NOT_CONNECTED",message:"Verified broker connection is required before market validation. No order was submitted."});
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
    const mapping=await broker.getMapping(user.id);
    if(!mapping)return res.status(503).json({ok:false,error:"BROKER_ACCOUNT_MAPPING_UNAVAILABLE",message:"The authorized broker account mapping could not be verified. No order was submitted."});
    const riskState=await pool.query("SELECT baseline_date,day_start_equity,peak_equity FROM kingbot_account_risk_state WHERE user_id=$1 AND provider=$2 AND account_id=$3",[user.id,mapping.provider,mapping.account_id]);
    const today=new Date().toISOString().slice(0,10);
    let dayStartEquity=equity;
    let peakEquity=equity;
    if(riskState.rowCount){
      const state=riskState.rows[0];
      dayStartEquity=state.baseline_date===today?Number(state.day_start_equity):equity;
      peakEquity=Math.max(Number(state.peak_equity)||equity,equity);
    }
    await pool.query("INSERT INTO kingbot_account_risk_state(user_id,provider,account_id,baseline_date,day_start_equity,peak_equity,updated_at) VALUES($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT(user_id,provider,account_id) DO UPDATE SET baseline_date=EXCLUDED.baseline_date,day_start_equity=EXCLUDED.day_start_equity,peak_equity=EXCLUDED.peak_equity,updated_at=NOW()",[user.id,mapping.provider,mapping.account_id,today,dayStartEquity,peakEquity]);
    const requestedRiskPct=s.maxRiskPerTradePct;
    const risk=authorizeOrder({
      limits:s,
      executionMode:s.executionMode,
      killSwitch:s.killSwitch,
      equity,
      dayStartEquity,
      peakEquity,
      openPositions:positionData.length,
      requestedRiskPct,
      spread,
      atr:Number(req.body?.atr),
      dataAgeMs:0
    });
    const signal=analysis.signal;
    let action="NO_ACTION",order=null;
    if(signal!=="NO_SIGNAL"&&risk.allowed){
        const side=signal==="LONG_CANDIDATE"?"BUY":"SELL";
        let specification;
        try{ specification=(await broker.getSymbolSpecification(requestedSymbol,user.id)).data||{}; }
        catch(error){ return res.status(503).json({ok:false,error:"SYMBOL_SPECIFICATION_UNAVAILABLE",reason:error?.message||"BROKER_SPECIFICATION_FAILED",message:"Broker symbol constraints could not be verified. No order was submitted.",analysis,risk}); }
        const minVolume=Number(specification.minVolume),maxVolume=Number(specification.maxVolume),volumeStep=Number(specification.volumeStep),point=Number(specification.point),stopsLevel=Number(specification.stopsLevel),tickSize=Number(specification.tickSize),tickValue=Number(specification.tickValue);
        if(!Number.isFinite(minVolume)||!Number.isFinite(maxVolume)||!Number.isFinite(volumeStep)||minVolume<=0||maxVolume<minVolume||volumeStep<=0)return res.status(503).json({ok:false,error:"INVALID_SYMBOL_SPECIFICATION",message:"Broker returned incomplete symbol constraints. No order was submitted.",analysis,risk});
        const stopLoss=req.body?.stopLoss==null?null:Number(req.body.stopLoss);
        const takeProfit=req.body?.takeProfit==null?null:Number(req.body.takeProfit);
        if(stopLoss==null)return res.status(400).json({ok:false,error:"STOP_LOSS_REQUIRED_FOR_AUTO_SIZING",message:"A stop loss is required so the server can calculate risk-based position size. No order was submitted.",analysis,risk});
        if(!Number.isFinite(tickSize)||tickSize<=0||!Number.isFinite(tickValue)||tickValue<=0)return res.status(503).json({ok:false,error:"RISK_SIZING_DATA_UNAVAILABLE",message:"Broker did not provide verified monetary tick data required for automatic risk sizing. No order was submitted.",analysis,risk});
        const riskAmount=equity*(requestedRiskPct/100);
        const entryPrice=side==="BUY"?ask:bid;
        const stopDistance=Math.abs(entryPrice-stopLoss);
        const rawVolume=riskAmount/((stopDistance/tickSize)*tickValue);
        const steppedVolume=Math.floor(rawVolume/volumeStep)*volumeStep;
        const volume=Number(steppedVolume.toFixed(12));
        if(!Number.isFinite(volume)||volume<minVolume||volume>maxVolume)return res.status(400).json({ok:false,error:"RISK_SIZED_VOLUME_OUT_OF_RANGE",message:"Calculated risk-based volume is outside broker limits. No order was submitted.",calculatedVolume:volume,minVolume,maxVolume,volumeStep,analysis,risk});
        const stepAligned=Math.abs((volume-minVolume)/volumeStep-Math.round((volume-minVolume)/volumeStep))<1e-9;
        if(!stepAligned)return res.status(400).json({ok:false,error:"INVALID_CALCULATED_VOLUME_STEP",message:"Calculated volume does not satisfy the broker volume step. No order was submitted.",calculatedVolume:volume,volumeStep,analysis,risk});
        if(!Number.isFinite(point)||point<=0||!Number.isFinite(stopsLevel)||stopsLevel<0)return res.status(503).json({ok:false,error:"INVALID_STOP_CONSTRAINTS",message:"Broker stop-distance constraints could not be verified. No order was submitted.",analysis,risk});
        const minDistance=stopsLevel*point;
        if(stopLoss!=null){
          if(stopLoss<=0|| (side==="BUY" && stopLoss>=bid) || (side==="SELL" && stopLoss<=ask) || Math.abs((side==="BUY"?bid:ask)-stopLoss)<minDistance)return res.status(400).json({ok:false,error:"INVALID_STOP_LOSS",message:"Stop loss violates broker-side price direction or minimum distance. No order was submitted.",analysis,risk});
        }
        if(takeProfit!=null){
          if(takeProfit<=0|| (side==="BUY" && takeProfit<=ask) || (side==="SELL" && takeProfit>=bid) || Math.abs(takeProfit-(side==="BUY"?ask:bid))<minDistance)return res.status(400).json({ok:false,error:"INVALID_TAKE_PROFIT",message:"Take profit violates broker-side price direction or minimum distance. No order was submitted.",analysis,risk});
        }
        if(symbolPositions.length>=s.maxPositions)return res.status(409).json({ok:false,error:"MAX_SYMBOL_POSITIONS",message:"Maximum positions for this symbol are already open. No order was submitted.",analysis,risk});
        const clientId="kb_"+crypto.randomUUID();
        const journal=await pool.query("INSERT INTO kingbot_execution_journal(user_id,bot_id,client_id,execution_mode,symbol,side,volume,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',NOW()) ON CONFLICT(client_id) DO NOTHING RETURNING id",[user.id,b.id,clientId,s.executionMode,analysis.market.symbol,side,volume]);
        if(!journal.rowCount)return res.status(409).json({ok:false,error:"DUPLICATE_EXECUTION_REQUEST",message:"Duplicate execution request blocked. No order was submitted.",analysis,risk});
        try{
          await broker.assertExecutionAuthorized(user.id);
          order=await broker.placeOrder({side,symbol:analysis.market.symbol,volume,stopLoss,takeProfit,comment:"KINGBOT",clientId,userId:user.id});
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
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_risk_state (user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,bot_id TEXT NOT NULL,baseline_date DATE NOT NULL,day_start_equity NUMERIC NOT NULL,peak_equity NUMERIC NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(user_id,bot_id))");
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_account_risk_state (user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,provider TEXT NOT NULL,account_id TEXT NOT NULL,baseline_date DATE NOT NULL,day_start_equity NUMERIC NOT NULL,peak_equity NUMERIC NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(user_id,provider,account_id))");
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_execution_journal (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,bot_id TEXT NOT NULL,client_id TEXT NOT NULL UNIQUE,execution_mode TEXT NOT NULL,symbol TEXT NOT NULL,side TEXT NOT NULL,volume NUMERIC NOT NULL,status TEXT NOT NULL,broker_result JSONB,error_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_bot_runtime (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,bot_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'STOPPED',last_signal JSONB,last_run_at TIMESTAMPTZ,last_error TEXT,symbol TEXT,timeframe TEXT DEFAULT '5m',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(user_id,bot_id))");
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_user_bot_selection (user_id UUID PRIMARY KEY REFERENCES kingbot_users(id) ON DELETE CASCADE,selected_bot_id TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_ladder_v8_state (user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,bot_id TEXT NOT NULL,symbol TEXT NOT NULL,timeframe TEXT NOT NULL DEFAULT '5m',active BOOLEAN NOT NULL DEFAULT FALSE,direction SMALLINT NOT NULL DEFAULT 0,anchor_price NUMERIC,initial_stop_distance NUMERIC,step_price NUMERIC,lock_level INTEGER NOT NULL DEFAULT 0,last_lock_price NUMERIC,last_pyramid_price NUMERIC,rungs_opened INTEGER NOT NULL DEFAULT 0,aggressive_entry BOOLEAN NOT NULL DEFAULT FALSE,position_ids JSONB NOT NULL DEFAULT '[]'::jsonb,rung_lots JSONB NOT NULL DEFAULT '[]'::jsonb,velocity_samples JSONB NOT NULL DEFAULT '[]'::jsonb,cycle_id TEXT,last_action TEXT,last_action_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(user_id,bot_id))");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS symbol TEXT");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS timeframe TEXT DEFAULT '5m'");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS lot_scale NUMERIC NOT NULL DEFAULT 1");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS deriv_contract_type TEXT");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS deriv_multiplier NUMERIC");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS locked_profits JSONB NOT NULL DEFAULT '[]'::jsonb");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT FALSE");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS direction SMALLINT NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS anchor_price NUMERIC");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS initial_stop_distance NUMERIC");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS step_price NUMERIC");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS lock_level INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS last_lock_price NUMERIC");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS last_pyramid_price NUMERIC");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS rungs_opened INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS aggressive_entry BOOLEAN NOT NULL DEFAULT FALSE");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS position_ids JSONB NOT NULL DEFAULT '[]'::jsonb");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS rung_lots JSONB NOT NULL DEFAULT '[]'::jsonb");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS velocity_samples JSONB NOT NULL DEFAULT '[]'::jsonb");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS cycle_id TEXT");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS last_action TEXT");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS last_action_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE kingbot_ladder_v8_state ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");

  await pool.query("ALTER TABLE kingbot_bot_runtime ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'STOPPED'");
  await pool.query("ALTER TABLE kingbot_bot_runtime ADD COLUMN IF NOT EXISTS last_signal JSONB");
  await pool.query("ALTER TABLE kingbot_bot_runtime ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE kingbot_bot_runtime ADD COLUMN IF NOT EXISTS last_error TEXT");
  await pool.query("ALTER TABLE kingbot_bot_runtime ADD COLUMN IF NOT EXISTS symbol TEXT");
  await pool.query("ALTER TABLE kingbot_bot_runtime ADD COLUMN IF NOT EXISTS timeframe TEXT DEFAULT '5m'");
  await pool.query("ALTER TABLE kingbot_bot_runtime ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
}
