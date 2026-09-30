/* KINGBOT FINTECH — canonical neural startup bridge
   Startup flow:
   NEURAL LOADER → SIGN IN / CREATE ACCOUNT → VERIFICATION → HOME

   The loader is visual-only. This bridge controls only the
   initial application entry transition and never stores
   passwords or authentication secrets.
*/
(function(window,document){
"use strict";
if(window.__KINGBOT_BOOT_BRIDGE__) return;
window.__KINGBOT_BOOT_BRIDGE__=true;

function installStyle(){
  if(document.getElementById("kb-boot-bridge-style")) return;
  const style=document.createElement("style");
  style.id="kb-boot-bridge-style";
  style.textContent=`
    html.kb-boot-lock,html.kb-boot-lock body{overflow:hidden!important}
    #kb-boot-frame{
      position:fixed;inset:0;z-index:2147483647;
      width:100vw;height:100vh;border:0;display:block;
      background:#02040a;opacity:1;
      transition:opacity .42s ease;
    }
    #kb-boot-frame.kb-boot-hide{opacity:0;pointer-events:none}
    @media(prefers-reduced-motion:reduce){
      #kb-boot-frame{transition:none}
    }
  `;
  (document.head||document.documentElement).appendChild(style);
}

function start(){

  const homeEntry =
    window.location.pathname === "/" ||
    /\/index\.html$/i.test(window.location.pathname);

  /*
    Customer entry contract:
      FIRST VISIT   → neural loader → sign in/verify → home
      LATER VISIT   → no loader → auth check → home or sign in/verify

    The one-time loader marker must never disable the authentication
    handoff. It only controls whether the visual animation is shown.
  */
  const handoffHome=async()=>{
    if(!homeEntry) return;

    try{
      const session=window.KINGBOT_SESSION;

      if(!session){
        window.setTimeout(handoffHome,100);
        return;
      }

      const state=await session.check({force:true});

      if(state?.authenticated && state?.user?.verified){
        return;
      }

      if(state?.authenticated && !state?.user?.verified){
        window.location.replace(
          "verify.html?return="+
          encodeURIComponent("index.html")
        );
        return;
      }

      window.location.replace(
        "access-stable.html?return="+
        encodeURIComponent("index.html")+
        "#signin"
      );
    }catch(error){
      console.warn(
        "[KINGBOT BOOT] Auth handoff check failed:",
        error?.message || error
      );

      window.location.replace(
        "access-stable.html?return="+
        encodeURIComponent("index.html")+
        "#signin"
      );
    }
  };

  try{
    if(sessionStorage.getItem("KINGBOT_NEURAL_BOOT_SEEN")==="1"){
      window.dispatchEvent(new CustomEvent("kingbot:boot-complete"));
      handoffHome();
      return;
    }
  }catch(e){}

  installStyle();
  document.documentElement.classList.add("kb-boot-lock");

  const frame=document.createElement("iframe");
  frame.id="kb-boot-frame";
  frame.title="KINGBOT FINTECH neural startup";
  frame.setAttribute("aria-label","KINGBOT FINTECH neural startup");
  const isAdminEntry=/\/admin-entry\.html$/i.test(window.location.pathname);
  frame.src="loader.html?embed=1&duration=3200&surface="+(isAdminEntry?"admin":"home")+"&v=3";
  document.body.appendChild(frame);

  let finished=false;
  const finish=()=>{
    if(finished) return;
    finished=true;
    window.removeEventListener("message",onMessage);

    try{
      sessionStorage.setItem("KINGBOT_NEURAL_BOOT_SEEN","1");
    }catch(e){}

    frame.classList.add("kb-boot-hide");
    window.dispatchEvent(new CustomEvent("kingbot:boot-complete"));

    window.setTimeout(async ()=>{
      frame.remove();
      document.documentElement.classList.remove("kb-boot-lock");

      await handoffHome();
    },460);
  };

  const onMessage=(event)=>{
    if(event.origin!==window.location.origin) return;
    if(event.source!==frame.contentWindow) return;
    if(event.data&&event.data.type==="KINGBOT_BOOT_COMPLETE") finish();
  };

  window.addEventListener("message",onMessage);

  // Safety release if the embedded loader fails to signal completion.
  // Admin surfaces must never remain covered by the loader indefinitely.
  const isAdminEntry=/\/admin-entry\.html$/i.test(window.location.pathname);
  const releaseMs=isAdminEntry?3200:11000;
  window.setTimeout(finish,releaseMs);
}

if(document.readyState==="loading"){
  document.addEventListener("DOMContentLoaded",start,{once:true});
}else{
  start();
}
})(window,document);
