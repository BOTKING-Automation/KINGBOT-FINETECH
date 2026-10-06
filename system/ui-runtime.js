/*
 * KINGBOT FINTECH — UI Runtime
 * UI-only utilities: theme persistence, evidence/freshness badges,
 * risk-meter rendering, safe action summaries, and accessible status toasts.
 */
(function(window, document){
  "use strict";

  const THEME_KEY = "kingbot_ui_theme";
  const THEMES = ["cyan","violet","gold","matrix","aurora"];

  function safeText(value, fallback="—"){
    const v=String(value ?? "").trim();
    return v || fallback;
  }

  function applyTheme(theme){
    const next=THEMES.includes(theme)?theme:"cyan";
    document.documentElement.dataset.kbTheme=next;
    try{window.localStorage.setItem(THEME_KEY,next);}catch{}
    document.querySelectorAll("[data-kb-theme]").forEach(btn=>{
      btn.setAttribute("aria-pressed", String(btn.dataset.kbTheme===next));
    });
    window.dispatchEvent(new CustomEvent("kingbot:theme-change",{detail:{theme:next}}));
    return next;
  }

  function initTheme(){
    let saved="cyan";
    try{saved=window.localStorage.getItem(THEME_KEY)||saved;}catch{}
    return applyTheme(saved);
  }

  function ageMs(timestamp){
    const t=Date.parse(String(timestamp||""));
    return Number.isFinite(t)?Math.max(0,Date.now()-t):null;
  }

  function formatAge(ms){
    if(ms==null)return "TIME UNAVAILABLE";
    if(ms<1000)return "UPDATED <1s AGO";
    const sec=Math.floor(ms/1000);
    if(sec<60)return "UPDATED "+sec+"s AGO";
    const min=Math.floor(sec/60);
    if(min<60)return "UPDATED "+min+"m AGO";
    return "UPDATED "+Math.floor(min/60)+"h AGO";
  }

  function decorateFreshness(root=document){
    root.querySelectorAll("[data-kb-freshness]").forEach(el=>{
      const timestamp=el.dataset.kbFreshness||el.getAttribute("data-timestamp");
      const maxAge=Math.max(250,Number(el.dataset.kbMaxAge||5000));
      const warningAge=Math.max(250,Number(el.dataset.kbWarningAge||Math.min(maxAge,2500)));
      let age=ageMs(timestamp);
      if(age==null && el.dataset.kbAgeValue==="true"){
        const match=String(el.textContent||"").match(/(-?\\d+(?:\\.\\d+)?)\\s*(ms|s|m|h)?/i);
        if(match){
          const n=Number(match[1]),unit=String(match[2]||"ms").toLowerCase();
          const multiplier=unit==="h"?3600000:unit==="m"?60000:unit==="s"?1000:1;
          age=Math.max(0,n*multiplier);
        }
      }
      el.classList.remove("is-live","is-warning","is-stale");
      if(age==null){
        el.classList.add("is-stale");
      }else if(age<=warningAge){
        el.classList.add("is-live");
      }else if(age<=maxAge){
        el.classList.add("is-warning");
      }else{
        el.classList.add("is-stale");
      }
      let fresh=el.querySelector(".kb-data-meta__fresh");
      if(!fresh){
        fresh=document.createElement("span");
        fresh.className="kb-data-meta__fresh";
        const dot=document.createElement("i");
        const label=document.createElement("span");
        fresh.append(dot,label);
        el.appendChild(fresh);
      }
      const label=fresh.querySelector("span");
      if(label)label.textContent=age==null?"TIME UNAVAILABLE":formatAge(age);
      const source=el.dataset.kbSource;
      let sourceEl=el.querySelector(".kb-data-meta__source");
      if(source){
        if(!sourceEl){
          sourceEl=document.createElement("span");
          sourceEl.className="kb-data-meta__source";
          el.insertBefore(sourceEl,fresh);
        }
        sourceEl.textContent="SOURCE · "+safeText(source).toUpperCase();
      }else{
        sourceEl?.remove();
      }
    });
  }

  function decorateRiskMeters(root=document){
    root.querySelectorAll("[data-kb-risk-meter]").forEach(meter=>{
      const value=Number(meter.dataset.value);
      const max=Math.max(Number(meter.dataset.max||100),0.000001);
      const pct=Number.isFinite(value)?Math.max(0,Math.min(100,value/max*100)):0;
      meter.style.setProperty("--kb-risk-pct",pct.toFixed(2)+"%");
      const fill=meter.querySelector(":scope > span");
      if(fill)fill.setAttribute("aria-valuenow",Number.isFinite(value)?String(value):"0");
    });
  }

  function showStatus(message,tone=""){
    let box=document.getElementById("kb-ui-status");
    if(!box){
      box=document.createElement("div");
      box.id="kb-ui-status";
      box.className="kb-ui-status";
      document.body.appendChild(box);
    }
    box.textContent=safeText(message);
    box.dataset.tone=tone;
    box.classList.add("is-visible");
    clearTimeout(showStatus.timer);
    showStatus.timer=setTimeout(()=>box.classList.remove("is-visible"),3600);
  }

  function confirmAction({title="CONFIRM ACTION",consequence="",actionLabel="CONTINUE",cancelLabel="CANCEL"}={}){
    const shell=document.createElement("div");
    shell.className="kb-modal-overlay";
    shell.setAttribute("role","dialog");
    shell.setAttribute("aria-modal","true");
    shell.innerHTML='<div class="kb-modal"><div class="kb-modal-kicker">KINGBOT / USER CONFIRMATION</div><h2></h2><p></p><div class="kb-modal-actions"><button type="button" data-cancel></button><button type="button" data-confirm></button></div></div>';
    shell.querySelector("h2").textContent=safeText(title,"CONFIRM ACTION");
    shell.querySelector("p").textContent=safeText(consequence,"Review the action before continuing.");
    shell.querySelector("[data-cancel]").textContent=cancelLabel;
    shell.querySelector("[data-confirm]").textContent=actionLabel;
    document.body.appendChild(shell);
    return new Promise(resolve=>{
      const done=value=>{shell.remove();resolve(value);};
      shell.querySelector("[data-cancel]").addEventListener("click",()=>done(false));
      shell.querySelector("[data-confirm]").addEventListener("click",()=>done(true));
      shell.addEventListener("click",e=>{if(e.target===shell)done(false);});
      const onKey=e=>{if(e.key==="Escape"){document.removeEventListener("keydown",onKey);done(false);}};
      document.addEventListener("keydown",onKey);
      shell.querySelector("[data-confirm]").focus();
    });
  }

  function initSafeActions(root=document){
    root.querySelectorAll("[data-kb-risk-action]").forEach(el=>{
      if(el.dataset.kbRiskBound==="1")return;
      el.dataset.kbRiskBound="1";
      el.addEventListener("click",async e=>{
        if(el.dataset.kbConfirmed==="true")return;
        const consequence=el.dataset.kbConsequence||el.getAttribute("title")||"This action may change trading state.";
        const ok=await confirmAction({
          title:el.dataset.kbActionTitle||"CONFIRM TRADING ACTION",
          consequence,
          actionLabel:el.dataset.kbActionLabel||"CONFIRM",
          cancelLabel:el.dataset.kbCancelLabel||"CANCEL"
        });
        if(!ok)e.preventDefault();
      },true);
    });
  }

  function currentPage(){
    return (window.location.pathname.split("/").filter(Boolean).pop() || "index.html").toLowerCase();
  }

  function applySurfaceClass(){
    const page=currentPage().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") || "index";
    document.body.classList.add("kb-ui-surface-"+page);
    document.body.dataset.kbSurface=page;
  }

  function injectAmbientLayer(){
    if(document.getElementById("kb-ambient-layer"))return;
    const layer=document.createElement("div");
    layer.id="kb-ambient-layer";
    layer.setAttribute("aria-hidden","true");
    layer.innerHTML='<span class="kb-ambient-beam kb-ambient-beam-a"></span><span class="kb-ambient-beam kb-ambient-beam-b"></span><span class="kb-ambient-beam kb-ambient-beam-c"></span><span class="kb-ambient-grid"></span>';
    document.body.prepend(layer);
  }

  function init(){
    initTheme();
    applySurfaceClass();
    injectAmbientLayer();
    document.body.classList.add("kb-ui-runtime-ready");
    decorateFreshness();
    decorateRiskMeters();
    initSafeActions();
    window.setInterval(()=>decorateFreshness(),1000);
    window.setInterval(()=>decorateRiskMeters(),1500);
    window.KINGBOT_UI={
      applyTheme,
      getTheme:()=>document.documentElement.dataset.kbTheme||"cyan",
      decorateFreshness,
      decorateRiskMeters,
      confirmAction,
      showStatus
    };
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});
  else init();
})(window,document);
