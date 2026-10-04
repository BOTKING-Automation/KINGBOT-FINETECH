import test from "node:test";
import assert from "node:assert/strict";
import { orchestrateKingbotIntelligence } from "../src/intelligence-orchestrator.js";

const now=new Date().toISOString();
const mtf={timeframes:[
  {timeframe:"5m",ok:true,trend:"BULLISH",bos:"BULLISH",choch:"BULLISH",liquiditySweep:"BULLISH",displacement:"BULLISH"},
  {timeframe:"15m",ok:true,trend:"BULLISH",bos:"BULLISH",choch:"BULLISH",liquiditySweep:"BULLISH",displacement:"BULLISH"},
  {timeframe:"1h",ok:true,trend:"BULLISH",bos:"BULLISH",choch:"BULLISH",liquiditySweep:"NONE",displacement:"BULLISH"},
  {timeframe:"4h",ok:true,trend:"BULLISH",bos:"BULLISH",choch:"NONE",liquiditySweep:"NONE",displacement:"BULLISH"}
],requiredTimeframes:["5m","15m","1h","4h"],higherTimeframeBias:"BULLISH",lowerTimeframeBias:"BULLISH",triggerPresent:true,setupState:"BUY_CANDIDATE",alignment:{direction:"BULLISH",bullish:4,bearish:0,total:4,required:4,ratio:1,htfBias:"BULLISH",ltfBias:"BULLISH",conflict:false}};

const market={
  symbol:"XAUUSD",timeframe:"15m",price:2000,bid:1999.9,ask:2000.1,spread:.2,atr:10,volatility:.45,
  trend:.8,momentum:.8,structure:"bullish",rawTrend:.8,rawStructure:"bullish",
  rawBos:"BULLISH",rawChoch:"BULLISH",rawLiquiditySweep:"BULLISH",liquiditySweep:"BULLISH",
  rawDisplacement:"BULLISH",displacement:"BULLISH",orderBlock:{direction:"BULLISH"},fairValueGap:true,
  breakout:false,retest:false,adx:25,rsi:58,emaFast:2010,emaSlow:1990,receivedAt:now,quoteTimestamp:now,barTime:now,multiTimeframe:mtf
};

test("orchestrator exposes five specialists and stays fresh with live receivedAt",async()=>{
  const result=await orchestrateKingbotIntelligence({market,riskContext:{executionMode:"DEMO"},options:{botId:null},adaptivePerformance:{}});
  assert.equal(result.ok,true);
  assert.equal(result.market.freshness.ok,true);
  assert.equal(result.market.freshnessMode,"LIVE_QUOTE");
  assert.equal(result.specialists.length,5);
  assert.ok(result.specialists.every(x=>x.botId));
  assert.equal(result.strategyCouncil.state,"BUY");
  assert.ok(result.strategyCouncil.primarySpecialist);
  assert.equal(result.routing.primarySpecialist,result.strategyCouncil.primarySpecialist.botId);
  assert.equal(result.execution.authorized,false);
  assert.deepEqual(result.riskCouncil.blocks,[]);
});

test("orchestrator blocks deterministically when market telemetry is stale",async()=>{
  const stale={...market,quoteTimestamp:new Date(Date.now()-60000).toISOString(),receivedAt:new Date(Date.now()-60000).toISOString(),barTime:new Date(Date.now()-60000).toISOString()};
  const result=await orchestrateKingbotIntelligence({market:stale,riskContext:{executionMode:"DEMO"},options:{botId:null},adaptivePerformance:{}});
  assert.ok(result.riskCouncil.blocks.includes("STALE_MARKET_DATA"));
  assert.equal(result.execution.authorized,false);
  assert.notEqual(result.decisionGate.state,"BUY");
});