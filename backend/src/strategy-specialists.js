const clamp=(v,min=-100,max=100)=>Math.min(max,Math.max(min,Number(v)||0));
const num=(v,fallback=null)=>Number.isFinite(Number(v))?Number(v):fallback;
const upper=v=>String(v??"").trim().toUpperCase();
const lower=v=>String(v??"").trim().toLowerCase();

const dirFromSigned=v=>Number(v)>0?"BUY":Number(v)<0?"SELL":"WAIT";
const mtfFrames=(mtf={})=>Array.isArray(mtf.timeframes)?mtf.timeframes.filter(x=>x&&x.ok!==false):[];
const frameDirection=x=>upper(x?.trend)==="BULLISH"?"BUY":upper(x?.trend)==="BEARISH"?"SELL":"WAIT";

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

function evaluateStrategic(m,mtf,regime){
  const conditions=[],missing=[],entry=[],wait=[],contradictions=[];
  const trend=num(m.trend,0), momentum=num(m.momentum,0);
  const emaBull=num(m.emaFast)>num(m.emaSlow), emaBear=num(m.emaFast)<num(m.emaSlow);
  const htf=upper(mtf.higherTimeframeBias);
  const local=lower(m.structure);
  if(Math.abs(trend)>=0.45) conditions.push("Directional trend regime is established.");
  else missing.push("Stronger directional trend regime.");
  if(Math.abs(momentum)>=0.35) conditions.push("Momentum confirms direction.");
  else missing.push("Momentum confirmation.");
  if((trend>0&&emaBull)||(trend<0&&emaBear)) conditions.push("EMA structure agrees with trend.");
  else missing.push("EMA structure alignment.");
  const d=trend>=0?"BUY":"SELL";
  if((d==="BUY"&&htf==="BULLISH")||(d==="SELL"&&htf==="BEARISH")) conditions.push("Higher-timeframe bias agrees.");
  else if(htf==="MIXED") wait.push("Higher-timeframe directional bias.");
  else contradictions.push("Higher-timeframe bias conflicts with directional trend.");
  if((d==="BUY"&&local==="bullish")||(d==="SELL"&&local==="bearish")) conditions.push("Local structure agrees.");
  const completion=conditions.length/4;
  const score=clamp((trend*48)+(momentum*28)+(d==="BUY"?(emaBull?14:-8):(emaBear?-14:8))+(htf===d.replace("BUY","BULLISH").replace("SELL","BEARISH")?10:0));
  const direction=completion>=0.75&&!contradictions.length?d:"WAIT";
  if(direction!=="WAIT") entry.push("Trend + momentum + EMA structure + higher-timeframe context align.");
  else wait.push("Complete the multi-factor directional confluence.");
  return card({botId:"strategic",strategyIdentity:"Multi-strategy directional confluence",direction,rawScore:direction==="WAIT"?score*0.7:score,confidence:completion*100,conditions,missingConditions:missing,entryConditions:entry,waitConditions:wait,marketRegimes:["TRENDING","TRENDING_VOLATILE"],timeframeRequirements:{regime:"4h",setup:"1h",execution:"15m"},evidenceUsed:["trend","momentum","EMA20/EMA50","market structure","MTF bias","regime"],contradictions,strategyMatch:direction!=="WAIT",invalidation:"Invalidate if trend/EMA structure breaks or higher-timeframe bias reverses."});
}

function evaluateFlipper(m,mtf){
  const conditions=[],missing=[],entry=[],wait=[],contradictions=[];
  const momentum=num(m.momentum,0), rsi=num(m.rsi);
  const sweep=upper(m.rawLiquiditySweep||m.liquiditySweep);
  const choch=upper(m.rawChoch);
  const displacement=upper(m.rawDisplacement||m.displacement);
  const volatility=num(m.volatility,0);
  const reversalBuy=(sweep==="BULLISH"||choch==="BULLISH")&&displacement==="BULLISH";
  const reversalSell=(sweep==="BEARISH"||choch==="BEARISH")&&displacement==="BEARISH";
  if(reversalBuy||reversalSell) conditions.push("Reversal trigger shows sweep/CHOCH plus directional displacement.");
  else missing.push("Reversal trigger: liquidity event or CHOCH followed by displacement.");
  if((rsi!==null&&((reversalBuy&&rsi<65)||(reversalSell&&rsi>35)))) conditions.push("RSI is compatible with a reversal transition.");
  else missing.push("RSI transition/exhaustion confirmation.");
  if(Math.abs(momentum)>=0.35) conditions.push("Momentum transition is measurable.");
  else missing.push("Momentum transition.");
  if(volatility>0.9) contradictions.push("Volatility is too extreme for the fast-flip risk profile.");
  const direction=reversalBuy&&!contradictions.length?"BUY":reversalSell&&!contradictions.length?"SELL":"WAIT";
  const score=direction==="BUY"?70+Math.min(20,Math.abs(momentum)*20):direction==="SELL"?-(70+Math.min(20,Math.abs(momentum)*20)):0;
  if(direction!=="WAIT") entry.push("Reversal trigger confirmed without requiring a breakout.");
  else wait.push("Wait for a clean reversal transition; do not infer a flip from trend strength alone.");
  return card({botId:"flipper",strategyIdentity:"Rapid reversal and momentum-flip specialist",direction,rawScore:score,confidence:conditions.length/3*100,conditions,missingConditions:missing,entryConditions:entry,waitConditions:wait,marketRegimes:["REVERSAL","EXPANSION"],timeframeRequirements:{regime:"15m",setup:"5m",execution:"1m"},evidenceUsed:["liquidity sweep","CHOCH","displacement","RSI","momentum","volatility"],contradictions,strategyMatch:direction!=="WAIT",invalidation:"Invalidate when the reversal trigger fails or momentum returns to the prior direction."});
}

function evaluateBreakout(m,mtf){
  const conditions=[],missing=[],entry=[],wait=[],contradictions=[];
  const breakout=Boolean(m.breakout), retest=Boolean(m.retest), vol=num(m.volatility,0), momentum=num(m.momentum,0);
  if(breakout) conditions.push("Range boundary breakout detected."); else missing.push("Confirmed range boundary breakout.");
  if(retest) conditions.push("Breakout retest confirmed."); else missing.push("Retest/acceptance after breakout.");
  if(vol>=0.2&&vol<=0.9) conditions.push("Volatility is suitable for continuation."); else missing.push("Controlled volatility expansion.");
  if(Math.abs(momentum)>=0.35) conditions.push("Momentum supports continuation."); else missing.push("Post-breakout momentum.");
  const htf=upper(mtf.higherTimeframeBias);
  const d=m.trend>=0?"BUY":"SELL";
  if((d==="BUY"&&htf==="BULLISH")||(d==="SELL"&&htf==="BEARISH")) conditions.push("Higher-timeframe bias supports the breakout.");
  else if(htf==="MIXED") wait.push("Higher-timeframe confirmation.");
  else contradictions.push("Higher-timeframe bias opposes breakout direction.");
  const ready=breakout&&retest&&vol>=0.2&&vol<=0.9&&Math.abs(momentum)>=0.35&&!contradictions.length;
  const direction=ready?d:"WAIT";
  const score=ready?clamp(65+Math.abs(momentum)*20+(retest?10:0)):breakout?40:0;
  if(ready) entry.push("Breakout + retest + momentum + volatility confirmation.");
  else wait.push("Do not classify a breakout as tradable until confirmation/retest is present.");
  return card({botId:"breakout",strategyIdentity:"Range-compression breakout and retest specialist",direction,rawScore:d==="BUY"?score:-score,confidence:(conditions.length/5)*100,conditions,missingConditions:missing,entryConditions:entry,waitConditions:wait,marketRegimes:["LOW_VOLATILITY","EXPANSION"],timeframeRequirements:{regime:"1h",setup:"15m",execution:"5m"},evidenceUsed:["breakout","retest","volatility","momentum","MTF bias"],contradictions,strategyMatch:ready,invalidation:"Invalidate on failed breakout acceptance, failed retest, or return inside the broken range."});
}

function evaluateSmc(m,mtf){
  const conditions=[],missing=[],entry=[],wait=[],contradictions=[];
  const structure=lower(m.structure), bos=upper(m.rawBos), choch=upper(m.rawChoch);
  const sweep=upper(m.rawLiquiditySweep||m.liquiditySweep), displacement=upper(m.displacement);
  const bull=structure==="bullish"||bos==="BULLISH"||choch==="BULLISH";
  const bear=structure==="bearish"||bos==="BEARISH"||choch==="BEARISH";
  const d=sweep==="BULLISH"&&displacement==="BULLISH"&&bull?"BUY":sweep==="BEARISH"&&displacement==="BEARISH"&&bear?"SELL":"WAIT";
  if(sweep==="BULLISH"||sweep==="BEARISH") conditions.push("Liquidity sweep identified."); else missing.push("Liquidity sweep.");
  if(displacement==="BULLISH"||displacement==="BEARISH") conditions.push("Directional displacement identified."); else missing.push("Directional displacement.");
  if((d==="BUY"&&bos==="BULLISH")||(d==="SELL"&&bos==="BEARISH")||(d==="BUY"&&choch==="BULLISH")||(d==="SELL"&&choch==="BEARISH")) conditions.push("Structure break/shift confirms the direction."); else missing.push("Directional BOS/CHOCH confirmation.");
  if(m.orderBlock) conditions.push("Order-block evidence available."); else missing.push("Order-block confirmation.");
  if(m.fairValueGap) conditions.push("Fair-value-gap evidence available."); else missing.push("FVG confirmation.");
  const htf=upper(mtf.higherTimeframeBias);
  if((d==="BUY"&&htf==="BULLISH")||(d==="SELL"&&htf==="BEARISH")) conditions.push("Higher-timeframe structure supports the setup.");
  else if(d!=="WAIT"&&htf!=="MIXED") contradictions.push("Higher-timeframe bias conflicts with SMC direction.");
  const ready=d!=="WAIT"&&!contradictions.length&&conditions.length>=4;
  const direction=ready?d:"WAIT";
  const score=ready?(d==="BUY"?82:-82):0;
  if(ready) entry.push("Liquidity → structure shift → displacement with OB/FVG confluence.");
  else wait.push("Complete the SMC sequence before considering an entry.");
  return card({botId:"smc-pro",strategyIdentity:"Smart Money Concepts structure/liquidity specialist",direction,rawScore:score,confidence:conditions.length/6*100,conditions,missingConditions:missing,entryConditions:entry,waitConditions:wait,marketRegimes:["TRENDING","RANGE","LIQUIDITY_EVENT"],timeframeRequirements:{regime:"4h",setup:"15m",execution:"5m"},evidenceUsed:["liquidity sweep","BOS","CHOCH","displacement","order block","FVG","structure","MTF bias"],contradictions,strategyMatch:ready,invalidation:"Invalidate if the sweep/structure sequence fails or displacement is reclaimed."});
}

function evaluateLadder(m,mtf){
  const conditions=[],missing=[],entry=[],wait=[],contradictions=[];
  const adx=num(m.adx), rsi=num(m.rsi), fast=num(m.emaFast), slow=num(m.emaSlow), price=num(m.price), atr=num(m.atr);
  const cfg={adxMinStrength:18,rsiBullMin:50,rsiBearMax:50};
  if([adx,rsi,fast,slow,price].some(v=>v===null)){ missing.push("EMA20/EMA50, ADX14, RSI14 and price."); return card({botId:"ladder-flip",strategyIdentity:"Adaptive ladder/re-entry specialist",direction:"WAIT",rawScore:0,confidence:0,conditions,missingConditions:missing,entryConditions:entry,waitConditions:["Wait for the complete V8 indicator gate."],marketRegimes:["TRENDING"],timeframeRequirements:{regime:"1h",setup:"15m",execution:"5m"},evidenceUsed:["EMA20/EMA50","ADX14","RSI14","price","ATR"],strategyMatch:false,invalidation:"Invalidate if EMA trend gate or ADX strength gate fails."});}
  if(adx>=cfg.adxMinStrength) conditions.push("ADX14 trend-strength gate passed."); else missing.push("ADX14 trend strength above the V8 minimum.");
  const bull=fast>slow&&price>fast&&rsi>=cfg.rsiBullMin, bear=fast<slow&&price<fast&&rsi<=cfg.rsiBearMax;
  if(bull||bear) conditions.push("EMA20/EMA50 + price location + RSI gate aligned."); else missing.push("EMA20/EMA50, price location and RSI alignment.");
  if(atr&&Math.abs(fast-slow)/atr>=0.02) conditions.push("EMA separation provides usable trend room."); else missing.push("Usable EMA separation relative to ATR.");
  const d=bull?"BUY":bear?"SELL":"WAIT";
  const ready=d!=="WAIT"&&adx>=cfg.adxMinStrength;
  const direction=ready?d:"WAIT";
  const score=ready?(d==="BUY"?78:-78):0;
  if(ready) entry.push("V8 trend gate qualifies for staged ladder/re-entry logic.");
  else wait.push("Wait for V8 EMA + ADX + RSI qualification before staging entries.");
  return card({botId:"ladder-flip",strategyIdentity:"V8 adaptive ladder, re-entry and momentum specialist",direction,rawScore:score,confidence:conditions.length/3*100,conditions,missingConditions:missing,entryConditions:entry,waitConditions:wait,marketRegimes:["TRENDING"],timeframeRequirements:{regime:"1h",setup:"15m",execution:"5m"},evidenceUsed:["EMA20/EMA50","ADX14","RSI14","price location","ATR","MTF bias"],contradictions,strategyMatch:ready,invalidation:"Invalidate the ladder when ADX weakens or EMA/price/RSI alignment breaks."});
}

const EVALUATORS={strategic:evaluateStrategic,flipper:evaluateFlipper,breakout:evaluateBreakout,"smc-pro":evaluateSmc,"ladder-flip":evaluateLadder};

export function evaluateStrategySpecialists({market={},multiTimeframe={},regime={}}={}){
  return Object.entries(EVALUATORS).map(([botId,fn])=>fn(market,multiTimeframe,regime));
}

export function specialistByBot(cards=[],botId){return cards.find(x=>x.botId===botId)||null;}
