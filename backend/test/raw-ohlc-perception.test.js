import test from "node:test";
import assert from "node:assert/strict";
import { deriveTechnicalFromBars } from "../src/ai-market-scanner.js";

function makeBars(count=140){
  return Array.from({length:count},(_,i)=>{
    const base=1900+i*1.2+Math.sin(i/4)*2;
    const open=base;
    const close=base+1.0;
    const high=close+0.8;
    const low=open-0.8;
    return {datetime:new Date(Date.now()-(count-i)*300000).toISOString(),open,high,low,close,volume:100+i};
  });
}

test("raw OHLC perception returns structure and confluence fields",()=>{
  const result=deriveTechnicalFromBars(makeBars());
  assert.ok(result);
  assert.equal(result.trend,"BULLISH");
  assert.ok(["bullish","range","bearish"].includes(result.structure));
  assert.ok(["BULLISH","BEARISH","NONE"].includes(result.bos));
  assert.ok(["BULLISH","BEARISH","NONE"].includes(result.choch));
  assert.ok(["BULLISH","BEARISH","NONE"].includes(result.liquiditySweep));
  assert.ok(["BULLISH","BEARISH","NONE"].includes(result.displacement));
  assert.equal(typeof result.fvg,"boolean");
  assert.ok(result.marketStructure);
  assert.ok(result.swingPoints);
  assert.equal(result.source,"KINGBOT raw OHLC perception engine");
});

test("raw OHLC perception rejects insufficient candles",()=>{
  assert.equal(deriveTechnicalFromBars(makeBars(79)),null);
});
