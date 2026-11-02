const clamp=(v,min=-100,max=100)=>Math.min(max,Math.max(min,Number(v)||0));
const num=(v,fallback=null)=>v===null||v===undefined||v===""?fallback:(Number.isFinite(Number(v))?Number(v):fallback);
const upper=v=>String(v??"").trim().toUpperCase();
const lower=v=>String(v??"").trim().toLowerCase();

function directionOf(value){
  const text=upper(value);
  if(["BUY","BULLISH","LONG","UP"].includes(text))return "BUY";
  if(["SELL","BEARISH","SHORT","DOWN"].includes(text))return "SELL";
  if(["WAIT","NONE","NEUTRAL","MIXED","RANGE","UNKNOWN",""].includes(text))return "WAIT";
  if(typeof value==="boolean"||value===null||value===undefined)return "WAIT";
  const n=Number(value);
  return Number.isFinite(n)?(n>.12?"BUY":n<-.12?"SELL":"WAIT"):"WAIT";
}
const mtfFrames=(mtf={})=>Array.isArray(mtf.timeframes)?mtf.timeframes.filter(x=>x&&x.ok!==false):[];
const frameDirection=x=>directionOf(x?.trend??x?.bias??x?.direction);

function mtfAllows(direction,mtf={},options={}){
  const expected=direction==="BUY"?"BULLISH":"BEARISH";
  const higher=upper(mtf.higherTimeframeBias);
  const lowerBias=upper(mtf.lowerTimeframeBias);
  const frames=Array.isArray(mtf.timeframes)?mtf.timeframes:[];
  if(upper(mtf.policy)==="BASE_TIMEFRAME_ONLY")return {ok:false,reason:"Higher-timeframe data is not available."};
  if(["DATA_INSUFFICIENT","CONFLICTED"].includes(upper(mtf.setupState)))return {ok:false,reason:"Multi-timeframe evidence is incomplete or conflicted."};
  if(mtf.alignment?.conflict===true)return {ok:false,reason:"Higher and lower timeframe directions conflict."};
  if(higher!==expected)return {ok:false,reason:"Higher-timeframe bias does not confirm this direction."};
  if(options.requireLower&&lowerBias!==expected)return {ok:false,reason:"Lower-timeframe bias does not confirm this direction."};
  if(lowerBias!==""&&lowerBias!=="MIXED"&&lowerBias!==expected)return {ok:false,reason:"Lower-timeframe bias contradicts this direction."};
  if(frames.length&&frames.some(x=>x.ok===false))return {ok:false,reason:"At least one required timeframe is unavailable."};
  return {ok:true,reason:null};
}

function card(base){
  return {
    botId:base.botId,
    strategyIdentity:base.strategyIdentity,
    direction:base.direction||"WAIT",
    rawScore:Number(clamp(base.rawScore).toFixed(2)),
    confidence:Number(Math.max(0,Math.min(100,Number(base.confidence)||0)).toFixed(2)),
    conditions:base.conditions||[],
    missingConditions:base.missingConditions||[],
    entryConditions:base.entryConditions||[],
    waitConditions:base.waitConditions||[],
    invalidation:base.invalidation||"Setup invalidates when its defining structure is lost.",
    marketRegimes:base.marketRegimes||[],
    timeframeRequirements:base.timeframeRequirements||{},
    evidenceUsed:base.evidenceUsed||[],
    contradictions:base.contradictions||[],
    strategyMatch:Boolean(base.strategyMatch),
    executionAuthorized:false,
    executionAuthority:"NONE"
  };
}

function evaluateStrategic(m,mtf){
  const conditions=[],missing=[],entry=[],wait=[],contradictions=[];
  const trend=num(m.trend,0),momentum=num(m.momentum,0);
  const direction=directionOf(trend);
  const emaFast=num(m.emaFast),emaSlow=num(m.emaSlow);
  const emaDirection=emaFast!==null&&emaSlow!==null?(emaFast>emaSlow?"BUY":emaFast<emaSlow?"SELL":"WAIT"):"WAIT";
  if(direction==="WAIT"){
    missing.push("A measurable directional trend.");
    wait.push("Wait for the market regime to leave neutral/range conditions.");
  }else{
    conditions.push("Directional trend regime is established.");
    if(Math.sign(momentum)===(direction==="BUY"?1:-1)&&Math.abs(momentum)>=.30)conditions.push("Momentum confirms the trend.");
    else missing.push("Directional momentum confirmation.");
    if(emaDirection===direction)conditions.push("EMA20/EMA50 structure confirms direction.");
    else missing.push("EMA20/EMA50 alignment.");
    const structure=lower(m.structure);
    if(structure===(direction==="BUY"?"bullish":"bearish"))conditions.push("Local swing structure supports the trend.");
    else missing.push("Matching local market structure.");
    const aligned=mtfAllows(direction,mtf);
    if(aligned.ok)conditions.push("Higher and lower timeframe context is aligned.");
    else contradictions.push(aligned.reason);
  }
  const regime=upper(mtf.setupState);
  if(regime==="BUY_CANDIDATE"||regime==="SELL_CANDIDATE")conditions.push("Independent MTF setup state is directional.");
  else missing.push("Independent multi-timeframe setup confirmation.");
  const completion=conditions.length/5;
  const magnitude=Math.round(Math.min(100,Math.abs(trend)*22+Math.abs(momentum)*18+(emaDirection===direction?18:0)+(direction!=="WAIT"?18:0)));
  const qualified=direction!=="WAIT"&&completion>=.8&&!contradictions.length;
  const score=(qualified?Math.max(75,magnitude):Math.min(74,magnitude))*(direction==="SELL"?-1:1);
  if(qualified)entry.push("Trend, momentum, EMA structure, swing structure and MTF regime align.");
  else wait.push("Complete directional confluence before producing a candidate.");
  return card({botId:"strategic",strategyIdentity:"Multi-timeframe trend and regime specialist",direction:qualified?direction:"WAIT",rawScore:score,confidence:completion*100,conditions,missingConditions:missing,entryConditions:entry,waitConditions:wait,marketRegimes:["TRENDING","TRENDING_VOLATILE"],timeframeRequirements:{regime:"4h",setup:"1h",execution:"15m"},evidenceUsed:["trend strength","momentum","EMA20/EMA50","swing structure","volatility regime","multi-timeframe bias"],contradictions,strategyMatch:qualified,invalidation:"Invalidate when the EMA stack, controlling swing structure or higher-timeframe bias reverses."});
}

function evaluateFlipper(m,mtf){
  const conditions=[],missing=[],entry=[],wait=[],contradictions=[];
  const momentum=num(m.momentum,0),rsi=num(m.rsi);
  const sweep=directionOf(m.rawLiquiditySweep??m.liquiditySweepDirection);
  const choch=directionOf(m.rawChoch??m.chochDirection);
  const displacement=directionOf(m.rawDisplacement??m.displacementDirection);
  const trigger=sweep!=="WAIT"?sweep:choch;
  const direction=trigger!=="WAIT"&&trigger===displacement?trigger:"WAIT";
  if(direction==="WAIT")missing.push("Same-direction sweep/CHOCH followed by displacement.");
  else conditions.push("Reversal trigger and displacement agree directionally.");
  const rsiOk=rsi!==null&&(direction==="BUY"?rsi>=30&&rsi<=62:direction==="SELL"?rsi>=38&&rsi<=70:false);
  if(rsiOk)conditions.push("RSI is compatible with a reversal transition.");
  else missing.push("RSI transition confirmation.");
  const momentumOk=direction!=="WAIT"&&Math.sign(momentum)===(direction==="BUY"?1:-1)&&Math.abs(momentum)>=.30;
  if(momentumOk)conditions.push("Short-horizon momentum confirms the reversal.");
  else missing.push("Directional momentum confirmation.");
  if(num(m.volatility,0)>.90)contradictions.push("Volatility is too extreme for the fast-flip profile.");
  const aligned=direction==="WAIT"?{ok:false,reason:"Reversal direction is unresolved."}:mtfAllows(direction,mtf);
  if(aligned.ok)conditions.push("Regime and setup timeframes do not oppose the reversal.");
  else if(direction!=="WAIT")contradictions.push(aligned.reason);
  const qualified=direction!=="WAIT"&&rsiOk&&momentumOk&&!contradictions.length;
  const score=(qualified?Math.min(92,72+Math.abs(momentum)*18):0)*(direction==="SELL"?-1:1);
  if(qualified)entry.push("Sweep/CHOCH, displacement, RSI, momentum and context confirm a rapid reversal.");
  else wait.push("Wait for every reversal confirmation; do not trade a sweep or momentum spike alone.");
  return card({botId:"flipper",strategyIdentity:"Rapid reversal and momentum-transition specialist",direction:qualified?direction:"WAIT",rawScore:score,confidence:conditions.length/4*100,conditions,missingConditions:missing,entryConditions:entry,waitConditions:wait,marketRegimes:["REVERSAL","EXPANSION"],timeframeRequirements:{regime:"15m",setup:"5m",execution:"1m"},evidenceUsed:["liquidity sweep","CHOCH","displacement","RSI","momentum","volatility","MTF context"],contradictions,strategyMatch:qualified,invalidation:"Invalidate if the sweep extreme is reclaimed or reversal momentum fails."});
}

function evaluateBreakout(m,mtf){
  const conditions=[],missing=[],entry=[],wait=[],contradictions=[];
  const breakout=Boolean(m.breakout),retest=Boolean(m.retest),vol=num(m.volatility,0),momentum=num(m.momentum,0);
  const direction=directionOf(m.breakoutDirection??m.bosDirection??m.trend);
  if(breakout&&direction!=="WAIT")conditions.push("Directional range expansion detected.");
  else missing.push("Directional range-boundary break.");
  const retestDirection=directionOf(m.retestDirection);
  const retestOk=retest&&((retestDirection==="WAIT")||retestDirection===direction);
  if(retestOk)conditions.push("Breakout retest/acceptance confirmed.");
  else missing.push("A separate retest and close back in breakout direction.");
  if(vol>=.20&&vol<=.90)conditions.push("Volatility expansion is controlled.");
  else missing.push("Controlled volatility expansion.");
  const momentumOk=direction!=="WAIT"&&Math.sign(momentum)===(direction==="BUY"?1:-1)&&Math.abs(momentum)>=.30;
  if(momentumOk)conditions.push("Post-breakout momentum confirms direction.");
  else missing.push("Directional continuation momentum.");
  const aligned=direction==="WAIT"?{ok:false,reason:"Breakout direction is unresolved."}:mtfAllows(direction,mtf);
  if(aligned.ok)conditions.push("Higher-timeframe context supports continuation.");
  else if(direction!=="WAIT")contradictions.push(aligned.reason);
  const qualified=breakout&&retestOk&&vol>=.20&&vol<=.90&&momentumOk&&aligned.ok&&!contradictions.length;
  const raw=qualified?Math.min(94,68+Math.abs(momentum)*16+(retest?8:0)):0;
  if(qualified)entry.push("Breakout, retest, momentum, volatility and MTF acceptance align.");
  else wait.push("Do not treat the first range crossing as an entry; wait for retest acceptance.");
  return card({botId:"breakout",strategyIdentity:"Range-compression breakout and retest specialist",direction:qualified?direction:"WAIT",rawScore:raw*(direction==="SELL"?-1:1),confidence:conditions.length/5*100,conditions,missingConditions:missing,entryConditions:entry,waitConditions:wait,marketRegimes:["LOW_VOLATILITY","EXPANSION"],timeframeRequirements:{regime:"1h",setup:"15m",execution:"5m"},evidenceUsed:["range break","retest","volatility expansion","momentum","MTF bias"],contradictions,strategyMatch:qualified,invalidation:"Invalidate after a failed retest close or a return inside the broken range."});
}

function evaluateSmc(m,mtf){
  const conditions=[],missing=[],entry=[],wait=[],contradictions=[];
  const structure=lower(m.structure),bos=directionOf(m.rawBos??m.bos),choch=directionOf(m.rawChoch);
  const sweep=directionOf(m.rawLiquiditySweep??m.liquiditySweepDirection);
  const displacement=directionOf(m.rawDisplacement??m.displacementDirection);
  const direction=sweep!=="WAIT"&&sweep===displacement?sweep:"WAIT";
  if(direction!=="WAIT")conditions.push("Liquidity sweep and displacement are same-direction.");
  else missing.push("Directional liquidity sweep plus matching displacement.");
  const structureOk=direction!=="WAIT"&&(
    bos===direction||choch===direction||structure===(direction==="BUY"?"bullish":"bearish")
  );
  if(structureOk)conditions.push("BOS/CHOCH or swing structure confirms the shift.");
  else missing.push("Directional BOS/CHOCH or structure confirmation.");
  const ob=m.orderBlock;
  const obDirection=directionOf(ob?.direction??m.orderBlockDirection);
  const fvgDirection=directionOf(m.fairValueGapDirection??m.rawFvgDirection);
  const obOk=Boolean(ob)&&(obDirection===direction);
  const fvgOk=Boolean(m.fairValueGap??m.fvg)&&(fvgDirection===direction);
  if(obOk)conditions.push("Directional order block is present.");
  if(fvgOk)conditions.push("Directional fair-value gap is present.");
  if(!obOk&&!fvgOk)missing.push("At least one directional order block or fair-value gap.");
  const aligned=direction==="WAIT"?{ok:false,reason:"SMC direction is unresolved."}:mtfAllows(direction,mtf);
  if(aligned.ok)conditions.push("Higher-timeframe structure supports the SMC sequence.");
  else if(direction!=="WAIT")contradictions.push(aligned.reason);
  const qualified=direction!=="WAIT"&&structureOk&&(obOk||fvgOk)&&aligned.ok&&!contradictions.length;
  const score=(qualified?Math.min(96,76+(obOk?8:0)+(fvgOk?8:0)+(bos===direction?4:0)):0)*(direction==="SELL"?-1:1);
  if(qualified)entry.push("Liquidity → displacement → structure shift with directional OB/FVG and MTF alignment.");
  else wait.push("Wait for the complete directional SMC sequence.");
  return card({botId:"smc-pro",strategyIdentity:"Smart Money Concepts liquidity/structure specialist",direction:qualified?direction:"WAIT",rawScore:score,confidence:conditions.length/5*100,conditions,missingConditions:missing,entryConditions:entry,waitConditions:wait,marketRegimes:["TRENDING","RANGE","LIQUIDITY_EVENT"],timeframeRequirements:{regime:"4h",setup:"15m",execution:"5m"},evidenceUsed:["liquidity sweep","BOS","CHOCH","displacement","order block","FVG","MTF bias"],contradictions,strategyMatch:qualified,invalidation:"Invalidate if the sweep extreme is reclaimed, displacement is negated, or the OB/FVG zone fails."});
}

function evaluateLadder(m,mtf){
  const conditions=[],missing=[],entry=[],wait=[],contradictions=[];
  const adx=num(m.adx),rsi=num(m.rsi),fast=num(m.emaFast),slow=num(m.emaSlow),price=num(m.price),atr=num(m.atr);
  if([adx,rsi,fast,slow,price,atr].some(v=>v===null)||atr<=0){
    missing.push("EMA20/EMA50, ADX14, RSI14, price and ATR data.");
    wait.push("Wait for a complete V8 indicator set.");
    return card({botId:"ladder-flip",strategyIdentity:"V8 adaptive ladder and trend-continuation specialist",direction:"WAIT",rawScore:0,confidence:0,conditions,missingConditions:missing,entryConditions:entry,waitConditions:wait,marketRegimes:["TRENDING"],timeframeRequirements:{regime:"1h",setup:"15m",execution:"5m"},evidenceUsed:["EMA20/EMA50","ADX14","RSI14","ATR"],strategyMatch:false,invalidation:"Invalidate if the EMA trend gate or ADX strength gate fails."});
  }
  const bull=fast>slow&&price>fast&&rsi>=52;
  const bear=fast<slow&&price<fast&&rsi<=48;
  const direction=bull?"BUY":bear?"SELL":"WAIT";
  if(adx>=20)conditions.push("ADX14 trend-strength gate passed.");
  else missing.push("ADX14 above the V8 minimum.");
  if(direction!=="WAIT")conditions.push("EMA20/EMA50, price location and RSI agree.");
  else missing.push("EMA direction, price location and RSI alignment.");
  const emaGapAtr=Math.abs(fast-slow)/atr;
  if(emaGapAtr>=.02)conditions.push("EMA separation provides room relative to ATR.");
  else missing.push("EMA separation relative to ATR.");
  const aligned=direction==="WAIT"?{ok:false,reason:"V8 directional trend is unresolved."}:mtfAllows(direction,mtf);
  if(aligned.ok)conditions.push("Higher and lower timeframe trend is aligned.");
  else if(direction!=="WAIT")contradictions.push(aligned.reason);
  const qualified=direction!=="WAIT"&&adx>=20&&emaGapAtr>=.02&&aligned.ok&&!contradictions.length;
  const base=Math.min(94,78+Math.min(10,Math.max(0,(adx-20)*.25))+Math.min(6,emaGapAtr*3));
  const score=(qualified?base:0)*(direction==="SELL"?-1:1);
  if(qualified)entry.push("V8 trend gate confirmed with strength, EMA separation and multi-timeframe alignment.");
  else wait.push("Wait for V8 EMA/ADX/RSI and MTF qualification before staging entries.");
  return card({botId:"ladder-flip",strategyIdentity:"V8 adaptive ladder and trend-continuation specialist",direction:qualified?direction:"WAIT",rawScore:score,confidence:conditions.length/4*100,conditions,missingConditions:missing,entryConditions:entry,waitConditions:wait,marketRegimes:["TRENDING"],timeframeRequirements:{regime:"1h",setup:"15m",execution:"5m"},evidenceUsed:["EMA20/EMA50","ADX14","RSI14","price location","ATR separation","MTF bias"],contradictions,strategyMatch:qualified,invalidation:"Stop staging new rungs if ADX weakens or price/EMA/RSI alignment breaks."});
}

const EVALUATORS={strategic:evaluateStrategic,flipper:evaluateFlipper,breakout:evaluateBreakout,"smc-pro":evaluateSmc,"ladder-flip":evaluateLadder};

export function evaluateStrategySpecialists({market={},multiTimeframe={},regime={}}={}){
  return Object.entries(EVALUATORS).map(([botId,fn])=>fn(market,multiTimeframe,regime));
}

export function specialistByBot(cards=[],botId){return cards.find(x=>x.botId===botId)||null;}
