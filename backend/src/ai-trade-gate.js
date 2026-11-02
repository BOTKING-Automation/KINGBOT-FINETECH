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
    liquiditySweep:Boolean(market?.liquiditySweep),rawLiquiditySweep:String(market?.rawLiquiditySweep??market?.liquiditySweepDirection??""),
    rawChoch:String(market?.rawChoch??market?.chochDirection??""),rawBos:String(market?.rawBos??market?.bosDirection??""),
    orderBlock:Boolean(market?.orderBlock),orderBlockDirection:String(market?.orderBlock?.direction??market?.orderBlockDirection??""),
    fairValueGap:Boolean(market?.fairValueGap),fairValueGapDirection:String(market?.fairValueGapDirection??market?.rawFvgDirection??""),
    displacement:Boolean(market?.displacement),rawDisplacement:String(market?.rawDisplacement??market?.displacementDirection??""),
    breakout:Boolean(market?.breakout),breakoutDirection:String(market?.breakoutDirection??""),
    retest:Boolean(market?.retest),retestDirection:String(market?.retestDirection??""),
    candleCount:num(market?.candleCount),
    adx:num(market?.adx),rsi:num(market?.rsi),emaFast:num(market?.emaFast),
    emaSlow:num(market?.emaSlow),velocityPoints:num(market?.velocityPoints),
    deterministicSignal:String(analysis?.signal||"NO_SIGNAL"),
    deterministicScore:num(analysis?.score),
    reason:String(analysis?.reason||""),
    multiTimeframe:Object.fromEntries(
      ["regime","setup","execution"].map(role=>{
        const x=market?.multiTimeframe?.[role]||{};
        return [role,{
          timeframe:String(x.timeframe||""),
          available:Boolean(x.available),
          trend:num(x.trend),
          momentum:num(x.momentum),
          structure:String(x.structure||""),
          atr:num(x.atr),
          emaFast:num(x.emaFast),
          emaSlow:num(x.emaSlow),
          adx:num(x.adx),
          rsi:num(x.rsi),
          liquiditySweepDirection:String(x.liquiditySweepDirection||""),
          displacementDirection:String(x.displacementDirection||""),
          bosDirection:String(x.bosDirection||""),
          breakoutDirection:String(x.breakoutDirection||""),
          retestDirection:String(x.retestDirection||""),
          orderBlockDirection:String(x.orderBlock?.direction||""),
          fairValueGapDirection:String(x.fairValueGapDirection||"")
        }];
      })
    )
  });
}

function evidenceDirection(value){
  const text=upper(value);
  if(["BUY","BULLISH","LONG","UP"].includes(text))return "BUY";
  if(["SELL","BEARISH","SHORT","DOWN"].includes(text))return "SELL";
  if(["NONE","WAIT","HOLD","NEUTRAL","MIXED","RANGE",""].includes(text))return "HOLD";
  if(typeof value==="boolean"||value===null||value===undefined)return "HOLD";
  const n=Number(value);
  return Number.isFinite(n)?(n>.12?"BUY":n<-.12?"SELL":"HOLD"):"HOLD";
}

function strategyDirection(botId,market={},analysis={}){
  const trend=evidenceDirection(market.trend);
  const momentum=evidenceDirection(market.momentum);
  if(botId==="flipper"){
    const sweep=evidenceDirection(market.rawLiquiditySweep??market.liquiditySweepDirection);
    const choch=evidenceDirection(market.rawChoch??market.chochDirection);
    const displacement=evidenceDirection(market.rawDisplacement??market.displacementDirection);
    const trigger=sweep!=="HOLD"?sweep:choch;
    const triggerConflict=sweep!=="HOLD"&&choch!=="HOLD"&&sweep!==choch;
    return !triggerConflict&&trigger!=="HOLD"&&trigger===displacement?trigger:"HOLD";
  }
  if(botId==="breakout"){
    const breakout=evidenceDirection(market.breakoutDirection??market.bosDirection);
    const retest=evidenceDirection(market.retestDirection);
    return market.breakout&&market.retest&&breakout!=="HOLD"&&retest===breakout?breakout:"HOLD";
  }
  if(botId==="smc-pro"){
    const sweep=evidenceDirection(market.rawLiquiditySweep??market.liquiditySweepDirection);
    const displacement=evidenceDirection(market.rawDisplacement??market.displacementDirection);
    return sweep!=="HOLD"&&sweep===displacement?sweep:"HOLD";
  }
  if(botId==="ladder-flip"){
    const fast=num(market.emaFast),slow=num(market.emaSlow),price=num(market.price);
    return fast>slow&&price>fast?"BUY":fast<slow&&price<fast?"SELL":"HOLD";
  }
  const score=num(market.trend)*.55+num(market.momentum)*.45;
  if(score>.10)return "BUY";
  if(score<-.10)return "SELL";
  return candidateDirection(analysis.signal)||"HOLD";
}

function strategyTimeframeEvidence(market={},direction){
  const multi=market?.multiTimeframe||{};
  const roles=["regime","setup","execution"];
  const frames=roles.map(role=>({role,frame:multi[role]||null}));
  const missing=frames.filter(x=>!x.frame||x.frame.available===false||x.frame.ok===false||!(num(x.frame?.atr,0)>0));
  const directions=frames.map(({role,frame})=>({
    role,
    timeframe:String(frame?.timeframe||""),
    direction:evidenceDirection(frame?.trend??frame?.structure),
    momentum:num(frame?.momentum),
    adx:num(frame?.adx),
    atr:num(frame?.atr)
  }));
  const aligned=missing.length===0&&directions.every(x=>x.direction===direction);
  return {
    ready:missing.length===0,
    aligned,
    missingRoles:missing.map(x=>x.role),
    directions,
    reason:missing.length
      ? "MTF data is missing for "+missing.map(x=>x.role).join(", ")+"."
      : aligned
        ? "Regime, setup and execution timeframe evidence is directionally aligned."
        : "Regime, setup and execution timeframe evidence is not fully aligned."
  };
}

function evaluateNativeSignal({botId,market={},analysis={},risk={}}={}){
  const profile=STRATEGY_PROFILES[botId];
  const bot=getBotDefinitions()[botId];
  if(!profile||!bot)return null;

  const direction=strategyDirection(botId,market,analysis);
  const dir=direction==="BUY"?1:direction==="SELL"?-1:0;
  const trend=num(market.trend),momentum=num(market.momentum),velocity=num(market.velocityPoints);
  const spread=num(market.spread),atr=Math.max(num(market.atr),1e-12);
  const spreadRatio=Math.abs(spread)/atr;
  const rsi=num(market.rsi),adx=num(market.adx),fast=num(market.emaFast),slow=num(market.emaSlow);
  const mtf=strategyTimeframeEvidence(market,direction);
  const tests=[];

  if(botId==="strategic"){
    tests.push(["trend strength",dir!==0&&Math.abs(trend)>=.35,15]);
    tests.push(["directional momentum",dir!==0&&Math.sign(momentum)===dir&&Math.abs(momentum)>=.30,15]);
    tests.push(["swing structure",String(market.structure||"").toLowerCase()===(dir>0?"bullish":"bearish"),15]);
    tests.push(["EMA alignment",fast>0&&slow>0&&((fast>slow&&dir>0)||(fast<slow&&dir<0)),10]);
    tests.push(["volatility regime",num(market.volatility)>0&&num(market.volatility)<.90,10]);
    tests.push(["regime timeframe",mtf.directions[0]?.direction===direction,12]);
    tests.push(["setup timeframe",mtf.directions[1]?.direction===direction,12]);
    tests.push(["execution timeframe",mtf.directions[2]?.direction===direction,11]);
  }else if(botId==="flipper"){
    const sweep=evidenceDirection(market.rawLiquiditySweep??market.liquiditySweepDirection);
    const choch=evidenceDirection(market.rawChoch??market.chochDirection);
    const displacement=evidenceDirection(market.rawDisplacement??market.displacementDirection);
    const trigger=(sweep!=="HOLD"?sweep:choch)===direction&&direction!=="HOLD"&&displacement===direction;
    const rsiOk=rsi>0&&(dir>0?rsi>=30&&rsi<=62:rsi>=38&&rsi<=70);
    tests.push(["sweep/CHOCH and displacement",trigger,24]);
    tests.push(["RSI reversal transition",rsiOk,14]);
    tests.push(["directional momentum",dir!==0&&Math.sign(momentum)===dir&&Math.abs(momentum)>=.30,14]);
    tests.push(["micro velocity",dir!==0&&Math.sign(velocity)===dir&&Math.abs(velocity)>=.20,14]);
    tests.push(["spread efficiency",spreadRatio<=.20,10]);
    tests.push(["regime timeframe",mtf.directions[0]?.direction===direction,8]);
    tests.push(["setup timeframe",mtf.directions[1]?.direction===direction,8]);
    tests.push(["execution timeframe",mtf.directions[2]?.direction===direction,8]);
  }else if(botId==="breakout"){
    const breakoutDirection=evidenceDirection(market.breakoutDirection??market.bosDirection);
    const retestDirection=evidenceDirection(market.retestDirection);
    tests.push(["directional breakout",Boolean(market.breakout)&&breakoutDirection===direction&&dir!==0,20]);
    tests.push(["separate retest acceptance",Boolean(market.retest)&&retestDirection===direction,20]);
    tests.push(["volatility expansion",num(market.volatility)>=.20&&num(market.volatility)<=.90,14]);
    tests.push(["post-breakout momentum",dir!==0&&Math.sign(momentum)===dir&&Math.abs(momentum)>=.30,14]);
    tests.push(["relative activity",num(market.volume)>=.30,10]);
    tests.push(["regime timeframe",mtf.directions[0]?.direction===direction,8]);
    tests.push(["setup timeframe",mtf.directions[1]?.direction===direction,7]);
    tests.push(["execution timeframe",mtf.directions[2]?.direction===direction,7]);
  }else if(botId==="smc-pro"){
    const sweep=evidenceDirection(market.rawLiquiditySweep??market.liquiditySweepDirection);
    const displacement=evidenceDirection(market.rawDisplacement??market.displacementDirection);
    const structure=evidenceDirection(market.rawBos??market.bosDirection??market.structure);
    const obDirection=evidenceDirection(market.orderBlock?.direction??market.orderBlockDirection);
    const fvgDirection=evidenceDirection(market.fairValueGapDirection??market.rawFvgDirection);
    const directionalZoneOk=(Boolean(market.orderBlock)&&obDirection===direction)||
      (Boolean(market.fairValueGap)&&fvgDirection===direction);
    tests.push(["liquidity sweep",sweep===direction&&dir!==0,18]);
    tests.push(["directional displacement",displacement===direction&&dir!==0,18]);
    tests.push(["BOS/CHOCH/structure",structure===direction||evidenceDirection(market.rawChoch)===direction,16]);
    tests.push(["directional OB/FVG zone",directionalZoneOk,28]);
    tests.push(["regime timeframe",mtf.directions[0]?.direction===direction,7]);
    tests.push(["setup timeframe",mtf.directions[1]?.direction===direction,7]);
    tests.push(["execution timeframe",mtf.directions[2]?.direction===direction,6]);
  }else if(botId==="ladder-flip"){
    tests.push(["EMA trend and price",fast>0&&slow>0&&num(market.price)>0&&((fast>slow&&num(market.price)>fast&&dir>0)||(fast<slow&&num(market.price)<fast&&dir<0)),20]);
    tests.push(["ADX trend strength",adx>=20,18]);
    tests.push(["RSI trend confirmation",rsi>0&&((dir>0&&rsi>=52&&rsi<=72)||(dir<0&&rsi<=48&&rsi>=28)),18]);
    tests.push(["directional velocity",dir!==0&&Math.sign(velocity)===dir&&Math.abs(velocity)>=.10,12]);
    tests.push(["spread efficiency",spreadRatio<=.25,10]);
    tests.push(["regime timeframe",mtf.directions[0]?.direction===direction,8]);
    tests.push(["setup timeframe",mtf.directions[1]?.direction===direction,7]);
    tests.push(["execution timeframe",mtf.directions[2]?.direction===direction,7]);
  }

  const evidence=tests.filter(x=>x[1]).map(x=>x[0]);
  const totalWeight=tests.reduce((sum,x)=>sum+x[2],0);
  const score=Math.round(totalWeight?tests.reduce((sum,x)=>sum+(x[1]?x[2]:0),0)/totalWeight*100:0);
  const baseline=num(analysis?.score,0);
  const baselineAligned=dir!==0&&Math.sign(baseline)===dir&&Math.abs(baseline)>=50;
  const triggerChecks={
    strategic:["trend strength","directional momentum","EMA alignment"],
    flipper:["sweep/CHOCH and displacement"],
    breakout:["directional breakout","separate retest acceptance"],
    "smc-pro":["liquidity sweep","directional displacement"],
    "ladder-flip":["EMA trend and price"]
  }[botId]||[];
  const primaryTrigger=triggerChecks.length>0&&triggerChecks.every(name=>tests.some(x=>x[0]===name&&x[1]));
  const criticalMtf=mtf.ready&&mtf.aligned;
  const riskBlocks=Array.isArray(risk?.blocks)?risk.blocks:[];
  const strategyMatch=dir!==0&&score>=65&&baselineAligned&&criticalMtf&&primaryTrigger&&!riskBlocks.length&&risk?.allowed!==false;
  const signal=!strategyMatch?"HOLD":direction;
  const flags=[];
  if(riskBlocks.length)flags.push(...riskBlocks.map(String));
  if(risk?.allowed===false)flags.push("RISK_ENGINE_NOT_ALLOWED");
  if(!mtf.ready)flags.push("MTF_DATA_INCOMPLETE");
  else if(!mtf.aligned)flags.push("MTF_DIRECTIONAL_CONFLICT");
  if(spreadRatio>.25)flags.push("SPREAD_ELEVATED");
  if(!baselineAligned)flags.push("DETERMINISTIC_DIRECTION_OR_SCORE_MISMATCH");
  if(score<65)flags.push("STRATEGY_ALIGNMENT_BELOW_CORTEX_THRESHOLD");

  return {
    engine:botId,
    direction:signal,
    strategyMatch,
    trigger:evidence.length?evidence.join(" + "):"NO_VALID_SETUP",
    riskFlags:flags.slice(0,10),
    reason:(strategyMatch?"CORTEX confirmed this specialist setup. ":"CORTEX held the candidate because strategy-specific or MTF gates were incomplete. ")+
      "Evidence: "+(evidence.join(", ")||"none")+". "+mtf.reason,
    engineAccepted:true,
    score,
    evidence,
    timeframeEvidence:mtf.directions,
    at:Date.now(),
    expiresAt:Date.now()+TTL_MS,
    model:MODEL,
    source:"KINGBOT_CORTEX"
  };
}

export function aiExecutionGateEnabled(){
  // AI STRATEGIES is the bot decision layer. A bot is never allowed to
  // submit an order without a fresh strategy-specific ML confirmation.
  return String(process.env.KINGBOT_AI_STRATEGIES_REQUIRED || "true").toLowerCase() !== "false";
}

export function getAiStrategySignal({userId,botId,market,analysis}={}){
  if(!userId||!botId||!analysis)return null;
  const item=signalCache.get(keyFor(userId,botId));
  if(!item||Date.now()-item.at>TTL_MS)return null;
  if(item.fingerprint!==snapshotFingerprint({botId,market,analysis}))return null;
  return item;
}

function strategyTimeframeRoles(botId,market={}){
  const profile=market?.timeframeProfile||getBotDefinitions()[botId]?.timeframeProfile||{};
  return [
    {role:"regime",timeframe:String(profile.regime||"4h").toLowerCase(),weight:0.25},
    {role:"setup",timeframe:String(profile.setup||"15m").toLowerCase(),weight:0.35},
    {role:"execution",timeframe:String(profile.execution||market?.timeframe||"5m").toLowerCase(),weight:0.40}
  ];
}

function buildMlTimeframeMarket(baseMarket,frame){
  const roleSnapshot=baseMarket?.multiTimeframe?.[frame.role]||{};
  const usable=frame.role==="execution"
    ? baseMarket
    : (roleSnapshot?.available ? roleSnapshot : null);
  if(!usable)return null;
  return {
    ...baseMarket,
    ...usable,
    rawLiquiditySweep:usable.liquiditySweepDirection??baseMarket?.rawLiquiditySweep??null,
    rawDisplacement:usable.displacementDirection??baseMarket?.rawDisplacement??null,
    rawBos:usable.bosDirection??baseMarket?.rawBos??null,
    breakoutDirection:usable.breakoutDirection??baseMarket?.breakoutDirection??null,
    retestDirection:usable.retestDirection??baseMarket?.retestDirection??null,
    orderBlock:usable.orderBlock??baseMarket?.orderBlock??null,
    fairValueGapDirection:usable.fairValueGapDirection??baseMarket?.fairValueGapDirection??null,
    candleCount:usable.candleCount??baseMarket?.candleCount??null,
    symbol:String(baseMarket?.symbol||"").toUpperCase(),
    timeframe:frame.timeframe,
    price:num(usable.price, num(baseMarket?.price)),
    close:num(usable.close, num(baseMarket?.price)),
    atr:num(usable.atr, num(baseMarket?.atr)),
    spread:num(baseMarket?.spread),
    bid:num(baseMarket?.bid),
    ask:num(baseMarket?.ask),
    velocityPoints:frame.role==="execution"
      ? num(baseMarket?.velocityPoints)
      : num(usable.velocityPoints, 0),
    multiTimeframe:baseMarket?.multiTimeframe||null
  };
}

async function predictMultiTimeframeMl({botId,market}={}){
  const frames=strategyTimeframeRoles(botId,market);
  const predictions=await Promise.all(frames.map(async frame=>{
    const snapshot=buildMlTimeframeMarket(market,frame);
    if(!snapshot){
      return {role:frame.role,timeframe:frame.timeframe,weight:frame.weight,ready:false,status:"TIMEFRAME_DATA_UNAVAILABLE"};
    }
    try{
      const result=await predictMlStrategySignal({botId,market:snapshot});
      return {...result,role:frame.role,timeframe:frame.timeframe,weight:frame.weight};
    }catch(error){
      return {ready:false,status:"ML_TIMEFRAME_ERROR",error:String(error?.message||"ML_TIMEFRAME_ERROR").slice(0,160),role:frame.role,timeframe:frame.timeframe,weight:frame.weight};
    }
  }));

  const ready=predictions.filter(x=>x?.ready&&x?.probabilities);
  const execution=ready.find(x=>x.role==="execution")||null;
  if(!execution){
    return {
      ready:false,
      status:predictions.find(x=>x.role==="execution")?.status||"MODEL_NOT_READY",
      predictions,
      requiredTimeframe:frames.find(x=>x.role==="execution")?.timeframe||"5m"
    };
  }

  const aggregate={sell:0,hold:0,buy:0};
  let totalWeight=0;
  for(const prediction of ready){
    const weight=Math.max(0.05,Number(prediction.weight)||0);
    aggregate.sell+=(Number(prediction.probabilities.sell)||0)*weight;
    aggregate.hold+=(Number(prediction.probabilities.hold)||0)*weight;
    aggregate.buy+=(Number(prediction.probabilities.buy)||0)*weight;
    totalWeight+=weight;
  }
  if(totalWeight<=0)return {ready:false,status:"ML_MTF_AGGREGATION_EMPTY",predictions};

  aggregate.sell/=totalWeight;
  aggregate.hold/=totalWeight;
  aggregate.buy/=totalWeight;

  const ranked=[
    ["SELL",aggregate.sell],
    ["HOLD",aggregate.hold],
    ["BUY",aggregate.buy]
  ].sort((a,b)=>b[1]-a[1]);
  const direction=ranked[0][0];
  const confidence=ranked[0][1];
  const score=aggregate.buy-aggregate.sell;

  const directional=ready
    .map(x=>candidateDirection(x.direction))
    .filter(Boolean);
  const directionWeight={BUY:0,SELL:0};
  for(const prediction of ready){
    const d=candidateDirection(prediction.direction);
    if(d)directionWeight[d]+=Math.max(0.05,Number(prediction.weight)||0);
  }
  const directionalTotal=directionWeight.BUY+directionWeight.SELL;
  const directionalConsensus=directionalTotal>0
    ? Math.max(directionWeight.BUY,directionWeight.SELL)/directionalTotal
    : 0;
  const modelConsensus=directional.length?(
    directionWeight.BUY>=directionWeight.SELL?"BUY":"SELL"
  ):"HOLD";

  return {
    ok:true,
    ready:true,
    status:"LIVE_ML_MTF_CONSENSUS",
    direction,
    confidence:Number(confidence.toFixed(2)),
    score:Number(score.toFixed(2)),
    probabilities:{
      sell:Number(aggregate.sell.toFixed(2)),
      hold:Number(aggregate.hold.toFixed(2)),
      buy:Number(aggregate.buy.toFixed(2))
    },
    execution:{
      direction:execution.direction||"HOLD",
      confidence:num(execution.confidence),
      score:num(execution.score),
      timeframe:execution.timeframe,
      modelKey:execution.modelKey||null
    },
    consensus:{
      direction:modelConsensus,
      agreementPct:Number((directionalConsensus*100).toFixed(2)),
      readyModels:ready.length,
      totalModels:predictions.length
    },
    predictions:predictions.map(x=>({
      role:x.role,
      timeframe:x.timeframe,
      ready:Boolean(x.ready),
      status:x.status||null,
      direction:x.direction||"HOLD",
      confidence:num(x.confidence),
      score:num(x.score),
      probabilities:x.probabilities||null,
      modelKey:x.modelKey||null,
      trainedAt:x.trainedAt||null
    }))
  };
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
    const ml=await predictMultiTimeframeMl({botId,market});
    let item={
      ...native,
      fingerprint,
      aiStrategyRequired:aiExecutionGateEnabled(),
      aiStrategyService:mlSignalServiceStatus(),
      aiTimeframeProfile:strategyTimeframeRoles(botId,market)
    };

    if(ml?.ready){
      const nativeDirection=candidateDirection(native.direction)||candidateDirection(analysis?.signal);
      const mlDirection=candidateDirection(ml.direction);
      const mlScore=num(ml.score,0);
      const nativeScore=num(native.score,0);
      const combinedScore=Math.round(nativeScore*0.30+mlScore*0.70);
      const directionAgreement=!nativeDirection||!mlDirection||nativeDirection===mlDirection;
      const mlConfidence=num(ml.confidence,0);
      const consensusDirection=candidateDirection(ml?.consensus?.direction);
      const consensusAgreement=num(ml?.consensus?.agreementPct,0);
      const contextAligned=!consensusDirection||consensusDirection===mlDirection||consensusAgreement<55;
      const modelAligned=Boolean(mlDirection)&&mlDirection!=="HOLD"&&mlConfidence>=60&&directionAgreement&&contextAligned;

      item={
        ...item,
        direction:modelAligned?mlDirection:"HOLD",
        strategyMatch:Boolean(native.strategyMatch)&&modelAligned&&Math.abs(combinedScore)>=65,
        trigger:[
          native.trigger||"NATIVE_STRATEGY",
          "MTF="+String(mlDirection||"HOLD"),
          "EXEC="+String(ml.execution?.direction||"HOLD"),
          "CTX="+String(consensusDirection||"HOLD"),
          "CONF="+mlConfidence.toFixed(1)
        ].join(" + "),
        score:combinedScore,
        nativeScore,
        mlScore,
        mlConfidence,
        mlProbabilities:ml.probabilities||null,
        mlModelKey:ml.execution?.modelKey||null,
        mlModels:ml.predictions||null,
        mlConsensus:ml.consensus||null,
        mlExecution:ml.execution||null,
        mlTimeframes:ml.predictions||null,
        mlStatus:ml.status||"LIVE_ML_MTF_CONSENSUS",
        source:"KINGBOT_CORTEX+SCIKIT_LEARN+PYTORCH+MTF",
        model:"KINGBOT-CORTEX-1+ML-MTF-ENSEMBLE",
        reason:(modelAligned
          ? "AI STRATEGIES confirmed the candidate with deterministic strategy evidence plus regime/setup/execution ML consensus. "
          : "AI STRATEGIES held the candidate because multi-timeframe model confidence, direction or context agreement was insufficient. ")
          +"Native context="+nativeScore+"/100; MTF model score="+mlScore.toFixed(1)+"/100; context agreement="+consensusAgreement.toFixed(1)+"%."
      };
    }else if(aiExecutionGateEnabled()){
      item={
        ...item,
        direction:"HOLD",
        strategyMatch:false,
        trigger:"AI_MODEL_REQUIRED",
        engineAccepted:true,
        mlStatus:ml?.status||"ML_SERVICE_NOT_READY",
        mlError:ml?.error||null,
        mlTimeframes:ml?.predictions||[],
        source:"KINGBOT_CORTEX+MTF",
        reason:"AI STRATEGIES is mandatory. The execution-timeframe model must be ready before a broker order is authorized; higher-timeframe context is also monitored when available."
      };
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
