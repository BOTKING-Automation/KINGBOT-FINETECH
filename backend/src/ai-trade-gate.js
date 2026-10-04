/*
 * KINGBOT CORTEX TRADE GATE
 * Backward-compatible API; no external AI dependency.
 * The deterministic strategy engine and risk engine remain authoritative.
 */
import { getBotDefinitions } from "./bot-engines.js";
import { predictMlStrategySignal, mlSignalServiceStatus } from "./ml-signal-client.js";

const MODEL = "KINGBOT-CORTEX-1";
const signalCache = new Map();
const inflight = new Map();
const COOLDOWN_MS = Math.max(1500, Number(process.env.KINGBOT_CORTEX_COOLDOWN_MS || 2500));
const TTL_MS = Math.max(4000, Number(process.env.KINGBOT_CORTEX_SIGNAL_TTL_MS || 6500));

const STRATEGY_PROFILES = {
  strategic: { rules:["trend","momentum","structure","volatility"] },
  flipper: { rules:["momentum","velocity","spread","reversal"] },
  breakout: { rules:["breakout","retest","volatility","momentum"] },
  "smc-pro": { rules:["structure","liquiditySweep","displacement","orderBlock","fairValueGap"] },
  "ladder-flip": { rules:["ema","adx","rsi","velocity","spread"] }
};

const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const upper=v=>String(v||"").toUpperCase();
const candidateDirection=v=>{
  const s=upper(v);
  return s==="LONG_CANDIDATE"||s==="BUY"?"BUY":s==="SHORT_CANDIDATE"||s==="SELL"?"SELL":null;
};
const keyFor=(userId,botId)=>String(userId)+":"+String(botId);

function snapshotFingerprint({botId,market,analysis}={}){
  const atr=Math.max(num(market?.atr),1e-12);
  const price=num(market?.price);
  return JSON.stringify({
    botId,symbol:market?.symbol,timeframe:market?.timeframe,
    priceBucket:Math.round(price/(atr*.2)),
    spreadBucket:Math.round(num(market?.spread)/(atr*.05)),
    atr:num(market?.atr),volatility:num(market?.volatility),trend:num(market?.trend),
    momentum:num(market?.momentum),structure:String(market?.structure||""),
    liquiditySweep:Boolean(market?.liquiditySweep),orderBlock:Boolean(market?.orderBlock),
    fairValueGap:Boolean(market?.fairValueGap),displacement:Boolean(market?.displacement),
    breakout:Boolean(market?.breakout),retest:Boolean(market?.retest),
    adx:num(market?.adx),rsi:num(market?.rsi),emaFast:num(market?.emaFast),
    emaSlow:num(market?.emaSlow),velocityPoints:num(market?.velocityPoints),
    deterministicSignal:String(analysis?.signal||"NO_SIGNAL"),
    deterministicScore:num(analysis?.score),
    reason:String(analysis?.reason||"")
  });
}

function directionFromMarket(market={},analysis={}){
  const trend=num(market.trend);
  const momentum=num(market.momentum);
  const score=trend*.55+momentum*.45;
  if(score>.10)return "BUY";
  if(score<-.10)return "SELL";
  const s=candidateDirection(analysis.signal);
  return s||"HOLD";
}

function evaluateNativeSignal({botId,market={},analysis={},risk={}}={}){
  const profile=STRATEGY_PROFILES[botId];
  const bot=getBotDefinitions()[botId];
  if(!profile||!bot)return null;

  const direction=directionFromMarket(market,analysis);
  const dir=direction==="BUY"?1:direction==="SELL"?-1:0;
  const trend=num(market.trend), momentum=num(market.momentum), velocity=num(market.velocityPoints);
  const spread=num(market.spread), atr=Math.max(num(market.atr),1e-12);
  const spreadRatio=Math.abs(spread)/atr;
  const rsi=num(market.rsi), adx=num(market.adx), fast=num(market.emaFast), slow=num(market.emaSlow);
  const tests=[];

  if(botId==="strategic"){
    tests.push(["trend",Math.abs(trend)>=.35,Math.abs(trend)*25]);
    tests.push(["momentum",Math.sign(momentum)===dir&&Math.abs(momentum)>=.30,Math.abs(momentum)*20]);
    tests.push(["structure",["bullish","bearish"].includes(String(market.structure||"").toLowerCase()),10]);
    tests.push(["volatility",num(market.volatility)>0&&num(market.volatility)<.90,10]);
  } else if(botId==="flipper"){
    tests.push(["momentum",Math.sign(momentum)===dir&&Math.abs(momentum)>=.45,20]);
    tests.push(["velocity",Math.sign(velocity)===dir&&Math.abs(velocity)>=.20,22]);
    tests.push(["spread",spreadRatio<=.20,18]);
    tests.push(["directional trend",Math.sign(trend)===dir||Math.abs(trend)<.20,15]);
  } else if(botId==="breakout"){
    tests.push(["breakout",Boolean(market.breakout)&&Math.sign(trend||momentum)===dir,28]);
    tests.push(["retest",Boolean(market.retest),20]);
    tests.push(["volatility",num(market.volatility)>=.35,16]);
    tests.push(["momentum",Math.sign(momentum)===dir&&Math.abs(momentum)>=.30,16]);
  } else if(botId==="smc-pro"){
    tests.push(["structure",String(market.structure||"").toLowerCase()===(dir>0?"bullish":"bearish"),24]);
    tests.push(["liquidity sweep",Boolean(market.liquiditySweep),18]);
    tests.push(["displacement",Boolean(market.displacement),18]);
    tests.push(["order block/FVG",Boolean(market.orderBlock||market.fairValueGap),15]);
  } else if(botId==="ladder-flip"){
    tests.push(["EMA trend",fast>0&&slow>0&&((fast>slow&&dir>0)||(fast<slow&&dir<0)),23]);
    tests.push(["ADX",adx>=18,18]);
    tests.push(["RSI",rsi>0&&((dir>0&&rsi>=52&&rsi<=72)||(dir<0&&rsi<=48&&rsi>=28)),17]);
    tests.push(["velocity",Math.sign(velocity)===dir&&Math.abs(velocity)>=.10,16]);
    tests.push(["spread",spreadRatio<=.25,12]);
  }

  const evidence=tests.filter(x=>x[1]).map(x=>x[0]);
  const score=Math.round(tests.length?tests.reduce((s,x)=>s+(x[1]?x[2]:0),0)/tests.reduce((s,x)=>s+x[2],0)*100:0);
  const baseline=Number(analysis?.score||0);
  const strategyMatch=dir!==0&&score>=65&&baseline>=50&&!(risk?.blocks||[]).length;
  const signal=dir===0||!strategyMatch?"HOLD":direction;
  const flags=[];
  if((risk?.blocks||[]).length)flags.push(...risk.blocks.map(String));
  if(spreadRatio>.25)flags.push("SPREAD_ELEVATED");
  if(score<65)flags.push("STRATEGY_ALIGNMENT_BELOW_CORTEX_THRESHOLD");
  if(baseline<50)flags.push("DETERMINISTIC_BASELINE_BELOW_THRESHOLD");

  return {
    engine:botId,
    direction:signal,
    strategyMatch,
    trigger:evidence.length?evidence.join(" + "):"NO_VALID_SETUP",
    riskFlags:flags.slice(0,8),
    reason:(strategyMatch?"CORTEX strategy alignment confirmed from deterministic features. ":"CORTEX rejected the candidate because alignment is insufficient. ")+"Evidence: "+(evidence.join(", ")||"none")+".",
    engineAccepted:true,
    score,
    evidence,
    at:Date.now(),
    expiresAt:Date.now()+TTL_MS,
    model:MODEL,
    source:"KINGBOT_CORTEX"
  };
}

export function aiExecutionGateEnabled(){
  // The legacy environment variable is intentionally ignored. KINGBOT Cortex
  // is advisory and deterministic execution/risk controls remain authoritative.
  return false;
}

export function getAiStrategySignal({userId,botId,market,analysis}={}){
  if(!userId||!botId||!analysis)return null;
  const item=signalCache.get(keyFor(userId,botId));
  if(!item||Date.now()-item.at>TTL_MS)return null;
  if(item.fingerprint!==snapshotFingerprint({botId,market,analysis}))return null;
  return item;
}

export async function warmAiStrategySignal({userId,botId,market,analysis,risk}={}){
  if(!userId||!botId||!analysis)return null;
  const fingerprint=snapshotFingerprint({botId,market,analysis});
  const key=keyFor(userId,botId);
  const cached=signalCache.get(key);
  if(cached&&Date.now()-cached.at<COOLDOWN_MS&&cached.fingerprint===fingerprint)return cached;
  if(inflight.has(key))return inflight.get(key);

  const run=(async()=>{
    const native=evaluateNativeSignal({botId,market,analysis,risk})||{};
    const ml=await predictMlStrategySignal({botId,market});
    let item={...native,fingerprint};

    if(ml?.ready){
      const nativeDirection=candidateDirection(native.direction)||candidateDirection(analysis?.signal);
      const mlDirection=candidateDirection(ml.direction);
      const mlScore=num(ml.score,0);
      const nativeScore=num(native.score,0);
      const combinedScore=Math.round(nativeScore*0.60+mlScore*0.40);
      const directionAgreement=!nativeDirection||!mlDirection||nativeDirection===mlDirection;
      const mlConfidence=num(ml.confidence,0);
      const modelAligned=Boolean(mlDirection)&&mlDirection!=="HOLD"&&mlConfidence>=55&&directionAgreement;
      const directionalSignal=modelAligned?mlDirection:"HOLD";

      item={
        ...item,
        direction:directionalSignal,
        strategyMatch:Boolean(native.strategyMatch)&&modelAligned&&Math.abs(combinedScore)>=65,
        trigger:[
          native.trigger||"NATIVE_STRATEGY",
          "ML="+String(mlDirection||"HOLD"),
          "ML_CONF="+mlConfidence.toFixed(1)
        ].join(" + "),
        score:combinedScore,
        nativeScore,
        mlScore,
        mlConfidence,
        mlProbabilities:ml.probabilities||null,
        mlModelKey:ml.modelKey||null,
        mlModels:ml.models||null,
        mlStatus:ml.status||"LIVE_ML_SIGNAL",
        source:"KINGBOT_CORTEX+SCIKIT_LEARN+PYTORCH",
        model:"KINGBOT-CORTEX-1+ML-ENSEMBLE",
        reason:(modelAligned
          ? "AI STRATEGIES combined the deterministic strategy engine with the scikit-learn/PyTorch ensemble; both layers support the current direction. "
          : "AI STRATEGIES kept the candidate on hold because the ML ensemble did not provide sufficient confidence/alignment. ")
          +"Native score="+nativeScore+"/100; ML score="+mlScore.toFixed(1)+"/100."
      };
    }else if(ml?.status==="ML_SERVICE_UNAVAILABLE"){
      item={...item,mlStatus:"SERVICE_UNAVAILABLE",source:"KINGBOT_CORTEX",mlError:ml.error||null};
    }else if(ml?.status==="MODEL_NOT_READY"){
      item={...item,mlStatus:"MODEL_NOT_READY",source:"KINGBOT_CORTEX",mlModelKey:ml.modelKey||null};
    }

    signalCache.set(key,item);
    return item;
  })().finally(()=>inflight.delete(key));

  inflight.set(key,run);
  return run;
}

export function routeAiSignalToEngine({botId,signal,candidateSignal}={}){
  const target=String(botId||"");
  const direction=upper(signal?.direction||"HOLD");
  const candidate=candidateDirection(candidateSignal);
  const engineAccepted=Boolean(signal?.engineAccepted)&&String(signal?.engine||"")===target;
  const strategyAccepted=Boolean(signal?.strategyMatch);
  const directionAccepted=!candidate||candidate===direction;
  const confirm=engineAccepted&&strategyAccepted&&direction!=="HOLD"&&directionAccepted;
  let status="CORTEX_CONFIRMATION_REJECTED";
  if(confirm)status="CORTEX_ENGINE_SIGNAL_CONFIRMED";
  else if(direction==="HOLD"||!signal)status="CORTEX_SIGNAL_HOLD";
  else if(!engineAccepted)status="CORTEX_ENGINE_ROUTE_MISMATCH";
  else if(!strategyAccepted)status="CORTEX_STRATEGY_MISMATCH";
  else status="CORTEX_DIRECTION_MISMATCH";
  return {...(signal||{}),confirm,status,candidateDirection:candidate||null};
}

export function getAiTradeConfirmation({userId,botId,signal,market,analysis}={}){
  const x=getAiStrategySignal({userId,botId,market,analysis});
  return x?routeAiSignalToEngine({botId,signal:x,candidateSignal:signal}):null;
}
export async function warmAiTradeConfirmation({userId,botId,signal,market,analysis,risk}={}){
  const x=await warmAiStrategySignal({userId,botId,market,analysis,risk});
  return x?routeAiSignalToEngine({botId,signal:x,candidateSignal:signal}):null;
}
export function mlAiStrategyStatus() {
  return mlSignalServiceStatus();
}

export function aiTradeGateStatus({userId,botId}={}){
  const x=signalCache.get(keyFor(userId,botId));
  return !x?{ready:false}:{ready:Date.now()-x.at<=TTL_MS,engine:x.engine,direction:x.direction,strategyMatch:Boolean(x.strategyMatch),engineAccepted:Boolean(x.engineAccepted),trigger:x.trigger,reason:x.reason,riskFlags:x.riskFlags||[],expiresAt:x.expiresAt,model:x.model,source:"KINGBOT_CORTEX"};
}
