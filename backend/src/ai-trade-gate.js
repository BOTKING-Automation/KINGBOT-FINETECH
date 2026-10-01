import { GoogleGenAI } from "@google/genai";

const MODEL = process.env.GEMINI_TRADE_MODEL || process.env.GEMINI_MODEL || "gemini-3.8-flash";
const API_KEY = String(process.env.GEMINI_API_KEY || "").trim();
const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

const cache = new Map();
const inflight = new Map();
const COOLDOWN_MS = Math.max(1500, Number(process.env.GEMINI_TRADE_COOLDOWN_MS || 4000));
const TTL_MS = Math.max(4000, Number(process.env.GEMINI_TRADE_CONFIRM_TTL_MS || 8000));

const SYSTEM = `You are KINGBOT's real-time trade confirmation engine.
You NEVER invent prices or broker state.
You ONLY evaluate the supplied deterministic strategy result and market snapshot.
Confirm only when the deterministic strategy is already a valid entry candidate.
Return JSON only:
{"decision":"BUY|SELL|HOLD","confirm":true|false,"strategyMatch":true|false,"riskFlags":["..."],"reason":"..."}
A confirmation is valid only when decision matches the supplied candidate direction and there is no obvious strategy contradiction.
Do not change the supplied stop loss, take profit, stake, or risk limits.`;

function safeJson(value){
  try{return JSON.parse(String(value||"").trim());}catch{return null;}
}

function keyFor(userId,botId){
  return String(userId)+":"+String(botId);
}

function candidateFingerprint({botId,signal,market,analysis}={}){
  const direction=signal==="LONG_CANDIDATE"?"BUY":signal==="SHORT_CANDIDATE"?"SELL":"HOLD";
  return JSON.stringify({
    botId,
    direction,
    symbol:market?.symbol,
    timeframe:market?.timeframe,
    score:Number(analysis?.score||0),
    price:Number(market?.price||0),
    atr:Number(market?.atr||0),
    trend:Number(market?.trend||0),
    momentum:Number(market?.momentum||0),
    structure:String(market?.structure||""),
    adx:Number(market?.adx||0),
    rsi:Number(market?.rsi||0),
    emaFast:Number(market?.emaFast||0),
    emaSlow:Number(market?.emaSlow||0)
  });
}

export function getAiTradeConfirmation({userId,botId,signal,market,analysis}={}){
  if(!ai||!userId||!botId||!analysis||signal==="NO_SIGNAL") return null;
  const key=keyFor(userId,botId);
  const item=cache.get(key);
  if(!item) return null;
  if(Date.now()-item.at>TTL_MS) return null;
  const fingerprint=candidateFingerprint({botId,signal,market,analysis});
  if(item.fingerprint!==fingerprint) return null;
  return item;
}

export async function warmAiTradeConfirmation({userId,botId,signal,market,analysis,risk,tradePlan}={}){
  if(!ai||!userId||!botId||!analysis||signal==="NO_SIGNAL") return null;
  const candidate=Math.abs(Number(analysis.score||0));
  const threshold=Math.abs(Number(analysis.threshold||0));
  if(candidate < Math.max(60,threshold-10)) return null;

  const key=keyFor(userId,botId);
  const now=Date.now();
  const cached=cache.get(key);
  if(cached && now-cached.at<COOLDOWN_MS && cached.signal===signal) return cached;
  if(inflight.has(key)) return inflight.get(key);

  const marketPayload={
    symbol:market?.symbol,
    timeframe:market?.timeframe,
    price:Number(market?.price||0),
    bid:Number(market?.bid||0),
    ask:Number(market?.ask||0),
    atr:Number(market?.atr||0),
    volatility:Number(market?.volatility||0),
    trend:Number(market?.trend||0),
    momentum:Number(market?.momentum||0),
    structure:String(market?.structure||""),
    adx:Number(analysis?.adx14||market?.adx||0),
    rsi:Number(analysis?.rsi14||market?.rsi||0),
    emaFast:Number(analysis?.ema20||market?.emaFast||0),
    emaSlow:Number(analysis?.ema50||market?.emaSlow||0),
    velocityPoints:Number(analysis?.velocityPoints||market?.velocityPoints||0)
  };
  const direction=signal==="LONG_CANDIDATE"?"BUY":"SELL";
  const prompt=`BOT: ${botId}
CANDIDATE: ${direction}
ANALYSIS: ${JSON.stringify(analysis)}
MARKET: ${JSON.stringify(marketPayload)}
RISK: ${JSON.stringify(risk||{})}
TRADE PLAN: ${JSON.stringify(tradePlan||{})}
Confirm whether the candidate direction is consistent with the supplied strategy and market facts. Do not invent missing facts.`;

  const run=(async()=>{
    try{
      const response=await ai.models.generateContent({
        model:MODEL,
        contents:prompt,
        config:{
          systemInstruction:SYSTEM,
          maxOutputTokens:220,
          responseMimeType:"application/json",
          thinkingConfig:{thinkingLevel:"low"}
        }
      });
      const parsed=safeJson(response.text);
      const decision=parsed?.decision==="BUY"||parsed?.decision==="SELL"?parsed.decision:"HOLD";
      const confirm=Boolean(parsed?.confirm)&&Boolean(parsed?.strategyMatch)&&decision===direction;
      const item={
        signal,
        decision,
        confirm,
        strategyMatch:Boolean(parsed?.strategyMatch),
        riskFlags:Array.isArray(parsed?.riskFlags)?parsed.riskFlags.slice(0,6).map(x=>String(x).slice(0,80)):[],
        reason:String(parsed?.reason||"Gemini confirmation completed.").slice(0,220),
        fingerprint:candidateFingerprint({botId,signal,market:{...marketPayload,price:marketPayload.price},analysis}),
        at:Date.now(),
        expiresAt:Date.now()+TTL_MS,
        model:MODEL
      };
      cache.set(key,item);
      return item;
    }catch(error){
      console.error("[KINGBOT AI TRADE GATE]",error?.message||error);
      const item={
        signal,
        decision:"HOLD",
        confirm:false,
        strategyMatch:false,
        riskFlags:["AI_CONFIRMATION_UNAVAILABLE"],
        reason:"Gemini confirmation unavailable; execution remains blocked until a fresh confirmation is available.",
        fingerprint:candidateFingerprint({botId,signal,market:marketPayload,analysis}),
        at:Date.now(),
        expiresAt:Date.now()+2000,
        model:MODEL
      };
      cache.set(key,item);
      return item;
    }finally{
      inflight.delete(key);
    }
  })();

  inflight.set(key,run);
  return run;
}

export function aiTradeGateStatus({userId,botId}={}){
  const key=keyFor(userId,botId);
  const item=cache.get(key);
  if(!item)return {ready:false};
  return {
    ready:Date.now()-item.at<=TTL_MS,
    confirm:Boolean(item.confirm),
    decision:item.decision,
    signal:item.signal,
    reason:item.reason,
    riskFlags:item.riskFlags||[],
    expiresAt:item.expiresAt,
    model:item.model
  };
}
