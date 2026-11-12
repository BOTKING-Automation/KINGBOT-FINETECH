import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCortexMultiTimeframeEntry, toCouncilMultiTimeframe, applyCortexCouncilApproval } from "../src/cortex-mtf-entry-engine.js";

const TIMEFRAME_MS = { "1d":86400000, "4h":14400000, "1h":3600000, "15m":900000, "5m":300000 };

function makeFrame(timeframe, direction = "BULLISH", overrides = {}) {
  const closeMs = Date.now() - 1000;
  const openMs = closeMs - TIMEFRAME_MS[timeframe];
  const base = {
    timeframe,ok:true,fresh:true,ageSinceCloseMs:1000,freshnessLimitMs:300000,barCount:120,
    lastClosedBarTime:new Date(openMs).toISOString(),
    lastBarCloseTime:new Date(closeMs).toISOString(),
    lastClosedBar:{time:Math.floor(openMs/1000),open:100,high:102,low:99,close:101.8},
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
    "1d":makeFrame("1d"),"4h":makeFrame("4h"),"1h":makeFrame("1h"),"15m":makeFrame("15m"),
    "5m":makeFrame("5m","BULLISH",{technical:{marketStructure:{lastSwingHigh:106,lastSwingLow:100.5}}})
  };
  for(const [timeframe,patch] of Object.entries(overrides.frames||{})){
    frames[timeframe]=makeFrame(timeframe,patch.direction||"BULLISH",patch);
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

test("a timeframe cannot borrow another timeframe's candles or timestamps",()=>{
  const wrongIdentity=evaluateCortexMultiTimeframeEntry(qualifiedInput({
    frames:{"4h":{timeframe:"15m"}}
  }));
  assert.equal(wrongIdentity.entryEligible,false);
  assert.ok(wrongIdentity.staleTimeframes.includes("4h"));
  const wrongInterval=evaluateCortexMultiTimeframeEntry(qualifiedInput({
    frames:{"1h":{lastBarCloseTime:new Date(Date.now()-1000-30*60*1000).toISOString()}}
  }));
  assert.equal(wrongInterval.entryEligible,false);
  assert.ok(wrongInterval.staleTimeframes.includes("1h"));
});

test("negative quote age and malformed closed-candle OHLC are rejected",()=>{
  const negativeAge=evaluateCortexMultiTimeframeEntry(qualifiedInput({
    quote:{available:true,price:101.9,bid:101.85,ask:101.95,ageMs:-5}
  }));
  assert.equal(negativeAge.entryEligible,false);
  assert.equal(negativeAge.gates.freshTwoSidedQuote,false);
  const malformed=evaluateCortexMultiTimeframeEntry(qualifiedInput({
    frames:{"5m":{lastClosedBar:{open:101,high:100,low:99,close:101.8}}}
  }));
  assert.equal(malformed.entryEligible,false);
  assert.equal(malformed.gates.confirmedExecutionTrigger,false);
});


test("specialist adapter preserves all five verified timeframe frames", () => {
  const frames = Object.fromEntries(["1d","4h","1h","15m","5m"].map(timeframe => [
    timeframe,
    {
      ok:true,fresh:true,barCount:120,ageSinceCloseMs:1000,lastClosedBarTime:"2026-11-12T08:00:00.000Z",
      technical:{
        trend:"BULLISH",structure:"bullish",atr14:2,rsi14:60,adx14:25,momentum:0.7,
        ema20:101,ema50:99,bos:"BULLISH",displacementDirection:"BULLISH"
      }
    }
  ]));
  const adapted = toCouncilMultiTimeframe(frames,{entryEligible:true,side:"BUY",signal:"ENTRY_CONFIRMING",gates:{confirmedExecutionTrigger:true}});
  assert.equal(adapted.timeframes.length,5);
  assert.equal(adapted.timeframes.find(frame=>frame.timeframe==="4h").atr,2);
  assert.equal(adapted.timeframes.find(frame=>frame.timeframe==="15m").atr,2);
  assert.equal(adapted.timeframes.find(frame=>frame.timeframe==="5m").atr,2);
  assert.equal(adapted.setupState,"BUY_CANDIDATE");
  assert.equal(adapted.timeframes.every(frame=>frame.available&&frame.atr===2),true);
  assert.equal("regime" in adapted,false);
  assert.equal("setup" in adapted,false);
  assert.equal("execution" in adapted,false);
});

test("stale timeframe evidence is passed to the Council as unavailable", () => {
  const frames = Object.fromEntries(["1d","4h","1h","15m","5m"].map(timeframe => [
    timeframe,{ok:true,fresh:true,barCount:120,technical:{trend:"BULLISH",structure:"bullish",atr14:2}}
  ]));
  frames["4h"]={ok:true,fresh:false,barCount:120,technical:{trend:"BULLISH",structure:"bullish",atr14:2}};
  const adapted=toCouncilMultiTimeframe(frames,{entryEligible:false,signal:"WAIT"});
  assert.equal(adapted.regime.available,false);
  assert.equal(adapted.setupState,"DATA_INSUFFICIENT");
});

test("technical BUY is downgraded when Strategy Council disagrees", () => {
  const candidate={entryEligible:true,signal:"ENTRY_CONFIRMING",side:"BUY",entry:100,sl:98,tp1:102,tp2:104,blockedReasons:[]};
  const result=applyCortexCouncilApproval(candidate,{
    strategyCouncil:{state:"SELL"},routing:{direction:"SELL",selectedEngine:"smc-pro"},
    tradePlan:{ok:true},riskCouncil:{blocks:[]}
  });
  assert.equal(result.signal,"WAIT");
  assert.equal(result.entryEligible,false);
  assert.equal(result.entry,null);
  assert.equal(result.councilApproval.approved,false);
});

test("technical BUY is downgraded when council specialist or risk validation is missing", () => {
  const candidate={entryEligible:true,signal:"ENTRY_CONFIRMING",side:"BUY",entry:100,sl:98,tp1:102,tp2:104,blockedReasons:[]};
  const noPlan=applyCortexCouncilApproval(candidate,{
    strategyCouncil:{state:"BUY"},routing:{direction:"BUY",selectedEngine:"strategic"},
    tradePlan:null,riskCouncil:{blocks:[]}
  });
  assert.equal(noPlan.entryEligible,false);
  const riskBlocked=applyCortexCouncilApproval(candidate,{
    strategyCouncil:{state:"BUY"},routing:{direction:"BUY",selectedEngine:"strategic"},
    tradePlan:{ok:true},riskCouncil:{blocks:["STALE_MARKET_DATA"]}
  });
  assert.equal(riskBlocked.entryEligible,false);
  assert.ok(riskBlocked.blockedReasons.some(value=>String(value).includes("STALE_MARKET_DATA")));
});

test("a matching Council route and clean risk review can approve an MTF candidate", () => {
  const candidate={entryEligible:true,signal:"ENTRY_CONFIRMING",side:"BUY",entry:100,sl:98,tp1:102,tp2:104,blockedReasons:[]};
  const result=applyCortexCouncilApproval(candidate,{
    strategyCouncil:{state:"BUY"},routing:{direction:"BUY",selectedEngine:"strategic"},
    tradePlan:{ok:true},riskCouncil:{blocks:[]}
  });
  assert.equal(result.entryEligible,true);
  assert.equal(result.councilApproval.approved,true);
  assert.equal(result.councilApproval.selectedEngine,"strategic");
});
