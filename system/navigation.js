/* KINGBOT FINTECH — Compact global navigation
   The previous large/full-height navigation dashboard has been removed.
   Only a small top-right command button remains.
   Clicking it opens a lightweight compact menu. */
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
        width:42px;
        height:42px;
        display:block;
        object-fit:contain;
        border-radius:11px;
        padding:4px;
        background:rgba(4,9,22,.82);
        border:1px solid rgba(255,255,255,.10);
        box-shadow:0 0 22px rgba(25,230,255,.08),0 0 16px rgba(246,185,59,.05);
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
        #kb-compact-nav{top:10px;right:10px}
        #kb-compact-nav .kb-fintech-logo{top:10px;left:10px;width:38px;height:38px;border-radius:10px}
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
    `;

    document.head.appendChild(style);
  }

  function build(){
    if(document.getElementById("kb-compact-nav")) return;

    // Auth/verification screens remain clean and focused.
    if(document.querySelector(".verify-shell,.auth-shell,.auth-card")) return;

    injectStyle();

    const page=currentPage();

    const pageLinks=links.map(([href,name,icon,desc])=>{
      const active=href.toLowerCase()===page;
      return '<a href="'+href+'"'+(active?' class="kb-active" aria-current="page"':'')+'>'+
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

    const root=document.createElement("div");
    root.id="kb-compact-nav";
    root.innerHTML=
      '<img class="kb-fintech-logo" src="assets/images/kingbot-fintech-logo.png" alt="KINGBOT FINTECH logo" title="KINGBOT FINTECH">'+
      '<button class="kb-nav-trigger" type="button" aria-label="Open KINGBOT navigation" aria-expanded="false">'+
        '<span class="kb-bars" aria-hidden="true"><i></i><i></i><i></i></span>'+
      '</button>'+
      '<div class="kb-menu" role="navigation" aria-label="KINGBOT navigation">'+
        '<div class="kb-menu-head">'+
          '<div class="kb-menu-title">KINGBOT NAVIGATION</div>'+
          '<div class="kb-menu-state"><span class="kb-menu-dot"></span>SYSTEM ONLINE</div>'+
        '</div>'+
        '<div class="kb-menu-grid">'+pageLinks+'</div>'+
        '<div class="kb-menu-account">'+account+'</div>'+
        '<div class="kb-menu-footer"><span>COMPACT CONTROL</span><span>GIBSONFX TECH</span></div>'+
      '</div>';

    document.body.appendChild(root);

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
    window.addEventListener("kingbot:session-change",event=>syncAuthUI(event.detail||{}));
  }

  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",build,{once:true});
  }else{
    build();
  }

})(window,document);
