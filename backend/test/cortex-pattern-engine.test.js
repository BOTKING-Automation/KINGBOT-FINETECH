import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const engineSource=readFileSync(new URL("../../system/cortex-pattern-engine.js",import.meta.url),"utf8");
const sandbox={};vm.createContext(sandbox);vm.runInContext(engineSource,sandbox);
const engine=sandbox.KINGBOT_CORTEX_PATTERNS;

function makeBars(closes,step=300){
  return closes.map((close,index)=>{
    const previous=index?closes[index-1]:close-0.1;
    const open=previous+(close>=previous?-0.1:0.1);
    return {time:1700000000+index*step,open,high:Math.max(open,close)+0.25,low:Math.min(open,close)-0.25,close,volume:100+index};
  });
}
test("pattern engine identifies a completed bullish engulfing candle",()=>{
  const closes=Array(30).fill(100);closes[28]=98;closes[29]=103;
  const bars=makeBars(closes);
  bars[28]={...bars[28],open:101,high:101.5,low:97.5,close:98};
  bars[29]={...bars[29],open:97.8,high:103.5,low:97.3,close:103};
  const result=engine.analyze(bars,"5m",Date.now()),pattern=result.patterns.find(item=>item.type==="BULLISH_ENGULFING");
  assert.equal(result.ok,true);assert.ok(pattern);assert.equal(pattern.state,"CONFIRMED");assert.equal(pattern.direction,"BULLISH");
  assert.equal(pattern.points.at(-1).time,bars.at(-1).time);
});
test("double top requires a completed neckline break and supplies a measured target",()=>{
  const closes=[100,101,103,106,109,106,103,101,100,101,103,106,109,106,103,101,100,101,103,106,109.1,106,103,100,97];
  const bars=makeBars(closes),result=engine.analyze(bars,"5m",Date.now()),pattern=result.patterns.find(item=>item.type==="DOUBLE_TOP");
  assert.ok(pattern);assert.equal(pattern.state,"CONFIRMED");assert.equal(pattern.direction,"BEARISH");
  assert.ok(pattern.trigger.price>bars.at(-1).close);assert.ok(pattern.target.price<pattern.trigger.price);assert.ok(pattern.lines.length>=2);
});
test("forming candle is excluded from confirmation to avoid repainting",()=>{
  const now=Date.now(),interval=300,currentBucket=Math.floor(now/(interval*1000))*interval;
  const bars=Array.from({length:30},(_,index)=>{
    const close=100+Math.sin(index/2);
    return {time:currentBucket-(29-index)*interval,open:close-0.1,high:close+0.3,low:close-0.3,close};
  });
  const result=engine.analyze(bars,"5m",now);
  assert.equal(result.activeBarExcluded,true);assert.equal(result.barCount,29);
  assert.equal(result.activeBarTime,currentBucket);assert.equal(result.latestClosedBarTime,currentBucket-interval);
});
test("malformed OHLC rows are discarded and insufficient history produces no patterns",()=>{
  const bars=makeBars(Array(25).fill(100));bars[6]={...bars[6],low:bars[6].high+2};
  const result=engine.analyze(bars.slice(0,19),"5m",Date.now());
  assert.equal(result.ok,false);assert.equal(result.reason,"INSUFFICIENT_CLOSED_BARS");
  const normalized=engine.normalizeBars(bars,"5m",Date.now());
  assert.equal(normalized.bars.some(bar=>bar.time===bars[6].time),false);
});
