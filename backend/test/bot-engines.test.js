import test from "node:test";
import assert from "node:assert/strict";
import { evaluateBot } from "../src/bot-engines.js";

function frames(direction="BUY"){
  const trend=direction==="BUY"?.72:-.72;
  return {
    regime:{timeframe:"4h",available:true,atr:2,trend,momentum:trend,structure:direction==="BUY"?"bullish":"bearish"},
    setup:{timeframe:"1h",available:true,atr:1.2,trend,momentum:trend,structure:direction==="BUY"?"bullish":"bearish"},
    execution:{timeframe:"15m",available:true,atr:.8,trend,momentum:trend,structure:direction==="BUY"?"bullish":"bearish"}
  };
}

function market(direction="BUY"){
  const buy=direction==="BUY";
  const sign=buy?1:-1;
  return {
    symbol:"XAUUSD",
    timeframe:"15m",
    price:buy?2505:2495,
    entryPrice:buy?2505:2495,
    spread:.08,
    atr:1,
    volatility:.45,
    trend:.82*sign,
    momentum:.72*sign,
    volume:.85,
    structure:buy?"bullish":"bearish",
    emaFast:buy?2502:2498,
    emaSlow:buy?2495:2505,
    adx:30,
    rsi:buy?60:40,
    velocityPoints:.55*sign,
    rawLiquiditySweep:buy?"BULLISH":"BEARISH",
    rawChoch:buy?"BULLISH":"BEARISH",
    rawDisplacement:buy?"BULLISH":"BEARISH",
    rawBos:buy?"BULLISH":"BEARISH",
    orderBlock:{direction:buy?"BULLISH":"BEARISH",high:2504,low:2501},
    fairValueGap:true,
    fairValueGapDirection:buy?"BULLISH":"BEARISH",
    breakout:true,
    breakoutDirection:buy?"BULLISH":"BEARISH",
    retest:true,
    retestDirection:buy?"BULLISH":"BEARISH",
    candleCount:100,
    timeframeProfile:{regime:"4h",setup:"1h",execution:"15m"},
    multiTimeframe:frames(direction)
  };
}

test("all five engines can qualify only when their own setup and MTF evidence align",()=>{
  const ids=["strategic","flipper","breakout","smc-pro","ladder-flip"];
  for(const id of ids){
    const result=evaluateBot(id,market("BUY"));
    assert.equal(result.ok,true,id);
    assert.equal(result.signal,"LONG_CANDIDATE",id);
    assert.equal(result.qualified,true,id);
    assert.equal(result.executionAuthorized,false,id);
    assert.equal(result.multiTimeframe.ready,true,id);
  }
});

test("all five engines preserve bearish score direction and candidate direction",()=>{
  const ids=["strategic","flipper","breakout","smc-pro","ladder-flip"];
  for(const id of ids){
    const result=evaluateBot(id,market("SELL"));
    assert.equal(result.signal,"SHORT_CANDIDATE",id);
    assert.ok(result.score<0,id);
    assert.equal(result.direction,"SELL",id);
  }
});

test("Strategic waits when timeframe evidence is absent",()=>{
  const snapshot=market("BUY");
  delete snapshot.multiTimeframe;
  const result=evaluateBot("strategic",snapshot);
  assert.equal(result.signal,"NO_SIGNAL");
  assert.equal(result.qualified,false);
  assert.equal(result.multiTimeframe.ready,false);
});

test("Breakout does not qualify on the first range cross without a separate retest",()=>{
  const snapshot={...market("BUY"),retest:false,retestDirection:"WAIT"};
  const result=evaluateBot("breakout",snapshot);
  assert.equal(result.signal,"NO_SIGNAL");
  assert.equal(result.qualified,false);
  assert.match(result.reason,/retest/i);
});

test("SMC waits when OB and FVG directional confirmation is not complete",()=>{
  const snapshot={...market("BUY"),fairValueGap:false,fairValueGapDirection:"NONE"};
  const result=evaluateBot("smc-pro",snapshot);
  assert.equal(result.signal,"NO_SIGNAL");
  assert.equal(result.qualified,false);
});

test("Ladder Flip waits when EMA separation is too small for ATR",()=>{
  const snapshot={...market("BUY"),emaFast:100.01,emaSlow:100,price:100.02,atr:1};
  const result=evaluateBot("ladder-flip",snapshot);
  assert.equal(result.signal,"NO_SIGNAL");
  assert.equal(result.qualified,false);
});

test("a timeframe direction conflict blocks an otherwise strong candidate",()=>{
  const snapshot=market("BUY");
  snapshot.multiTimeframe.setup={...snapshot.multiTimeframe.setup,trend:-.7,structure:"bearish"};
  const result=evaluateBot("strategic",snapshot);
  assert.equal(result.signal,"NO_SIGNAL");
  assert.equal(result.multiTimeframe.conflict,true);
});

test("market analysis refuses snapshots without ATR",()=>{
  const snapshot={...market("BUY"),atr:0};
  const result=evaluateBot("strategic",snapshot);
  assert.equal(result.ok,false);
  assert.equal(result.status,"DATA_BLOCKED");
  assert.equal(result.reason,"ATR_REQUIRED");
});
