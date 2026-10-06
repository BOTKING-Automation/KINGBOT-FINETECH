/* KINGBOT FINTECH — Compact global navigation
   The previous large/full-height navigation dashboard has been removed.
   Only a small top-right command button remains.
   Clicking it opens a lightweight compact menu. */
(function(window, document){
  /* Shared runtime is loaded by every product surface through the global shell. */
  (function loadKingbotRuntime(){
    if(!document.querySelector('link[rel="icon"]')){
      const icon=document.createElement("link");
      icon.rel="icon";
      icon.type="image/png";
      icon.href="assets/images/kingbot-fintech-logo.png";
      document.head.appendChild(icon);
    }
    if(!document.querySelector('link[rel="stylesheet"][href="system/platform.css"]')){
      const css=document.createElement("link");
      css.rel="stylesheet";
      css.href="system/platform.css?v=theme-v5";
      document.head.appendChild(css);
    }
    if(!document.getElementById("kb-client-state")){
      const stateScript=document.createElement("script");
      stateScript.id="kb-client-state";
      stateScript.src="system/kingbot-client-state.js?v=theme-v5";
      stateScript.defer=true;
      document.head.appendChild(stateScript);
    }
    if(!document.getElementById("kb-site-performance")){
      const script=document.createElement("script");
      script.id="kb-site-performance";
      script.src="system/site-performance.js?v=theme-v5";
      script.defer=true;
      document.head.appendChild(script);
    }
    if(!document.getElementById("kb-ui-runtime")){
      const ui=document.createElement("script");
      ui.id="kb-ui-runtime";
      ui.src="system/ui-runtime.js?v=theme-v5";
      ui.defer=true;
      document.head.appendChild(ui);
    }
    if(!document.querySelector('link[rel="manifest"]')){
      const manifest=document.createElement("link");
      manifest.rel="manifest";
      manifest.href="manifest.webmanifest";
      document.head.appendChild(manifest);
    }
  })();
  "use strict";

  const links = [
    ["index.html","Overview","⌂","Core platform"],
    ["command-center.html","Command Center","◎","Unified trading control"],
    ["markets.html","Markets","◈","Live market intelligence"],
    ["terminal.html","Terminal","⌁","Trading terminal"],
    ["bots.html","Bots","◉","Automated trading systems"],
    ["broker-connect.html","Broker Connect","⚡","Secure broker execution"],
    ["partner-revenue.html","Partner Revenue","◌","Broker referral intelligence"],
    ["analytics.html","Analytics","▦","Performance intelligence"],
    ["ai.html","AI Intelligence","✦","AI intelligence layer"],
    ["scanner.html","AI Scanner","◫","Live AI market scanner"],
    ["gold-signals.html","Gold Signals","◆","Live XAUUSD signal desk"],
    ["academy.html","Academy","◇","Education & research"],
    ["platform-os.html","Company OS","▦","Full trading technology stack"],
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
    ["admin.html","Admin","admin"],
    ["#","Logout","logout"]
  ];

  function currentPage(){
    return (window.location.pathname.split("/").filter(Boolean).pop() || "index.html").toLowerCase();
  }

  function injectStyle(){
    if(document.getElementById("kb-compact-nav-style")) return;

    const style=document.createElement("style");
    style.id="kb-compact-nav-style";
    style.textContent=`
      #kb-compact-nav{
        position:fixed;
        top:14px;
        right:14px;
        z-index:2147483000;
        display:flex;
        align-items:center;
        gap:0;
        font-family:Space Grotesk,Inter,system-ui,sans-serif;
      }

      #kb-compact-nav .kb-fintech-logo{
        position:fixed;
        top:14px;
        left:14px;
        z-index:2147483001;
        width:58px;
        height:58px;
        display:block;
        object-fit:contain;
        border-radius:14px;
        padding:5px;
        background:rgba(4,9,22,.82);
        border:1px solid rgba(255,255,255,.10);
        box-shadow:0 0 28px rgba(25,230,255,.12),0 0 20px rgba(246,185,59,.07);
        transition:transform .2s ease,box-shadow .2s ease,border-color .2s ease;
      }

      #kb-compact-nav .kb-fintech-logo:hover{
        transform:translateY(-1px);
        border-color:rgba(25,230,255,.25);
        box-shadow:0 0 28px rgba(25,230,255,.13),0 0 18px rgba(246,185,59,.07);
      }

      #kb-compact-nav .kb-nav-trigger{
        position:relative;
        width:48px;
        height:48px;
        display:grid;
        place-items:center;
        border:1px solid rgba(255,255,255,.13);
        border-radius:14px;
        background:rgba(4,9,22,.86);
        backdrop-filter:blur(16px);
        -webkit-backdrop-filter:blur(16px);
        color:#eef4ff;
        cursor:pointer;
        box-shadow:0 12px 38px rgba(0,0,0,.42),0 0 24px rgba(25,230,255,.09);
        transition:.2s ease;
      }

      #kb-compact-nav .kb-nav-trigger::before{
        content:"";
        position:absolute;
        inset:-2px;
        padding:2px;
        border-radius:16px;
        background:conic-gradient(
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
        animation:kbCompactSpin 5s linear infinite;
        pointer-events:none;
      }

      /* Animated KINGBOT + crown logo: smooth gold → purple → blue → green → red */
      #kb-compact-nav .kb-fintech-logo{
        animation:kbLogoColorCycle 10s ease-in-out infinite, kbLogoFloat 3.8s ease-in-out infinite;
        will-change:filter,transform;
      }

      @keyframes kbLogoColorCycle{
        0%,100%{
          filter:saturate(1.15) brightness(1.06) hue-rotate(0deg) drop-shadow(0 0 10px rgba(246,185,59,.48)) drop-shadow(0 0 28px rgba(246,185,59,.20));
        }
        20%{
          filter:saturate(1.35) brightness(1.08) hue-rotate(228deg) drop-shadow(0 0 12px rgba(155,92,255,.62)) drop-shadow(0 0 32px rgba(155,92,255,.25));
        }
        40%{
          filter:saturate(1.35) brightness(1.08) hue-rotate(178deg) drop-shadow(0 0 12px rgba(71,135,255,.64)) drop-shadow(0 0 34px rgba(71,135,255,.25));
        }
        60%{
          filter:saturate(1.38) brightness(1.10) hue-rotate(108deg) drop-shadow(0 0 12px rgba(35,247,163,.64)) drop-shadow(0 0 34px rgba(35,247,163,.25));
        }
        80%{
          filter:saturate(1.42) brightness(1.10) hue-rotate(318deg) drop-shadow(0 0 13px rgba(255,77,109,.66)) drop-shadow(0 0 36px rgba(255,77,109,.27));
        }
      }

      @keyframes kbLogoFloat{
        0%,100%{transform:translateY(0) scale(1)}
        50%{transform:translateY(-2px) scale(1.025)}
      }

      #kb-compact-nav .kb-fintech-logo:hover{
        animation-play-state:paused;
        transform:translateY(-2px) scale(1.045);
      }

      #kb-compact-nav .kb-nav-trigger:hover{
        transform:translateY(-2px);
        box-shadow:0 16px 44px rgba(0,0,0,.5),0 0 32px rgba(25,230,255,.16);
      }

      #kb-compact-nav .kb-bars{
        position:relative;
        z-index:2;
        width:19px;
        height:15px;
      }

      #kb-compact-nav .kb-bars i{
        position:absolute;
        left:0;
        width:100%;
        height:2px;
        border-radius:3px;
        background:linear-gradient(90deg,#19e6ff,#9b5cff,#f6b93b);
        transition:.2s ease;
      }

      #kb-compact-nav .kb-bars i:nth-child(1){top:0}
      #kb-compact-nav .kb-bars i:nth-child(2){top:6px}
      #kb-compact-nav .kb-bars i:nth-child(3){top:12px}

      #kb-compact-nav .kb-nav-trigger[aria-expanded="true"] .kb-bars i:nth-child(1){
        top:6px;
        transform:rotate(45deg);
      }

      #kb-compact-nav .kb-nav-trigger[aria-expanded="true"] .kb-bars i:nth-child(2){
        opacity:0;
      }

      #kb-compact-nav .kb-nav-trigger[aria-expanded="true"] .kb-bars i:nth-child(3){
        top:6px;
        transform:rotate(-45deg);
      }

      @keyframes kbCompactSpin{
        to{transform:rotate(360deg)}
      }

      #kb-compact-nav .kb-system-pulse{
        position:fixed;
        top:15px;
        right:72px;
        min-width:118px;
        height:42px;
        display:flex;
        align-items:center;
        justify-content:center;
        gap:7px;
        padding:0 11px;
        border-radius:12px;
        border:1px solid rgba(35,247,163,.12);
        background:rgba(4,9,22,.78);
        backdrop-filter:blur(14px);
        -webkit-backdrop-filter:blur(14px);
        box-shadow:0 12px 32px rgba(0,0,0,.28);
        color:#8fa8a3;
        font:800 7px JetBrains Mono,monospace;
        letter-spacing:.08em;
      }
      #kb-compact-nav .kb-system-dot{
        width:6px;height:6px;border-radius:50%;background:#23f7a3;box-shadow:0 0 11px rgba(35,247,163,.8);
      }
      #kb-compact-nav .kb-system-pulse[data-state="offline"]{color:#ffb2c0;border-color:rgba(255,77,109,.16)}
      #kb-compact-nav .kb-system-pulse[data-state="offline"] .kb-system-dot{background:#ff4d6d;box-shadow:0 0 11px rgba(255,77,109,.65)}

      @media(prefers-reduced-motion:reduce){
        #kb-compact-nav .kb-fintech-logo{animation:none}
      }

      #kb-compact-nav .kb-menu{
        position:absolute;
        top:58px;
        right:0;
        width:min(310px,calc(100vw - 28px));
        padding:8px;
        border-radius:15px;
        border:1px solid rgba(255,255,255,.10);
        background:
          radial-gradient(circle at 10% 0%,rgba(25,230,255,.08),transparent 34%),
          radial-gradient(circle at 95% 15%,rgba(155,92,255,.08),transparent 34%),
          linear-gradient(145deg,rgba(7,13,29,.98),rgba(3,7,17,.99));
        box-shadow:0 25px 75px rgba(0,0,0,.62),0 0 36px rgba(25,230,255,.07);
        opacity:0;
        transform:translateY(-7px) scale(.98);
        pointer-events:none;
        visibility:hidden;
        transition:opacity .18s ease,transform .18s ease,visibility .18s;
      }

      #kb-compact-nav .kb-menu::before{
        content:"";
        position:absolute;
        inset:-1px;
        border-radius:16px;
        padding:1px;
        background:linear-gradient(
          120deg,
          rgba(25,230,255,.5),
          rgba(155,92,255,.32),
          rgba(255,79,216,.32),
          rgba(246,185,59,.45),
          rgba(35,247,163,.32)
        );
        -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
        -webkit-mask-composite:xor;
        mask-composite:exclude;
        pointer-events:none;
      }

      #kb-compact-nav .kb-menu.kb-open{
        opacity:1;
        transform:none;
        pointer-events:auto;
        visibility:visible;
      }

      .kb-menu-head{
        position:relative;
        z-index:1;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        padding:8px 9px 11px;
        border-bottom:1px solid rgba(255,255,255,.06);
      }

      .kb-menu-title{
        color:#eef2ff;
        font:900 9px Orbitron,sans-serif;
        letter-spacing:.11em;
      }

      .kb-menu-state{
        display:flex;
        align-items:center;
        gap:5px;
        color:#6e7c99;
        font:700 7px JetBrains Mono,monospace;
      }

      .kb-menu-dot{
        width:6px;
        height:6px;
        border-radius:50%;
        background:#23f7a3;
        box-shadow:0 0 10px #23f7a3;
      }

      .kb-menu-grid{
        position:relative;
        z-index:1;
        display:grid;
        grid-template-columns:repeat(2,minmax(0,1fr));
        gap:6px;
        padding:9px 0 0;
      }

      .kb-menu-grid a{
        min-height:38px;
        display:flex;
        align-items:center;
        gap:8px;
        padding:7px 8px;
        border-radius:10px;
        color:#8e9ab8;
        text-decoration:none;
        border:1px solid rgba(255,255,255,.05);
        background:rgba(255,255,255,.022);
        transition:.17s ease;
      }

      .kb-menu-grid a:hover,
      .kb-menu-grid a.kb-active{
        color:#fff;
        border-color:rgba(25,230,255,.20);
        background:linear-gradient(90deg,rgba(25,230,255,.07),rgba(155,92,255,.06));
      }

      .kb-menu-icon{
        width:25px;
        height:25px;
        flex:none;
        display:grid;
        place-items:center;
        border-radius:7px;
        background:rgba(255,255,255,.04);
        color:#19e6ff;
        font-size:11px;
      }

      .kb-menu-grid a.kb-active .kb-menu-icon{
        color:#f6b93b;
      }

      .kb-menu-name{
        font:800 7.5px/1.1 Orbitron,sans-serif;
      }

      .kb-menu-sub{
        display:block;
        margin-top:3px;
        color:#586681;
        font:600 5.8px/1.15 JetBrains Mono,monospace;
      }

      .kb-menu-account{
        position:relative;
        z-index:1;
        display:grid;
        grid-template-columns:repeat(3,1fr);
        gap:6px;
        margin-top:9px;
        padding-top:9px;
        border-top:1px solid rgba(255,255,255,.06);
      }

      .kb-menu-account a{
        padding:8px 5px;
        text-align:center;
        color:#7f8ba8;
        text-decoration:none;
        border:1px solid rgba(255,255,255,.05);
        border-radius:8px;
        background:rgba(255,255,255,.02);
        font:700 7px Space Grotesk,sans-serif;
      }

      .kb-menu-account a:hover{
        color:#fff;
        border-color:rgba(246,185,59,.20);
      }

      .kb-command-snapshot{
        position:relative;
        z-index:1;
        margin-top:9px;
        padding:9px;
        border:1px solid rgba(25,230,255,.10);
        border-radius:11px;
        background:linear-gradient(135deg,rgba(25,230,255,.035),rgba(155,92,255,.035),rgba(246,185,59,.025));
      }
      .kb-command-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}
      .kb-command-title{font:900 7px Orbitron,sans-serif;letter-spacing:.12em;color:#dbe6fb}
      .kb-command-refresh{border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025);color:#8ea0bd;border-radius:7px;padding:5px 7px;font:800 6px JetBrains Mono,monospace;cursor:pointer}
      .kb-command-refresh:hover{color:#fff;border-color:rgba(25,230,255,.18)}
      .kb-command-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}
      .kb-command-cell{min-width:0;padding:6px 7px;border-radius:8px;background:rgba(255,255,255,.018);border:1px solid rgba(255,255,255,.045)}
      .kb-command-label{display:block;color:#56657f;font:700 5.5px JetBrains Mono,monospace;letter-spacing:.08em}
      .kb-command-value{display:block;margin-top:2px;color:#dfe8f8;font:900 7px JetBrains Mono,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .kb-command-value.good{color:#86ffd0}.kb-command-value.warn{color:#ffd977}.kb-command-value.bad{color:#ff9bad}
      .kb-command-foot{margin-top:6px;color:#4d5b74;font:600 5.5px JetBrains Mono,monospace}
      .kb-menu-footer{
        position:relative;
        z-index:1;
        display:flex;
        justify-content:space-between;
        gap:8px;
        margin-top:8px;
        color:#4f5d78;
        font:600 6px JetBrains Mono,monospace;
        letter-spacing:.05em;
      }

      @media(max-width:560px){
        #kb-ai-float{right:12px;bottom:14px;width:58px;height:58px;border-radius:18px}
        #kb-ai-float .kb-ai-orb{width:39px;height:39px;border-radius:13px}
        #kb-ai-float .kb-ai-label{display:none}
        #kb-compact-nav{top:10px;right:10px}
        #kb-compact-nav .kb-fintech-logo{top:10px;left:10px;width:46px;height:46px;border-radius:12px}
        #kb-compact-nav .kb-nav-trigger{width:44px;height:44px}
        #kb-compact-nav .kb-menu{
          top:53px;
          width:calc(100vw - 20px);
          right:-2px;
        }
      }

      @media(prefers-reduced-motion:reduce){
        #kb-compact-nav .kb-nav-trigger::before{animation:none}
      }
      @media(prefers-reduced-motion:reduce){
        #kb-ai-float,
        #kb-ai-float::before,
        #kb-ai-float::after,
        #kb-ai-float .kb-ai-orb::before,
        #kb-ai-float .kb-ai-icon{animation:none!important}
      }


      /* Floating KINGBOT AI assistant — shared across all navigation-enabled pages */
      #kb-ai-float{
        position:fixed;
        right:18px;
        bottom:18px;
        z-index:2147482999;
        /* Fixed to the viewport so the AI companion stays visible while the page scrolls. */
        width:64px;
        height:64px;
        display:grid;
        place-items:center;
        border-radius:21px;
        text-decoration:none;
        background:rgba(3,8,20,.88);
        border:1px solid rgba(255,255,255,.16);
        box-shadow:
          0 18px 55px rgba(0,0,0,.52),
          0 0 24px rgba(25,230,255,.18),
          0 0 42px rgba(155,92,255,.10);
        backdrop-filter:blur(16px);
        -webkit-backdrop-filter:blur(16px);
        isolation:isolate;
        transition:transform .22s ease,box-shadow .22s ease;
        animation:kbAiFloat 3.8s ease-in-out infinite;
        will-change:transform;
      }

      #kb-ai-float::before{
        content:"";
        position:absolute;
        inset:-2px;
        border-radius:23px;
        padding:2px;
        background:conic-gradient(
          #19e6ff,
          #4787ff,
          #9b5cff,
          #ff4fd8,
          #ff4d6d,
          #f6b93b,
          #23f7a3,
          #19e6ff
        );
        animation:kbAiHueSpin 4.5s linear infinite;
        -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
        -webkit-mask-composite:xor;
        mask-composite:exclude;
        z-index:-1;
      }

      #kb-ai-float::after{
        content:"";
        position:absolute;
        inset:9px;
        border-radius:16px;
        background:conic-gradient(
          from 20deg,
          rgba(25,230,255,.16),
          rgba(155,92,255,.14),
          rgba(255,79,216,.14),
          rgba(246,185,59,.14),
          rgba(35,247,163,.14),
          rgba(25,230,255,.16)
        );
        filter:blur(10px);
        animation:kbAiGlowCycle 5s ease-in-out infinite;
        z-index:-1;
      }

      #kb-ai-float .kb-ai-orb{
        position:relative;
        width:43px;
        height:43px;
        display:grid;
        place-items:center;
        border-radius:15px;
        background:linear-gradient(145deg,rgba(8,18,38,.98),rgba(10,6,27,.98));
        border:1px solid rgba(255,255,255,.13);
        box-shadow:inset 0 0 18px rgba(25,230,255,.08);
        overflow:hidden;
      }

      #kb-ai-float .kb-ai-orb::before{
        content:"";
        position:absolute;
        width:75px;
        height:16px;
        left:-18px;
        top:14px;
        background:linear-gradient(90deg,transparent,rgba(25,230,255,.38),rgba(255,79,216,.40),transparent);
        transform:rotate(-32deg);
        animation:kbAiScan 2.3s linear infinite;
      }

      #kb-ai-float .kb-ai-icon{
        position:relative;
        z-index:2;
        width:27px;
        height:27px;
        display:grid;
        place-items:center;
        border-radius:9px;
        color:#fff;
        font:900 13px Orbitron,sans-serif;
        background:linear-gradient(135deg,#19e6ff,#9b5cff,#ff4fd8,#f6b93b,#23f7a3);
        background-size:300% 300%;
        -webkit-background-clip:text;
        background-clip:text;
        -webkit-text-fill-color:transparent;
        animation:kbAiColorShift 4s ease infinite;
        filter:drop-shadow(0 0 8px rgba(25,230,255,.55));
      }

      #kb-ai-float .kb-ai-label{
        position:absolute;
        right:0;
        bottom:-24px;
        padding:5px 8px;
        border-radius:8px;
        color:#dce8ff;
        background:rgba(3,8,19,.94);
        border:1px solid rgba(255,255,255,.10);
        font:800 6px JetBrains Mono,monospace;
        letter-spacing:.08em;
        white-space:nowrap;
        opacity:0;
        transform:translateY(4px);
        pointer-events:none;
        transition:.18s ease;
        box-shadow:0 8px 24px rgba(0,0,0,.4);
      }

      #kb-ai-float:hover{
        transform:translateY(-4px) scale(1.045);
        box-shadow:
          0 22px 65px rgba(0,0,0,.56),
          0 0 30px rgba(25,230,255,.25),
          0 0 50px rgba(155,92,255,.16);
        animation-play-state:paused;
      }

      #kb-ai-float:hover .kb-ai-label{
        opacity:1;
        transform:none;
      }

      #kb-ai-float:focus-visible{
        outline:2px solid #19e6ff;
        outline-offset:4px;
      }

      @keyframes kbAiHueSpin{
        to{transform:rotate(360deg)}
      }

      @keyframes kbAiColorShift{
        0%,100%{background-position:0% 50%;filter:drop-shadow(0 0 8px rgba(25,230,255,.62))}
        25%{background-position:50% 0%;filter:drop-shadow(0 0 9px rgba(155,92,255,.68))}
        50%{background-position:100% 50%;filter:drop-shadow(0 0 10px rgba(255,79,216,.68))}
        75%{background-position:50% 100%;filter:drop-shadow(0 0 9px rgba(35,247,163,.68))}
      }

      @keyframes kbAiGlowCycle{
        0%,100%{opacity:.55;transform:scale(.92)}
        50%{opacity:1;transform:scale(1.08)}
      }

      @keyframes kbAiScan{
        from{transform:translateX(-45px) rotate(-32deg)}
        to{transform:translateX(75px) rotate(-32deg)}
      }

      @keyframes kbAiFloat{
        0%,100%{transform:translate3d(0,0,0) rotate(0deg)}
        25%{transform:translate3d(2px,-5px,0) rotate(-1deg)}
        50%{transform:translate3d(0,-8px,0) rotate(0deg)}
        75%{transform:translate3d(-2px,-5px,0) rotate(1deg)}
      }

    `;

    document.head.appendChild(style);
  }

  function build(){
    if(document.getElementById("kb-compact-nav")) return;

    // Global user shell: logo + navigation remain available across every public/user surface.
    injectStyle();

    const page=currentPage();

    const pageLinks=links.map(([href,name,icon,desc])=>{
      const active=href.toLowerCase()===page;
      const adminOnly=href.toLowerCase()==="platform-os.html";
      const classes=[active?"kb-active":"",adminOnly?"kb-admin-only-link":""] .filter(Boolean).join(" ");
      return '<a href="'+href+'"'+
        (classes?' class="'+classes+'"':'')+
        (active?' aria-current="page"':'')+
        (adminOnly?' data-kb-admin-only="true" hidden':'')+'>'+
        '<span class="kb-menu-icon">'+icon+'</span>'+
        '<span><span class="kb-menu-name">'+name+'</span><span class="kb-menu-sub">'+desc+'</span></span>'+
      '</a>';
    }).join("");

    const accountLinks = window.KINGBOT_SESSION?.isAuthenticated?.()
      ? authenticatedAccountLinks
      : guestAccountLinks;

    const account=accountLinks.map(([href,name,action])=>{
      if(action==="logout"){
        return '<a href="#" data-kb-logout>'+name+'</a>';
      }
      return '<a href="'+href+'">'+name+'</a>';
    }).join("");

    const skip=document.createElement("a");
    skip.className="kb-skip-link";
    skip.href="#main";
    skip.textContent="Skip to content";
    document.body.appendChild(skip);

    const live=document.createElement("div");
    live.className="kb-live-region";
    live.setAttribute("aria-live","polite");
    live.id="kb-live-region";
    document.body.appendChild(live);

    const aiFloat=document.createElement("a");
    aiFloat.id="kb-ai-float";
    aiFloat.href="ai.html#consoleSection";
    aiFloat.setAttribute("aria-label","Open KINGBOT AI support");
    aiFloat.setAttribute("title","KINGBOT AI · Ask for help");
    aiFloat.innerHTML='<span class="kb-ai-orb"><span class="kb-ai-icon" aria-hidden="true">✦</span></span><span class="kb-ai-label">KINGBOT AI · SUPPORT</span>';
    document.body.appendChild(aiFloat);

    const root=document.createElement("div");
    root.id="kb-compact-nav";
    root.innerHTML=
      '<a href="index.html" aria-label="KINGBOT FINTECH home" style="display:block">'+
        '<img class="kb-fintech-logo" src="assets/images/kingbot-fintech-logo.png" alt="KINGBOT FINTECH logo" title="KINGBOT FINTECH">'+
      '</a>'+
      '<button class="kb-nav-trigger" type="button" aria-label="Open KINGBOT navigation" aria-expanded="false">'+
        '<span class="kb-bars" aria-hidden="true"><i></i><i></i><i></i></span>'+
      '</button>'+
      '<div class="kb-system-pulse" data-kb-network-state data-state="online" aria-live="polite"><span class="kb-system-dot"></span><span>NETWORK <b>ONLINE</b></span></div><div class="kb-menu" role="navigation" aria-label="KINGBOT navigation">'+
        '<div class="kb-menu-head">'+
          '<div class="kb-menu-title">KINGBOT NAVIGATION</div>'+
          '<div class="kb-menu-state"><span class="kb-menu-dot"></span>SYSTEM ONLINE</div>'+
        '</div>'+
        '<div class="kb-menu-grid">'+pageLinks+'</div>'+
        '<div class="kb-command-snapshot" data-kb-command-snapshot>'+
          '<div class="kb-command-top"><span class="kb-command-title">LIVE CORE SNAPSHOT</span><button class="kb-command-refresh" type="button" data-kb-command-refresh>REFRESH</button></div>'+
          '<div class="kb-command-grid">'+
            '<div class="kb-command-cell"><span class="kb-command-label">BROKER</span><span class="kb-command-value" data-kb-core-broker>—</span></div>'+
            '<div class="kb-command-cell"><span class="kb-command-label">ACCOUNT</span><span class="kb-command-value" data-kb-core-account>—</span></div>'+
            '<div class="kb-command-cell"><span class="kb-command-label">BOT</span><span class="kb-command-value" data-kb-core-bot>—</span></div>'+
            '<div class="kb-command-cell"><span class="kb-command-label">RISK</span><span class="kb-command-value" data-kb-core-risk>—</span></div>'+
          '</div>'+
          '<div class="kb-command-foot" data-kb-core-time>CORE STATE STANDBY</div>'+
        '</div>'+
        '<div class="kb-menu-account">'+account+'</div>'+
        '<div class="kb-menu-footer"><span>COMPACT CONTROL</span><span>GIBSONFX TECH</span></div>'+
      '</div>';

    document.body.appendChild(root);
    document.querySelector("main")?.setAttribute("id","main");
    document.documentElement.classList.add("kb-page-enter");

    const trigger=root.querySelector(".kb-nav-trigger");
    const menu=root.querySelector(".kb-menu");

    function close(){
      menu.classList.remove("kb-open");
      trigger.setAttribute("aria-expanded","false");
    }

    function open(){
      menu.classList.add("kb-open");
      trigger.setAttribute("aria-expanded","true");
    }

    trigger.addEventListener("click",()=>menu.classList.contains("kb-open")?close():open());
    root.querySelectorAll("a").forEach(a=>a.addEventListener("click",close));
    root.querySelectorAll("a[href]").forEach(a=>a.addEventListener("mouseenter",()=>window.KINGBOT_PERFORMANCE?.prefetch?.(a.getAttribute("href")),{passive:true}));
    root.querySelector("[data-kb-logout]")?.addEventListener("click",async event=>{
      event.preventDefault();
      close();
      const logout=window.KINGBOT_SESSION?.logout;
      if(logout){
        await logout({redirect:true});
      }else{
        window.location.replace("access-stable.html");
      }
    });

    function syncAdminNav(detail){
      const state=detail || window.KINGBOT_CLIENT_STATE?.getState?.() || {};
      const admin=state?.auth?.user?.admin===true || state?.user?.admin===true;
      root.querySelectorAll("[data-kb-admin-only]").forEach(el=>{
        el.hidden=!admin;
        el.setAttribute("aria-hidden",admin?"false":"true");
      });
      return admin;
    }

    function syncAuthUI(detail){
      const authenticated = detail?.authenticated === true ||
        window.KINGBOT_SESSION?.isAuthenticated?.() === true;

      const accountNode=root.querySelector(".kb-menu-account");
      if(accountNode){
        const activeLinks=authenticated ? authenticatedAccountLinks : guestAccountLinks;
        accountNode.innerHTML=activeLinks.map(([href,name,action])=>{
          if(action==="logout") return '<a href="#" data-kb-logout>'+name+'</a>';
          return '<a href="'+href+'">'+name+'</a>';
        }).join("");

        accountNode.querySelectorAll("a").forEach(a=>a.addEventListener("click",close));
        accountNode.querySelector("[data-kb-logout]")?.addEventListener("click",async event=>{
          event.preventDefault();
          close();
          const logout=window.KINGBOT_SESSION?.logout;
          if(logout) await logout({redirect:true});
          else window.location.replace("access-stable.html");
        });
      }

      const state=root.querySelector(".kb-menu-state");
      if(state){
        state.innerHTML=authenticated
          ? '<span class="kb-menu-dot"></span>AUTHENTICATED'
          : '<span class="kb-menu-dot"></span>SYSTEM ONLINE';
      }

      document.querySelectorAll("[data-kb-auth-cta]").forEach(el=>{
        if(authenticated){
          el.textContent="DASHBOARD →";
          el.setAttribute("href","index.html");
          el.classList.remove("kb-guest-only");
        }else{
          el.textContent=el.dataset.guestText||"ENTER KINGBOT →";
          el.setAttribute("href","access-stable.html#signin");
        }
      });

      document.querySelectorAll("[data-kb-guest-only]").forEach(el=>{
        el.hidden=authenticated;
      });
      syncAdminNav();
    }

    window.KINGBOT_NAV={
      config:{links,guestAccount:guestAccountLinks,authenticatedAccount:authenticatedAccountLinks},
      state:{initialized:true,open:false},
      initialize:()=>Promise.resolve(),
      current:currentPage,
      active:href=>String(href).toLowerCase()===currentPage(),
      open,close,
      syncAuthUI
    };

    syncAuthUI();

    function renderCoreSnapshot(snapshot){
      const snap=root.querySelector("[data-kb-command-snapshot]"); if(!snap)return;
      const broker=snapshot?.broker||{};
      const account=snapshot?.account?.account||snapshot?.account?.accountSnapshot||snapshot?.account||{};
      const selection=snapshot?.botSelection?.bot||{};
      const risk=snapshot?.risk?.executionControl||snapshot?.risk||{};
      const b=snap.querySelector("[data-kb-core-broker]");
      const a=snap.querySelector("[data-kb-core-account]");
      const bot=snap.querySelector("[data-kb-core-bot]");
      const rr=snap.querySelector("[data-kb-core-risk]");
      if(b){b.textContent=broker.connected?String(broker.broker||"CONNECTED").toUpperCase():"OFFLINE";b.className="kb-command-value "+(broker.connected?"good":"warn");}
      if(a){const balance=Number(account?.balance);a.textContent=Number.isFinite(balance)?(String(account?.currency||"")+" "+balance.toLocaleString()):"CONNECTED";a.className="kb-command-value "+(snapshot?.account?.ok===false?"warn":"good");}
      if(bot){bot.textContent=selection.name||selection.botId||"NO SELECTION";bot.className="kb-command-value "+(selection.state==="RUNNING"?"good":"");}
      if(rr){rr.textContent=risk.globalKillSwitch?"GLOBAL KILL":risk.tradingPaused?"PAUSED":"OPEN";rr.className="kb-command-value "+(risk.globalKillSwitch?"bad":risk.tradingPaused?"warn":"good");}
      const tm=snap.querySelector("[data-kb-core-time]"); if(tm)tm.textContent="CORE UPDATED "+new Date(snapshot?.updatedAt||Date.now()).toLocaleTimeString();
    }

    function bindCoreState(){
      const store=window.KINGBOT_CLIENT_STATE;
      if(!store?.subscribe)return;
      store.subscribe(renderCoreSnapshot);
      root.querySelector("[data-kb-command-refresh]")?.addEventListener("click",()=>store.refresh({reason:"nav-manual-refresh"}));
    }

    bindCoreState();
    if(window.KINGBOT_CLIENT_STATE?.subscribe){
      window.KINGBOT_CLIENT_STATE.subscribe(snapshot=>syncAdminNav(snapshot));
    }
    syncAdminNav();
    window.addEventListener("kingbot:session-change",event=>{syncAuthUI(event.detail||{});syncAdminNav();void window.KINGBOT_CLIENT_STATE?.refresh?.({reason:"session-change"});});
    window.addEventListener("kingbot:event-bus-ready",()=>{
      const state=root.querySelector(".kb-menu-state");
      if(state && (window.KINGBOT_SESSION?.isAuthenticated?.()===true)){
        state.innerHTML='<span class="kb-menu-dot"></span>LIVE CORE';
      }
    });
    window.addEventListener("kingbot:event",event=>{
      const type=String(event?.detail?.eventType||"").toUpperCase();
      if(!type)return;
      const state=root.querySelector(".kb-menu-state");
      if(state && /ERROR|REJECT|FAIL|DISCONNECT|BLOCK/.test(type)){
        state.innerHTML='<span class="kb-menu-dot" style="background:#ff4d6d;box-shadow:0 0 10px #ff4d6d"></span>'+type.replaceAll("_"," ");
        clearTimeout(window.__kbNavStatusTimer);
        window.__kbNavStatusTimer=setTimeout(()=>syncAuthUI(),4500);
      }
    });
  }

  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",build,{once:true});
  }else{
    build();
  }

})(window,document);
