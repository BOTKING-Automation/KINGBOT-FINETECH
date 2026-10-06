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

  const THEME_PRESETS=Object.freeze({
    cyan:{bg0:"#02040a",bg1:"#050a18",bg2:"#0a1228",panel:"#081326",text:"#eef4ff",muted:"#8490a8",cyan:"#19e6ff",blue:"#4787ff",violet:"#9b5cff",pink:"#ff4fd8",gold:"#f6b93b",gold2:"#ffd977",green:"#23f7a3",red:"#ff4d6d"},
    violet:{bg0:"#05020a",bg1:"#0b0618",bg2:"#170b2f",panel:"#100b21",text:"#f5efff",muted:"#aa9bbc",cyan:"#b77cff",blue:"#7c6cff",violet:"#9b5cff",pink:"#ff4fd8",gold:"#d9adff",gold2:"#f0d9ff",green:"#68ffc4",red:"#ff6a9d"},
    gold:{bg0:"#080602",bg1:"#110b03",bg2:"#211405",panel:"#171007",text:"#fff7e7",muted:"#b6a486",cyan:"#46e8ff",blue:"#4d9dff",violet:"#b477ff",pink:"#ff70dc",gold:"#f6b93b",gold2:"#ffe49a",green:"#5dffbd",red:"#ff6d78"},
    matrix:{bg0:"#000804",bg1:"#01130a",bg2:"#032115",panel:"#03150c",text:"#eafff2",muted:"#78a98d",cyan:"#35ff9a",blue:"#16d66e",violet:"#2dff83",pink:"#70ffbd",gold:"#b6ff4a",gold2:"#d6ff9b",green:"#35ff9a",red:"#ff667d"},
    aurora:{bg0:"#02050d",bg1:"#071128",bg2:"#102149",panel:"#0b1730",text:"#edf5ff",muted:"#8d9ab6",cyan:"#2de2ff",blue:"#5d7dff",violet:"#a66bff",pink:"#ff65c7",gold:"#67ffd7",gold2:"#c1fff0",green:"#58ffd2",red:"#ff668d"}
  });

  function ensureThemeBridge(){
    if(document.getElementById("kb-theme-bridge"))return;
    const style=document.createElement("style");
    style.id="kb-theme-bridge";
    const blocks=Object.entries(THEME_PRESETS).map(([name,p])=>`
      html[data-kb-theme="${name}"]{
        --bg:${p.bg0};
        --bg-0:${p.bg0};
        --bg-1:${p.bg1};
        --bg-2:${p.bg2};
        --panel:${p.panel};
        --panel2:${p.bg2};
        --panel-strong:${p.panel};
        --line:rgba(255,255,255,.12);
        --text:${p.text};
        --txt:${p.text};
        --t:${p.text};
        --muted:${p.muted};
        --m:${p.muted};
        --cyan:${p.cyan};
        --blue:${p.blue};
        --violet:${p.violet};
        --pink:${p.pink};
        --gold:${p.gold};
        --g:${p.gold};
        --gold2:${p.gold2};
        --gold-2:${p.gold2};
        --green:${p.green};
        --ok:${p.green};
        --red:${p.red};
        --bad:${p.red};
        --a:${p.cyan};
        --b:${p.violet};
        --l:rgba(255,255,255,.12);
        --p:${p.panel};
        --kb-bg-0:${p.bg0};
        --kb-bg-1:${p.bg1};
        --kb-bg-2:${p.bg2};
        --kb-panel:rgba(8,13,27,.84);
        --kb-panel-strong:rgba(7,12,26,.94);
        --kb-text:${p.text};
        --kb-text-soft:rgba(238,242,255,.76);
        --kb-text-dim:rgba(238,242,255,.48);
        --kb-cyan:${p.cyan};
        --kb-blue:${p.blue};
        --kb-violet:${p.violet};
        --kb-pink:${p.pink};
        --kb-gold:${p.gold};
        --kb-gold-2:${p.gold2};
        --kb-green:${p.green};
        --kb-red:${p.red};
        --kb-border:rgba(255,255,255,.10);
        --kb-border-gold:color-mix(in srgb,${p.gold} 34%, transparent);
        --kb-border-cyan:color-mix(in srgb,${p.cyan} 30%, transparent);
      }
      html[data-kb-theme="${name}"] body{
        background:
          radial-gradient(circle at 8% 0%,color-mix(in srgb,${p.cyan} 10%, transparent),transparent 30%),
          radial-gradient(circle at 92% 8%,color-mix(in srgb,${p.violet} 10%, transparent),transparent 30%),
          linear-gradient(180deg,${p.bg0},${p.bg1}) !important;
        color:${p.text} !important;
      }
      html[data-kb-theme="${name}"] ::selection{
        background:color-mix(in srgb,${p.cyan} 28%, transparent);
        color:#fff;
      }
      html[data-kb-theme="${name}"] ::-webkit-scrollbar-thumb{
        background:color-mix(in srgb,${p.cyan} 34%, transparent);
      }
      html[data-kb-theme="${name}"] ::-webkit-scrollbar-thumb:hover{
        background:color-mix(in srgb,${p.gold} 48%, transparent);
      }
      html[data-kb-theme="${name}"] a:not(.kb-fintech-logo){
        color:var(--cyan);
      }
      html[data-kb-theme="${name}"] input,
      html[data-kb-theme="${name}"] select,
      html[data-kb-theme="${name}"] textarea{
        accent-color:var(--cyan);
      }
      html[data-kb-theme="${name}"] .kb-menu,
      html[data-kb-theme="${name}"] .kb-panel,
      html[data-kb-theme="${name}"] .kb-kpi{
        background:
          linear-gradient(145deg,
            color-mix(in srgb,${p.bg2} 92%, transparent),
            color-mix(in srgb,${p.bg0} 96%, transparent));
        border-color:color-mix(in srgb,${p.cyan} 24%, rgba(255,255,255,.08));
        box-shadow:0 25px 80px rgba(0,0,0,.38),0 0 30px color-mix(in srgb,${p.cyan} 9%, transparent);
      }
      html[data-kb-theme="${name}"] .kb-nav-trigger{
        background:color-mix(in srgb,${p.bg1} 92%, transparent);
        border-color:color-mix(in srgb,${p.cyan} 28%, rgba(255,255,255,.12));
        box-shadow:0 12px 38px rgba(0,0,0,.42),0 0 24px color-mix(in srgb,${p.cyan} 13%, transparent);
      }
      html[data-kb-theme="${name}"] .kb-system-pulse{
        border-color:color-mix(in srgb,${p.green} 22%, transparent);
      }
      html[data-kb-theme="${name}"] #kb-ai-float{
        box-shadow:0 18px 55px rgba(0,0,0,.52),0 0 26px color-mix(in srgb,${p.cyan} 20%, transparent),0 0 42px color-mix(in srgb,${p.violet} 12%, transparent);
      }
      html[data-kb-theme="${name}"] #kb-ai-float .kb-ai-orb{
        background:linear-gradient(145deg,${p.bg2},${p.panel});
        box-shadow:inset 0 0 18px color-mix(in srgb,${p.cyan} 10%, transparent);
      }
    `).join("\n");
    style.textContent=blocks;
    document.head.appendChild(style);
  }

  function applyTheme(theme){
    const next=THEMES.includes(theme)?theme:"cyan";
    ensureThemeBridge();
    document.documentElement.dataset.kbTheme=next;
    try{window.localStorage.setItem(THEME_KEY,next);}catch{}
    const meta=document.querySelector('meta[name="theme-color"]');
    if(meta){
      const preset=THEME_PRESETS[next]||THEME_PRESETS.cyan;
      meta.setAttribute("content",preset.bg0);
    }
    document.querySelectorAll("[data-kb-theme]").forEach(btn=>{
      btn.setAttribute("aria-pressed", String(btn.dataset.kbTheme===next));
    });
    document.querySelectorAll("[data-theme-choice]").forEach(btn=>{
      btn.setAttribute("aria-pressed", String(btn.dataset.themeChoice===next));
    });
    window.dispatchEvent(new CustomEvent("kingbot:theme-change",{detail:{theme:next}}));
    return next;
  }

  function initTheme(){
    ensureThemeBridge();
    let saved="cyan";
    try{saved=window.localStorage.getItem(THEME_KEY)||saved;}catch{}
    applyTheme(saved);
    void hydrateAccountTheme();
    return saved;
  }

  async function hydrateAccountTheme(){
    try{
      const mod=await import("./firebase-auth.js");
      const fb=window.KINGBOT_FIREBASE || mod?.KINGBOT_FIREBASE;
      if(!fb?.getProfile)return;
      const profile=await fb.getProfile();
      const accountTheme=THEMES.includes(profile?.theme)?profile.theme:null;
      if(accountTheme && accountTheme!==getCurrentTheme()){
        applyTheme(accountTheme);
      }else if(accountTheme){
        applyTheme(accountTheme);
      }
    }catch{}
  }

  function getCurrentTheme(){
    return document.documentElement.dataset.kbTheme||"cyan";
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
    ensureThemeBridge();
    initTheme();
    applySurfaceClass();
    injectAmbientLayer();
    document.body.classList.add("kb-ui-runtime-ready");
    window.addEventListener("storage",event=>{
      if(event.key===THEME_KEY && THEMES.includes(event.newValue)) applyTheme(event.newValue);
    });
    decorateFreshness();
    decorateRiskMeters();
    initSafeActions();
    window.setInterval(()=>decorateFreshness(),1000);
    window.setInterval(()=>decorateRiskMeters(),1500);
    window.KINGBOT_UI={
      applyTheme,
      getTheme:getCurrentTheme,
      themes:THEMES.slice(),
      decorateFreshness,
      decorateRiskMeters,
      confirmAction,
      showStatus
    };
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});
  else init();
})(window,document);
