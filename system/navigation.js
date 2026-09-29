/*
 KINGBOT FINTECH — UNIVERSAL COMMAND NAVIGATION
 GIBSONFX TECH
*/
(function(window,document){
"use strict";
const KINGBOT_NAV={
 config:{
  links:[
   {label:"Home",href:"index.html",icon:"⌂",group:"CORE"},
   {label:"Markets",href:"markets.html",icon:"◈",group:"CORE"},
   {label:"Terminal",href:"terminal.html",icon:"⌁",group:"TRADE"},
   {label:"Bots",href:"bots.html",icon:"◉",group:"TRADE"},
   {label:"Analytics",href:"analytics.html",icon:"◫",group:"TRADE"},
   {label:"AI Intelligence",href:"ai.html",icon:"✦",group:"INTELLIGENCE"},
   {label:"Academy",href:"academy.html",icon:"◆",group:"DISCOVER"},
   {label:"Pricing",href:"pricing.html",icon:"◇",group:"DISCOVER"},
   {label:"About",href:"about.html",icon:"◎",group:"DISCOVER"},
   {label:"Contact",href:"contact.html",icon:"⌕",group:"DISCOVER"},
   {label:"Legal",href:"legal.html",icon:"◍",group:"DISCOVER"}
  ],
  account:[
   {label:"Settings",href:"settings.html",icon:"⚙"},
   {label:"Subscription",href:"subscription.html",icon:"◈"},
   {label:"Access Management",href:"admin.html",icon:"⬢"}
  ]
 },
 state:{initialized:false,user:null,open:false},
 async initialize(){
  if(this.state.initialized)return;
  this.injectStyles(); this.ensureMount(); this.loadUser().then(()=>this.refreshUser()).catch(()=>{});
  this.state.initialized=true;
  window.dispatchEvent(new CustomEvent("kingbot:navigation-ready"));
 },
 async loadUser(){
  try{
   if(window.KINGBOT_SESSION&&typeof window.KINGBOT_SESSION.check==="function"){
    const s=await window.KINGBOT_SESSION.check();
    if(s&&s.authenticated&&s.user)this.state.user=s.user;
   }
  }catch(e){console.warn("[KINGBOT NAV] Session unavailable.");}
 },
 current(){return(window.location.pathname.split("/").filter(Boolean).pop()||"index.html").toLowerCase();},
 active(href){return this.current()===href.toLowerCase();},
 name(){return this.state.user?(this.state.user.name||this.state.user.displayName||this.state.user.email||"KINGBOT User"):"KINGBOT User";},
 email(){return this.state.user?(this.state.user.email||"Secure Account"):"Secure Account";},
 initials(){
  const p=String(this.name()).trim().split(/\s+/).slice(0,2);
  return p.length===1?p[0].slice(0,2).toUpperCase():(p[0][0]+p[1][0]).toUpperCase();
 },
 esc(v){return String(v||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");},
 ensureMount(){
  let m=document.querySelector("[data-kingbot-navigation]");
  if(!m){m=document.createElement("div");m.setAttribute("data-kingbot-navigation","");document.body.insertBefore(m,document.body.firstChild);}
  this.render(m);
 },
 render(m){
  const groups=[...new Set(this.config.links.map(x=>x.group))];
  const links=groups.map(g=>`<div class="kb-nav-group"><div class="kb-nav-group-title">${g}</div>${this.config.links.filter(x=>x.group===g).map(x=>`<a class="kb-nav-link ${this.active(x.href)?"active":""}" href="${x.href}" title="${x.label}"><span class="kb-nav-icon">${x.icon}</span><span class="kb-nav-label">${x.label}</span><span class="kb-nav-signal"></span></a>`).join("")}</div>`).join("");
  const account=this.config.account.map(x=>`<a class="kb-account-link" href="${x.href}"><span>${x.icon}</span><span>${x.label}</span></a>`).join("");
  m.innerHTML=`
   <aside class="kb-command-rail" id="kb-command-rail">
    <div class="kb-rail-flow"></div>
    <a class="kb-brand" href="index.html"><span class="kb-brand-mark"><span>K</span></span><span class="kb-brand-text"><strong>KING<span>BOT</span></strong><small>FINTECH OS</small></span></a>
    <div class="kb-rail-status"><i></i><span>SECURE GRID</span><b>●</b></div>
    <button class="kb-rail-toggle" id="kb-rail-toggle" aria-label="Toggle command menu">☰</button>
    <nav class="kb-command-menu" id="kb-command-menu">${links}</nav>
    <div class="kb-rail-bottom">
     <button class="kb-user-button" id="kb-user-button"><span class="kb-avatar">${this.initials()}</span><span class="kb-user-copy"><b>${this.esc(this.name())}</b><small>${this.esc(this.email())}</small></span><span>⌄</span></button>
     <div class="kb-user-menu" id="kb-user-menu">${account}<button class="kb-account-link kb-logout" id="kb-logout"><span>↪</span><span>Sign Out</span></button></div>
    </div>
   </aside>
   <div class="kb-command-spacer"></div>
  `;
  this.bind();
 },
 bind(){
  const rail=document.getElementById("kb-command-rail"),toggle=document.getElementById("kb-rail-toggle"),menu=document.getElementById("kb-command-menu"),user=document.getElementById("kb-user-button"),um=document.getElementById("kb-user-menu"),logout=document.getElementById("kb-logout");
  if(toggle)toggle.onclick=()=>{this.state.open=!this.state.open;rail.classList.toggle("open",this.state.open);toggle.setAttribute("aria-expanded",String(this.state.open));};
  if(user)user.onclick=e=>{e.stopPropagation();um.classList.toggle("open");};
  document.addEventListener("click",e=>{if(um&&!um.contains(e.target)&&user&&!user.contains(e.target))um.classList.remove("open");});
  if(logout)logout.onclick=async()=>{logout.disabled=true;logout.innerHTML="<span>⋯</span><span>Signing Out</span>";try{if(window.KINGBOT_SESSION&&typeof window.KINGBOT_SESSION.logout==="function")await window.KINGBOT_SESSION.logout();else location.href="signin.html";}catch(e){location.href="signin.html";}};
  if(menu)menu.querySelectorAll("a").forEach(a=>a.onclick=()=>{this.state.open=false;rail.classList.remove("open");});
 },
 injectStyles(){
  if(document.getElementById("kingbot-navigation-style"))return;
  const s=document.createElement("style");s.id="kingbot-navigation-style";s.textContent=`
   :root{--kb-c:#19e6ff;--kb-b:#4787ff;--kb-v:#9b5cff;--kb-p:#ff4fd8;--kb-g:#f6b93b}
   body{--kb-rail-width:248px}
   .kb-navigation-mount{position:relative;z-index:99990}
   .kb-command-rail{position:fixed;z-index:99999;left:14px;top:14px;bottom:14px;width:248px;box-sizing:border-box;padding:18px 13px;display:flex;flex-direction:column;background:rgba(4,8,20,.9);border:1px solid rgba(255,255,255,.08);border-radius:22px;backdrop-filter:blur(26px);box-shadow:0 25px 90px rgba(0,0,0,.45),0 0 35px rgba(25,230,255,.06);overflow:hidden}
   .kb-command-rail:before{content:"";position:absolute;inset:0;border-radius:22px;padding:1px;background:linear-gradient(180deg,var(--kb-c),var(--kb-b),var(--kb-v),var(--kb-p),var(--kb-g),var(--kb-c));background-size:100% 300%;animation:kbRailFlow 8s linear infinite;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;pointer-events:none}
   .kb-rail-flow{position:absolute;left:1px;top:0;bottom:0;width:2px;background:linear-gradient(180deg,var(--kb-c),var(--kb-v),var(--kb-p),var(--kb-g),var(--kb-c));background-size:100% 300%;animation:kbRailFlow 5s linear infinite;box-shadow:0 0 15px rgba(25,230,255,.7)}
   @keyframes kbRailFlow{0%{background-position:50% 0}100%{background-position:50% 300%}}
   .kb-brand{position:relative;z-index:2;display:flex;align-items:center;gap:11px;text-decoration:none;padding:3px 6px 16px}
   .kb-brand-mark{width:43px;height:43px;display:grid;place-items:center;border-radius:13px;border:1px solid rgba(25,230,255,.38);background:linear-gradient(135deg,rgba(25,230,255,.15),rgba(155,92,255,.16),rgba(255,79,216,.1));box-shadow:0 0 25px rgba(25,230,255,.14)}
   .kb-brand-mark span,.kb-brand-text strong{background:linear-gradient(90deg,var(--kb-c),var(--kb-b),var(--kb-v),var(--kb-p),var(--kb-g));background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:kbTextFlow 6s linear infinite}
   .kb-brand-mark span{font:900 18px Orbitron,system-ui}
   .kb-brand-text{display:flex;flex-direction:column;line-height:1}.kb-brand-text strong{font:900 17px Orbitron,system-ui;letter-spacing:2px}.kb-brand-text strong span{color:inherit}.kb-brand-text small{margin-top:5px;color:rgba(238,242,255,.42);font:8px JetBrains Mono,monospace;letter-spacing:2px}
   @keyframes kbTextFlow{0%{background-position:0}100%{background-position:250%}}
   .kb-rail-status{position:relative;z-index:2;display:flex;align-items:center;gap:7px;padding:8px 10px;margin:0 3px 14px;border:1px solid rgba(25,230,255,.14);border-radius:10px;background:linear-gradient(90deg,rgba(25,230,255,.05),rgba(155,92,255,.05),rgba(255,79,216,.04));font:8px JetBrains Mono,monospace;letter-spacing:1.4px;color:rgba(238,242,255,.5)}.kb-rail-status i{width:6px;height:6px;border-radius:50%;background:var(--kb-c);box-shadow:0 0 12px var(--kb-c);animation:kbPulse 1.5s infinite}.kb-rail-status b{margin-left:auto;color:var(--kb-p);font-size:8px}
   @keyframes kbPulse{50%{transform:scale(1.3);opacity:1}}
   .kb-command-menu{position:relative;z-index:2;display:flex;flex-direction:column;gap:3px;overflow:auto;padding:0 2px;scrollbar-width:none}.kb-command-menu::-webkit-scrollbar{display:none}
   .kb-nav-group{margin-bottom:10px}.kb-nav-group-title{padding:3px 10px 6px;color:rgba(238,242,255,.3);font:8px JetBrains Mono,monospace;letter-spacing:1.7px}
   .kb-nav-link{position:relative;display:flex;align-items:center;gap:11px;min-height:42px;padding:0 10px;border:1px solid transparent;border-radius:11px;color:rgba(238,242,255,.66);text-decoration:none;font-size:11px;font-weight:800;transition:.2s ease;overflow:hidden}.kb-nav-link:before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(25,230,255,.07),rgba(155,92,255,.07),rgba(255,79,216,.05));opacity:0;transition:.2s}.kb-nav-link:hover:before,.kb-nav-link.active:before{opacity:1}.kb-nav-link:hover{color:#fff;border-color:rgba(25,230,255,.12);transform:translateX(2px);text-shadow:0 0 12px rgba(25,230,255,.45)}.kb-nav-link.active{color:#fff;border-color:rgba(155,92,255,.24);box-shadow:inset 0 0 18px rgba(155,92,255,.05)}.kb-nav-link.active:after{content:"";position:absolute;left:2px;top:7px;bottom:7px;width:2px;border-radius:4px;background:linear-gradient(180deg,var(--kb-c),var(--kb-v),var(--kb-p),var(--kb-g));box-shadow:0 0 13px rgba(25,230,255,.7)}.kb-nav-icon{position:relative;z-index:1;font-size:16px;background:linear-gradient(180deg,var(--kb-c),var(--kb-b),var(--kb-v),var(--kb-p),var(--kb-g));-webkit-background-clip:text;background-clip:text;color:transparent}.kb-nav-label{position:relative;z-index:1}
   .kb-rail-bottom{position:relative;z-index:4;margin-top:auto;padding-top:12px;border-top:1px solid rgba(255,255,255,.07)}.kb-user-button{width:100%;display:flex;align-items:center;gap:9px;padding:7px;border:1px solid rgba(255,255,255,.07);border-radius:12px;background:rgba(255,255,255,.025);color:#fff;cursor:pointer;text-align:left}.kb-user-button:hover{border-color:rgba(255,79,216,.25);box-shadow:0 0 18px rgba(255,79,216,.08)}.kb-avatar{width:32px;height:32px;flex:0 0 32px;display:grid;place-items:center;border-radius:9px;background:linear-gradient(135deg,rgba(25,230,255,.2),rgba(155,92,255,.18),rgba(255,79,216,.14),rgba(246,185,59,.12));border:1px solid rgba(25,230,255,.28);font:900 9px Orbitron;color:#fff}.kb-user-copy{min-width:0;display:flex;flex-direction:column;gap:3px;flex:1}.kb-user-copy b{font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kb-user-copy small{font:8px JetBrains Mono;color:rgba(238,242,255,.38);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
   .kb-user-menu{position:absolute;left:5px;right:5px;bottom:58px;display:none;padding:8px;border:1px solid rgba(155,92,255,.24);border-radius:15px;background:rgba(5,10,24,.99);backdrop-filter:blur(22px);box-shadow:0 20px 60px rgba(0,0,0,.55)}.kb-user-menu.open{display:block;animation:kbIn .18s ease}.kb-account-link{width:100%;display:flex;align-items:center;gap:9px;padding:10px;border:0;border-radius:9px;background:transparent;color:rgba(238,242,255,.68);text-decoration:none;font-size:10px;font-weight:700;text-align:left;cursor:pointer}.kb-account-link:hover{color:#fff;background:rgba(155,92,255,.08)}.kb-logout{color:#ff6b83}
   .kb-command-spacer{width:278px;min-height:1px}
   .kb-rail-toggle{display:none}
   @keyframes kbIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
   @media(max-width:1050px){.kb-command-rail{left:9px;top:9px;bottom:auto;width:calc(100% - 18px);min-height:64px;height:auto;padding:10px 12px;border-radius:16px;flex-direction:row;align-items:center}.kb-command-rail:before{border-radius:16px}.kb-rail-flow{left:0;right:0;top:auto;bottom:0;width:auto;height:2px}.kb-brand{padding:0;flex-shrink:0}.kb-brand-mark{width:36px;height:36px}.kb-brand-text strong{font-size:14px}.kb-rail-status{display:none}.kb-rail-toggle{display:block;margin-left:auto;position:relative;z-index:4;width:40px;height:40px;border:1px solid rgba(25,230,255,.18);border-radius:10px;background:rgba(255,255,255,.03);color:#fff;cursor:pointer}.kb-command-menu{display:none;position:absolute;left:8px;right:8px;top:calc(100% + 8px);padding:10px;border:1px solid rgba(25,230,255,.2);border-radius:16px;background:rgba(5,10,24,.99);backdrop-filter:blur(24px);box-shadow:0 25px 70px rgba(0,0,0,.6);max-height:70vh}.kb-command-rail.open .kb-command-menu{display:flex}.kb-rail-bottom{margin:0 8px 0 0;padding:0;border:0}.kb-user-copy{display:none}.kb-user-button{padding:4px;border-radius:9px}.kb-user-button>span:last-child{display:none}.kb-user-menu{bottom:auto;top:calc(100% + 8px);right:0;left:auto;width:230px}.kb-command-spacer{width:0;min-height:82px}}
   @media(max-width:560px){.kb-command-rail{left:6px;right:6px;width:auto}.kb-brand-text small{display:none}.kb-brand-mark{width:34px;height:34px}.kb-command-menu{max-height:76vh}.kb-nav-group-title{font-size:7px}.kb-nav-link{min-height:43px}}
  `;
  document.head.appendChild(s);
 }
};
window.KINGBOT_NAV=KINGBOT_NAV;
document.addEventListener("DOMContentLoaded",()=>KINGBOT_NAV.initialize());
})(window);
