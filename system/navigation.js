/* KINGBOT FINTECH — Advanced command navigation
   Trigger: fixed top-left.
   Panel: premium dashboard opens from the right.
   One navigation surface only.
   Designed for fast, lightweight interaction with no framework. */
(function(window, document){
  "use strict";

  const links = [
    ["index.html","Overview","⌂","Core platform"],
    ["markets.html","Markets","◈","Live market intelligence"],
    ["terminal.html","Terminal","⌁","Trading terminal"],
    ["bots.html","Bots","◉","Automated trading systems"],
    ["analytics.html","Analytics","▦","Performance intelligence"],
    ["ai.html","AI Intelligence","✦","AI intelligence layer"],
    ["academy.html","Academy","◇","Education & research"],
    ["pricing.html","Plans","◫","Platform access"],
    ["about.html","About","◎","KINGBOT FINTECH"],
    ["contact.html","Contact","✉","Support & contact"],
    ["settings.html","Settings","⚙","Account controls"],
    ["legal.html","Legal Center","▤","Terms & risk disclosure"]
  ];

  const accountLinks = [
    ["subscription.html","Subscription"],
    ["signin.html","Sign in"],
    ["signup.html","Create account"]
  ];

  function currentPage(){
    return (window.location.pathname.split("/").filter(Boolean).pop() || "index.html").toLowerCase();
  }

  function injectStyle(){
    if(document.getElementById("kb-command-nav-style")) return;

    const style=document.createElement("style");
    style.id="kb-command-nav-style";
    style.textContent=`
      #kb-command-nav{
        position:fixed;
        top:16px;
        right:16px;
        z-index:2147483000;
        font-family:Space Grotesk,Inter,system-ui,sans-serif;
      }

      .kb-command-trigger{
        position:relative;
        width:54px;
        height:54px;
        display:grid;
        place-items:center;
        border:1px solid rgba(255,255,255,.14);
        border-radius:16px;
        cursor:pointer;
        color:#eef4ff;
        background:rgba(4,9,22,.82);
        backdrop-filter:blur(18px);
        -webkit-backdrop-filter:blur(18px);
        box-shadow:
          0 14px 45px rgba(0,0,0,.40),
          0 0 30px rgba(25,230,255,.11);
        transition:transform .22s ease,box-shadow .22s ease;
      }

      .kb-command-trigger::before{
        content:"";
        position:absolute;
        inset:-2px;
        border-radius:18px;
        padding:2px;
        background:conic-gradient(
          from 0deg,
          #19e6ff,
          #4787ff,
          #9b5cff,
          #ff4fd8,
          #f6b93b,
          #23f7a3,
          #19e6ff
        );
        -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
        -webkit-mask-composite:xor;
        mask-composite:exclude;
        opacity:.95;
        animation:kbNavSpin 4.8s linear infinite;
        pointer-events:none;
      }

      .kb-command-trigger::after{
        content:"";
        position:absolute;
        width:26px;
        height:26px;
        border-radius:50%;
        background:radial-gradient(circle,rgba(25,230,255,.20),transparent 72%);
        filter:blur(2px);
      }

      .kb-command-trigger:hover{
        transform:translateY(-2px) scale(1.03);
        box-shadow:
          0 18px 55px rgba(0,0,0,.48),
          0 0 38px rgba(25,230,255,.18),
          0 0 28px rgba(246,185,59,.08);
      }

      .kb-command-trigger .bars{
        position:relative;
        z-index:2;
        width:21px;
        height:17px;
      }

      .kb-command-trigger .bars i{
        position:absolute;
        left:0;
        width:100%;
        height:2px;
        border-radius:4px;
        background:linear-gradient(90deg,#19e6ff,#9b5cff,#f6b93b);
        box-shadow:0 0 8px rgba(25,230,255,.25);
        transition:.22s ease;
      }

      .kb-command-trigger .bars i:nth-child(1){top:0}
      .kb-command-trigger .bars i:nth-child(2){top:7px}
      .kb-command-trigger .bars i:nth-child(3){top:14px}

      .kb-command-trigger[aria-expanded="true"] .bars i:nth-child(1){
        top:7px;
        transform:rotate(45deg);
      }
      .kb-command-trigger[aria-expanded="true"] .bars i:nth-child(2){
        opacity:0;
        transform:scaleX(.2);
      }
      .kb-command-trigger[aria-expanded="true"] .bars i:nth-child(3){
        top:7px;
        transform:rotate(-45deg);
      }

      @keyframes kbNavSpin{to{transform:rotate(360deg)}}

      .kb-command-panel{
        position:fixed;
        top:14px;
        right:14px;
        bottom:14px;
        width:min(920px,calc(100vw - 28px));
        z-index:2147482999;
        overflow:hidden;
        border-radius:28px;
        background:
          radial-gradient(circle at 10% 0%,rgba(25,230,255,.09),transparent 28%),
          radial-gradient(circle at 90% 16%,rgba(155,92,255,.10),transparent 30%),
          radial-gradient(circle at 70% 100%,rgba(246,185,59,.08),transparent 30%),
          linear-gradient(145deg,rgba(8,14,32,.98),rgba(2,6,16,.99));
        border:1px solid rgba(255,255,255,.10);
        box-shadow:
          0 40px 140px rgba(0,0,0,.76),
          0 0 85px rgba(25,230,255,.08);
        transform:translateX(36px) scale(.985);
        opacity:0;
        pointer-events:none;
        transition:transform .28s cubic-bezier(.2,.8,.2,1),opacity .22s ease;
        isolation:isolate;
      }

      .kb-command-panel::before{
        content:"";
        position:absolute;
        inset:-2px;
        padding:2px;
        border-radius:30px;
        background:conic-gradient(
          from 25deg,
          #19e6ff,
          #4787ff,
          #9b5cff,
          #ff4fd8,
          #f6b93b,
          #23f7a3,
          #19e6ff
        );
        -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
        -webkit-mask-composite:xor;
        mask-composite:exclude;
        animation:kbNavSpin 8s linear infinite;
        pointer-events:none;
        opacity:.95;
      }

      .kb-command-panel::after{
        content:"";
        position:absolute;
        inset:0;
        pointer-events:none;
        background:
          linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),
          linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);
        background-size:42px 42px;
        mask-image:linear-gradient(to bottom,black,transparent 90%);
        z-index:-1;
      }

      .kb-command-panel.kb-open{
        opacity:1;
        transform:none;
        pointer-events:auto;
      }

      .kb-panel-shell{
        position:relative;
        z-index:2;
        height:100%;
        overflow:auto;
        padding:28px;
      }

      .kb-panel-top{
        display:flex;
        align-items:flex-start;
        justify-content:space-between;
        gap:18px;
      }

      .kb-kicker{
        color:#19e6ff;
        font:800 9px/1 JetBrains Mono,monospace;
        letter-spacing:.25em;
      }

      .kb-title{
        margin-top:9px;
        font:900 clamp(22px,3.1vw,38px)/1 Orbitron,sans-serif;
        letter-spacing:-.035em;
        color:#edf2ff;
      }

      .kb-title span{
        background:linear-gradient(90deg,#f6b93b,#19e6ff,#9b5cff,#ff4fd8);
        -webkit-background-clip:text;
        background-clip:text;
        color:transparent;
      }

      .kb-close{
        width:42px;
        height:42px;
        flex:none;
        border:1px solid rgba(255,255,255,.10);
        border-radius:12px;
        background:rgba(255,255,255,.035);
        color:#93a0c9;
        font-size:22px;
        cursor:pointer;
      }

      .kb-close:hover{
        color:#fff;
        border-color:rgba(25,230,255,.28);
        box-shadow:0 0 18px rgba(25,230,255,.08);
      }

      .kb-system-strip{
        margin-top:20px;
        display:grid;
        grid-template-columns:1fr auto auto;
        align-items:center;
        gap:12px;
        padding:12px 14px;
        border-radius:14px;
        background:linear-gradient(90deg,rgba(25,230,255,.06),rgba(155,92,255,.055),rgba(246,185,59,.045));
        border:1px solid rgba(255,255,255,.07);
      }

      .kb-system-live{
        display:flex;
        align-items:center;
        gap:8px;
        min-width:0;
        color:#a9b6d2;
        font:700 8px JetBrains Mono,monospace;
        letter-spacing:.08em;
      }

      .kb-live-dot{
        width:7px;
        height:7px;
        border-radius:50%;
        background:#23f7a3;
        box-shadow:0 0 14px #23f7a3;
        animation:kbNavPulse 1.5s ease-in-out infinite;
        flex:none;
      }

      @keyframes kbNavPulse{
        50%{opacity:.35;transform:scale(.7)}
      }

      .kb-strip-chip{
        padding:7px 9px;
        border-radius:8px;
        color:#7784a4;
        background:rgba(255,255,255,.025);
        border:1px solid rgba(255,255,255,.06);
        font:700 7px JetBrains Mono,monospace;
        letter-spacing:.06em;
        white-space:nowrap;
      }

      .kb-section-label{
        margin:24px 0 10px;
        color:#596786;
        font:800 8px JetBrains Mono,monospace;
        letter-spacing:.18em;
      }

      .kb-page-grid{
        display:grid;
        grid-template-columns:repeat(3,minmax(0,1fr));
        gap:11px;
      }

      .kb-page-card{
        position:relative;
        min-height:112px;
        padding:16px;
        overflow:hidden;
        display:flex;
        flex-direction:column;
        justify-content:space-between;
        border-radius:16px;
        border:1px solid rgba(255,255,255,.075);
        background:
          linear-gradient(145deg,rgba(15,24,52,.78),rgba(4,9,22,.90));
        color:#eef2ff;
        text-decoration:none;
        transition:transform .2s ease,border-color .2s ease,box-shadow .2s ease;
      }

      .kb-page-card::before{
        content:"";
        position:absolute;
        inset:-45%;
        background:conic-gradient(
          from 0deg,
          transparent,
          rgba(25,230,255,.12),
          transparent,
          rgba(255,79,216,.10),
          transparent
        );
        opacity:0;
        animation:kbNavSpin 7s linear infinite;
        transition:opacity .2s ease;
      }

      .kb-page-card:hover{
        transform:translateY(-3px);
        border-color:rgba(25,230,255,.28);
        box-shadow:
          0 18px 42px rgba(0,0,0,.32),
          0 0 25px rgba(25,230,255,.07);
      }

      .kb-page-card:hover::before{opacity:1}

      .kb-page-card>*{position:relative;z-index:1}

      .kb-page-icon{
        width:35px;
        height:35px;
        display:grid;
        place-items:center;
        border-radius:10px;
        background:rgba(255,255,255,.045);
        border:1px solid rgba(255,255,255,.07);
        color:#19e6ff;
        font-size:16px;
        box-shadow:0 0 16px rgba(25,230,255,.06);
      }

      .kb-page-name{
        margin-top:12px;
        font:900 10px/1 Orbitron,sans-serif;
        letter-spacing:.035em;
      }

      .kb-page-desc{
        margin-top:5px;
        color:#687695;
        font:600 7px/1.45 JetBrains Mono,monospace;
      }

      .kb-page-card.kb-active{
        border-color:rgba(246,185,59,.30);
        box-shadow:
          inset 0 2px 0 rgba(246,185,59,.65),
          0 0 28px rgba(246,185,59,.08);
      }

      .kb-page-card.kb-active .kb-page-icon{
        color:#f6b93b;
        border-color:rgba(246,185,59,.22);
        box-shadow:0 0 18px rgba(246,185,59,.11);
      }

      .kb-lower{
        display:grid;
        grid-template-columns:1.35fr .65fr;
        gap:12px;
        margin-top:18px;
      }

      .kb-lower-panel{
        padding:15px;
        border-radius:15px;
        border:1px solid rgba(255,255,255,.07);
        background:rgba(255,255,255,.022);
      }

      .kb-lower-title{
        color:#eef2ff;
        font:800 9px Orbitron,sans-serif;
        letter-spacing:.08em;
      }

      .kb-account-links{
        display:grid;
        grid-template-columns:repeat(3,1fr);
        gap:7px;
        margin-top:11px;
      }

      .kb-account-links a{
        padding:9px 7px;
        text-align:center;
        color:#8390ad;
        border-radius:9px;
        border:1px solid rgba(255,255,255,.055);
        background:rgba(255,255,255,.022);
        text-decoration:none;
        font:700 8px Space Grotesk,sans-serif;
      }

      .kb-account-links a:hover{
        color:#fff;
        border-color:rgba(25,230,255,.20);
      }

      .kb-auto-grid{
        display:grid;
        grid-template-columns:repeat(2,1fr);
        gap:7px;
        margin-top:11px;
      }

      .kb-auto-chip{
        position:relative;
        padding:9px 8px;
        text-align:center;
        border-radius:9px;
        color:#9ba8c0;
        background:linear-gradient(135deg,rgba(25,230,255,.035),rgba(155,92,255,.045),rgba(255,79,216,.035));
        border:1px solid rgba(255,255,255,.06);
        font:800 7px JetBrains Mono,monospace;
        letter-spacing:.05em;
        overflow:hidden;
      }

      .kb-auto-chip::after{
        content:"";
        position:absolute;
        left:-30%;
        width:30%;
        top:0;
        bottom:0;
        background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);
        animation:kbAutoScan 3.8s linear infinite;
      }

      @keyframes kbAutoScan{
        to{left:110%}
      }

      .kb-panel-foot{
        margin-top:16px;
        display:flex;
        justify-content:space-between;
        gap:10px;
        color:#4f5d7b;
        font:600 7px JetBrains Mono,monospace;
        letter-spacing:.07em;
      }

      .kb-shade{
        position:fixed;
        inset:0;
        z-index:2147482998;
        background:rgba(1,4,12,.62);
        backdrop-filter:blur(5px);
        -webkit-backdrop-filter:blur(5px);
        opacity:0;
        pointer-events:none;
        transition:opacity .22s ease;
      }

      .kb-shade.kb-open{
        opacity:1;
        pointer-events:auto;
      }

      @media(max-width:900px){
        #kb-command-nav{top:10px;right:10px}
        .kb-command-trigger{width:48px;height:48px;border-radius:14px}
        .kb-command-panel{top:8px;right:8px;bottom:8px;width:calc(100vw - 16px);border-radius:22px}
        .kb-panel-shell{padding:20px 16px}
        .kb-page-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
        .kb-lower{grid-template-columns:1fr}
      }

      @media(max-width:560px){
        .kb-page-grid{grid-template-columns:1fr 1fr;gap:8px}
        .kb-page-card{min-height:96px;padding:12px}
        .kb-system-strip{grid-template-columns:1fr}
        .kb-strip-chip{display:none}
        .kb-account-links{grid-template-columns:1fr}
        .kb-panel-foot{flex-direction:column}
      }

      @media(prefers-reduced-motion:reduce){
        .kb-command-trigger::before,
        .kb-page-card::before,
        .kb-auto-chip::after,
        .kb-live-dot{animation:none}
      }
    `;
    document.head.appendChild(style);
  }

  function build(){
    if(document.getElementById("kb-command-nav")) return;

    // Keep dedicated verification/auth screens visually focused.
    if(document.querySelector(".verify-shell,.auth-shell,.auth-card")) return;

    injectStyle();

    const page=currentPage();

    const pageCards=links.map(([href,name,icon,desc])=>{
      const active=href.toLowerCase()===page;
      return '<a class="kb-page-card'+(active?' kb-active':'')+'" href="'+href+'"'+
        (active?' aria-current="page"':'')+'>'+
        '<div class="kb-page-icon">'+icon+'</div>'+
        '<div><div class="kb-page-name">'+name+'</div>'+
        '<div class="kb-page-desc">'+desc+'</div></div>'+
      '</a>';
    }).join("");

    const account=accountLinks.map(([href,name]) =>
      '<a href="'+href+'">'+name+'</a>'
    ).join("");

    const root=document.createElement("div");
    root.id="kb-command-nav";

    root.innerHTML=
      '<button class="kb-command-trigger" type="button" aria-label="Open KINGBOT navigation" aria-expanded="false">'+
        '<span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>'+
      '</button>'+
      '<div class="kb-shade" aria-hidden="true"></div>'+
      '<aside class="kb-command-panel" aria-label="KINGBOT navigation dashboard">'+
        '<div class="kb-panel-shell">'+
          '<div class="kb-panel-top">'+
            '<div>'+
              '<div class="kb-kicker">KINGBOT // ADVANCED NAVIGATION</div>'+
              '<div class="kb-title">FINTECH <span>COMMAND DASHBOARD</span></div>'+
            '</div>'+
            '<button class="kb-close" type="button" aria-label="Close navigation">×</button>'+
          '</div>'+
          '<div class="kb-system-strip">'+
            '<div class="kb-system-live"><span class="kb-live-dot"></span><span>SYSTEM ONLINE · UNIFIED CONTROL SURFACE</span></div>'+
            '<div class="kb-strip-chip">AI CORE</div>'+
            '<div class="kb-strip-chip">RISK ENGINE</div>'+
          '</div>'+
          '<div class="kb-section-label">PLATFORM MODULES</div>'+
          '<div class="kb-page-grid">'+pageCards+'</div>'+
          '<div class="kb-lower">'+
            '<section class="kb-lower-panel">'+
              '<div class="kb-lower-title">ACCOUNT ACCESS</div>'+
              '<div class="kb-account-links">'+account+'</div>'+
            '</section>'+
            '<section class="kb-lower-panel">'+
              '<div class="kb-lower-title">AUTOMATION LAYER</div>'+
              '<div class="kb-auto-grid">'+
                '<div class="kb-auto-chip">AUTO-TRADING</div>'+
                '<div class="kb-auto-chip">LIVE DATA</div>'+
                '<div class="kb-auto-chip">AI LAYER</div>'+
                '<div class="kb-auto-chip">RISK GATE</div>'+
              '</div>'+
            '</section>'+
          '</div>'+
          '<div class="kb-panel-foot"><span>ONE PLATFORM · ONE NAVIGATION SURFACE</span><span>CONSISTENCY · RESILIENCE · INNOVATION</span></div>'+
        '</div>'+
      '</aside>';

    document.body.appendChild(root);

    const trigger=root.querySelector(".kb-command-trigger");
    const shade=root.querySelector(".kb-shade");
    const panel=root.querySelector(".kb-command-panel");
    const closeButton=root.querySelector(".kb-close");

    function open(){
      panel.classList.add("kb-open");
      shade.classList.add("kb-open");
      trigger.setAttribute("aria-expanded","true");
      shade.setAttribute("aria-hidden","false");
      document.body.style.overflow="hidden";
    }

    function close(){
      panel.classList.remove("kb-open");
      shade.classList.remove("kb-open");
      trigger.setAttribute("aria-expanded","false");
      shade.setAttribute("aria-hidden","true");
      document.body.style.overflow="";
    }

    trigger.addEventListener("click",()=>panel.classList.contains("kb-open")?close():open());
    closeButton.addEventListener("click",close);
    shade.addEventListener("click",close);
    root.querySelectorAll("a").forEach(a=>a.addEventListener("click",close));
    document.addEventListener("keydown",e=>{
      if(e.key==="Escape" && panel.classList.contains("kb-open")) close();
    });

    window.KINGBOT_NAV={
      config:{links,account:accountLinks},
      state:{initialized:true,open:false},
      initialize:()=>Promise.resolve(),
      current:currentPage,
      active:href=>String(href).toLowerCase()===currentPage(),
      open,close
    };
  }

  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",build,{once:true});
  else build();

})(window,document);
