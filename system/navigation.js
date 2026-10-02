/* KINGBOT FINTECH — Global high-tech navigation shell */
(function(window, document){
  "use strict";

  const links = [
    ["index.html","Overview","⌂","Core platform"],
    ["markets.html","Markets","◈","Live market intelligence"],
    ["terminal.html","Terminal","⌁","Trading terminal"],
    ["bots.html","Bots","◉","Automated trading systems"],
    ["broker-connect.html","Broker Connect","⚡","Secure broker execution"],
    ["vps-dashboard.html","VPS Dashboard","▣","User-owned VPS & MT5 hosting"],
    ["partner-revenue.html","Partner Revenue","◌","Broker referral intelligence"],
    ["analytics.html","Analytics","▦","Performance intelligence"],
    ["reports.html","Reports","▤","Trading and account reports"],
    ["security-center.html","Security Center","⌾","Security and API credentials"],
    ["support-center.html","Support","✉","Customer support operations"],
    ["compliance.html","Compliance","◇","KYC and compliance center"],
    ["admin-entry.html","Admin OS","▣","Administrator command center","admin"],
    ["ai.html","AI Intelligence","✦","AI intelligence layer"],
    ["scanner.html","AI Scanner","◎","High-intelligence market scanner"],
    ["pattern.html","Patterns","◉","Pattern intelligence"],
    ["academy.html","Academy","◇","Education & research"],
    ["technical-analysis-ai-book.html","TA AI Book","▤","Technical analysis intelligence book"],
    ["about.html","About","◎","KINGBOT FINTECH"],
    ["contact.html","Contact","✉","Support & contact"],
    ["settings.html","Settings","⚙","Account controls"],
    ["legal.html","Legal Center","▤","Terms & risk disclosure"]
  ];

  const guestAccountLinks = [
    ["subscription.html","Subscription"],
    ["access-stable.html#signin","Sign in"],
    ["access-stable.html#signup","Create account"]
  ];

  const protectedPages = new Set([
    "index.html","terminal.html","analytics.html","ai.html","scanner.html",
    "bots.html","settings.html","subscription.html","broker-connect.html",
    "partner-revenue.html","pattern.html","vps-dashboard.html","reports.html",
    "security-center.html","support-center.html","compliance.html"
  ]);

  const API_BASE = "https://kingbot-fintech-api-etfv.onrender.com/api";

  function currentPage(){
    return (window.location.pathname.split("/").filter(Boolean).pop() || "index.html").toLowerCase();
  }

  function injectFallbackStyle(){
    if(document.getElementById("kb-compact-nav-style")) return;
    const style=document.createElement("style");
    style.id="kb-compact-nav-style";
    style.textContent=[
      "#kb-compact-nav{position:fixed;top:42px;right:14px;z-index:2147483000;font-family:Inter,system-ui,sans-serif}",
      "#kb-compact-nav .kb-nav-trigger{display:grid;place-items:center;border:1px solid rgba(255,255,255,.13);border-radius:17px;background:rgba(4,9,22,.9);color:#eef4ff;cursor:pointer}",
      "#kb-compact-nav .kb-menu{position:absolute;top:64px;right:0;opacity:0;pointer-events:none;visibility:hidden;transition:.18s}",
      "#kb-compact-nav .kb-menu.kb-open{opacity:1;pointer-events:auto;visibility:visible}"
    ].join("");
    document.head.appendChild(style);
  }

  function ensureRuntime(){
    if(window.KINGBOT_UI)return Promise.resolve(window.KINGBOT_UI);
    return new Promise(resolve=>{
      const existing=document.querySelector('script[data-kb-ui-runtime="true"]');
      if(existing){existing.addEventListener("load",()=>resolve(window.KINGBOT_UI||null),{once:true});setTimeout(()=>resolve(window.KINGBOT_UI||null),900);return;}
      const script=document.createElement("script");
      script.src=new URL("system/ui-runtime.js",window.location.href).href;
      script.dataset.kbUiRuntime="true";
      script.onload=()=>resolve(window.KINGBOT_UI||null);
      script.onerror=()=>resolve(null);
      document.head.appendChild(script);
    });
  }

  function escapeHtml(value){
    return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  }

  function accountMarkup(authState){
    const authenticated=Boolean(authState?.authenticated);
    const verified=Boolean(authState?.user?.verified);
    if(authenticated&&verified){
      const name=escapeHtml(String(authState.user?.name||authState.user?.email||"ACCOUNT").trim());
      return '<a href="index.html" data-kb-account>Dashboard</a>' +
        '<a href="subscription.html" data-kb-account>Subscription</a>' +
        '<a href="admin-entry.html" data-kb-account>Admin</a>' +
        '<a href="#" data-kb-logout>Logout · '+name+'</a>';
    }
    if(authenticated&&!verified){
      return '<a href="verify.html" data-kb-account>Verify email</a>' +
        '<a href="#" data-kb-signin>Continue</a>' +
        '<a href="access-stable.html#signin" data-kb-account>Sign in</a>';
    }
    return guestAccountLinks.map(([href,name])=>'<a href="'+href+'" data-kb-account>'+name+'</a>').join("");
  }

  async function resolveAuthState(){
    if(!window.KINGBOT_SESSION){
      try{await import(new URL("system/session.js",window.location.href).href);}catch{}
    }
    if(!window.KINGBOT_SESSION)return {authenticated:false,verified:false,user:null};
    try{return await window.KINGBOT_SESSION.check();}catch{return {authenticated:false,verified:false,user:null};}
  }

  function renderAccount(root,authState){
    const box=root?.querySelector(".kb-menu-account");
    if(!box)return;
    box.innerHTML=accountMarkup(authState);
    box.querySelector("[data-kb-logout]")?.addEventListener("click",async e=>{
      e.preventDefault();
      const logout=window.KINGBOT_SESSION?.logout;
      if(logout)await logout({redirect:true});
      else location.replace("access-stable.html#signin");
    });
    box.querySelector("[data-kb-signin]")?.addEventListener("click",e=>{
      e.preventDefault();
      location.replace("verify.html?return="+encodeURIComponent(window.location.pathname+window.location.search+window.location.hash));
    });
  }

  function protectNavClicks(root){
    root.querySelectorAll(".kb-menu-grid a[data-kb-protected]").forEach(a=>{
      a.addEventListener("click",async e=>{
        const state=window.KINGBOT_SESSION?.getState?.() || await resolveAuthState();
        if(!state.authenticated){
          e.preventDefault();
          location.replace("access-stable.html?return="+encodeURIComponent(a.getAttribute("href")||"")+"#signin");
          return;
        }
        if(!state.user?.verified){
          e.preventDefault();
          location.replace("verify.html?return="+encodeURIComponent(a.getAttribute("href")||""));
        }
      });
    });
  }

  async function refreshApiState(root){
    const pill=root?.querySelector("[data-kb-api-status]");
    if(!pill)return;
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),2500);
    try{
      const res=await fetch(API_BASE+"/health",{method:"GET",headers:{Accept:"application/json"},cache:"no-store",credentials:"omit",signal:controller.signal});
      const data=await res.json().catch(()=>({}));
      const live=res.ok && data?.ok!==false;
      pill.classList.toggle("is-live",live);
      pill.classList.toggle("is-offline",!live);
      const label=pill.querySelector("span");
      if(label)label.textContent=live?"API · LIVE":"API · OFFLINE";
    }catch{
      pill.classList.remove("is-live");
      pill.classList.add("is-offline");
      const label=pill.querySelector("span");
      if(label)label.textContent="API · OFFLINE";
    }finally{clearTimeout(timer);}
  }

  function themeControls(){
    return '<div class="kb-menu-control-row">' +
      '<span class="kb-menu-control-title">VISUAL CORE / THEME</span>' +
      '<span class="kb-menu-control-actions">' +
      '<button type="button" class="kb-menu-control-btn" data-kb-theme="cyan" aria-label="Use cyan theme">CYAN</button>' +
      '<button type="button" class="kb-menu-control-btn" data-kb-theme="violet" aria-label="Use violet theme">VIOLET</button>' +
      '<button type="button" class="kb-menu-control-btn" data-kb-theme="gold" aria-label="Use gold theme">GOLD</button>' +
      '</span></div>';
  }

  async function build(){
    if(document.getElementById("kb-compact-nav"))return;
    if(document.querySelector(".verify-shell,.auth-shell,.auth-card"))return;

    injectFallbackStyle();
    await ensureRuntime();

    const page=currentPage();
    const pageLinks=links.map(([href,name,icon,desc,role])=>{
      const active=href.toLowerCase()===page;
      const protectedAttr=protectedPages.has(href.toLowerCase())?' data-kb-protected="true"':'';
      const roleAttr=role==='admin'?' data-kb-role="admin"':'';
      return '<a href="'+href+'"'+(active?' class="kb-active"':'')+protectedAttr+roleAttr+'>' +
        '<span class="kb-menu-icon">'+icon+'</span>' +
        '<span><span class="kb-menu-name">'+name+'</span><span class="kb-menu-sub">'+desc+'</span></span>' +
        '</a>';
    }).join("");

    const authState=await resolveAuthState();
    const root=document.createElement("div");
    root.id="kb-compact-nav";
    root.innerHTML=
      '<a href="index.html" class="kb-brand-link" aria-label="KINGBOT Overview">' +
        '<img class="kb-fintech-logo" src="assets/images/kingbot-fintech-logo.png" alt="KINGBOT">' +
      '</a>' +
      '<button class="kb-nav-trigger" type="button" aria-label="Open navigation menu" aria-expanded="false">☰</button>' +
      '<div class="kb-menu" aria-hidden="true">' +
        themeControls() +
        '<div class="kb-menu-grid">'+pageLinks+'</div>' +
        '<div class="kb-menu-account">'+accountMarkup(authState)+'</div>' +
      '</div>';

    document.body.appendChild(root);

    const trigger=root.querySelector(".kb-nav-trigger");
    const menu=root.querySelector(".kb-menu");
    const close=()=>{
      menu.classList.remove("kb-open");
      menu.setAttribute("aria-hidden","true");
      trigger.setAttribute("aria-expanded","false");
    };
    const open=()=>{
      menu.classList.add("kb-open");
      menu.setAttribute("aria-hidden","false");
      trigger.setAttribute("aria-expanded","true");
    };

    trigger.addEventListener("click",()=>menu.classList.contains("kb-open")?close():open());
    root.querySelectorAll(".kb-menu-grid a,.kb-menu-account a").forEach(a=>a.addEventListener("click",close));
    document.addEventListener("keydown",e=>{if(e.key==="Escape")close();});

    root.querySelectorAll("[data-kb-theme]").forEach(btn=>{
      btn.addEventListener("click",()=>{
        window.KINGBOT_UI?.applyTheme(btn.dataset.kbTheme);
        const current=document.documentElement.dataset.kbTheme||"cyan";
        root.querySelectorAll("[data-kb-theme]").forEach(x=>x.setAttribute("aria-pressed",String(x.dataset.kbTheme===current)));
      });
    });

    renderAccount(root,authState);
    protectNavClicks(root);

    const status=document.createElement("div");
    status.className="kb-system-bar";
    status.innerHTML='<div class="kb-system-bar__inner">' +
      '<span class="kb-system-pill is-live"><i></i><span>SESSION · READY</span></span>' +
      '<span class="kb-system-pill" data-kb-api-status><i></i><span>API · CHECKING</span></span>' +
      '<span class="kb-system-pill"><i></i><span>EXECUTION · RISK-GATED</span></span>' +
      '<span class="kb-system-pill"><i></i><span>MODEL · NON-CUSTODIAL</span></span>' +
      '</div>';
    document.body.appendChild(status);

    await refreshApiState(status);
    const refreshTimer=setInterval(()=>refreshApiState(status),30000);

    window.addEventListener("pagehide",()=>clearInterval(refreshTimer),{once:true});
    window.addEventListener("kingbot:session-change",e=>renderAccount(root,e.detail||window.KINGBOT_SESSION?.getState?.()||{authenticated:false,verified:false}));

    window.KINGBOT_NAV={
      open,close,current:currentPage,
      refresh:async()=>renderAccount(root,await resolveAuthState()),
      apiRefresh:()=>refreshApiState(status)
    };
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",build,{once:true});
  else build();
})(window,document);
