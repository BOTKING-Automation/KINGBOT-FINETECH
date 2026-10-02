import { evaluateBot, getBotDefinitions } from "./bot-engines.js";

const BOT_IDS = ["strategic", "flipper", "breakout", "smc-pro", "ladder-flip"];

function clamp(n,min,max){return Math.min(max,Math.max(min,n));}
function normalizeSignal(signal){
  if(signal==="LONG_CANDIDATE") return "LONG";
  if(signal==="SHORT_CANDIDATE") return "SHORT";
  return "NEUTRAL";
}

function freshness(timestamp, maxAgeMs=5000){
  const t=Date.parse(timestamp||"");
  if(!Number.isFinite(t)) return {ok:false,ageMs:null,reason:"MARKET_TIMESTAMP_MISSING"};
  const ageMs=Math.max(0,Date.now()-t);
  return {ok:ageMs<=maxAgeMs,ageMs,reason:ageMs<=maxAgeMs?null:"MARKET_DATA_STALE"};
}

export function buildKingbotBrainSnapshot(market={}){
  return {
    symbol:String(market.symbol||"").toUpperCase(),
    timeframe:String(market.timeframe||"unknown"),
    price:Number(market.price ?? market.close),
    entryPrice:Number(market.entryPrice ?? market.price ?? market.close),
    spread:Number(market.spread||0),
    atr:Number(market.atr ?? market.atr14),
    volatility:Number(market.volatility||0),
    trend:Number.isFinite(Number(market.trendScore)) ? Number(market.trendScore) :
      (String(market.trend||"").toUpperCase()==="BULLISH"?1:String(market.trend||"").toUpperCase()==="BEARISH"?-1:0),
    momentum:Number.isFinite(Number(market.momentum)) ? Number(market.momentum) : 0,
    volume:Number.isFinite(Number(market.volumeScore)) ? Number(market.volumeScore) : 0,
    structure:String(market.structure||"unknown").toLowerCase(),
    liquiditySweep:Boolean(market.liquiditySweep),
    orderBlock:Boolean(market.orderBlock),
    fairValueGap:Boolean(market.fairValueGap ?? market.fvg),
    emaFast:Number(market.emaFast ?? market.ema20),
    emaSlow:Number(market.emaSlow ?? market.ema50),
    adx:Number(market.adx ?? market.adx14),
    rsi:Number(market.rsi ?? market.rsi14),
    velocityPoints:Number(market.velocityPoints||0),
    brokerPoint:Number(market.brokerPoint||0),
    displacement:Boolean(market.displacement),
    breakout:Boolean(market.breakout),
    retest:Boolean(market.retest),
  };
}

export function evaluateKingbotBrain(market={}, options={}){
  const snapshot=buildKingbotBrainSnapshot(market);
  const maxAgeMs=Number(options.maxAgeMs||5000);
  const freshnessCheck=freshness(market.timestamp||market.receivedAt||market.time, maxAgeMs);
  const definitions=getBotDefinitions();
  const engines=BOT_IDS.map(id=>{
    const result=evaluateBot(id,snapshot);
    return {
      botId:id,
      name:definitions[id].name,
      signal:result.ok?normalizeSignal(result.signal):"BLOCKED",
      rawSignal:result.signal||null,
      score:result.score??0,
      threshold:result.threshold??definitions[id].signalThreshold,
      reason:result.reason||null,
      executionAuthorized:false,
      risk:result.risk||definitions[id].risk,
    };
  });

  const usable=engines.filter(x=>x.signal==="LONG"||x.signal==="SHORT");
  const long=usable.filter(x=>x.signal==="LONG");
  const short=usable.filter(x=>x.signal==="SHORT");
  const longStrength=long.reduce((sum,x)=>sum+Math.abs(Number(x.score||0)),0);
  const shortStrength=short.reduce((sum,x)=>sum+Math.abs(Number(x.score||0)),0);
  const totalStrength=longStrength+shortStrength;
  const agreement=usable.length?Math.max(long.length,short.length)/usable.length:0;
  const directionalEdge=totalStrength?Math.abs(longStrength-shortStrength)/totalStrength:0;

  let signal="NO_TRADE";
  let direction="NEUTRAL";
  const reasons=[];
  if(!freshnessCheck.ok){
    reasons.push(freshnessCheck.reason);
  }else if(!Number.isFinite(snapshot.price)||snapshot.price<=0||!Number.isFinite(snapshot.atr)||snapshot.atr<=0){
    reasons.push("PRICE_AND_ATR_REQUIRED");
  }else if(usable.length===0){
    reasons.push("NO_STRATEGY_CONFIRMATION");
  }else if(long.length===short.length){
    reasons.push("ENGINE_CONFLICT");
  }else{
    direction=long.length>short.length?"LONG":"SHORT";
    const sideCount=Math.max(long.length,short.length);
    if(sideCount>=3 && agreement>=0.6 && directionalEdge>=0.2){
      signal="ENTRY_CONFIRMING";
      reasons.push("MULTI_ENGINE_CONFLUENCE_CONFIRMED");
    }else{
      signal="WAIT";
      reasons.push("CONFLUENCE_NOT_STRONG_ENOUGH");
    }
  }

  const dominant=direction==="LONG"?longStrength:direction==="SHORT"?shortStrength:0;
  const confidence=Math.round(clamp(
    usable.length===0?0:
      (agreement*0.45+directionalEdge*0.35+Math.min(dominant/Math.max(1,usable.length*100),1)*0.20)*100,
    0,100
  ));

  return {
    ok:true,
    brain:"KINGBOT_CONFLUENCE_ENGINE",
    version:"1.0",
    timestamp:new Date().toISOString(),
    market:{
      symbol:snapshot.symbol,
      timeframe:snapshot.timeframe,
      price:snapshot.price,
      atr:snapshot.atr,
      dataFresh:freshnessCheck.ok,
      dataAgeMs:freshnessCheck.ageMs,
    },
    decision:{
      signal,
      direction,
      confidence,
      engineAgreement:Math.round(agreement*100),
      directionalEdge:Math.round(directionalEdge*100),
      reasons,
      executionAuthorized:false,
      requiresRiskGate:true,
    },
    engines,
    riskGate:{
      required:true,
      passed:false,
      reason:signal==="ENTRY_CONFIRMING"?"Awaiting user/bot risk-context evaluation and execution authorization.":"No execution authorization because confluence is not confirmed.",
    },
  };
}
