/**
 * KINGBOT CORTEX — Market Evidence Engine
 * Normalizes verified market telemetry into auditable evidence.
 * No LLM calls and no fabricated market state.
 */
const n=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const up=v=>String(v||"").trim().toUpperCase();
const clamp=(v,a=0,b=100)=>Math.min(b,Math.max(a,n(v,0)));
function freshness(timestamp,maxAgeMs=5000){
  if(!timestamp)return {ok:false,ageMs:null,reason:"DATA_TIMESTAMP_MISSING"};
  const t=timestamp instanceof Date?timestamp.getTime():new Date(timestamp).getTime();
  if(!Number.isFinite(t))return {ok:false,ageMs:null,reason:"DATA_TIMESTAMP_INVALID"};
  const age=Math.max(0,Date.now()-t);
  return {ok:age<=maxAgeMs,ageMs:age,reason:age>maxAgeMs?"STALE_MARKET_DATA":"FRESH"};
}
function direction(v){const x=up(v);if(["BULLISH","BUY","LONG"].includes(x))return "BULLISH";if(["BEARISH","SELL","SHORT"].includes(x))return "BEARISH";const z=n(v);return z!=null?(z>.15?"BULLISH":z<-.15?"BEARISH":"NEUTRAL"):"NEUTRAL";}
function scoreDirection(market){
  const evidence=[],positive=[],negative=[];
  const add=(label,bull,bear,weight=1)=>{if(bull){positive.push({label,weight});evidence.push({label,direction:"BULLISH",weight});}else if(bear){negative.push({label,weight});evidence.push({label,direction:"BEARISH",weight});}};
  add("trend",direction(market.rawTrend??market.trend)==="BULLISH",direction(market.rawTrend??market.trend)==="BEARISH",2);
  add("structure",direction(market.rawStructure??market.structure)==="BULLISH",direction(market.rawStructure??market.structure)==="BEARISH",2);
  add("BOS",direction(market.rawBos??market.bos)==="BULLISH",direction(market.rawBos??market.bos)==="BEARISH",2);
  add("CHOCH",direction(market.rawChoch??market.choch)==="BULLISH",direction(market.rawChoch??market.choch)==="BEARISH",1.5);
  add("liquidity sweep",direction(market.rawLiquiditySweep??market.liquiditySweep)==="BULLISH",direction(market.rawLiquiditySweep??market.liquiditySweep)==="BEARISH",1.5);
  const ef=n(market.emaFast??market.ema20),es=n(market.emaSlow??market.ema50);
  add("EMA alignment",ef!=null&&es!=null&&ef>es,ef!=null&&es!=null&&ef<es,1.5);
  const r=n(market.rsi14??market.rsi);
  add("RSI regime",r!=null&&r>=52&&r<=70,r!=null&&r<48&&r>=30,1);
  const m=n(market.momentum);
  add("momentum",m!=null&&m>=.2,m!=null&&m<=-.2,1.5);
  const bull=positive.reduce((s,x)=>s+x.weight,0),bear=negative.reduce((s,x)=>s+x.weight,0),total=bull+bear;
  return {bull,bear,delta:bull-bear,alignment:total?Math.round(Math.max(bull,bear)/total*100):0,evidence};
}
function multiTimeframe(market){
  const frames=Array.isArray(market.multiTimeframe?.timeframes)?market.multiTimeframe.timeframes:[];
  const usable=frames.filter(x=>x?.ok!==false&&x?.trend);
  const bull=usable.filter(x=>direction(x.trend)==="BULLISH").length,bear=usable.filter(x=>direction(x.trend)==="BEARISH").length;
  return {frames:usable.map(x=>({timeframe:x.timeframe,trend:up(x.trend),signal:up(x.signal),score:n(x.score,0)})),bull,bear,total:usable.length,direction:bull>bear?"BULLISH":bear>bull?"BEARISH":"MIXED",ratio:usable.length?Number((Math.max(bull,bear)/usable.length).toFixed(2)):0};
}
export function buildMarketEvidence(market={},options={}){
  const defaultMaxAgeMs=n(options.maxAgeMs,5000);
  const maxAgeMs=n(market.quoteFreshnessMaxAgeMs??market.freshnessMaxAgeMs,defaultMaxAgeMs);
  const quoteFresh=freshness(market.quoteTimestamp||market.timestamp||market.receivedAt,maxAgeMs);
  const barFresh=freshness(market.barTime||market.receivedAt||market.timestamp,Math.max(maxAgeMs,30000));
  const side=scoreDirection(market),mtf=multiTimeframe(market),flags=[];
  if(!(n(market.price)>0))flags.push("PRICE_MISSING");
  if(!quoteFresh.ok&&!barFresh.ok)flags.push(quoteFresh.reason);
  if(!Array.isArray(market.multiTimeframe?.timeframes))flags.push("MTF_NOT_AVAILABLE");
  const contradiction=Math.min(35,Math.abs(side.delta)<=1?18:0)+(mtf.direction!=="MIXED"&&mtf.total&&mtf.direction!==direction(market.trend)?15:0);
  const freshnessScore=quoteFresh.ok?100:barFresh.ok?72:0,mtfScore=mtf.total?Math.round(mtf.ratio*100):50;
  const evidenceQuality=Math.round(clamp(freshnessScore*.30+mtfScore*.25+side.alignment*.30+(flags.length?50:100)*.15-contradiction));
  let decision="WAIT";
  if(flags.some(x=>/MISSING|INVALID|STALE/.test(x)))decision="DATA_INSUFFICIENT";
  else if(side.alignment>=72&&mtfScore>=67&&Math.abs(side.delta)>=3)decision=side.delta>0?"BUY":"SELL";
  else if(Math.abs(side.delta)<=1||mtf.direction==="MIXED")decision="CONFLICTED";
  return {
    version:"1.0.0",decision,directionalBias:side.delta>0?"BULLISH":side.delta<0?"BEARISH":"NEUTRAL",
    confidence:evidenceQuality,evidenceQuality,freshness:{quote:quoteFresh,bar:barFresh},multiTimeframe:mtf,
    directionalEvidence:side.evidence,
    scores:{bullish:Number(side.bull.toFixed(2)),bearish:Number(side.bear.toFixed(2)),delta:Number(side.delta.toFixed(2)),alignment:side.alignment,mtf:mtfScore,freshness:freshnessScore,contradictionPenalty:contradiction},
    dataFlags:flags,
    waitFor:decision==="BUY"?"Bullish confirmation/retest while higher-timeframe structure remains aligned.":decision==="SELL"?"Bearish confirmation/retest while higher-timeframe structure remains aligned.":"Fresh data plus clearer directional/structure alignment.",
    invalidation:side.delta>0?"Bullish thesis invalidates on loss of controlling swing/support structure.":side.delta<0?"Bearish thesis invalidates on reclaim of controlling swing/resistance structure.":"No directional thesis is valid until structure resolves.",
    provenance:{source:market.source||"unknown",generatedAt:new Date().toISOString(),verified:quoteFresh.ok||barFresh.ok}
  };
}
export function marketDecisionGate(evidence,riskBlocks=[]){
  if(riskBlocks.length)return {state:"BLOCKED",allowed:false,reason:"DETERMINISTIC_RISK_BLOCK"};
  if(!evidence?.provenance?.verified)return {state:"DATA_INSUFFICIENT",allowed:false,reason:"MARKET_DATA_NOT_VERIFIED"};
  if(evidence.decision==="BUY"||evidence.decision==="SELL")return {state:evidence.decision,allowed:true,reason:"EVIDENCE_ALIGNMENT_THRESHOLD_MET"};
  if(evidence.decision==="CONFLICTED")return {state:"CONFLICTED",allowed:false,reason:"EVIDENCE_CONFLICT"};
  return {state:"WAIT",allowed:false,reason:"CONFIRMATION_REQUIRED"};
}
