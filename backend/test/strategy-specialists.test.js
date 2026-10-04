import test from "node:test";
import assert from "node:assert/strict";
import { evaluateStrategySpecialists } from "../src/strategy-specialists.js";

const mtf={higherTimeframeBias:"BULLISH",lowerTimeframeBias:"BULLISH",setupState:"BUY_CANDIDATE",triggerPresent:true,alignment:{direction:"BULLISH"}};
const base={
  symbol:"XAUUSD",price:2500,atr:5,trend:.7,momentum:.6,volatility:.45,
  structure:"bullish",emaFast:2502,emaSlow:2495,adx:25,rsi:58,
  breakout:false,retest:false,liquiditySweep:false,orderBlock:false,fairValueGap:false,
  displacement:false,rawBos:"NONE",rawChoch:"NONE",rawLiquiditySweep:"NONE",rawDisplacement:"NONE"
};

test("Strategic can qualify from trend/confluence without SMC conditions",()=>{
  const cards=evaluateStrategySpecialists({market:base,multiTimeframe:mtf,regime:{regime:"TRENDING"}});
  const c=cards.find(x=>x.botId==="strategic");
  assert.equal(c.direction,"BUY");
  assert.equal(c.strategyMatch,true);
  assert.equal(cards.find(x=>x.botId==="smc-pro").direction,"WAIT");
});

test("Flipper uses reversal evidence and does not require a breakout",()=>{
  const market={...base,trend:-.2,momentum:.6,structure:"bullish",rsi:40,rawLiquiditySweep:"BULLISH",rawChoch:"BULLISH",rawDisplacement:"BULLISH"};
  const cards=evaluateStrategySpecialists({market,multiTimeframe:{...mtf,lowerTimeframeBias:"BULLISH"}});
  const flipper=cards.find(x=>x.botId==="flipper");
  assert.equal(flipper.direction,"BUY");
  assert.equal(market.breakout,false);
});

test("Breakout waits until breakout and retest are both confirmed",()=>{
  const pre=evaluateStrategySpecialists({market:{...base,breakout:true,retest:false},multiTimeframe:mtf});
  assert.equal(pre.find(x=>x.botId==="breakout").direction,"WAIT");
  const confirmed=evaluateStrategySpecialists({market:{...base,breakout:true,retest:true},multiTimeframe:mtf});
  assert.equal(confirmed.find(x=>x.botId==="breakout").direction,"BUY");
});

test("SMC PRO qualifies from a coherent liquidity/structure sequence",()=>{
  const market={...base,rawLiquiditySweep:"BULLISH",rawDisplacement:"BULLISH",rawBos:"BULLISH",orderBlock:true,fairValueGap:true};
  const c=evaluateStrategySpecialists({market,multiTimeframe:mtf}).find(x=>x.botId==="smc-pro");
  assert.equal(c.direction,"BUY");
  assert.equal(c.strategyMatch,true);
  assert.ok(c.conditions.length>=4);
});

test("Ladder Flip requires its own EMA/ADX/RSI gate",()=>{
  const good=evaluateStrategySpecialists({market:base,multiTimeframe:mtf}).find(x=>x.botId==="ladder-flip");
  assert.equal(good.direction,"BUY");
  const bad=evaluateStrategySpecialists({market:{...base,adx:12},multiTimeframe:mtf}).find(x=>x.botId==="ladder-flip");
  assert.equal(bad.direction,"WAIT");
});

test("all specialists can independently wait when their conditions are absent",()=>{
  const market={...base,trend:.1,momentum:.05,structure:"range",emaFast:2490,emaSlow:2500,adx:10,rsi:50,breakout:false,retest:false};
  const cards=evaluateStrategySpecialists({market,multiTimeframe:{...mtf,setupState:"WAIT",higherTimeframeBias:"MIXED"}});
  assert.ok(cards.every(x=>x.direction==="WAIT"));
});
