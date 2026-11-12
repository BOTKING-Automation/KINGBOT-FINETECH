import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCortexMultiTimeframeEntry } from "../src/cortex-mtf-entry-engine.js";

function makeFrame(direction = "BULLISH", overrides = {}) {
  const base = {
    ok:true,fresh:true,ageSinceCloseMs:1000,freshnessLimitMs:300000,barCount:120,
    lastClosedBarTime:"2026-11-12T08:00:00.000Z",
    lastClosedBar:{open:100,high:102,low:99,close:101.8},
    technical:{
      trend:direction,structure:direction.toLowerCase(),adx:25,rsi14:60,
      momentum:direction==="BULLISH"?0.7:-0.7,atr14:2,close:101.8,
      breakout:true,breakoutDirection:direction,bosDirection:direction,bos:direction,
      displacementDirection:direction,retestDirection:"NONE",liquiditySweepDirection:"NONE",
      fairValueGapDirection:direction,orderBlock:{direction},
      marketStructure:{lastSwingHigh:106,lastSwingLow:100.5}
    }
  };
  return {...base,...overrides,technical:{...base.technical,...(overrides.technical||{})}};
}
function qualifiedInput(overrides={}) {
  const frames={
    "1d":makeFrame(),"4h":makeFrame(),"1h":makeFrame(),"15m":makeFrame(),
    "5m":makeFrame("BULLISH",{technical:{marketStructure:{lastSwingHigh:106,lastSwingLow:100.5}}})
  };
  for(const [timeframe,patch] of Object.entries(overrides.frames||{})){
    frames[timeframe]=makeFrame(patch.direction||"BULLISH",patch);
  }
  const {frames:frameOverrides,...rest}=overrides;
  return {
    frames,quote:{available:true,price:101.9,bid:101.85,ask:101.95,ageMs:200},
    ...rest
  };
}
test("only a fully aligned, fresh and cost-aware multi-timeframe setup qualifies",()=>{
  const result=evaluateCortexMultiTimeframeEntry(qualifiedInput());
  assert.equal(result.signal,"ENTRY_CONFIRMING");assert.equal(result.entryEligible,true);
  assert.equal(result.side,"BUY");assert.ok(result.riskReward>=1.8);
  assert.ok(result.sl<result.entry);assert.ok(result.tp2>result.entry);
  assert.equal(Object.values(result.gates).every(Boolean),true);
});
test("a single conflicting higher timeframe blocks the entry",()=>{
  const result=evaluateCortexMultiTimeframeEntry(qualifiedInput({frames:{"4h":{direction:"BEARISH"}}}));
  assert.equal(result.signal,"NO_TRADE");assert.equal(result.entryEligible,false);
  assert.equal(result.entry,null);assert.equal(result.gates.higherTimeframeAgreement,false);
});
test("missing or stale timeframe data can never qualify an entry",()=>{
  const input=qualifiedInput();delete input.frames["1h"];
  const missing=evaluateCortexMultiTimeframeEntry(input);
  assert.equal(missing.signal,"WAIT");assert.equal(missing.entryEligible,false);
  assert.ok(missing.missingTimeframes.includes("1h"));
  const stale=evaluateCortexMultiTimeframeEntry(qualifiedInput({frames:{"15m":{fresh:false}}}));
  assert.equal(stale.entryEligible,false);assert.equal(stale.dataStatus,"INCOMPLETE");
});
test("a trend without a completed execution trigger remains WAIT",()=>{
  const result=evaluateCortexMultiTimeframeEntry(qualifiedInput({
    frames:{"5m":{technical:{
      breakoutDirection:"NONE",bosDirection:"NONE",bos:"NONE",
      displacementDirection:"NONE",liquiditySweepDirection:"NONE",retestDirection:"NONE"
    }}}
  }));
  assert.equal(result.signal,"WAIT");assert.equal(result.entryEligible,false);
  assert.equal(result.gates.confirmedExecutionTrigger,false);
});
test("stale quotes, wide spreads and weak reward-to-risk are rejected",()=>{
  const stale=evaluateCortexMultiTimeframeEntry(qualifiedInput({
    quote:{available:true,price:101.9,bid:101.8,ask:102,ageMs:5000}
  }));
  assert.equal(stale.entryEligible,false);assert.equal(stale.gates.freshTwoSidedQuote,false);
  const wide=evaluateCortexMultiTimeframeEntry(qualifiedInput({
    quote:{available:true,price:101.9,bid:101.4,ask:102.4,ageMs:200}
  }));
  assert.equal(wide.entryEligible,false);assert.equal(wide.gates.spreadCost,false);
  const poorRR=evaluateCortexMultiTimeframeEntry(qualifiedInput({
    frames:{
      "5m":{technical:{marketStructure:{lastSwingHigh:102.1,lastSwingLow:100.9}}},
      "15m":{technical:{marketStructure:{lastSwingHigh:102.1,lastSwingLow:100.9}}},
      "1h":{technical:{marketStructure:{lastSwingHigh:102.1,lastSwingLow:100.9}}},
      "4h":{technical:{marketStructure:{lastSwingHigh:102.1,lastSwingLow:100.9}}}
    }
  }));
  assert.equal(poorRR.entryEligible,false);assert.equal(poorRR.gates.rewardToRisk,false);
});
