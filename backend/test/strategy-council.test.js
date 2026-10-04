import test from "node:test";
import assert from "node:assert/strict";
import { buildStrategyCouncil } from "../src/strategy-council.js";

const aligned={higherTimeframeBias:"BULLISH",setupState:"BUY_CANDIDATE",triggerPresent:true,alignment:{direction:"BULLISH"}};
const card=(botId,direction,score=85,confidence=85,extra={})=>({
  botId,strategyIdentity:botId+" specialist",direction,rawScore:direction==="SELL"?-score:score,
  confidence,conditions:["core condition"],missingConditions:[],entryConditions:["valid specialist setup"],
  waitConditions:[],invalidation:"test invalidation",evidenceUsed:["verified market evidence"],
  contradictions:[],strategyMatch:direction!=="WAIT",...extra
});
const engine=(botId,specialist,score=85)=>({botId,name:botId,score,fit:85,strategyMatch:true,signal:specialist.direction==="BUY"?"LONG_CANDIDATE":"SHORT_CANDIDATE",specialist});

test("a single valid specialist can lead without majority voting",()=>{
  const cards=[
    card("strategic","WAIT",0,0,{strategyMatch:false}),
    card("flipper","WAIT",0,0,{strategyMatch:false}),
    card("breakout","WAIT",0,0,{strategyMatch:false}),
    card("smc-pro","BUY",91,92),
    card("ladder-flip","WAIT",0,0,{strategyMatch:false})
  ];
  const r=buildStrategyCouncil(cards.map((s)=>engine(s.botId,s,s.rawScore)),{multiTimeframe:aligned,marketDecision:"BUY"});
  assert.equal(r.state,"BUY");
  assert.equal(r.primarySpecialist.botId,"smc-pro");
  assert.equal(r.bullishVotes,1);
  assert.equal(r.waitVotes,4);
});

test("SMC PRO can lead while Ladder Flip is recorded as independent dissent",()=>{
  const cards=[
    card("strategic","BUY",84,82),
    card("flipper","WAIT",0,0,{strategyMatch:false}),
    card("breakout","WAIT",0,0,{strategyMatch:false}),
    card("smc-pro","BUY",91,94),
    card("ladder-flip","SELL",78,78)
  ];
  const r=buildStrategyCouncil(cards.map((s)=>engine(s.botId,s)),{multiTimeframe:aligned,marketDecision:"BUY"});
  assert.equal(r.state,"BUY");
  assert.equal(r.primarySpecialist.botId,"smc-pro");
  assert.equal(r.supportingSpecialists[0].botId,"strategic");
  assert.equal(r.dissentingSpecialists[0].botId,"ladder-flip");
});

test("two strong opposing specialists create CONFLICTED state",()=>{
  const cards=[
    card("strategic","BUY",88,90),
    card("flipper","WAIT",0,0,{strategyMatch:false}),
    card("breakout","SELL",86,90),
    card("smc-pro","BUY",91,94),
    card("ladder-flip","WAIT",0,0,{strategyMatch:false})
  ];
  const r=buildStrategyCouncil(cards.map((s)=>engine(s.botId,s)),{multiTimeframe:aligned,marketDecision:"BUY"});
  assert.equal(r.state,"CONFLICTED");
  assert.ok(r.dissentingSpecialists.some(x=>x.botId==="breakout"));
  assert.ok(r.confidence<=55);
});

test("all five specialists waiting produces WAIT",()=>{
  const cards=["strategic","flipper","breakout","smc-pro","ladder-flip"].map(id=>card(id,"WAIT",0,0,{strategyMatch:false}));
  const r=buildStrategyCouncil(cards.map((s)=>engine(s.botId,s)),{multiTimeframe:aligned,marketDecision:"BUY"});
  assert.equal(r.state,"WAIT");
  assert.equal(r.waitVotes,5);
});

test("market evidence conflict blocks otherwise valid specialist",()=>{
  const s=card("smc-pro","BUY",91,94);
  const r=buildStrategyCouncil([engine("smc-pro",s)],{multiTimeframe:{...aligned,higherTimeframeBias:"BEARISH",setupState:"CONFLICTED"},marketDecision:"BUY"});
  assert.equal(r.state,"CONFLICTED");
  assert.ok(r.confidence<=55);
});

test("hard risk block overrides specialist consensus",()=>{
  const s=card("smc-pro","BUY",95,98);
  const r=buildStrategyCouncil([engine("smc-pro",s)],{multiTimeframe:aligned,riskBlocks:["SPREAD_GATE"],marketDecision:"BUY"});
  assert.equal(r.state,"WAIT");
  assert.ok(r.whatToWait.some(x=>x.includes("SPREAD_GATE")));
  assert.equal(r.executionAuthorized,false);
});
