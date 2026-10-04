import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketEvidence, marketDecisionGate } from "../src/market-evidence-engine.js";

const fresh=new Date().toISOString();

test("Cortex evidence engine returns BUY only with aligned verified evidence",()=>{
  const m={symbol:"XAUUSD",price:2500,timestamp:fresh,quoteTimestamp:fresh,barTime:fresh,
    trend:"BULLISH",structure:"BULLISH",bos:"BULLISH",choch:"BULLISH",liquiditySweep:"BULLISH",
    ema20:2501,ema50:2495,rsi14:60,momentum:.8,
    multiTimeframe:{timeframes:[
      {timeframe:"5m",ok:true,trend:"BULLISH",signal:"ENTRY_CONFIRMING",score:80},
      {timeframe:"15m",ok:true,trend:"BULLISH",signal:"ENTRY_CONFIRMING",score:82},
      {timeframe:"1h",ok:true,trend:"BULLISH",signal:"ENTRY_CONFIRMING",score:85}
    ]}};
  const e=buildMarketEvidence(m);
  assert.equal(e.decision,"BUY");
  assert.equal(marketDecisionGate(e,[]).state,"BUY");
  assert.equal(marketDecisionGate(e,[]).allowed,true);
});

test("Cortex blocks stale data",()=>{
  const stale=new Date(Date.now()-120000).toISOString();
  const e=buildMarketEvidence({price:2500,timestamp:stale,barTime:stale,trend:"BULLISH"});
  assert.equal(e.decision,"DATA_INSUFFICIENT");
  assert.equal(marketDecisionGate(e,[]).allowed,false);
});

test("Cortex treats mixed timeframe evidence as conflicted",()=>{
  const e=buildMarketEvidence({price:2500,timestamp:fresh,barTime:fresh,trend:"BULLISH",ema20:1,ema50:0,momentum:.5,
    multiTimeframe:{timeframes:[
      {timeframe:"5m",ok:true,trend:"BULLISH",score:70},
      {timeframe:"1h",ok:true,trend:"BEARISH",score:70}
    ]}});
  assert.equal(e.multiTimeframe.direction,"MIXED");
  assert.equal(e.decision,"CONFLICTED");
  assert.equal(marketDecisionGate(e,[]).state,"CONFLICTED");
});

test("Risk blockers always override an otherwise aligned market",()=>{
  const e=buildMarketEvidence({price:2500,timestamp:fresh,barTime:fresh,trend:"BULLISH",structure:"BULLISH",bos:"BULLISH",
    ema20:1,ema50:0,rsi14:60,momentum:.8,multiTimeframe:{timeframes:[{timeframe:"15m",ok:true,trend:"BULLISH"}]}});
  const gate=marketDecisionGate(e,["GLOBAL_KILL_SWITCH"]);
  assert.equal(gate.state,"BLOCKED");
  assert.equal(gate.allowed,false);
});
