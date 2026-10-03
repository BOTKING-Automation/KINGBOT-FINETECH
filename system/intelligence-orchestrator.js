/*
 KINGBOT INTELLIGENCE ORCHESTRATOR — FRONTEND CONTROL SURFACE
 Live data is requested from the secured backend. This module is advisory only.
*/
(function(window){
  "use strict";

  const state={busy:false,last:null,timer:null};
  const API_BASE=(window.KINGBOT_FIREBASE?.API_BASE||"https://kingbot-fintech-api-etfv.onrender.com/api");

  const $=id=>document.getElementById(id);
  const text=(id,value)=>{const el=$(id);if(el)el.textContent=String(value??"—");};
  const esc=value=>String(value??"").replace(/[&<>"]/g,m=>m==="&"?"&amp;":m==="<"?"&lt;":m===">"?"&gt;":"&quot;");
  const tone=value=>String(value||"").toUpperCase();
  const fmt=n=>Number.isFinite(Number(n))?Number(n).toFixed(0):"—";

  async function token(force=false){
    if(window.KINGBOT_SESSION?.check){
      const s=await window.KINGBOT_SESSION.check({force});
      if(!s?.authenticated)throw new Error("Please sign in to run KINGBOT Intelligence.");
      if(!s?.user?.verified)throw new Error("Verify your email before using KINGBOT Intelligence.");
    }
    const user=window.KINGBOT_FIREBASE?.auth?.currentUser;
    if(!user)throw new Error("Please sign in to run KINGBOT Intelligence.");
    if(!user.emailVerified)throw new Error("Verify your email before using KINGBOT Intelligence.");
    return user.getIdToken(Boolean(force));
  }

  async function request(path,options={}){
    const run=async force=>{
      const headers={Accept:"application/json","Content-Type":"application/json"};
      headers.Authorization="Bearer "+await token(force);
      return fetch(API_BASE+path,{...options,headers,credentials:"omit",cache:"no-store"});
    };
    let r=await run(false);
    if(r.status===401)r=await run(true);
    const d=await r.json().catch(()=>({}));
    if(!r.ok||d.ok===false)throw new Error(d.error||d.reason||d.message||("HTTP "+r.status));
    return d;
  }

  function render(data){
    state.last=data;
    const s=data.summary||{};
    const routing=data.routing||{};
    const risk=data.riskCouncil||{};
    const debate=data.debate||{};
    const market=data.market||{};
    const identity=data.identity||{};
    const cognitive=data.cognitive||{};
    const cognitivePlan=cognitive.plan||{};
    text("orchRegime",s.regime||"—");
    text("orchBias",s.bias||debate.direction||"NEUTRAL");
    text("orchConfidence",Number.isFinite(Number(s.confidence))?Math.round(Number(s.confidence))+" / 100":"—");
    text("orchEngine",routing.selectedEngine||"NO ROUTE");
    text("orchState",risk.status||"—");
    text("orchSymbol",market.symbol||"—");
    text("orchTimeframe",String(market.timeframe||"—").toUpperCase());
    text("orchFreshness",market.freshness?.ok?"FRESH":"STALE / UNKNOWN");
    text("orchUpdated",data.generatedAt?new Date(data.generatedAt).toLocaleTimeString():"—");
    text("identityDeliberation",data.cognitive?.plan?.thinking?.label||data.adaptive?.thinkingLevel||"EXPERT");
    text("identityReasoning","NATIVE MULTI-PASS");
    text("identityState","COGNITIVE PASS ACTIVE");
    text("identityMode",cognitivePlan.mode||"MARKET INTELLIGENCE");
    text("identityCapabilities",Array.isArray(cognitive.capabilities)?cognitive.capabilities.join(" · "):"PERCEPTION · REASONING · VERIFICATION");
    text("identityMission",identity.mission||"Observe verified state, reason, challenge, adapt, verify and explain.");
    text("identityAuthority",identity.authority||"ANALYSIS AND COORDINATION ONLY");
    text("identityVersion",identity.version||"3.0.0");

    const agentList=$("orchAgents");
    if(agentList){
      agentList.innerHTML=(data.analysts||[]).map(a=>
        '<div class="orch-agent"><div><span>'+esc(a.name)+'</span><small>'+esc(a.status||"—")+'</small></div><strong>'+esc(fmt(a.score))+'</strong></div>'
      ).join("")||'<div class="orch-empty">NO ANALYST STATE</div>';
    }

    const engineList=$("orchEngines");
    if(engineList){
      const rows=[...(data.engines||[])].sort((a,b)=>Number(b.fit||0)-Number(a.fit||0));
      engineList.innerHTML=rows.map(e=>{
        const selected=e.botId===routing.selectedEngine;
        return '<div class="orch-engine '+(selected?"selected":"")+'"><div><span>'+esc(e.name)+'</span><small>'+esc(e.botId)+' · '+esc(e.signal||"NO_SIGNAL")+'</small></div><strong>'+esc(fmt(e.fit))+'</strong></div>';
      }).join("")||'<div class="orch-empty">NO ENGINE EVALUATIONS</div>';
    }

    const bull=$("orchBull"),bear=$("orchBear");
    if(bull)bull.innerHTML=(debate.bullCase||[]).slice(0,6).map(x=>'<div>+ '+esc(x)+'</div>').join("")||'<div class="orch-muted">No bullish evidence supplied.</div>';
    if(bear)bear.innerHTML=(debate.bearCase||[]).slice(0,6).map(x=>'<div>− '+esc(x)+'</div>').join("")||'<div class="orch-muted">No bearish evidence supplied.</div>';

    const riskFlags=[...(risk.blocks||[]),...(risk.flags||[])];
    text("orchRiskStatus",risk.status||"—");
    const riskList=$("orchRiskList");
    if(riskList)riskList.innerHTML=riskFlags.length
      ? riskFlags.map(x=>'<span class="orch-chip bad">'+esc(x)+'</span>').join("")
      : '<span class="orch-chip good">NO DETERMINISTIC BLOCKERS</span>';

    const plan=data.tradePlan||null;
    text("orchPlanEngine",plan?.botId||routing.selectedEngine||"—");
    text("orchPlanSide",plan?.side||routing.direction||"HOLD");
    text("orchPlanEntry",plan?.entryPrice!=null?fmt(plan.entryPrice):(market.price!=null?fmt(market.price):"—"));
    text("orchPlanSL",plan?.stopLoss!=null?fmt(plan.stopLoss):"—");
    text("orchPlanTP",plan?.takeProfit!=null?fmt(plan.takeProfit):"—");
    text("orchPlanRR",plan?.riskReward!=null?String(plan.riskReward)+"R":"—");
    text("orchPlanState",data.execution?.authorized?"AUTHORIZED":"ANALYSIS ONLY");

    const adaptive=data.adaptive||{};
    text("biasCardState",adaptive.decisionState||"STANDBY");
    text("biasCardBias",s.bias||debate.direction||"NEUTRAL");
    text("biasCardRegime",s.regime||"—");
    text("biasCardConfidence",Number.isFinite(Number(s.confidence))?Math.round(Number(s.confidence))+" / 100":"—");
    text("biasCardSetup",adaptive.setupType||"—");
    text("biasCardInvalidation",plan?.stopLoss!=null?fmt(plan.stopLoss):"WAIT FOR VALID SETUP");
    text("biasCardDecision",adaptive.decisionId||"—");

    const evidence=$("biasCardEvidence");
    if(evidence){
      const facts=[];
      for(const a of (data.analysts||[]).slice(0,4)){
        const signal=a.bias&&String(a.bias).toUpperCase()!=="NEUTRAL" ? (" · "+a.bias) : "";
        facts.push(String(a.name||"ANALYST")+signal);
      }
      if(routing.candidate)facts.push("ROUTED: "+String(routing.candidate.name||routing.selectedEngine));
      if(risk.blocks?.length)facts.push("BLOCKERS: "+risk.blocks.join(", "));
      evidence.innerHTML=facts.slice(0,5).map(x=>"<div>• "+esc(x)+"</div>").join("")||"No structured evidence.";
    }

    const adaptiveMemory=$("biasCardMemory");
    if(adaptiveMemory){
      const adaptiveRows=Array.isArray(data.engines)?data.engines.filter(e=>Number(e.historicalSampleSize||0)>0):[];
      const bestSample=adaptiveRows.reduce((max,e)=>Math.max(max,Number(e.historicalSampleSize||0)),0);
      const adaptiveCount=adaptiveRows.filter(e=>e.adaptationState==="ADAPTIVE").length;
      adaptiveMemory.innerHTML=adaptiveCount
        ? esc(adaptiveCount)+" engine(s) have enough settled outcomes to influence fit · max sample "+esc(bestSample)
        : "Baseline routing active · historical sample thresholds not yet met.";
    }

    const adaptiveTable=$("adaptiveEngineTable");
    if(adaptiveTable){
      const rows=[...(data.engines||[])].sort((a,b)=>Number(b.fit||0)-Number(a.fit||0));
      adaptiveTable.innerHTML=rows.map(e=>{
        const selected=e.botId===routing.selectedEngine;
        const current=fmt(e.currentFit);
        const historical=e.historicalReliable?fmt(e.historicalFit):"BASE";
        const adjusted=fmt(e.fit);
        const samples=Number(e.historicalSampleSize||0);
        const delta=Number(e.adaptiveAdjustment||0);
        return '<div style="display:grid;grid-template-columns:1.6fr .8fr .8fr .9fr .7fr .7fr;gap:7px;align-items:center;padding:8px;border:1px solid '+(selected?"rgba(25,230,255,.28)":"rgba(255,255,255,.05)")+';border-radius:9px;background:'+(selected?"rgba(25,230,255,.05)":"rgba(255,255,255,.015)")+'"><div><strong style="font:900 8px JetBrains Mono">'+esc(e.name||e.botId)+'</strong><small style="display:block;color:var(--muted);font:700 7px JetBrains Mono">'+esc(e.adaptationState||"BASELINE")+'</small></div><span style="font:800 8px JetBrains Mono">NOW "+esc(current)+"</span><span style="font:800 8px JetBrains Mono">HIST "+esc(historical)+"</span><span style="font:900 8px JetBrains Mono">FIT "+esc(adjusted)+"</span><span style="font:800 8px JetBrains Mono">N="+esc(samples)+"</span><span style="font:800 8px JetBrains Mono">Δ "+esc(delta>=0?"+":"")+esc(delta)+"</span></div>';
      }).join("")||'<div class="orch-muted">No adaptive engine context.</div>';
    }

    const note=$("orchSummary");
    if(note)note.textContent=String(s.summary||"KINGBOT completed the intelligence pass without execution authority.");

    const provider=data.aiSynthesis?.provider||"deterministic";
    text("orchProvider",provider.toUpperCase());
  }

  async function loadSyntheticOptions(){
    const select=$("symbolSelect");
    if(!select || select.dataset.syntheticLoaded==="1") return;
    try{
      const response=await fetch(API_BASE.replace(/\/api\/?$/,"")+"/api/markets/synthetics",{cache:"no-store"});
      if(!response.ok)return;
      const data=await response.json().catch(()=>({}));
      const markets=Array.isArray(data.markets)?data.markets:[];
      for(const item of markets.slice(0,40)){
        const id=String(item.symbol||"").trim().toUpperCase();
        if(!id || [...select.options].some(o=>o.value===id))continue;
        const option=document.createElement("option");
        option.value=id;
        option.textContent=String(item.name||id);
        select.appendChild(option);
      }
      select.dataset.syntheticLoaded="1";
    }catch{}
  }

  async function run(){
    if(state.busy)return;
    state.busy=true;
    const button=$("runOrchestrator");
    if(button){button.disabled=true;button.textContent="ORCHESTRATING…";}
    text("orchLiveState","COLLECTING EVIDENCE");
    try{
      const symbol=$("symbolSelect")?.value||"XAUUSD";
      const timeframe=$("timeframeSelect")?.value||"15m";
      const data=await request("/ai/intelligence/orchestrate",{
        method:"POST",
        body:JSON.stringify({symbol,timeframe,thinkingLevel:$("thinkingLevelSelect")?.value||"EXPERT"})
      });
      render(data);
      text("orchLiveState","ORCHESTRATOR ONLINE");
      const toast=$("toast");
      if(toast){toast.textContent="Multi-agent market intelligence synchronized.";toast.dataset.tone="good";toast.classList.add("show");setTimeout(()=>toast.classList.remove("show"),2600);}
    }catch(error){
      text("orchLiveState","ORCHESTRATOR ERROR");
      const toast=$("toast");
      if(toast){toast.textContent=error?.message||"Intelligence orchestrator unavailable.";toast.dataset.tone="bad";toast.classList.add("show");setTimeout(()=>toast.classList.remove("show"),3000);}
    }finally{
      state.busy=false;
      if(button){button.disabled=false;button.textContent="RUN INTELLIGENCE";}
    }
  }

  function wire(){
    void loadSyntheticOptions();
    $("runOrchestrator")?.addEventListener("click",run);
    $("symbolSelect")?.addEventListener("change",()=>{if(state.last)run();});
    $("timeframeSelect")?.addEventListener("change",()=>{if(state.last)run();});
    window.addEventListener("kingbot:session-change",()=>{state.last=null;text("orchLiveState","AUTH CONTEXT CHANGED");});
    if(!state.timer)state.timer=setInterval(()=>{if(document.visibilityState==="visible"&&!state.busy)run();},45000);
    window.setTimeout(run,1400);
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",wire,{once:true});
  else wire();

  window.KINGBOT_ORCHESTRATOR={run,getState:()=>({...state})};
})(window);
