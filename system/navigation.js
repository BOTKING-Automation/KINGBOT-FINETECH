/* KINGBOT FINTECH — Compact global navigation */
(function(window, document){
  "use strict";
  const links = [
    ["index.html","Overview","⌂","Core platform"],
    ["markets.html","Markets","◈","Live market intelligence"],
    ["terminal.html","Terminal","⌁","Trading terminal"],
    ["bots.html","Bots","◉","Automated trading systems"],
    ["broker-connect.html","Broker Connect","⚡","Secure broker execution"],
    ["partner-revenue.html","Partner Revenue","◌","Broker referral intelligence"],
    ["analytics.html","Analytics","▦","Performance intelligence"],
    ["ai.html","AI Intelligence","✦","AI intelligence layer"],
    ["scanner.html","AI Scanner","◎","High-intelligence market scanner"],
    ["pattern.html","Patterns","◉","Pattern intelligence"],
    ["academy.html","Academy","◇","Education & research"],
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
  const authenticatedAccountLinks = [
    ["index.html","Dashboard"],
    ["subscription.html","Subscription"],
    ["admin-entry.html","Admin","admin"],
    ["#","Logout","logout"]
  ];
  function currentPage(){
    return (window.location.pathname.split("/").filter(Boolean).pop() || "index.html").toLowerCase();
  }
  function injectStyle(){
    if(document.getElementById("kb-compact-nav-style")) return;
    const style=document.createElement("style");
    style.id="kb-compact-nav-style";
    style.textContent=`#kb-compact-nav{position:fixed;top:14px;right:14px;z-index:2147483000;font-family:Inter,system-ui,sans-serif}#kb-compact-nav .kb-fintech-logo{position:fixed;top:14px;left:14px;z-index:2147483001;width:58px;height:58px;object-fit:contain;border-radius:14px;padding:5px;background:rgba(4,9,22,.82);border:1px solid rgba(255,255,255,.1)}#kb-compact-nav .kb-nav-trigger{width:48px;height:48px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.13);border-radius:14px;background:rgba(4,9,22,.86);color:#eef4ff;cursor:pointer}#kb-compact-nav .kb-menu{position:absolute;top:58px;right:0;width:min(310px,calc(100vw - 28px));padding:8px;border-radius:15px;border:1px solid rgba(255,255,255,.1);background:linear-gradient(145deg,rgba(7,13,29,.98),rgba(3,7,17,.99));opacity:0;pointer-events:none;visibility:hidden;transition:.18s}#kb-compact-nav .kb-menu.kb-open{opacity:1;pointer-events:auto;visibility:visible}.kb-menu-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding-top:9px}.kb-menu-grid a{min-height:38px;display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:10px;color:#8e9ab8;text-decoration:none;border:1px solid rgba(255,255,255,.05)}.kb-menu-grid a:hover,.kb-menu-grid a.kb-active{color:#fff;border-color:rgba(25,230,255,.2)}.kb-menu-name{font:800 7.5px Orbitron,sans-serif}.kb-menu-sub{display:block;margin-top:3px;color:#586681;font:600 5.8px JetBrains Mono,monospace}.kb-menu-account{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:9px;padding-top:9px;border-top:1px solid rgba(255,255,255,.06)}.kb-menu-account a{padding:8px 5px;text-align:center;color:#7f8ba8;text-decoration:none;border:1px solid rgba(255,255,255,.05);border-radius:8px;font:700 7px sans-serif}`;
    document.head.appendChild(style);
  }
  function build(){
    if(document.getElementById("kb-compact-nav")) return;
    if(document.querySelector(".verify-shell,.auth-shell,.auth-card")) return;
    injectStyle();
    const page=currentPage();
    const pageLinks=links.map(([href,name,icon,desc])=>{
      const active=href.toLowerCase()===page;
      return '<a href="'+href+'"'+(active?' class="kb-active"':'')+'><span class="kb-menu-icon">'+icon+'</span><span><span class="kb-menu-name">'+name+'</span><span class="kb-menu-sub">'+desc+'</span></span></a>';
    }).join("");
    const accountLinks=window.KINGBOT_SESSION?.isAuthenticated?.()?authenticatedAccountLinks:guestAccountLinks;
    const account=accountLinks.map(([href,name,action])=>action==="logout"?'<a href="#" data-kb-logout>'+name+'</a>':'<a href="'+href+'">'+name+'</a>').join("");
    const root=document.createElement("div");
    root.id="kb-compact-nav";
    root.innerHTML='<a href="index.html"><img class="kb-fintech-logo" src="assets/images/kingbot-fintech-logo.png" alt="KINGBOT"></a><button class="kb-nav-trigger" type="button" aria-label="Menu">☰</button><div class="kb-menu"><div class="kb-menu-grid">'+pageLinks+'</div><div class="kb-menu-account">'+account+'</div></div>';
    document.body.appendChild(root);
    const trigger=root.querySelector(".kb-nav-trigger");
    const menu=root.querySelector(".kb-menu");
    const close=()=>menu.classList.remove("kb-open");
    const open=()=>menu.classList.add("kb-open");
    trigger.addEventListener("click",()=>menu.classList.contains("kb-open")?close():open());
    root.querySelectorAll("a").forEach(a=>a.addEventListener("click",close));
    root.querySelector("[data-kb-logout]")?.addEventListener("click",async e=>{e.preventDefault();close();const l=window.KINGBOT_SESSION?.logout;if(l)await l({redirect:true});else location.replace("access-stable.html");});
    window.KINGBOT_NAV={open,close,current:currentPage};
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",build,{once:true});else build();
})(window,document);
