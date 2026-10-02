/* KINGBOT FINTECH — Global Command Navigator v2 */
(function(window, document){
  "use strict";

  const GROUPS = [
    {
      id:"trade",
      label:"TRADE & EXECUTION",
      icon:"◈",
      items:[
        ["index.html","Overview","⌂","Core platform command view"],
        ["markets.html","Markets","◈","Live market intelligence"],
        ["terminal.html","Terminal","⌁","Execution terminal & telemetry"],
        ["bots.html","Bots","◉","Five automated trading engines"],
        ["broker-connect.html","Broker Connect","⚡","Broker authorization & account binding"],
        ["vps-dashboard.html","VPS Dashboard","▣","MT5 / VPS runtime hosting"]
      ]
    },
    {
      id:"intelligence",
      label:"INTELLIGENCE",
      icon:"✦",
      items:[
        ["analytics.html","Analytics","▦","Performance & risk intelligence"],
        ["reports.html","Reports","▤","Trading and account reports"],
        ["ai.html","AI Intelligence","✦","KINGBOT intelligence console"],
        ["scanner.html","AI Scanner","◎","Live market scanning"],
        ["pattern.html","Patterns","◉","Pattern intelligence"],
        ["technical-analysis-ai-book.html","TA AI Book","▤","Technical analysis research"],
        ["academy.html","Academy","◇","Education & research"]
      ]
    },
    {
      id:"account",
      label:"ACCOUNT & OPERATIONS",
      icon:"◇",
      items:[
        ["profile.html","Profile","◎","Identity & account profile"],
        ["subscription.html","Subscription","◆","Plan & access management"],
        ["partner-revenue.html","Partner Revenue","◌","Broker referral intelligence"],
        ["security-center.html","Security Center","⌾","Security & credentials"],
        ["compliance.html","Compliance","◇","KYC & compliance center"],
        ["support-center.html","Support","✉","Customer support operations"],
        ["settings.html","Settings","⚙","Account controls"]
      ]
    },
    {
      id:"company",
      label:"COMPANY",
      icon:"◎",
      items:[
        ["about.html","About","◎","KINGBOT FINTECH"],
        ["contact.html","Contact","✉","Client services & partnerships"],
        ["legal.html","Legal Center","▤","Terms, privacy & risk disclosure"],
        ["admin-entry.html","Admin OS","▣","Restricted administrator command center","admin"]
      ]
    }
  ];

  const GUEST_ACCOUNT = [
    ["subscription.html","Subscription"],
    ["access-stable.html#signin","Sign in"],
    ["access-stable.html#signup","Create account"]
  ];

  const PROTECTED = new Set([
    "index.html","markets.html","terminal.html","analytics.html","ai.html","scanner.html",
    "bots.html","settings.html","subscription.html","broker-connect.html",
    "partner-revenue.html","pattern.html","vps-dashboard.html","reports.html",
    "security-center.html","support-center.html","compliance.html","profile.html"
  ]);

  const API_BASE="https://kingbot-fintech-api-etfv.onrender.com/api";

  function currentPage(){
    return (window.location.pathname.split("/").filter(Boolean).pop()||"index.html").toLowerCase();
  }

  function escapeHtml(value){
    return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  }

  function ensureRuntime(){
    if(window.KINGBOT_UI)return Promise.resolve(window.KINGBOT_UI);
    return new Promise(resolve=>{
      const script=document.querySelector('script[data-kb-ui-runtime="true"]')||document.querySelector('script[src*="ui-runtime.js"]');
      if(script){script.addEventListener("load",()=>resolve(window.KINGBOT_UI||null),{once:true});setTimeout(()=>resolve(window.KINGBOT_UI||null),700);return;}
      const s=document.createElement("script");
      s.src=new URL("system/ui-runtime.js",window.location.href).href;
      s.dataset.kbUiRuntime="true";
      s.onload=()=>resolve(window.KINGBOT_UI||null);
      s.onerror=()=>resolve(null);
      document.head.appendChild(s);
    });
  }

  async function resolveAuthState(){
    if(!window.KINGBOT_SESSION){
      try{await import(new URL("system/session.js",window.location.href).href);}catch{}
    }
    if(!window.KINGBOT_SESSION)return {authenticated:false,verified:false,user:null};
    try{return await window.KINGBOT_SESSION.check();}catch{return {authenticated:false,verified:false,user:null};}
  }

  async function resolveAccessState(){
    if(!window.KINGBOT_ACCESS)return null;
    try{
      if(!window.KINGBOT_ACCESS.state.loaded)await window.KINGBOT_ACCESS.initialize();
      return window.KINGBOT_ACCESS.getState();
    }catch{return null;}
  }

  function accountMarkup(authState){
    const authenticated=Boolean(authState?.authenticated);
    const verified=Boolean(authState?.user?.verified);
    if(authenticated&&verified){
      const name=escapeHtml(String(authState.user?.name||authState.user?.email||"ACCOUNT").trim());
      return '<a href="profile.html" class="kb-nav-account-link" data-kb-account>Profile</a>'+
        '<a href="subscription.html" class="kb-nav-account-link" data-kb-account>Subscription</a>'+
        '<a href="admin-entry.html" class="kb-nav-account-link" data-kb-account data-kb-admin-entry>Admin</a>'+
        '<a href="#" class="kb-nav-account-link" data-kb-logout>Logout · '+name+'</a>';
    }
    if(authenticated&&!verified){
      return '<a href="verify.html" class="kb-nav-account-link" data-kb-account>Verify</a>'+
        '<a href="#" class="kb-nav-account-link" data-kb-signin>Continue</a>'+
        '<a href="access-stable.html#signin" class="kb-nav-account-link" data-kb-account>Sign in</a>';
    }
    return GUEST_ACCOUNT.map(([href,name])=>'<a href="'+href+'" class="kb-nav-account-link" data-kb-account>'+name+'</a>').join("");
  }

  function iconDot(group){
    return '<span class="kb-nav-group-icon">'+group.icon+'</span>';
  }

  function groupMarkup(group,page){
    const itemMarkup=group.items.map(([href,name,icon,desc,role])=>{
      const active=href.toLowerCase()===page;
      const protectedAttr=PROTECTED.has(href.toLowerCase())?' data-kb-protected="true"':'';
      const adminAttr=role==="admin"?' data-kb-admin-link="true"':'';
      return '<a href="'+href+'" class="kb-nav-item'+(active?' is-active':'')+'"'+protectedAttr+adminAttr+'>'+
        '<span class="kb-nav-item-icon">'+icon+'</span>'+
        '<span class="kb-nav-item-copy"><strong>'+name+'</strong><small>'+desc+'</small></span>'+
        (active?'<span class="kb-nav-active-dot" aria-hidden="true"></span>':'')+
      '</a>';
    }).join("");
    return '<section class="kb-nav-group" data-group="'+group.id+'">'+
      '<div class="kb-nav-group-head">'+iconDot(group)+'<span>'+group.label+'</span><b>'+String(group.items.length).padStart(2,"0")+'</b></div>'+
      '<div class="kb-nav-group-items">'+itemMarkup+'</div>'+
    '</section>';
  }

  function filterItems(root,query){
    const q=String(query||"").trim().toLowerCase();
    let visible=0;
    root.querySelectorAll(".kb-nav-item").forEach(item=>{
      const text=item.textContent.toLowerCase();
      const show=!q||text.includes(q);
      item.hidden=!show;
      if(show)visible++;
    });
    root.querySelectorAll(".kb-nav-group").forEach(group=>{
      const count=[...group.querySelectorAll(".kb-nav-item")].filter(x=>!x.hidden).length;
      group.hidden=count===0;
    });
    const result=root.querySelector("[data-kb-search-count]");
    if(result)result.textContent=q?(visible+" MODULE"+(visible===1?"":"S")+" MATCHED"):"23 MODULES";
  }

  async function refreshApi(root){
    const pill=root.querySelector("[data-kb-api]");
    if(!pill)return;
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),2500);
    try{
      const r=await fetch(API_BASE+"/health",{headers:{Accept:"application/json"},cache:"no-store",credentials:"omit",signal:controller.signal});
      const d=await r.json().catch(()=>({}));
      const live=r.ok&&d?.ok!==false;
      pill.classList.toggle("is-live",live);
      pill.classList.toggle("is-offline",!live);
      pill.querySelector("span").textContent=live?"API LIVE":"API OFFLINE";
    }catch{
      pill.classList.remove("is-live");
      pill.classList.add("is-offline");
      pill.querySelector("span").textContent="API OFFLINE";
    }finally{clearTimeout(timer);}
  }

  async function updateAdminVisibility(root){
    const access=await resolveAccessState();
    const admin=access?.isAdmin===true;
    root.querySelectorAll("[data-kb-admin-link]").forEach(link=>{
      link.classList.toggle("is-admin-available",admin);
      const note=link.querySelector("small");
      if(note&&!admin)note.textContent="Restricted administrator access";
    });
    const badge=root.querySelector("[data-kb-admin-badge]");
    if(badge)badge.textContent=admin?"ADMIN VERIFIED":"ADMIN RESTRICTED";
  }

  async function build(){
    if(document.getElementById("kb-command-nav"))return;
    if(document.querySelector(".verify-shell,.auth-shell,.auth-card"))return;

    await ensureRuntime();

    const page=currentPage();
    const authState=await resolveAuthState();

    const root=document.createElement("aside");
    root.id="kb-command-nav";
    root.innerHTML=
      '<a class="kb-command-brand" href="index.html" aria-label="KINGBOT Overview">'+
        '<img src="assets/images/kingbot-fintech-logo.png" alt="KINGBOT">'+
        '<span><strong>KINGBOT</strong><small>FINTECH COMMAND</small></span>'+
      '</a>'+
      '<div class="kb-command-head">'+
        '<div><span class="kb-command-kicker">NAVIGATION / SYSTEM CORE</span><h2>Command Center</h2><small>All customer platform modules in one control surface.</small></div>'+
        '<button type="button" class="kb-nav-close" aria-label="Close navigation">×</button>'+
      '</div>'+
      '<div class="kb-command-status">'+
        '<span class="kb-command-status-pill is-live" data-kb-api><i></i><span>API CHECKING</span></span>'+
        '<span class="kb-command-status-pill is-live"><i></i><span>RISK GATED</span></span>'+
        '<span class="kb-command-status-pill"><i></i><span>NON-CUSTODIAL</span></span>'+
      '</div>'+
      '<label class="kb-nav-search"><span>⌕</span><input type="search" aria-label="Search platform modules" placeholder="Search modules…" autocomplete="off"><kbd>⌘K</kbd></label>'+
      '<div class="kb-nav-result"><span data-kb-search-count>23 MODULES</span><span>ESC TO CLOSE</span></div>'+
      '<div class="kb-nav-scroll">'+GROUPS.map(g=>groupMarkup(g,page)).join("")+'</div>'+
      '<div class="kb-nav-account"><div class="kb-nav-account-title"><span>ACCOUNT CHANNEL</span><b data-kb-admin-badge>ADMIN STATUS</b></div>'+accountMarkup(authState)+'</div>'+
      '<div class="kb-nav-footer"><span>CONSISTENCY · RESILIENCE · INNOVATION</span><button type="button" class="kb-nav-theme" data-kb-theme="cyan" aria-label="Cyan theme">CYAN</button></div>';

    document.body.appendChild(root);

    const trigger=document.createElement("button");
    trigger.id="kb-command-trigger";
    trigger.type="button";
    trigger.className="kb-command-trigger";
    trigger.setAttribute("aria-label","Open KINGBOT Command Center");
    trigger.setAttribute("aria-expanded","false");
    trigger.innerHTML='<span></span><span></span><span></span><b>MENU</b>';
    document.body.appendChild(trigger);

    const backdrop=document.createElement("button");
    backdrop.id="kb-command-backdrop";
    backdrop.type="button";
    backdrop.setAttribute("aria-label","Close navigation");
    document.body.appendChild(backdrop);

    const open=()=>{
      root.classList.add("is-open");
      backdrop.classList.add("is-open");
      trigger.classList.add("is-open");
      trigger.setAttribute("aria-expanded","true");
      root.querySelector(".kb-nav-search input")?.focus({preventScroll:true});
      document.documentElement.classList.add("kb-nav-lock");
    };
    const close=()=>{
      root.classList.remove("is-open");
      backdrop.classList.remove("is-open");
      trigger.classList.remove("is-open");
      trigger.setAttribute("aria-expanded","false");
      document.documentElement.classList.remove("kb-nav-lock");
    };

    trigger.addEventListener("click",()=>root.classList.contains("is-open")?close():open());
    root.querySelector(".kb-nav-close").addEventListener("click",close);
    backdrop.addEventListener("click",close);
    document.addEventListener("keydown",e=>{
      if(e.key==="Escape")close();
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();open();}
    });

    const input=root.querySelector(".kb-nav-search input");
    input.addEventListener("input",()=>filterItems(root,input.value));

    root.querySelectorAll("[data-kb-theme]").forEach(btn=>{
      btn.addEventListener("click",()=>{
        window.KINGBOT_UI?.applyTheme(btn.dataset.kbTheme);
        btn.textContent=(window.KINGBOT_UI?.getTheme?.()||"cyan").toUpperCase();
      });
    });

    root.querySelectorAll("[data-kb-logout]").forEach(a=>a.addEventListener("click",async e=>{
      e.preventDefault();
      const logout=window.KINGBOT_SESSION?.logout;
      if(logout)await logout({redirect:true});else location.replace("access-stable.html#signin");
    }));

    root.querySelector("[data-kb-signin]")?.addEventListener("click",e=>{
      e.preventDefault();
      location.replace("verify.html?return="+encodeURIComponent(window.location.pathname+window.location.search+window.location.hash));
    });

    root.querySelectorAll("[data-kb-protected]").forEach(a=>a.addEventListener("click",async e=>{
      const state=window.KINGBOT_SESSION?.getState?.()||await resolveAuthState();
      if(!state.authenticated){e.preventDefault();location.replace("access-stable.html?return="+encodeURIComponent(a.getAttribute("href")||"")+"#signin");return;}
      if(!state.user?.verified){e.preventDefault();location.replace("verify.html?return="+encodeURIComponent(a.getAttribute("href")||""));}
    }));

    root.querySelectorAll(".kb-nav-item").forEach(a=>a.addEventListener("click",close));
    window.addEventListener("kingbot:session-change",async e=>{
      const next=e.detail||await resolveAuthState();
      const box=root.querySelector(".kb-nav-account");
      box.querySelectorAll(".kb-nav-account-link,[data-kb-admin-entry]").forEach(x=>x.remove());
      box.insertAdjacentHTML("beforeend",accountMarkup(next));
      box.querySelectorAll("[data-kb-logout]").forEach(x=>x.addEventListener("click",async ev=>{
        ev.preventDefault();const logout=window.KINGBOT_SESSION?.logout;if(logout)await logout({redirect:true});
      }));
      await updateAdminVisibility(root);
    });

    await updateAdminVisibility(root);
    await refreshApi(root);
    const timer=setInterval(()=>refreshApi(root),30000);
    window.addEventListener("pagehide",()=>clearInterval(timer),{once:true});

    window.KINGBOT_NAV={
      open,close,current:currentPage,
      refresh:async()=>{await updateAdminVisibility(root);await refreshApi(root);},
      search:(q)=>{input.value=q;filterItems(root,q);open();}
    };
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",build,{once:true});
  else build();
})(window,document);
