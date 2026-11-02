import test from "node:test";
import assert from "node:assert/strict";
import { calculateMarketIndicators } from "../src/worker-market-perception.js";

function flatBars(count=100){
  return Array.from({length:count},(_,i)=>({
    time:new Date(Date.now()-(count-i)*60000).toISOString(),
    open:100,
    high:100.05,
    low:99.95,
    close:100.005,
    volume:100
  }));
}

function trendBars(count=100,direction=1){
  return Array.from({length:count},(_,i)=>{
    const base=100+direction*i*.08+Math.sin(i/3)*.015;
    const open=base;
    const close=base+direction*.05;
    return {
      time:new Date(Date.now()-(count-i)*60000).toISOString(),
      open,
      high:Math.max(open,close)+.03,
      low:Math.min(open,close)-.03,
      close,
      volume:100+i
    };
  });
}

test("market perception requires a sufficient OHLC history window",()=>{
  assert.throws(()=>calculateMarketIndicators(flatBars(59)),/INSUFFICIENT_HISTORICAL_CANDLES/);
  const result=calculateMarketIndicators(flatBars(100));
  assert.equal(result.candleCount,100);
  assert.ok(result.atr>0);
  assert.ok(Number.isFinite(result.adx));
  assert.ok(Number.isFinite(result.rsi));
});

test("market perception distinguishes the first breakout from a later retest",()=>{
  const firstBreak=flatBars(100);
  firstBreak[99]={...firstBreak[99],open:100.05,high:100.60,low:100.04,close:100.52};
  const first=calculateMarketIndicators(firstBreak);
  assert.equal(first.breakout,true);
  assert.equal(first.retest,false);
  assert.equal(first.breakoutDirection,"BULLISH");

  const retest=flatBars(100);
  retest[98]={...retest[98],open:100.05,high:100.60,low:100.03,close:100.52};
  retest[99]={...retest[99],open:100.45,high:100.58,low:100.06,close:100.53};
  const confirmed=calculateMarketIndicators(retest);
  assert.equal(confirmed.breakout,true);
  assert.equal(confirmed.retest,true);
  assert.equal(confirmed.retestDirection,"BULLISH");
  assert.equal(confirmed.breakoutDirection,"BULLISH");
});

test("liquidity sweep requires a wick through the range and a directional close back inside",()=>{
  const bars=flatBars(100);
  bars[99]={...bars[99],open:99.96,high:100.02,low:99.50,close:100.01};
  const result=calculateMarketIndicators(bars);
  assert.equal(result.liquiditySweep,true);
  assert.equal(result.liquiditySweepDirection,"BULLISH");
});

test("a large wick without a strong directional body is not displacement",()=>{
  const bars=flatBars(100);
  bars[99]={...bars[99],open:100,high:101,low:99,close:100.04};
  const result=calculateMarketIndicators(bars);
  assert.equal(result.displacement,false);
  assert.equal(result.displacementDirection,"NONE");
});

test("normalized velocity follows the recent price direction",()=>{
  const bullish=calculateMarketIndicators(trendBars(100,1));
  const bearish=calculateMarketIndicators(trendBars(100,-1));
  assert.ok(bullish.velocityScore>0);
  assert.ok(bearish.velocityScore<0);
  assert.ok(Number.isFinite(bullish.momentum));
  assert.ok(Number.isFinite(bearish.momentum));
});

test("a gap is included in true-range ATR rather than using candle range only",()=>{
  const bars=flatBars(100);
  bars[99]={time:bars[99].time,open:101,high:101.5,low:100.9,close:101.4,volume:100};
  const result=calculateMarketIndicators(bars);
  assert.ok(result.atr>0.12);
});
