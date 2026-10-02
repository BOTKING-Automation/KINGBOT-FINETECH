/* KINGBOT FINTECH — Advanced unified navigation
   High-performance command menu: compact top-left trigger + right-side nav dashboard.
   No framework, no canvas, no polling. CSS animations are GPU-friendly and DOM is created once. */
(function(window, document){
  "use strict";

  const links = [
    ["index.html","Overview","⌂","Core platform"],
    ["markets.html","Markets","◈","Live market intelligence"],
    ["terminal.html","Terminal","⌁","Trading terminal"],
    ["bots.html","Bot Ecosystem","◉","Automated trading systems"],
    ["analytics.html","Analytics","▦","Performance intelligence"],
    ["ai.html","AI Intelligence","✦","AI trading layer"],
    ["academy.html","Academy","◇","Education & research"],
    ["pricing.html","Plans","◫","Platform access"],
    ["about.html","About","◎","KINGBOT FINTECH"],
    ["contact.html","Contact","✉","Support & contact"],
    ["settings.html","Settings","⚙","Account controls"],
    ["legal.html","Legal Center","▤","Terms & risk disclosure"]
  ];

  const accountLinks = [
    ["subscription.html","Subscription"],
    ["access-stable.html#signin","Sign in"],
    ["access-stable.html#signup","Create account"]
  ];

  function currentPage(){
    const file=(window.location.pathname.split("/").filter(Boolean).pop()||"index.html").toLowerCase();
    return file === "" ? "index.html" : file;
  }

  function style(){
    if(document.getElementById("kb-advanced-nav-style")) return;
    const s=document.createElement("style");
    s.id="kb-advanced-nav-style";
    s.textContent=`
      #kb-nav-trigger{
        position:fixed;top:18px;left:18px;z-index:2147483000;
        width:48px;height:48px;border-radius:15px;border:1px solid rgba(255,255,255,.12);
        background:rgba(5,10,24,.78);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
        color:#eef2ff;cursor:pointer;display:grid;place-items:center;
        box-shadow:0 12px 35px rgba(0,0,0,.35),0 0 28px rgba(25,230,255,.08);
        transition:transform .22s ease,box-shadow .22s ease,border-color .22s ease;
        isolation:isolate;
      }
      #kb-nav-trigger:before{
        content:"";position:absolute;inset:-2px;border-radius:17px;padding:1px;
        background:conic-gradient(from 0deg,#19e6ff,#9b5cff,#ff4fd8,#f6b93b,#2ee6a8,#19e6ff);
        -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
        -webkit-mask-composite:xor;mask-composite:exclude;opacity:.9;
        animation:kbSpin 4.5s linear infinite;z-index:-1;
      }
      #kb-nav-trigger:hover{transform:translateY(-2px) scale(1.03);box-shadow:0 15px 42px rgba(0,0,0,.42),0 0 35px rgba(25,230,255,.2)}
      #kb-nav-trigger .kb-bars{width:20px;height:16px;position:relative}
      #kb-nav-trigger .kb-bars i{position:absolute;left:0;width:100%;height:2px;border-radius:2px;background:linear-gradient(90deg,#19e6ff,#9b5cff,#f6b93b);transition:.22s}
      #kb-nav-trigger .kb-bars i:nth-child(1){top:0}.kb-bars i:nth-child(2){top:7px}.kb-bars i:nth-child(3){top:14px}
      #kb-nav-trigger[aria-expanded="true"] .kb-bars i:nth-child(1){top:7px;transform:rotate(45deg)}
      #kb-nav-trigger[aria-expanded="true"] .kb-bars i:nth-child(2){opacity:0;transform:scaleX(.2)}
      #kb-nav-trigger[aria-expanded="true"] .kb-bars i:nth-child(3){top:7px;transform:rotate(-45deg)}

      #kb-nav-overlay{
        position:fixed;inset:0;z-index:2147482990;display:none;
        background:rgba(1,4,12,.72);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);
        opacity:0;transition:opacity .22s ease;
      }
      #kb-nav-overlay.kb-open{display:block;opacity:1}

      #kb-nav-panel{
        position:absolute;top:12px;right:12px;bottom:12px;width:min(900px,calc(100vw - 24px));
        overflow:hidden;border-radius:28px;
        background:linear-gradient(145deg,rgba(10,18,40,.97),rgba(3,7,17,.985));
        border:1px solid rgba(255,255,255,.09);
        box-shadow:0 35px 120px rgba(0,0,0,.72),0 0 90px rgba(77,141,255,.09);
        transform:translateX(30px) scale(.985);transition:transform .28s cubic-bezier(.2,.8,.2,1);
        isolation:isolate;
      }
      #kb-nav-overlay.kb-open #kb-nav-panel{transform:none}
      #kb-nav-panel:before{
        content:"";position:absolute;inset:0;padding:1px;border-radius:28px;pointer-events:none;
        background:conic-gradient(from 35deg,#19e6ff,#4d8dff,#9b5cff,#ff4fd8,#f6b93b,#2ee6a8,#19e6ff);
        -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
        -webkit-mask-composite:xor;mask-composite:exclude;opacity:.9;
        animation:kbSpin 9s linear infinite;
      }
      #kb-nav-panel:after{
        content:"";position:absolute;inset:0;pointer-events:none;
        background:radial-gradient(circle at 20% 15%,rgba(25,230,255,.1),transparent 28%),
                   radial-gradient(circle at 80% 85%,rgba(255,79,216,.08),transparent 30%);
        z-index:-1;
      }
      .kb-nv-shell{height:100%;display:grid;grid-template-columns:1fr 280px;position:relative}
      .kb-nv-main{min-width:0;padding:30px 30px 28px;overflow:auto}
      .kb-nv-right{position:relative;padding:30px 20px 24px;border-left:1px solid rgba(255,255,255,.07);background:rgba(2,7,18,.42);overflow:auto}
      .kb-nv-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
      .kb-nv-kicker{font:700 9px/1 JetBrains Mono,monospace;letter-spacing:.28em;color:#19e6ff;text-transform:uppercase}
      .kb-nv-title{margin-top:9px;font:800 clamp(22px,3vw,34px)/1.05 Orbitron,sans-serif;letter-spacing:-.03em;color:#eef2ff}
      .kb-nv-title span{background:linear-gradient(90deg,#f6b93b,#19e6ff,#9b5cff);-webkit-background-clip:text;background-clip:text;color:transparent}
      .kb-nv-close{width:38px;height:38px;border-radius:11px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:#93a0c9;cursor:pointer;font-size:20px}
      .kb-nv-close:hover{color:#fff;border-color:rgba(25,230,255,.35)}
      .kb-nv-status{margin-top:25px;display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:13px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);font:600 9px JetBrains Mono,monospace;color:#93a0c9}
      .kb-nv-live{width:7px;height:7px;border-radius:50%;background:#2ee6a8;box-shadow:0 0 12px #2ee6a8;animation:kbPulse 1.5s ease-in-out infinite}
      .kb-nv-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:11px;margin-top:16px}
      .kb-nv-card{position:relative;min-height:105px;padding:16px;border-radius:16px;background:linear-gradient(145deg,rgba(16,26,58,.75),rgba(5,10,24,.82));border:1px solid rgba(255,255,255,.07);transition:.2s;overflow:hidden}
      .kb-nv-card:before{content:"";position:absolute;inset:-50%;background:conic-gradient(from 90deg,transparent,#19e6ff22,transparent,#ff4fd822,transparent);animation:kbSpin 7s linear infinite;opacity:0;transition:.2s}
      .kb-nv-card:hover{transform:translateY(-3px);border-color:rgba(25,230,255,.32);box-shadow:0 15px 35px rgba(0,0,0,.25)}
      .kb-nv-card:hover:before{opacity:1}
      .kb-nv-card>*{position:relative}
      .kb-nv-icon{font-size:19px;margin-bottom:11px;color:#f6b93b}
      .kb-nv-name{font:800 10px Orbitron,sans-serif;color:#eef2ff;letter-spacing:.03em}
      .kb-nv-desc{margin-top:5px;font:500 8px/1.45 Space Grotesk,sans-serif;color:#7180a9}
      .kb-nv-right-title{font:800 10px Orbitron,sans-serif;letter-spacing:.14em;color:#eef2ff}
      .kb-nv-rail{margin-top:14px;display:grid;gap:6px}
      .kb-nv-link{display:grid;grid-template-columns:31px 1fr;gap:9px;align-items:center;padding:10px;border-radius:12px;color:#8f9bc0;border:1px solid transparent;transition:.18s}
      .kb-nv-link:hover,.kb-nv-link.kb-active{color:#fff;background:linear-gradient(90deg,rgba(25,230,255,.09),rgba(155,92,255,.07));border-color:rgba(25,230,255,.16)}
      .kb-nv-link.kb-active{box-shadow:inset 2px 0 0 #19e6ff,0 0 22px rgba(25,230,255,.05)}
      .kb-nv-link-icon{width:31px;height:31px;display:grid;place-items:center;border-radius:9px;background:rgba(255,255,255,.035);font-size:14px;color:#19e6ff}
      .kb-nv-link-text{font:700 9px Space Grotesk,sans-serif}.kb-nv-link-sub{display:block;margin-top:2px;font:500 7px JetBrains Mono,monospace;color:#5f6b8e}
      .kb-nv-section{margin-top:24px;padding-top:18px;border-top:1px solid rgba(255,255,255,.06)}
      .kb-nv-section-label{font:700 8px JetBrains Mono,monospace;letter-spacing:.2em;color:#596684;margin-bottom:9px}
      .kb-nv-mini{display:flex;gap:7px;flex-wrap:wrap}
      .kb-nv-chip{font:700 7px JetBrains Mono,monospace;color:#93a0c9;padding:7px 9px;border-radius:8px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06)}
      .kb-nv-footer{position:absolute;bottom:18px;left:20px;right:20px;font:500 7px/1.5 JetBrains Mono,monospace;color:#4f5b7c}
      @keyframes kbSpin{to{transform:rotate(360deg)}}@keyframes kbPulse{50%{opacity:.35;transform:scale(.75)}}
      @media(max-width:760px){
        #kb-nav-trigger{top:12px;left:12px;width:44px;height:44px}
        #kb-nav-panel{top:7px;right:7px;bottom:7px;width:calc(100vw - 14px);border-radius:22px}
        .kb-nv-shell{grid-template-columns:1fr}
        .kb-nv-main{padding:23px 18px 100px}
        .kb-nv-right{border-left:0;border-top:1px solid rgba(255,255,255,.07);padding:20px 18px 85px}
        .kb-nv-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
        .kb-nv-footer{position:static;margin-top:18px}
      }
      @media(prefers-reduced-motion:reduce){
        #kb-nav-trigger:before,#kb-nav-panel:before,.kb-nv-card:before,.kb-nv-live{animation:none}
        #kb-nav-overlay,#kb-nav-panel{transition:none}
      }
    `;
    document.head.appendChild(s);
  }

  function build(){
    if(document.getElementById("kb-nav-trigger")) return;

    style();

    const trigger=document.createElement("button");
    trigger.id="kb-nav-trigger";
    trigger.type="button";
    trigger.setAttribute("aria-label","Open KINGBOT navigation");
    trigger.setAttribute("aria-expanded","false");
    trigger.innerHTML='<span class="kb-bars" aria-hidden="true"><i></i><i></i><i></i></span>';

    const overlay=document.createElement("div");
    overlay.id="kb-nav-overlay";
    overlay.setAttribute("aria-hidden","true");

    const panel=document.createElement("aside");
    panel.id="kb-nav-panel";
    panel.setAttribute("aria-label","KINGBOT FINTECH navigation dashboard");

    const page=currentPage();
    const pageLinks=links.map(([href,name,icon,desc])=>{
      const active=href.toLowerCase()===page;
      return '<a class="kb-nv-card" href="'+href+'"'+(active?' aria-current="page"':'')+'>'+
        '<div class="kb-nv-icon">'+icon+'</div><div class="kb-nv-name">'+name+'</div><div class="kb-nv-desc">'+desc+'</div></a>';
    }).join("");

    const rail=links.map(([href,name,icon,desc])=>{
      const active=href.toLowerCase()===page;
      return '<a class="kb-nv-link'+(active?' kb-active':'')+'" href="'+href+'"'+(active?' aria-current="page"':'')+'>'+
        '<span class="kb-nv-link-icon">'+icon+'</span><span class="kb-nv-link-text">'+name+'<span class="kb-nv-link-sub">'+desc+'</span></span></a>';
    }).join("");

    const account=accountLinks.map(([href,name])=>'<a class="kb-nv-link" href="'+href+'"><span class="kb-nv-link-icon">↗</span><span class="kb-nv-link-text">'+name+'</span></a>').join("");

    panel.innerHTML=
      '<div class="kb-nv-shell">'+
        '<section class="kb-nv-main">'+
          '<div class="kb-nv-head"><div><div class="kb-nv-kicker">KINGBOT // CONTROL SYSTEM</div><div class="kb-nv-title">FINTECH <span>COMMAND</span></div></div><button class="kb-nv-close" type="button" aria-label="Close navigation">×</button></div>'+
          '<div class="kb-nv-status"><span class="kb-nv-live"></span><span>SYSTEM ONLINE</span><span style="margin-left:auto">UNIFIED OS</span></div>'+
          '<div class="kb-nv-grid">'+pageLinks+'</div>'+
        '</section>'+
        '<nav class="kb-nv-right">'+
          '<div class="kb-nv-right-title">NAVIGATION</div>'+
          '<div class="kb-nv-rail">'+rail+'</div>'+
          '<div class="kb-nv-section"><div class="kb-nv-section-label">ACCOUNT</div><div class="kb-nv-rail">'+account+'</div></div>'+
          '<div class="kb-nv-section"><div class="kb-nv-section-label">AUTOMATION</div><div class="kb-nv-mini"><span class="kb-nv-chip">AUTO-TRADING</span><span class="kb-nv-chip">AI LAYER</span><span class="kb-nv-chip">RISK ENGINE</span><span class="kb-nv-chip">LIVE DATA</span></div></div>'+
          '<div class="kb-nv-footer">ONE PLATFORM · ONE CONTROL SURFACE<br>CONSISTENCY · RESILIENCE · INNOVATION</div>'+
        '</nav>'+
      '</div>';

    overlay.appendChild(panel);
    document.body.appendChild(trigger);
    document.body.appendChild(overlay);

    function open(){
      overlay.classList.add("kb-open");
      overlay.setAttribute("aria-hidden","false");
      trigger.setAttribute("aria-expanded","true");
      document.body.style.overflow="hidden";
      const close=panel.querySelector(".kb-nv-close");
      if(close) close.focus();
    }
    function close(){
      overlay.classList.remove("kb-open");
      overlay.setAttribute("aria-hidden","true");
      trigger.setAttribute("aria-expanded","false");
      document.body.style.overflow="";
      trigger.focus();
    }

    trigger.addEventListener("click",()=>overlay.classList.contains("kb-open")?close():open());
    panel.querySelector(".kb-nv-close").addEventListener("click",close);
    overlay.addEventListener("click",e=>{if(e.target===overlay) close()});
    document.addEventListener("keydown",e=>{if(e.key==="Escape"&&overlay.classList.contains("kb-open")) close()},{passive:true});
    panel.querySelectorAll("a").forEach(a=>a.addEventListener("click",()=>close()));

    window.KINGBOT_NAV={
      config:{links,account:accountLinks},
      state:{initialized:true,user:null,open:false},
      initialize:()=>Promise.resolve(),
      current:currentPage,
      active:href=>String(href).toLowerCase()===currentPage(),
      refreshUser:()=>Promise.resolve(),
      open,close
    };
  }

  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",build,{once:true});
  else build();

})(window,document);
