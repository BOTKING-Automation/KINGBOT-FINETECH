/* KINGBOT FINTECH — deterministic 20-second startup router */
(function(window,document){
"use strict";
if(document.documentElement.dataset.kingbotBootLoaded==="1")return;
document.documentElement.dataset.kingbotBootLoaded="1";
if(!/index\\.html?$/i.test(window.location.pathname.split("/").pop()||"index.html"))return;

const states=["NEURAL CORE INITIALIZING","MARKET MATRIX LINKING","BOT BRAIN SYNCHRONIZING","RISK ENGINE ONLINE","AUTH GATE READY"];
let el=document.getElementById("kb-boot-loader");

function ensureLoader(){
  if(el)return el;
  el=document.createElement("div");
  el.id="kb-boot-loader";
  el.innerHTML='<div class="kb-boot-core"><div class="kb-boot-brand">KINGBOT FINTECH</div><div class="kb-boot-sub">NEURAL TRADING INFRASTRUCTURE · SECURE INITIALIZATION</div><div class="kb-boot-stage"><div class="kb-boot-halo"></div><div class="kb-boot-brain"></div></div><div class="kb-boot-status">NEURAL CORE INITIALIZING</div><div class="kb-boot-progress"><i></i></div></div>';
  (document.body||document.documentElement).prepend(el);
  return el;
}

function start(){
  ensureLoader();
  document.documentElement.classList.add("kb-boot-lock");
  const status=el.querySelector("#kb-boot-status")||el.querySelector(".kb-boot-status");
  let n=0;
  const ticker=setInterval(()=>{if(status){n=(n+1)%states.length;status.textContent=states[n]}},900);

  const remove=()=>{
    clearInterval(ticker);
    if(!el)return;
    el.style.transition="opacity .45s ease";
    el.style.opacity="0";
    setTimeout(()=>{
      el.remove();
      document.documentElement.classList.remove("kb-boot-lock");
    },460);
  };

  const localAuth=()=>{
    try{
      const user=window.KINGBOT_FIREBASE?.auth?.currentUser||null;
      if(user)return {authenticated:true,user:{verified:Boolean(user.emailVerified),email:user.email||""}};
    }catch(error){console.warn("[KINGBOT BOOT] Local auth read failed:",error?.message||error);}
    return {authenticated:false,user:null};
  };

  const routeAfterBoot=async()=>{
    let session=localAuth();
    if(!session.authenticated&&window.KINGBOT_SESSION?.check){
      try{
        const checked=await Promise.race([
          window.KINGBOT_SESSION.check({force:true}),
          new Promise(resolve=>setTimeout(()=>resolve(null),1500))
        ]);
        if(checked)session=checked;
      }catch(error){console.warn("[KINGBOT BOOT] Session preflight failed:",error?.message||error);}
    }
    if(!session?.authenticated){
      window.location.assign("access.html");
      return;
    }
    if(!session?.user?.verified){
      window.location.assign("verify.html");
      return;
    }
    remove();
  };

  setTimeout(routeAfterBoot,20000);
}

if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start();
})(window);
