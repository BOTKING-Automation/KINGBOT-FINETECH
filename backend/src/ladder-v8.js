// KINGBOT LADDER FLIP V8 — pure strategy/indicator helpers.
// The execution state remains server-side in Postgres; this module is deterministic.

const finite=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const clamp=(n,min,max)=>Math.min(max,Math.max(min,n));

export const LADDER_V8_DEFAULTS={
  trendFastEMA:20,
  trendSlowEMA:50,
  adxPeriod:14,
  adxMinStrength:20,
  rsiPeriod:14,
  rsiBullMin:52,
  rsiBearMax:48,
  baseLot:0.01,
  maxLadderLot:1.0,
  fixedRungCount:10,
  aggressiveLotIncrement:0.10,
  maxTotalRungs:20,
  pyramidStepPoints:150,
  velocityWindowMs:500,
  velocityHighPoints:15,
  velocityMaxSamples:80,
  profitLockUSD:1.0,
  atrPeriod:14,
  atrSLMult:1.5,
  takeProfitRR:2.0,
  maxSpreadPoints:40,
  sessionStartHour:0,
  sessionEndHour:23,
  maxDailyLossPercent:6,
  maxTotalDrawdownPct:20,
  maxTradesPerDay:200
};

export function ema(values=[],period=20){
  const p=Math.max(1,Math.round(period));
  if(values.length<p)return null;
  const alpha=2/(p+1);
  let value=values.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for(let i=p;i<values.length;i++) value=(values[i]-value)*alpha+value;
  return value;
}

export function rsi(values=[],period=14){
  const p=Math.max(1,Math.round(period));
  if(values.length<=p)return null;
  let gain=0,loss=0;
  for(let i=1;i<=p;i++){
    const delta=values[i]-values[i-1];
    if(delta>=0)gain+=delta; else loss-=delta;
  }
  gain/=p; loss/=p;
  for(let i=p+1;i<values.length;i++){
    const delta=values[i]-values[i-1];
    const g=Math.max(0,delta),l=Math.max(0,-delta);
    gain=((gain*(p-1))+g)/p;
    loss=((loss*(p-1))+l)/p;
  }
  if(loss===0)return 100;
  if(gain===0)return 0;
  const rs=gain/loss;
  return 100-(100/(1+rs));
}

export function atr(candles=[],period=14){
  const rows=candles.filter(c=>[c?.open,c?.high,c?.low,c?.close].every(Number.isFinite)).map(c=>({
    open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)
  }));
  const p=Math.max(1,Math.round(period));
  if(rows.length<=p)return null;
  const tr=[];
  for(let i=0;i<rows.length;i++){
    const prev=i>0?rows[i-1].close:rows[i].close;
    tr.push(Math.max(rows[i].high-rows[i].low,Math.abs(rows[i].high-prev),Math.abs(rows[i].low-prev)));
  }
  let value=tr.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for(let i=p;i<tr.length;i++) value=((value*(p-1))+tr[i])/p;
  return value;
}

export function adx(candles=[],period=14){
  const rows=candles.filter(c=>[c?.high,c?.low,c?.close].every(Number.isFinite)).map(c=>({
    high:Number(c.high),low:Number(c.low),close:Number(c.close)
  }));
  const p=Math.max(1,Math.round(period));
  if(rows.length<(p*2)+1)return null;
  const tr=[],plusDM=[],minusDM=[];
  for(let i=1;i<rows.length;i++){
    const up=rows[i].high-rows[i-1].high;
    const down=rows[i-1].low-rows[i].low;
    plusDM.push(up>down&&up>0?up:0);
    minusDM.push(down>up&&down>0?down:0);
    tr.push(Math.max(
      rows[i].high-rows[i].low,
      Math.abs(rows[i].high-rows[i-1].close),
      Math.abs(rows[i].low-rows[i-1].close)
    ));
  }
  let trN=tr.slice(0,p).reduce((a,b)=>a+b,0);
  let plusN=plusDM.slice(0,p).reduce((a,b)=>a+b,0);
  let minusN=minusDM.slice(0,p).reduce((a,b)=>a+b,0);
  const dx=[];
  for(let i=p;i<tr.length;i++){
    trN=trN-(trN/p)+tr[i];
    plusN=plusN-(plusN/p)+plusDM[i];
    minusN=minusN-(minusN/p)+minusDM[i];
    const plusDI=trN>0?100*(plusN/trN):0;
    const minusDI=trN>0?100*(minusN/trN):0;
    const denom=plusDI+minusDI;
    dx.push(denom>0?100*Math.abs(plusDI-minusDI)/denom:0);
  }
  if(dx.length<p)return null;
  let value=dx.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for(let i=p;i<dx.length;i++)value=((value*(p-1))+dx[i])/p;
  return value;
}

export function calculateLadderV8Indicators(candles=[],cfg=LADDER_V8_DEFAULTS){
  const rows=candles.filter(c=>[c?.open,c?.high,c?.low,c?.close].every(Number.isFinite)).map(c=>({
    open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close),volume:finite(c.volume,finite(c.tickVolume,0))
  }));
  if(rows.length<Math.max(60,cfg.trendSlowEMA+cfg.adxPeriod*2))throw new Error("INSUFFICIENT_LADDER_V8_CANDLES");
  const closes=rows.map(x=>x.close);
  const emaFast=ema(closes,cfg.trendFastEMA);
  const emaSlow=ema(closes,cfg.trendSlowEMA);
  const adxValue=adx(rows,cfg.adxPeriod);
  const rsiValue=rsi(closes,cfg.rsiPeriod);
  const atrValue=atr(rows,cfg.atrPeriod);
  const price=closes.at(-1);
  const bull=emaFast!==null&&emaSlow!==null&&price>emaFast&&emaFast>emaSlow&&rsiValue!==null&&rsiValue>=cfg.rsiBullMin&&adxValue!==null&&adxValue>=cfg.adxMinStrength;
  const bear=emaFast!==null&&emaSlow!==null&&price<emaFast&&emaFast<emaSlow&&rsiValue!==null&&rsiValue<=cfg.rsiBearMax&&adxValue!==null&&adxValue>=cfg.adxMinStrength;
  const direction=bull?1:(bear?-1:0);
  return {
    price,emaFast,emaSlow,adx:adxValue,rsi:rsiValue,atr:atrValue,
    bullishEntry:bull,bearishEntry:bear,direction,
    entryQualified:direction!==0,
    fastAboveSlow:emaFast!==null&&emaSlow!==null?emaFast>emaSlow:null,
    priceAboveFast:emaFast!==null?price>emaFast:null,
    volume:rows.length?clamp(rows.at(-1).volume/(rows.slice(-20).reduce((a,b)=>a+b.volume,0)/Math.max(1,Math.min(20,rows.length))),0,3):0
  };
}

export function ladderRungLot(rungIndex,cfg=LADDER_V8_DEFAULTS){
  const i=Math.max(0,Math.floor(rungIndex));
  let lot;
  if(i<cfg.fixedRungCount){
    const t=cfg.fixedRungCount>1?i/(cfg.fixedRungCount-1):1;
    lot=cfg.baseLot+(cfg.maxLadderLot-cfg.baseLot)*t;
  }else{
    lot=cfg.maxLadderLot+cfg.aggressiveLotIncrement*(i-cfg.fixedRungCount+1);
  }
  return lot;
}

export function normalizeLot(lot,{minLot=0,maxLot=Infinity,step=0.01}={}){
  const n=finite(lot,0);
  const s=step>0?step:0.01;
  const floored=Math.floor(n/s+1e-12)*s;
  return Number(clamp(floored,minLot,maxLot).toFixed(12));
}

export function ladderLockStepPrice({baseLot,profitLockUSD,tickValue,tickSize,point}={}){
  const tv=finite(tickValue),ts=finite(tickSize),bl=finite(baseLot);
  if(tv<=0||ts<=0||bl<=0)return finite(point,0.00001)*100;
  const valuePerPricePerLot=tv/ts;
  return profitLockUSD/(bl*valuePerPricePerLot);
}

export function ladderLockPrice({anchorPrice,stepPrice,lockLevel,isBuy,stepOffset=0.3}={}){
  const lockDistance=Math.max(0,Math.floor(lockLevel))*stepPrice;
  return isBuy
    ? anchorPrice+lockDistance-(stepPrice*stepOffset)
    : anchorPrice-lockDistance+(stepPrice*stepOffset);
}

export function updateVelocitySamples(samples=[],price,timestampMs,cfg=LADDER_V8_DEFAULTS){
  const next=Array.isArray(samples)?samples.slice():[];
  const p=finite(price),t=Math.round(finite(timestampMs));
  if(p>0&&t>0)next.push({price:p,t});
  const max=Math.max(2,Math.round(cfg.velocityMaxSamples));
  return next.filter(x=>Number.isFinite(Number(x?.price))&&Number.isFinite(Number(x?.t))).slice(-max);
}

export function velocityPoints(samples=[],point,cfg=LADDER_V8_DEFAULTS){
  const pts=Array.isArray(samples)?samples.slice():[];
  if(pts.length<2||!(point>0))return 0;
  const latest=pts.at(-1);
  const target=Math.max(1,Number(cfg.velocityWindowMs)||500);
  const maxAge=Math.max(target,Math.min(3000,target*4));
  let oldest=null;
  for(let i=pts.length-1;i>=0;i--){
    if(latest.t-pts[i].t<=maxAge)oldest=pts[i];
    else break;
  }
  if(!oldest||latest.t<=oldest.t)return 0;
  return Math.abs(latest.price-oldest.price)/point*(target/(latest.t-oldest.t));
}

export function withinLadderSession(date=new Date(),cfg=LADDER_V8_DEFAULTS){
  const h=date.getUTCHours();
  const start=Math.max(0,Math.min(23,Number(cfg.sessionStartHour)));
  const end=Math.max(0,Math.min(23,Number(cfg.sessionEndHour)));
  // 0–23 represents an unrestricted 24-hour session. Do not create an\n  // artificial block during the final UTC hour.\n  if(start===0&&end===23)return true;\n  if(start<=end)return h>=start&&h<end;
  return h>=start||h<end;
}

export function ladderBasketRisk({volumes=[],stopDistance,tickSize,tickValue}={}){
  const sd=finite(stopDistance),ts=finite(tickSize),tv=finite(tickValue);
  if(sd<=0||ts<=0||tv<=0)return 0;
  return volumes.reduce((sum,lot)=>sum+((sd/ts)*tv*finite(lot)),0);
}
