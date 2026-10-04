import test from "node:test";
import assert from "node:assert/strict";
import { buildStrategyCouncil } from "../src/strategy-council.js";

const engine=(botId,score,fit=85,match=Math.abs(score)>=75)=>({
  botId,name:botId,score,fit,strategyMatch:match,signal:score>=75?"LONG_CANDIDATE":score<=-75?"SHORT_CANDIDATE":"NO_SIGNAL",reason:"test"
});

const aligned={higherTimeframeBias:"BULLISH",setupState:"BUY_CANDIDATE",triggerPresent:true,alignment:{direction:"BULLISH"}};

test("five aligned BUY engines produce BUY consensus",()=>{
  const r=buildStrategyCouncil([
    engine("strategic",90),engine("flipper",84),engine("breakout",80),engine("smc-pro",88),engine("ladder-flip",82)
  ],{multiTimeframe:aligned,marketDecision:"BUY"});
  assert.equal(r.state,"BUY");
  assert.equal(r.bullishVotes,5);
  assert.equal(r.strongestEngine.botId,"strategic");
  assert.equal(r.executionAuthorized,false);
});

test("3 BUY versus 2 SELL stays directionally calibrated rather than pretending unanimity",()=>{
  const r=buildStrategyCouncil([
    engine("strategic",90),engine("flipper",84),engine("breakout",80),engine("smc-pro",-88),engine("ladder-flip",-82)
  ],{multiTimeframe:aligned,marketDecision:"BUY"});
  assert.equal(r.state,"BUY");
  assert.equal(r.bullishVotes,3);
  assert.equal(r.bearishVotes,2);
  assert.ok(r.confidence < 92);
});

test("2 BUY, 2 SELL and 1 WAIT is conflicted",()=>{
  const r=buildStrategyCouncil([
    engine("strategic",90),engine("flipper",84),engine("breakout",-80),engine("smc-pro",-88),engine("ladder-flip",0,false)
  ],{multiTimeframe:aligned,marketDecision:"BUY",minAgreement:0.6});
  assert.equal(r.state,"CONFLICTED");
});

test("MTF conflict cannot authorize a trade",()=>{
  const r=buildStrategyCouncil([
    engine("strategic",90),engine("flipper",84),engine("breakout",80),engine("smc-pro",88),engine("ladder-flip",82)
  ],{multiTimeframe:{...aligned,higherTimeframeBias:"BEARISH",setupState:"CONFLICTED"},marketDecision:"BUY"});
  assert.equal(r.state,"CONFLICTED");
  assert.ok(r.confidence<=55);
});

test("no engine threshold produces WAIT",()=>{
  const r=buildStrategyCouncil([
    engine("strategic",50,70,false),engine("flipper",-40,65,false),engine("breakout",30,60,false)
  ],{multiTimeframe:aligned,marketDecision:"BUY"});
  assert.equal(r.state,"WAIT");
  assert.match(r.reason,/signal threshold/i);
});

test("hard risk block overrides consensus",()=>{
  const r=buildStrategyCouncil([
    engine("strategic",95),engine("flipper",90),engine("breakout",85),engine("smc-pro",88),engine("ladder-flip",82)
  ],{multiTimeframe:aligned,riskBlocks:["SPREAD_GATE"],marketDecision:"BUY"});
  assert.equal(r.state,"WAIT");
  assert.ok(r.whatToWait.some(x=>x.includes("SPREAD_GATE")));
});

test("adaptive performance adjusts score but cannot override hard risk",()=>{
  const r=buildStrategyCouncil([
    engine("strategic",95,100),engine("flipper",90,100),engine("breakout",85,100),engine("smc-pro",88,100),engine("ladder-flip",82,100)
  ],{multiTimeframe:aligned,riskBlocks:["BOT_KILL_SWITCH"],marketDecision:"BUY"});
  assert.equal(r.state,"WAIT");
  assert.equal(r.executionAuthorized,false);
});
