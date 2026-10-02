/* KINGBOT FINTECH — VISIBLE GLOBAL NAVIGATION */
(function(window, document){
  "use strict";

  const links = [
    ["index.html","Dashboard","⌂","Core platform"],
    ["terminal.html","Trading","⌁","Live terminal"],
    ["bots.html","Bots","◉","Automated systems"],
    ["markets.html","Markets","◈","Live market intelligence"],
    ["market-review.html","Review","◎","Market review"],
    ["ai.html","AI","✦","Grok intelligence"],
    ["scanner.html","Scanner","⌬","AI market scanner"],
    ["analytics.html","Analytics","▦","Performance"],
    ["broker-connect.html","Broker","⚡","Secure broker access"],
    ["subscription.html","Plans","◇","Subscriptions"],
    ["academy.html","Academy","▱","Education"],
    ["partner-revenue.html","Partners","◌","Partner revenue"],
    ["settings.html","Settings","⚙","Account controls"]
  ];

  const accountLinks = [
    ["access-stable.html#signin","Sign in","signin"],
    ["access-stable.html#signup","Create account","signup"],
    ["#","Logout","logout"]
  ];

  function currentPage(){
    return (window.location.pathname.split("/").filter(Boolean).pop() || "index.html").toLowerCase();
  }

  function injectStyle(){
    if(document.getElementById("kb-visible-nav-style")) return;
    const style=document.createElement("style");
    style.id="kb-visible-nav-style";
    style.textContent=`
      :root{--kb-cyan:#19e6ff;--kb-blue:#4787ff;--kb-violet:#9b5cff;--kb-pink:#ff4fd8;--kb-gold:#f6b93b;--kb-green:#23f7a3}
      body{padding-top:70px!important}
      #kb-visible-nav{
        position:fixed;
        inset:0 0 auto 0;
        z-index:2147482000;
        height:70px;
        border-bottom:1px solid rgba(255,255,255,.10);
        background:
          radial-gradient(circle at 12% 0%,rgba(25,230,255,.11),transparent 25%),
          radial-gradient(circle at 82% 0%,rgba(155,92,255,.10),transparent 26%),
          linear-gradient(180deg,rgba(4,9,22,.97),rgba(3,6,16,.94));
        backdrop-filter:blur(20px);
        -webkit-backdrop-filter:blur(20px);
        box-shadow:0 12px 40px rgba(0,0,0,.28);
        font-family:Inter,system-ui,sans-serif;
      }
      #kb-visible-nav .kb-nav-inner{
        width:min(1540px,calc(100% - 28px));
        height:100%;
        margin:auto;
        display:flex;
        align-items:center;
        gap:14px;
      }
      #kb-visible-nav .kb-brand{
        flex:0 0 auto;
        display:flex;
        align-items:center;
        gap:10px;
        color:#fff;
        text-decoration:none;
        min-width:205px;
      }
      #kb-visible-nav .kb-brand img{
        width:44px;height:44px;
        object-fit:contain;
        border-radius:12px;
        padding:4px;
        background:rgba(255,255,255,.035);
        border:1px solid rgba(255,255,255,.10);
        box-shadow:0 0 26px rgba(25,230,255,.13),0 0 18px rgba(246,185,59,.06);
      }
      #kb-visible-nav .kb-brand-name{
        font:900 13px/1 Orbitron,Inter,sans-serif;
        letter-spacing:.09em;
      }
      #kb-visible-nav .kb-brand-sub{
        margin-top:4px;
        color:#68758f;
        font:700 7px/1.1 "JetBrains Mono",monospace;
        letter-spacing:.12em;
      }
      #kb-visible-nav .kb-links{
        flex:1;
        min-width:0;
        display:flex;
        align-items:center;
        gap:3px;
        overflow:hidden;
      }
      #kb-visible-nav .kb-link{
        position:relative;
        flex:none;
        display:flex;
        align-items:center;
        gap:6px;
        padding:10px 9px;
        border:1px solid transparent;
        border-radius:10px;
        color:#8794ad;
        text-decoration:none;
        white-space:nowrap;
        transition:.18s ease;
      }
      #kb-visible-nav .kb-link:hover{
        color:#fff;
        background:rgba(255,255,255,.045);
        border-color:rgba(255,255,255,.07);
      }
      #kb-visible-nav .kb-link.kb-active{
        color:#fff;
        border-color:rgba(25,230,255,.18);
        background:linear-gradient(90deg,rgba(25,230,255,.09),rgba(155,92,255,.06));
        box-shadow:inset 0 -2px var(--kb-cyan),0 0 20px rgba(25,230,255,.04);
      }
      #kb-visible-nav .kb-icon{font-size:12px;color:var(--kb-cyan)}
      #kb-visible-nav .kb-active .kb-icon{color:var(--kb-gold)}
      #kb-visible-nav .kb-name{font:800 8px/1 Orbitron,sans-serif;letter-spacing:.03em}
      #kb-visible-nav .kb-status{
        flex:none;
        display:flex;
        align-items:center;
        gap:7px;
        padding:8px 10px;
        color:var(--kb-green);
        border:1px solid rgba(35,247,163,.18);
        border-radius:999px;
        background:rgba(35,247,163,.045);
        font:800 7px "JetBrains Mono",monospace;
        white-space:nowrap;
      }
      #kb-visible-nav .kb-dot{
        width:6px;height:6px;border-radius:50%;
        background:currentColor;
        box-shadow:0 0 10px currentColor;
        animation:kbPulse 1.6s ease-in-out infinite;
      }
      #kb-visible-nav .kb-account{
        flex:none;
        display:flex;
        align-items:center;
        gap:6px;
      }
      #kb-visible-nav .kb-account a,
      #kb-visible-nav .kb-account button{
        min-height:36px;
        padding:8px 10px;
        border-radius:9px;
        border:1px solid rgba(255,255,255,.08);
        background:rgba(255,255,255,.025);
        color:#9ba7bf;
        text-decoration:none;
        font:800 7px "JetBrains Mono",monospace;
        cursor:pointer;
      }
      #kb-visible-nav .kb-account a:hover,
      #kb-visible-nav .kb-account button:hover{color:#fff;border-color:rgba(25,230,255,.20)}
      #kb-visible-nav .kb-menu-btn{
        display:none;
        margin-left:auto;
        width:42px;height:42px;
        border:1px solid rgba(255,255,255,.10);
        border-radius:11px;
        color:#fff;
        background:rgba(255,255,255,.035);
      }
      #kb-visible-nav .kb-mobile-panel{
        display:none;
      }
      @keyframes kbPulse{50%{opacity:.32}}
      @media(max-width:1180px){
        #kb-visible-nav .kb-status{display:none}
        #kb-visible-nav .kb-link{padding:9px 7px}
        #kb-visible-nav .kb-name{font-size:7px}
        #kb-visible-nav .kb-brand{min-width:185px}
      }
      @media(max-width:900px){
        body{padding-top:64px!important}
        #kb-visible-nav{height:64px}
        #kb-visible-nav .kb-nav-inner{width:calc(100% - 18px)}
        #kb-visible-nav .kb-brand{min-width:0}
        #kb-visible-nav .kb-brand img{width:40px;height:40px}
        #kb-visible-nav .kb-brand-sub{display:none}
        #kb-visible-nav .kb-links,#kb-visible-nav .kb-account{display:none}
        #kb-visible-nav .kb-menu-btn{display:grid;place-items:center}
        #kb-visible-nav .kb-mobile-panel{
          position:absolute;
          top:72px;right:9px;
          width:min(390px,calc(100vw - 18px));
          max-height:calc(100vh - 84px);
          overflow:auto;
          padding:9px;
          border:1px solid rgba(255,255,255,.10);
          border-radius:15px;
          background:
            radial-gradient(circle at 10% 0%,rgba(25,230,255,.10),transparent 34%),
            radial-gradient(circle at 95% 10%,rgba(155,92,255,.09),transparent 34%),
            rgba(4,8,20,.98);
          box-shadow:0 25px 80px rgba(0,0,0,.62);
        }
        #kb-visible-nav .kb-mobile-panel.kb-open{display:block}
        #kb-visible-nav .kb-mobile-links{
          display:grid;
          grid-template-columns:repeat(2,minmax(0,1fr));
          gap:6px;
        }
        #kb-visible-nav .kb-mobile-links a{
          display:flex;
          align-items:center;
          gap:8px;
          min-height:43px;
          padding:9px;
          border:1px solid rgba(255,255,255,.06);
          border-radius:10px;
          color:#9aa7bf;
          text-decoration:none;
          background:rgba(255,255,255,.022);
        }
        #kb-visible-nav .kb-mobile-links a.kb-active{
          color:#fff;
          border-color:rgba(25,230,255,.22);
          background:rgba(25,230,255,.055);
        }
        #kb-visible-nav .kb-mobile-links .kb-name{font-size:7px}
        #kb-visible-nav .kb-mobile-account{
          display:grid;
          grid-template-columns:repeat(3,1fr);
          gap:6px;
          margin-top:8px;
          padding-top:8px;
          border-top:1px solid rgba(255,255,255,.06);
        }
      }
    `;
    document.head.appendChild(style);
  }

  function linkMarkup([href,name,icon,desc]){
    const active=href.toLowerCase()===currentPage();
    return '<a class="kb-link'+(active?' kb-active':'')+'" href="'+href+'"'+(active?' aria-current="page"':'')+' title="'+desc+'">'+
      '<span class="kb-icon">'+icon+'</span><span class="kb-name">'+name+'</span></a>';
  }

  function accountMarkup(authenticated, mobile=false){
    const items=authenticated
      ? [["index.html","Dashboard"],["settings.html","Settings"],["#","Logout","logout"]]
      : [["access-stable.html#signin","Sign in"],["access-stable.html#signup","Create account"]];
    return items.map(([href,name,action])=>{
      if(action==="logout"){
        return '<button type="button" data-kb-logout>'+name+'</button>';
      }
      return '<a href="'+href+'">'+name+'</a>';
    }).join("");
  }

  function build(){
    if(document.getElementById("kb-visible-nav")) return;
    if(document.querySelector(".auth-shell,.verify-shell,.auth-card")) return;

    injectStyle();

    const root=document.createElement("header");
    root.id="kb-visible-nav";
    const authenticated=window.KINGBOT_SESSION?.isAuthenticated?.()===true;

    root.innerHTML=
      '<div class="kb-nav-inner">'+
        '<a class="kb-brand" href="index.html" aria-label="KINGBOT FINTECH dashboard">'+
          '<img src="assets/images/kingbot-fintech-logo.png" alt="KINGBOT FINTECH">'+
          '<span><span class="kb-brand-name">KINGBOT</span><span class="kb-brand-sub">AI-POWERED TRADING PLATFORM</span></span>'+
        '</a>'+
        '<nav class="kb-links" aria-label="KINGBOT primary navigation">'+
          links.map(linkMarkup).join("")+
        '</nav>'+
        '<div class="kb-status"><span class="kb-dot"></span>SYSTEM ONLINE</div>'+
        '<div class="kb-account">'+accountMarkup(authenticated)+'</div>'+
        '<button class="kb-menu-btn" type="button" aria-label="Open navigation" aria-expanded="false">☰</button>'+
      '</div>'+
      '<div class="kb-mobile-panel">'+
        '<nav class="kb-mobile-links" aria-label="KINGBOT mobile navigation">'+
          links.map(([href,name,icon,desc])=>{
            const active=href.toLowerCase()===currentPage();
            return '<a class="'+(active?'kb-active':'')+'" href="'+href+'"><span class="kb-icon">'+icon+'</span><span><span class="kb-name">'+name+'</span></span></a>';
          }).join("")+
        '</nav>'+
        '<div class="kb-mobile-account">'+accountMarkup(authenticated,true)+'</div>'+
      '</div>';

    document.body.prepend(root);

    const menuButton=root.querySelector(".kb-menu-btn");
    const panel=root.querySelector(".kb-mobile-panel");
    const close=()=>{
      panel?.classList.remove("kb-open");
      menuButton?.setAttribute("aria-expanded","false");
    };
    menuButton?.addEventListener("click",()=>{
      const open=!panel.classList.contains("kb-open");
      panel.classList.toggle("kb-open",open);
      menuButton.setAttribute("aria-expanded",String(open));
    });

    root.querySelectorAll("a").forEach(a=>a.addEventListener("click",close));

    root.querySelectorAll("[data-kb-logout]").forEach(btn=>{
      btn.addEventListener("click",async()=>{
        close();
        const logout=window.KINGBOT_SESSION?.logout;
        if(logout) await logout({redirect:true});
        else window.location.replace("access-stable.html");
      });
    });

    function syncAuthUI(detail){
      const authed=detail?.authenticated===true || window.KINGBOT_SESSION?.isAuthenticated?.()===true;
      root.querySelector(".kb-account").innerHTML=accountMarkup(authed);
      const mobileAccount=root.querySelector(".kb-mobile-account");
      if(mobileAccount) mobileAccount.innerHTML=accountMarkup(authed,true);
      [".kb-account [data-kb-logout]",".kb-mobile-account [data-kb-logout]"].forEach(sel=>{
        root.querySelectorAll(sel).forEach(btn=>btn.addEventListener("click",async()=>{
          close();
          const logout=window.KINGBOT_SESSION?.logout;
          if(logout) await logout({redirect:true});
          else window.location.replace("access-stable.html");
        }));
      });
    }

    window.KINGBOT_NAV={
      config:{links},
      state:{initialized:true,open:false},
      current:currentPage,
      active:href=>String(href).toLowerCase()===currentPage(),
      open:()=>{panel?.classList.add("kb-open");menuButton?.setAttribute("aria-expanded","true");},
      close,
      syncAuthUI
    };

    syncAuthUI();
    window.addEventListener("kingbot:session-change",event=>syncAuthUI(event.detail||{}));
  }

  function init(){
    if(window.__KINGBOT_NAV_VISIBLE_INITIALIZED) return;
    window.__KINGBOT_NAV_VISIBLE_INITIALIZED=true;
    build();
  }

  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",init,{once:true});
  }else{
    init();
  }
})(window,document);
