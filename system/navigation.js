/*
 KINGBOT FINTECH — UNIVERSAL NAVIGATION SYSTEM
 GIBSONFX TECH
*/

(function(window, document){
  "use strict";

  const KINGBOT_NAV = {
    config:{
      brand:"KINGBOT",
      links:[
        {label:"Home",href:"index.html",icon:"⌂",permission:null},
        {label:"Markets",href:"markets.html",icon:"◈",permission:"markets"},
        {label:"Terminal",href:"terminal.html",icon:"⌁",permission:"terminal"},
        {label:"Bots",href:"bots.html",icon:"◉",permission:"bots"},
        {label:"Analytics",href:"analytics.html",icon:"◫",permission:"analytics"},
        {label:"AI Intelligence",href:"ai.html",icon:"✦",permission:"ai"},
        {label:"Academy",href:"academy.html",icon:"◆",permission:null},
        {label:"Pricing",href:"pricing.html",icon:"◇",permission:null},
        {label:"About",href:"about.html",icon:"◎",permission:null},
        {label:"Contact",href:"contact.html",icon:"⌕",permission:null},
        {label:"Legal",href:"legal.html",icon:"◍",permission:null}
      ],
      accountLinks:[
        {label:"Settings",href:"settings.html",icon:"⚙"},
        {label:"Subscription",href:"subscription.html",icon:"◈"},
        {label:"Access Management",href:"admin.html",icon:"⬢"}
      ]
    },
    state:{initialized:false,mobileOpen:false,user:null},

    async initialize(){
      if(this.state.initialized)return;
      this.injectStyles();
      await this.loadUser();
      this.ensureMount();
      this.state.initialized=true;
      window.dispatchEvent(new CustomEvent("kingbot:navigation-ready"));
    },

    async loadUser(){
      try{
        if(window.KINGBOT_SESSION && typeof window.KINGBOT_SESSION.check==="function"){
          const session=await window.KINGBOT_SESSION.check();
          if(session && session.authenticated && session.user)this.state.user=session.user;
        }
      }catch(error){console.warn("[KINGBOT NAV] Session user unavailable.");}
    },

    getCurrentPage(){
      const path=window.location.pathname.split("/").filter(Boolean).pop();
      return (path||"index.html").toLowerCase();
    },

    isActive(href){return this.getCurrentPage()===href.toLowerCase();},

    canShow(link){
      if(!link.permission)return true;
      return true;
    },

    buildNavigation(){
      return this.config.links.filter(l=>this.canShow(l)).map(link=>{
        const active=this.isActive(link.href)?"active":"";
        return `<a class="kb-nav-link ${active}" href="${link.href}" data-kb-nav="${link.href}" title="${link.label}">
          <span class="kb-nav-icon">${link.icon}</span><span class="kb-nav-label">${link.label}</span>
        </a>`;
      }).join("");
    },

    buildAccountMenu(){
      const accountLinks=this.config.accountLinks.map(link=>`
        <a class="kb-account-link" href="${link.href}" data-kb-account-link="${link.href}">
          <span>${link.icon}</span><span>${link.label}</span>
        </a>`).join("");
      return `<div class="kb-account-menu" id="kb-account-menu">
        <div class="kb-account-header">
          <div class="kb-avatar">${this.getInitials()}</div>
          <div class="kb-account-info"><strong>${this.escapeHTML(this.getDisplayName())}</strong><span>${this.escapeHTML(this.getEmail())}</span></div>
        </div>
        <div class="kb-account-divider"></div>
        ${accountLinks}
        <button type="button" class="kb-account-link kb-logout" id="kb-logout"><span>↪</span><span>Sign Out</span></button>
      </div>`;
    },

    getDisplayName(){
      return this.state.user ? (this.state.user.name||this.state.user.displayName||this.state.user.email||"KINGBOT User") : "KINGBOT User";
    },

    getEmail(){return this.state.user ? (this.state.user.email||"Secure Account") : "Secure Account";},

    getInitials(){
      const name=this.getDisplayName();
      const parts=String(name||"KB").trim().split(/\s+/).slice(0,2);
      return parts.length===1 ? parts[0].substring(0,2).toUpperCase() : (parts[0][0]+parts[1][0]).toUpperCase();
    },

    ensureMount(){
      let mount=document.querySelector("[data-kingbot-navigation]");
      if(!mount){
        mount=document.createElement("div");
        mount.setAttribute("data-kingbot-navigation","");
        mount.className="kb-navigation-mount";
        document.body.insertBefore(mount,document.body.firstChild);
      }
      document.querySelectorAll("body > nav").forEach(nav=>nav.remove());
      this.render(mount);
    },

    render(mount){
      mount=mount||document.querySelector("[data-kingbot-navigation]");
      if(!mount)return;
      mount.innerHTML=`
        <header class="kb-nav-shell">
          <div class="kb-nav-neon-line"></div>
          <a href="index.html" class="kb-brand" aria-label="KINGBOT Home">
            <span class="kb-brand-mark"><span class="kb-brand-core">K</span></span>
            <span class="kb-brand-text"><strong>KING<span>BOT</span></strong><small>FINTECH // AUTOMATION OS</small></span>
          </a>
          <button type="button" class="kb-mobile-toggle" id="kb-mobile-toggle" aria-label="Open navigation" aria-expanded="false"><span></span><span></span><span></span></button>
          <nav class="kb-nav-links" id="kb-nav-links" aria-label="KINGBOT Navigation">${this.buildNavigation()}</nav>
          <div class="kb-nav-actions">
            <div class="kb-system-status"><span class="kb-status-dot"></span><span>SECURE</span></div>
            <button type="button" class="kb-account-button" id="kb-account-button" aria-expanded="false" aria-controls="kb-account-menu">
              <span class="kb-avatar kb-avatar-small">${this.getInitials()}</span><span class="kb-account-name">${this.escapeHTML(this.getDisplayName())}</span><span class="kb-account-arrow">▾</span>
            </button>
            ${this.buildAccountMenu()}
          </div>
        </header>`;
      this.bindEvents();
    },

    bindEvents(){
      const mobileToggle=document.getElementById("kb-mobile-toggle");
      const navLinks=document.getElementById("kb-nav-links");
      const accountButton=document.getElementById("kb-account-button");
      const accountMenu=document.getElementById("kb-account-menu");
      const logoutButton=document.getElementById("kb-logout");

      if(mobileToggle&&navLinks)mobileToggle.addEventListener("click",()=>{
        this.state.mobileOpen=!this.state.mobileOpen;
        navLinks.classList.toggle("open",this.state.mobileOpen);
        mobileToggle.classList.toggle("open",this.state.mobileOpen);
        mobileToggle.setAttribute("aria-expanded",String(this.state.mobileOpen));
      });

      if(navLinks)navLinks.querySelectorAll("a").forEach(link=>link.addEventListener("click",()=>{
        this.state.mobileOpen=false; navLinks.classList.remove("open");
        if(mobileToggle){mobileToggle.classList.remove("open");mobileToggle.setAttribute("aria-expanded","false");}
      }));

      if(accountButton&&accountMenu)accountButton.addEventListener("click",e=>{
        e.stopPropagation();
        const open=accountMenu.classList.toggle("open");
        accountButton.setAttribute("aria-expanded",String(open));
      });

      document.addEventListener("click",e=>{
        if(accountMenu&&accountButton&&!accountMenu.contains(e.target)&&!accountButton.contains(e.target)){
          accountMenu.classList.remove("open"); accountButton.setAttribute("aria-expanded","false");
        }
      });

      if(logoutButton)logoutButton.addEventListener("click",async()=>{
        logoutButton.disabled=true; logoutButton.innerHTML="<span>⋯</span><span>Signing Out</span>";
        try{
          if(window.KINGBOT_SESSION&&typeof window.KINGBOT_SESSION.logout==="function")await window.KINGBOT_SESSION.logout();
          else window.location.href="signin.html";
        }catch(error){console.error("[KINGBOT NAV] Logout failed:",error);window.location.href="signin.html";}
      });
    },

    escapeHTML(value){
      return String(value||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
    },

    injectStyles(){
      if(document.getElementById("kingbot-navigation-style"))return;
      const style=document.createElement("style");
      style.id="kingbot-navigation-style";
      style.textContent=`
        .kb-navigation-mount{position:relative;z-index:99990;width:100%}
        .kb-nav-shell{position:relative;width:100%;min-height:74px;display:flex;align-items:center;gap:18px;padding:0 22px;box-sizing:border-box;background:rgba(4,8,20,.84);border:1px solid rgba(255,255,255,.08);border-radius:0 0 18px 18px;backdrop-filter:blur(22px);box-shadow:0 18px 55px rgba(0,0,0,.28);overflow:visible}
        .kb-nav-shell:before{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;background:linear-gradient(90deg,#19e6ff,#4787ff,#9b5cff,#ff4fd8,#f6b93b,#19e6ff);background-size:300% 100%;animation:kbBorderFlow 7s linear infinite;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;pointer-events:none}
        .kb-nav-neon-line{position:absolute;left:0;right:0;bottom:-1px;height:2px;background:linear-gradient(90deg,#19e6ff,#4787ff,#9b5cff,#ff4fd8,#f6b93b,#19e6ff);background-size:300% 100%;animation:kbBorderFlow 5s linear infinite;box-shadow:0 0 14px rgba(25,230,255,.55),0 0 26px rgba(255,79,216,.22)}
        @keyframes kbBorderFlow{0%{background-position:0% 50%}100%{background-position:300% 50%}}
        .kb-brand{display:inline-flex;align-items:center;gap:10px;text-decoration:none;flex-shrink:0;position:relative;z-index:2}
        .kb-brand-mark{width:40px;height:40px;display:grid;place-items:center;border-radius:12px;border:1px solid rgba(25,230,255,.45);background:linear-gradient(135deg,rgba(25,230,255,.16),rgba(155,92,255,.12),rgba(246,185,59,.1));box-shadow:0 0 22px rgba(25,230,255,.16),inset 0 0 18px rgba(155,92,255,.08)}
        .kb-brand-core{font-family:Orbitron,system-ui,sans-serif;font-size:17px;font-weight:900;background:linear-gradient(90deg,#19e6ff,#9b5cff,#ff4fd8,#f6b93b);-webkit-background-clip:text;background-clip:text;color:transparent}
        .kb-brand-text{display:flex;flex-direction:column;line-height:1}
        .kb-brand-text strong{font-family:Orbitron,system-ui,sans-serif;font-size:16px;letter-spacing:2px;background:linear-gradient(90deg,#19e6ff,#9b5cff,#ff4fd8,#f6b93b);-webkit-background-clip:text;background-clip:text;color:transparent;background-size:220% 100%;animation:kbWordFlow 6s linear infinite}
        .kb-brand-text strong span{color:inherit}
        .kb-brand-text small{margin-top:5px;font-family:JetBrains Mono,monospace;font-size:7px;letter-spacing:2px;color:rgba(238,242,255,.48)}
        @keyframes kbWordFlow{0%{background-position:0%}100%{background-position:220%}}
        .kb-nav-links{display:flex;align-items:center;gap:3px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none;position:relative;z-index:2}
        .kb-nav-links::-webkit-scrollbar{display:none}
        .kb-nav-link{position:relative;display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:0 9px;border-radius:9px;color:rgba(238,242,255,.68);text-decoration:none;font-size:11px;font-weight:800;white-space:nowrap;transition:.2s ease}
        .kb-nav-link:hover{color:#fff;background:rgba(255,255,255,.05);transform:translateY(-1px);text-shadow:0 0 12px rgba(25,230,255,.5)}
        .kb-nav-link.active{color:#fff;background:linear-gradient(90deg,rgba(25,230,255,.1),rgba(155,92,255,.1),rgba(255,79,216,.08))}
        .kb-nav-link.active:after{content:"";position:absolute;left:9px;right:9px;bottom:2px;height:2px;border-radius:9px;background:linear-gradient(90deg,#19e6ff,#9b5cff,#ff4fd8,#f6b93b);box-shadow:0 0 13px rgba(25,230,255,.7)}
        .kb-nav-icon{font-size:13px;background:linear-gradient(180deg,#19e6ff,#9b5cff,#ff4fd8,#f6b93b);-webkit-background-clip:text;background-clip:text;color:transparent}
        .kb-nav-actions{position:relative;display:flex;align-items:center;gap:9px;flex-shrink:0;z-index:3}
        .kb-system-status{display:inline-flex;align-items:center;gap:6px;padding:7px 9px;border:1px solid rgba(25,230,255,.18);border-radius:999px;color:rgba(238,242,255,.55);font-family:JetBrains Mono,monospace;font-size:8px;letter-spacing:1px}
        .kb-status-dot{width:6px;height:6px;border-radius:50%;background:#19e6ff;box-shadow:0 0 12px #19e6ff,0 0 22px rgba(255,79,216,.55);animation:kbPulse 1.6s ease-in-out infinite}
        @keyframes kbPulse{50%{transform:scale(1.25);opacity:1}}
        .kb-account-button{display:inline-flex;align-items:center;gap:7px;padding:4px 8px 4px 4px;border:1px solid rgba(255,255,255,.09);border-radius:11px;background:rgba(255,255,255,.025);color:#eef2ff;cursor:pointer}
        .kb-account-button:hover{border-color:rgba(155,92,255,.5);box-shadow:0 0 18px rgba(155,92,255,.12)}
        .kb-avatar{width:34px;height:34px;display:grid;place-items:center;border-radius:10px;background:linear-gradient(135deg,rgba(25,230,255,.2),rgba(155,92,255,.18),rgba(255,79,216,.14),rgba(246,185,59,.12));border:1px solid rgba(25,230,255,.3);color:#fff;font-family:Orbitron,system-ui,sans-serif;font-size:10px;font-weight:900;box-shadow:0 0 18px rgba(155,92,255,.12)}
        .kb-avatar-small{width:29px;height:29px;border-radius:8px}
        .kb-account-name{max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;font-weight:800}
        .kb-account-arrow{color:rgba(238,242,255,.45)}
        .kb-account-menu{position:absolute;top:calc(100% + 11px);right:0;width:255px;padding:10px;display:none;border:1px solid rgba(155,92,255,.25);border-radius:16px;background:rgba(5,10,24,.98);backdrop-filter:blur(22px);box-shadow:0 25px 80px rgba(0,0,0,.5)}
        .kb-account-menu.open{display:block;animation:kbIn .18s ease both}
        @keyframes kbIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
        .kb-account-header{display:flex;align-items:center;gap:10px;padding:9px}
        .kb-account-info{min-width:0;display:flex;flex-direction:column;gap:4px}.kb-account-info strong,.kb-account-info span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kb-account-info strong{font-size:12px}.kb-account-info span{font:9px JetBrains Mono,monospace;color:rgba(238,242,255,.42)}
        .kb-account-divider{height:1px;margin:5px 0 8px;background:rgba(255,255,255,.07)}
        .kb-account-link{width:100%;display:flex;align-items:center;gap:10px;padding:11px;border:0;border-radius:9px;background:transparent;color:rgba(238,242,255,.68);text-decoration:none;font-size:11px;font-weight:700;text-align:left;cursor:pointer}.kb-account-link:hover{color:#fff;background:linear-gradient(90deg,rgba(25,230,255,.07),rgba(155,92,255,.07),rgba(255,79,216,.06))}
        .kb-logout{color:#ff6b83}
        .kb-mobile-toggle{display:none;width:42px;height:42px;padding:9px;border:1px solid rgba(25,230,255,.18);border-radius:10px;background:rgba(255,255,255,.025);cursor:pointer}.kb-mobile-toggle span{display:block;height:2px;margin:4px 0;border-radius:5px;background:linear-gradient(90deg,#19e6ff,#ff4fd8,#f6b93b);transition:.2s}
        @media(max-width:1180px){.kb-nav-shell{gap:11px;padding:0 15px}.kb-nav-link{padding:0 7px}.kb-nav-label{font-size:10px}.kb-system-status{display:none}}
        @media(max-width:900px){.kb-mobile-toggle{display:block;margin-left:auto}.kb-nav-links{position:absolute;left:10px;right:10px;top:calc(100% + 8px);display:none;flex-direction:column;align-items:stretch;padding:10px;border:1px solid rgba(25,230,255,.18);border-radius:16px;background:rgba(5,10,24,.99);backdrop-filter:blur(24px);box-shadow:0 25px 70px rgba(0,0,0,.55);z-index:99991}.kb-nav-links.open{display:flex;animation:kbIn .18s ease both}.kb-nav-link{width:100%;min-height:45px;box-sizing:border-box}.kb-nav-link.active:after{left:4px;right:auto;top:9px;bottom:9px;width:2px;height:auto}.kb-account-name,.kb-account-arrow{display:none}}
        @media(max-width:560px){.kb-nav-shell{min-height:64px;padding:0 10px}.kb-brand-text small{display:none}.kb-brand-text strong{font-size:14px}.kb-brand-mark{width:34px;height:34px}.kb-account-button{padding:4px}}
      `;
      document.head.appendChild(style);
    }
  };

  window.KINGBOT_NAV=KINGBOT_NAV;

  document.addEventListener("DOMContentLoaded",async()=>{
    await KINGBOT_NAV.initialize();
  });

})(window);
