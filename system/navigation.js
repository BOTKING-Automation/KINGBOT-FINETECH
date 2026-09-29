/* KINGBOT FINTECH — Unified top navigation
   Single source of truth for site navigation.
   Desktop: page links stay in the top-right.
   Mobile: compact glowing command button opens the same links.
   The old duplicate navigation dashboard/cards have been removed. */
(function(window, document){
  "use strict";

  const links = [
    ["index.html","Overview","⌂","Core platform"],
    ["markets.html","Markets","◈","Live market intelligence"],
    ["terminal.html","Terminal","⌁","Trading terminal"],
    ["bots.html","Bots","◉","Automated trading systems"],
    ["analytics.html","Analytics","▦","Performance intelligence"],
    ["ai.html","AI","✦","AI intelligence layer"],
    ["academy.html","Academy","◇","Education & research"],
    ["pricing.html","Plans","◫","Platform access"],
    ["about.html","About","◎","KINGBOT FINTECH"],
    ["contact.html","Contact","✉","Support & contact"],
    ["settings.html","Settings","⚙","Account controls"],
    ["legal.html","Legal","▤","Terms & risk disclosure"]
  ];

  const accountLinks = [
    ["subscription.html","Subscription"],
    ["signin.html","Sign in"],
    ["signup.html","Create account"]
  ];

  function currentPage(){
    const file = (window.location.pathname.split("/").filter(Boolean).pop() || "index.html").toLowerCase();
    return file || "index.html";
  }

  function style(){
    if(document.getElementById("kb-unified-nav-style")) return;

    const s = document.createElement("style");
    s.id = "kb-unified-nav-style";
    s.textContent = `
      body.kb-has-unified-nav{
        padding-top:84px;
      }

      #kb-unified-nav{
        position:fixed;
        top:12px;
        left:12px;
        right:12px;
        z-index:2147483000;
        pointer-events:none;
        font-family:Space Grotesk,Inter,system-ui,sans-serif;
      }

      .kb-nav-bar{
        width:min(1480px,100%);
        min-height:62px;
        margin:0 auto;
        padding:9px 11px 9px 14px;
        display:flex;
        align-items:center;
        gap:18px;
        border:1px solid rgba(255,255,255,.09);
        border-radius:18px;
        background:linear-gradient(120deg,rgba(5,10,24,.9),rgba(8,14,31,.78));
        backdrop-filter:blur(22px);
        -webkit-backdrop-filter:blur(22px);
        box-shadow:0 18px 55px rgba(0,0,0,.42),0 0 35px rgba(25,230,255,.06);
        pointer-events:auto;
        position:relative;
        overflow:visible;
      }

      .kb-nav-bar::before{
        content:"";
        position:absolute;
        inset:-1px;
        border-radius:19px;
        padding:1px;
        background:linear-gradient(100deg,rgba(25,230,255,.42),rgba(155,92,255,.24),rgba(246,185,59,.36),rgba(25,230,255,.18));
        -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
        -webkit-mask-composite:xor;
        mask-composite:exclude;
        pointer-events:none;
      }

      .kb-nav-brand{
        display:flex;
        align-items:center;
        gap:10px;
        flex:none;
        text-decoration:none;
        color:#eef2ff;
      }

      .kb-nav-brand-mark{
        width:38px;
        height:38px;
        display:grid;
        place-items:center;
        border-radius:12px;
        color:#07101b;
        font:900 17px Orbitron,sans-serif;
        background:linear-gradient(135deg,#f6b93b,#19e6ff,#9b5cff);
        box-shadow:0 0 22px rgba(25,230,255,.22),0 0 28px rgba(246,185,59,.14);
        position:relative;
        overflow:hidden;
      }

      .kb-nav-brand-mark::after{
        content:"";
        position:absolute;
        inset:0;
        background:linear-gradient(120deg,transparent,rgba(255,255,255,.55),transparent);
        transform:translateX(-120%);
        animation:kbNavSweep 4.8s linear infinite;
      }

      @keyframes kbNavSweep{
        55%,100%{transform:translateX(120%)}
      }

      .kb-nav-brand-copy strong{
        display:block;
        font:900 12px/1 Orbitron,sans-serif;
        letter-spacing:.13em;
      }

      .kb-nav-brand-copy span{
        display:block;
        margin-top:4px;
        color:#687695;
        font:600 7px/1 JetBrains Mono,monospace;
        letter-spacing:.18em;
      }

      .kb-nav-actions{
        margin-left:auto;
        display:flex;
        align-items:center;
        justify-content:flex-end;
        min-width:0;
      }

      .kb-nav-links{
        display:flex;
        align-items:center;
        justify-content:flex-end;
        flex-wrap:wrap;
        gap:3px;
      }

      .kb-nav-links a{
        display:inline-flex;
        align-items:center;
        gap:5px;
        padding:8px 9px;
        border-radius:9px;
        color:#8d98b5;
        text-decoration:none;
        font:700 8px/1 Space Grotesk,sans-serif;
        letter-spacing:.025em;
        white-space:nowrap;
        transition:.2s ease;
        border:1px solid transparent;
      }

      .kb-nav-links a .kb-nav-icon{
        color:#19e6ff;
        font-size:11px;
      }

      .kb-nav-links a:hover,
      .kb-nav-links a.kb-active{
        color:#ffffff;
        border-color:rgba(25,230,255,.15);
        background:linear-gradient(90deg,rgba(25,230,255,.08),rgba(155,92,255,.06));
        box-shadow:0 0 16px rgba(25,230,255,.05);
      }

      .kb-nav-right-stack{
        display:flex;
        flex-direction:column;
        align-items:flex-end;
        gap:5px;
        min-width:0;
      }

      .kb-nav-command-line{
        display:flex;
        align-items:center;
        justify-content:flex-end;
        gap:6px;
      }

      .kb-nav-status{
        display:inline-flex;
        align-items:center;
        gap:5px;
        color:#61708f;
        font:700 7px/1 JetBrains Mono,monospace;
        letter-spacing:.08em;
        white-space:nowrap;
      }

      .kb-nav-live{
        width:5px;
        height:5px;
        border-radius:50%;
        background:#23f7a3;
        box-shadow:0 0 9px #23f7a3;
        animation:kbNavPulse 1.6s ease-in-out infinite;
      }

      @keyframes kbNavPulse{
        50%{opacity:.3;transform:scale(.72)}
      }

      .kb-dashboard-portrait{
        display:flex;
        align-items:center;
        gap:7px;
        padding:4px 7px 4px 4px;
        border-radius:10px;
        color:#dfe7ff;
        text-decoration:none;
        background:rgba(255,255,255,.028);
        border:1px solid rgba(246,185,59,.16);
        box-shadow:0 0 18px rgba(246,185,59,.07);
        transition:.2s ease;
      }

      .kb-dashboard-portrait:hover{
        transform:translateY(-1px);
        border-color:rgba(25,230,255,.34);
        box-shadow:0 0 26px rgba(25,230,255,.12),0 0 18px rgba(246,185,59,.08);
      }

      .kb-dashboard-portrait img{
        width:32px;
        height:32px;
        object-fit:cover;
        border-radius:8px;
        display:block;
        border:1px solid rgba(25,230,255,.22);
        box-shadow:0 0 12px rgba(25,230,255,.15);
      }

      .kb-dashboard-portrait .dash-copy strong{
        display:block;
        color:#f6c75b;
        font:900 7px/1 Orbitron,sans-serif;
        letter-spacing:.1em;
      }

      .kb-dashboard-portrait .dash-copy span{
        display:block;
        margin-top:3px;
        color:#64708b;
        font:600 6px/1 JetBrains Mono,monospace;
        letter-spacing:.05em;
      }

      #kb-mobile-nav-trigger{
        display:none;
        width:43px;
        height:43px;
        flex:none;
        border:1px solid rgba(25,230,255,.22);
        border-radius:12px;
        background:rgba(5,10,24,.86);
        color:#eef2ff;
        box-shadow:0 0 24px rgba(25,230,255,.09);
      }

      #kb-mobile-nav-trigger .kb-bars{
        width:18px;
        height:14px;
        margin:auto;
        position:relative;
        display:block;
      }

      #kb-mobile-nav-trigger .kb-bars i{
        position:absolute;
        left:0;
        width:100%;
        height:2px;
        border-radius:2px;
        background:linear-gradient(90deg,#19e6ff,#9b5cff,#f6b93b);
        transition:.2s ease;
      }

      #kb-mobile-nav-trigger .kb-bars i:nth-child(1){top:0}
      #kb-mobile-nav-trigger .kb-bars i:nth-child(2){top:6px}
      #kb-mobile-nav-trigger .kb-bars i:nth-child(3){top:12px}

      #kb-mobile-nav-trigger[aria-expanded="true"] .kb-bars i:nth-child(1){top:6px;transform:rotate(45deg)}
      #kb-mobile-nav-trigger[aria-expanded="true"] .kb-bars i:nth-child(2){opacity:0}
      #kb-mobile-nav-trigger[aria-expanded="true"] .kb-bars i:nth-child(3){top:6px;transform:rotate(-45deg)}

      .kb-mobile-panel{
        display:none;
        margin-top:8px;
        margin-left:auto;
        width:min(430px,calc(100vw - 24px));
        max-height:calc(100vh - 90px);
        overflow:auto;
        padding:12px;
        border-radius:17px;
        border:1px solid rgba(25,230,255,.16);
        background:linear-gradient(145deg,rgba(6,12,28,.98),rgba(3,7,17,.98));
        box-shadow:0 25px 90px rgba(0,0,0,.6),0 0 40px rgba(25,230,255,.07);
      }

      .kb-mobile-panel.kb-open{display:block}

      .kb-mobile-grid{
        display:grid;
        grid-template-columns:repeat(2,minmax(0,1fr));
        gap:6px;
      }

      .kb-mobile-grid a{
        min-height:54px;
        padding:9px;
        display:flex;
        flex-direction:column;
        justify-content:center;
        gap:3px;
        border-radius:11px;
        color:#8e9abb;
        text-decoration:none;
        background:rgba(255,255,255,.025);
        border:1px solid rgba(255,255,255,.05);
      }

      .kb-mobile-grid a:hover,
      .kb-mobile-grid a.kb-active{
        color:#fff;
        border-color:rgba(25,230,255,.18);
        background:rgba(25,230,255,.055);
      }

      .kb-mobile-grid .kb-mobile-name{
        font:800 8px/1.1 Orbitron,sans-serif;
      }

      .kb-mobile-grid .kb-mobile-desc{
        font:500 7px/1.2 JetBrains Mono,monospace;
        color:#586581;
      }

      .kb-mobile-account{
        display:grid;
        grid-template-columns:repeat(3,1fr);
        gap:6px;
        margin-top:9px;
        padding-top:9px;
        border-top:1px solid rgba(255,255,255,.06);
      }

      .kb-mobile-account a{
        padding:9px 6px;
        border-radius:9px;
        text-align:center;
        color:#8895b5;
        text-decoration:none;
        font:700 7px/1.2 Space Grotesk,sans-serif;
        background:rgba(255,255,255,.025);
        border:1px solid rgba(255,255,255,.05);
      }

      .kb-mobile-dashboard{
        display:flex;
        align-items:center;
        gap:9px;
        margin-top:9px;
        padding:8px;
        border-radius:12px;
        background:linear-gradient(90deg,rgba(246,185,59,.07),rgba(25,230,255,.05));
        border:1px solid rgba(246,185,59,.14);
      }

      .kb-mobile-dashboard img{
        width:42px;
        height:42px;
        border-radius:10px;
        object-fit:cover;
        border:1px solid rgba(25,230,255,.2);
      }

      .kb-mobile-dashboard strong{
        display:block;
        font:800 8px Orbitron,sans-serif;
        color:#f6c75b;
        letter-spacing:.08em;
      }

      .kb-mobile-dashboard span{
        display:block;
        margin-top:3px;
        color:#63718c;
        font:600 7px JetBrains Mono,monospace;
      }

      .kb-mobile-meta{
        margin-top:9px;
        display:flex;
        align-items:center;
        justify-content:space-between;
        color:#56627d;
        font:600 7px JetBrains Mono,monospace;
      }

      @media(max-width:1120px){
        .kb-nav-links a{
          padding:7px 7px;
          font-size:7.5px;
        }
        .kb-nav-brand-copy span{display:none}
      }

      @media(max-width:900px){
        body.kb-has-unified-nav{
          padding-top:70px;
        }

        #kb-unified-nav{
          top:8px;
          left:8px;
          right:8px;
        }
        .kb-nav-bar{
          min-height:56px;
          padding:7px 8px 7px 9px;
          border-radius:15px;
        }
        .kb-nav-brand-mark{
          width:35px;
          height:35px;
          border-radius:10px;
        }
        .kb-nav-brand-copy strong{font-size:10px}
        .kb-nav-right-stack{
          display:none;
        }
        #kb-mobile-nav-trigger{
          display:grid;
          place-items:center;
          margin-left:auto;
        }
        .kb-nav-actions{
          margin-left:auto;
        }
        .kb-mobile-panel{
          position:relative;
        }
      }

      @media(max-width:520px){
        .kb-nav-brand-copy strong{font-size:9px}
        .kb-nav-bar{gap:8px}
        .kb-mobile-panel{width:calc(100vw - 16px)}
        .kb-mobile-grid{grid-template-columns:1fr 1fr}
        .kb-mobile-account{grid-template-columns:1fr}
      }

      @media(prefers-reduced-motion:reduce){
        .kb-nav-brand-mark::after,
        .kb-nav-live{animation:none}
      }
    `;
    document.head.appendChild(s);
  }

  function build(){
    if(document.getElementById("kb-unified-nav")) return;

    // Auth/verification screens have their own focused layout.
    if(document.querySelector(".verify-shell,.auth-shell,.auth-card")) return;

    style();
    document.body.classList.add("kb-has-unified-nav");

    const page = currentPage();

    const desktopLinks = links.map(([href,name,icon])=>{
      const active = href.toLowerCase() === page;
      return '<a href="'+href+'"'+(active?' class="kb-active" aria-current="page"':'')+'>'+
        '<span class="kb-nav-icon">'+icon+'</span><span>'+name+'</span></a>';
    }).join("");

    const mobileLinks = links.map(([href,name,icon,desc])=>{
      const active = href.toLowerCase() === page;
      return '<a href="'+href+'"'+(active?' class="kb-active" aria-current="page"':'')+'>'+
        '<span class="kb-mobile-name">'+icon+' '+name+'</span>'+
        '<span class="kb-mobile-desc">'+desc+'</span></a>';
    }).join("");

    const account = accountLinks.map(([href,name]) =>
      '<a href="'+href+'">'+name+'</a>'
    ).join("");

    const shell = document.createElement("div");
    shell.id = "kb-unified-nav";
    shell.innerHTML =
      '<div class="kb-nav-bar">'+
        '<a class="kb-nav-brand" href="index.html" aria-label="KINGBOT FINTECH home">'+
          '<span class="kb-nav-brand-mark">K</span>'+
          '<span class="kb-nav-brand-copy"><strong>KINGBOT FINTECH</strong><span>INTELLIGENT TRADING INFRASTRUCTURE</span></span>'+
        '</a>'+
        '<div class="kb-nav-actions">'+
          '<div class="kb-nav-right-stack">'+
            '<div class="kb-nav-links" aria-label="Primary navigation">'+desktopLinks+'</div>'+
            '<div class="kb-nav-command-line">'+
              '<span class="kb-nav-status"><span class="kb-nav-live"></span>SYSTEM ONLINE</span>'+
              '<a class="kb-dashboard-portrait" href="index.html" aria-label="Open KINGBOT Dashboard">'+
                '<img src="assets/images/hero-bot.png" alt="KINGBOT dashboard portrait">'+
                '<span class="dash-copy"><strong>DASHBOARD</strong><span>COMMAND OVERVIEW</span></span>'+
              '</a>'+
            '</div>'+
          '</div>'+
          '<button id="kb-mobile-nav-trigger" type="button" aria-label="Open KINGBOT navigation" aria-expanded="false"><span class="kb-bars" aria-hidden="true"><i></i><i></i><i></i></span></button>'+
        '</div>'+
      '</div>'+
      '<div class="kb-mobile-panel" aria-label="KINGBOT mobile navigation">'+
        '<div class="kb-mobile-grid">'+mobileLinks+'</div>'+
        '<div class="kb-mobile-account">'+account+'</div>'+
        '<a class="kb-mobile-dashboard" href="index.html">'+
          '<img src="assets/images/hero-bot.png" alt="KINGBOT dashboard portrait">'+
          '<span><strong>GLOWING DASHBOARD</strong><span>COMMAND OVERVIEW · KINGBOT FINTECH</span></span>'+
        '</a>'+
        '<div class="kb-mobile-meta"><span>ONE NAVIGATION SURFACE</span><span>CONSISTENCY · RESILIENCE · INNOVATION</span></div>'+
      '</div>';

    document.body.appendChild(shell);

    const trigger = shell.querySelector("#kb-mobile-nav-trigger");
    const panel = shell.querySelector(".kb-mobile-panel");

    const close = () => {
      panel?.classList.remove("kb-open");
      trigger?.setAttribute("aria-expanded","false");
    };

    const open = () => {
      panel?.classList.add("kb-open");
      trigger?.setAttribute("aria-expanded","true");
    };

    trigger?.addEventListener("click", () => {
      if(panel?.classList.contains("kb-open")) close();
      else open();
    });

    shell.querySelectorAll("a").forEach(a => a.addEventListener("click", close));
    document.addEventListener("keydown", event => {
      if(event.key === "Escape") close();
    });

    window.KINGBOT_NAV = {
      config:{links,account:accountLinks},
      state:{initialized:true,open:false},
      initialize:()=>Promise.resolve(),
      current:currentPage,
      active:href=>String(href).toLowerCase()===currentPage(),
      open,
      close
    };
  }

  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",build,{once:true});
  } else {
    build();
  }

})(window,document);
