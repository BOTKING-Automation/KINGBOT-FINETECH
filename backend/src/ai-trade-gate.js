import { GoogleGenAI } from "@google/genai";
import { getBotDefinitions } from "./bot-engines.js";

const MODEL = process.env.GEMINI_TRADE_MODEL || process.env.GEMINI_MODEL || "gemini-3.8-flash";
const API_KEY = String(process.env.GEMINI_API_KEY || "").trim();
const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

const signalCache = new Map();
const inflight = new Map();
const COOLDOWN_MS = Math.max(1500, Number(process.env.GEMINI_TRADE_COOLDOWN_MS || 2500));
const TTL_MS = Math.max(4000, Number(process.env.GEMINI_TRADE_SIGNAL_TTL_MS || 6500));

// AI is a strategy supervisor by default, not a single point of failure for execution.
// Set GEMINI_EXECUTION_GATE=1 (or "gated") when an installation explicitly wants
// Gemini confirmation to be mandatory before the deterministic engine may submit.
export function aiExecutionGateEnabled(){
  const mode=String(process.env.GEMINI_EXECUTION_GATE||"advisory").trim().toLowerCase();
  return mode==="1"||mode==="true"||mode==="gated";
}

const STRATEGY_PROFILES = {
  strategic: {
    mode: "multi-strategy",
    objective: "Select only a clear directional opportunity when trend, momentum, structure, volatility regime and mean-reversion context agree.",
    rules: ["trend-following", "mean-reversion", "volatility-regime", "multi-factor-consensus"]
  },
  flipper: {
    mode: "high-speed-flipping",
    objective: "Detect short-horizon impulse continuation or rapid reversal while rejecting poor spread and unstable conditions.",
    rules: ["micro-momentum", "impulse-continuation", "rapid-reversal", "spread-filter"]
  },
  breakout: {
    mode: "breakout-momentum",
    objective: "Trade only meaningful range/level breaks with volatility confirmation and preferably a valid retest.",
    rules: ["range-compression", "level-breakout", "volatility-confirmation", "retest-continuation"]
  },
  "smc-pro": {
    mode: "smart-money-concepts",
    objective: "Require a coherent market-structure and liquidity sequence, with displacement plus order-block/fair-value-gap context where supplied.",
    rules: ["market-structure", "liquidity-sweep", "order-block", "fair-value-gap", "displacement"]
  },
  "ladder-flip": {
    mode: "v8-adaptive-ladder",
    objective: "Identify a directional V8 entry that can safely initiate the ladder; preserve the engine's EMA20/EMA50, ADX14, RSI14, spread, velocity and risk gates.",
    rules: ["ema20-50-trend-gate", "adx-strength-gate", "rsi-confirmation", "velocity-pyramiding", "staircase-profit-lock", "risk-governor"]
  }
};

const SIGNAL_SCHEMA = {
  type: "object",
  properties: {
    engine: { type: "string" },
    direction: { type: "string" },
    strategyMatch: { type: "boolean" },
    trigger: { type: "string" },
    riskFlags: { type: "array", items: { type: "string" } },
    reason: { type: "string" }
  },
  required: ["engine", "direction", "strategyMatch", "trigger", "riskFlags", "reason"]
};

const SYSTEM = `You are the KINGBOT strategy intelligence engine.
Your job is to understand the specified bot engine and produce a strategy-specific market signal.

Hard rules:
- The supplied market snapshot and deterministic analysis are the only market facts you may use.
- Never invent price, spread, candle, broker, account, position, or risk data.
- You must target EXACTLY the supplied engine id. Do not route a signal to another engine.
- Learn the strategy from the supplied strategy profile and bot definition. Do not use a generic trading strategy in its place.
- Return BUY, SELL, or HOLD only.
- If the strategy conditions are not sufficiently aligned, return HOLD.
- strategyMatch must be true only when the setup actually fits the supplied engine.
- Do not set stop loss, take profit, stake, leverage, lot size, or broker parameters. Those remain deterministic engine/risk-engine responsibilities.
- Keep trigger and reason concise and factual.
Return JSON only.`;

function safeJson(value){
  try{return JSON.parse(String(value||"").trim());}catch{return null;}
}

function keyFor(userId,botId){
  return String(userId)+":"+String(botId);
}

function directionFromCandidate(signal){
  return signal==="LONG_CANDIDATE"?"BUY":signal==="SHORT_CANDIDATE"?"SELL":null;
}

function snapshotFingerprint({botId,market,analysis}={}){
  // Do not fingerprint raw bid/ask/price: those change every tick and would defeat
  // the short-lived AI cache. Deterministic validation still runs on every worker cycle.
  const atr=Math.max(Number(market?.atr||0),1e-12);
  const price=Number(market?.price||0);
  const priceBucket=Math.round(price/(atr*0.20));
  const spreadBucket=Math.round(Number(market?.spread||0)/(atr*0.05));
  return JSON.stringify({
    botId,
    symbol:market?.symbol,
    timeframe:market?.timeframe,
    priceBucket,
    spreadBucket,
    atr:Number(market?.atr||0),
    volatility:Number(market?.volatility||0),
    trend:Number(market?.trend||0),
    momentum:Number(market?.momentum||0),
    structure:String(market?.structure||""),
    liquiditySweep:Boolean(market?.liquiditySweep),
    orderBlock:Boolean(market?.orderBlock),
    fairValueGap:Boolean(market?.fairValueGap),
    displacement:Boolean(market?.displacement),
    breakout:Boolean(market?.breakout),
    retest:Boolean(market?.retest),
    volume:Number(market?.volume||0),
    adx:Number(market?.adx||0),
    rsi:Number(market?.rsi||0),
    emaFast:Number(market?.emaFast||0),
    emaSlow:Number(market?.emaSlow||0),
    velocityPoints:Number(market?.velocityPoints||0),
    deterministicSignal:String(analysis?.signal||"NO_SIGNAL"),
    deterministicScoreBucket:Math.round(Number(analysis?.score||0)/2),
    deterministicReason:String(analysis?.reason||""),
    multiTimeframe:compactTimeframeFingerprint(market?.multiTimeframe)
  });
}

function compactTimeframeFingerprint(value){
  const clean=(item)=>item?({
    timeframe:item.timeframe,
    available:Boolean(item.available),
    trend:Number(item.trend||0),
    momentum:Number(item.momentum||0),
    volatility:Number(item.volatility||0),
    structure:String(item.structure||""),
    adx:Number(item.adx||0),
    rsi:Number(item.rsi||0),
    emaFast:Number(item.emaFast||0),
    emaSlow:Number(item.emaSlow||0),
    breakout:Boolean(item.breakout),
    retest:Boolean(item.retest)
  }):null;
  return {
    profile:value?.profile||null,
    regime:clean(value?.regime),
    setup:clean(value?.setup),
    execution:clean(value?.execution)
  };
}

function normalizeSignal({botId,parsed}={}){
  const direction=["BUY","SELL","HOLD"].includes(parsed?.direction) ? parsed.direction : "HOLD";
  const engine=String(parsed?.engine||"");
  return {
    engine,
    direction,
    strategyMatch:Boolean(parsed?.strategyMatch),
    trigger:String(parsed?.trigger||"NO_VALID_SETUP").slice(0,140),
    riskFlags:Array.isArray(parsed?.riskFlags)
      ? parsed.riskFlags.slice(0,8).map(x=>String(x).slice(0,100))
      : [],
    reason:String(parsed?.reason||"No strategy-specific signal.").slice(0,260),
    engineAccepted:engine===String(botId),
    at:Date.now()
  };
}

export function getAiStrategySignal({userId,botId,market,analysis}={}){
  if(!ai||!userId||!botId||!analysis)return null;
  const item=signalCache.get(keyFor(userId,botId));
  if(!item)return null;
  if(Date.now()-item.at>TTL_MS)return null;
  const fingerprint=snapshotFingerprint({botId,market,analysis});
  if(item.fingerprint!==fingerprint)return null;
  return item;
}

export async function warmAiStrategySignal({userId,botId,market,analysis,risk,tradePlan}={}){
  if(!ai||!userId||!botId||!analysis)return null;
  const profile=STRATEGY_PROFILES[botId];
  const bot=getBotDefinitions()[botId];
  if(!profile||!bot)return null;

  const key=keyFor(userId,botId);
  const now=Date.now();
  const cached=signalCache.get(key);
  if(cached && now-cached.at<COOLDOWN_MS && cached.fingerprint===snapshotFingerprint({botId,market,analysis})) return cached;
  if(inflight.has(key)) return inflight.get(key);

  const marketPayload={
    symbol:market?.symbol,
    timeframe:market?.timeframe,
    price:Number(market?.price||0),
    bid:Number(market?.bid||0),
    ask:Number(market?.ask||0),
    spread:Number(market?.spread||0),
    atr:Number(market?.atr||0),
    volatility:Number(market?.volatility||0),
    trend:Number(market?.trend||0),
    momentum:Number(market?.momentum||0),
    volume:Number(market?.volume||0),
    structure:String(market?.structure||""),
    liquiditySweep:Boolean(market?.liquiditySweep),
    orderBlock:Boolean(market?.orderBlock),
    fairValueGap:Boolean(market?.fairValueGap),
    displacement:Boolean(market?.displacement),
    breakout:Boolean(market?.breakout),
    retest:Boolean(market?.retest),
    adx:Number(analysis?.adx14||market?.adx||0),
    rsi:Number(analysis?.rsi14||market?.rsi||0),
    emaFast:Number(analysis?.ema20||market?.emaFast||0),
    emaSlow:Number(analysis?.ema50||market?.emaSlow||0),
    velocityPoints:Number(analysis?.velocityPoints||market?.velocityPoints||0),
    multiTimeframe:compactTimeframeFingerprint(market?.multiTimeframe)
  };

  const aiInput={
    engine:botId,
    strategyProfile:profile,
    timeframeProfile:bot.timeframeProfile||{},
    botDefinition:{
      name:bot.name,
      mode:bot.mode,
      signalThreshold:bot.signalThreshold,
      strategies:bot.strategies,
      tradePlan:bot.tradePlan,
      risk:bot.risk,
      v8:bot.v8||null
    },
    deterministicAnalysis:analysis,
    market:marketPayload,
    risk:risk||{},
    tradePlan:tradePlan||null
  };

  const prompt=`TARGET ENGINE: ${botId}
TIMEFRAME PROFILE: ${JSON.stringify(bot.timeframeProfile || {})}
STRATEGY PROFILE:
${JSON.stringify(profile)}

BOT DEFINITION:
${JSON.stringify(aiInput.botDefinition)}

LIVE MARKET + ENGINE FEATURES:
${JSON.stringify(marketPayload)}

DETERMINISTIC ENGINE ANALYSIS:
${JSON.stringify(analysis)}

RISK CONTEXT:
${JSON.stringify(risk||{})}

TRADE PLAN CONTEXT:
${JSON.stringify(tradePlan||null)}

Produce the next strategy-specific signal for TARGET ENGINE ${botId}. The signal is a candidate for that engine, not permission to bypass deterministic validation or risk controls.`;

  const run=(async()=>{
    try{
      const response=await ai.models.generateContent({
        model:MODEL,
        contents:prompt,
        config:{
          systemInstruction:SYSTEM,
          maxOutputTokens:220,
          responseMimeType:"application/json",
          responseSchema:SIGNAL_SCHEMA,
          thinkingConfig:{thinkingLevel:"low"}
        }
      });
      const parsed=safeJson(response.text);
      const item={
        ...normalizeSignal({botId,parsed}),
        fingerprint:snapshotFingerprint({botId,market,analysis}),
        expiresAt:Date.now()+TTL_MS,
        model:MODEL
      };
      signalCache.set(key,item);
      return item;
    }catch(error){
      console.error("[KINGBOT AI SIGNAL]",error?.message||error);
      const item={
        engine:botId,
        direction:"HOLD",
        strategyMatch:false,
        trigger:"AI_UNAVAILABLE",
        riskFlags:["AI_SIGNAL_UNAVAILABLE"],
        reason:"Gemini strategy signal unavailable; deterministic engine remains authoritative unless AI execution gating is explicitly enabled.",
        engineAccepted:true,
        fingerprint:snapshotFingerprint({botId,market,analysis}),
        at:Date.now(),
        expiresAt:Date.now()+2000,
        model:MODEL
      };
      signalCache.set(key,item);
      return item;
    }finally{
      inflight.delete(key);
    }
  })();

  inflight.set(key,run);
  return run;
}

export function routeAiSignalToEngine({botId,signal,candidateSignal}={}){
  const target=String(botId||"");
  const direction=String(signal?.direction||"HOLD");
  const candidateDirection=directionFromCandidate(candidateSignal);
  const engineAccepted=Boolean(signal?.engineAccepted)&&String(signal?.engine||"")===target;
  const strategyAccepted=Boolean(signal?.strategyMatch);
  const directionAccepted=!candidateDirection||candidateDirection===direction;
  const confirm=engineAccepted&&strategyAccepted&&direction!=="HOLD"&&directionAccepted;
  let status="AI_CONFIRMATION_REJECTED";
  if(confirm)status="AI_ENGINE_SIGNAL_CONFIRMED";
  else if(direction==="HOLD"||!signal)status="AI_SIGNAL_HOLD";
  else if(!engineAccepted)status="AI_ENGINE_ROUTE_MISMATCH";
  else if(!strategyAccepted)status="AI_STRATEGY_MISMATCH";
  else if(!directionAccepted)status="AI_ENGINE_DIRECTION_MISMATCH";
  return {
    ...(signal||{}),
    confirm,
    status,
    candidateDirection:candidateDirection||null
  };
}

// Backward-compatible exports used by older worker code.
export function getAiTradeConfirmation({userId,botId,signal,market,analysis}={}){
  const aiSignal=getAiStrategySignal({userId,botId,market,analysis});
  if(!aiSignal)return null;
  return routeAiSignalToEngine({botId,signal:aiSignal,candidateSignal:signal});
}

export async function warmAiTradeConfirmation({userId,botId,signal,market,analysis,risk,tradePlan}={}){
  const aiSignal=await warmAiStrategySignal({userId,botId,market,analysis,risk,tradePlan});
  if(!aiSignal)return null;
  return routeAiSignalToEngine({botId,signal:aiSignal,candidateSignal:signal});
}

export function aiTradeGateStatus({userId,botId}={}){
  const item=signalCache.get(keyFor(userId,botId));
  if(!item)return {ready:false};
  return {
    ready:Date.now()-item.at<=TTL_MS,
    engine:item.engine,
    direction:item.direction,
    strategyMatch:Boolean(item.strategyMatch),
    engineAccepted:Boolean(item.engineAccepted),
    trigger:item.trigger,
    reason:item.reason,
    riskFlags:item.riskFlags||[],
    expiresAt:item.expiresAt,
    model:item.model
  };
}
