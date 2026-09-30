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
    CUSTOMER ENTRY CONTRACT

      Direct platform entry:
        NEURAL LOADING → SIGN IN / CREATE ACCOUNT
        → EMAIL VERIFICATION → HOME

      After successful authentication/verification:
        HOME opens normally without replaying the loader.

    The loader is a visual startup surface. Authentication
    remains handled by Firebase and the protected-page gate.
  */

  /*
    Authentication handoff for the customer Home entry.
    This checks the real Firebase-backed session every time;
    the sessionStorage marker is never treated as authentication.
  */
  const handoffHome=async()=>{
    if(!homeEntry) return;

    try{
      const session=window.KINGBOT_SESSION;

      if(!session){
        window.setTimeout(handoffHome,100);
        return;
      }

      const state=await Promise.race([
        session.check({force:true}),
        new Promise(resolve=>window.setTimeout(()=>resolve(null),5000))
      ]);

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

  /*
    Verification writes a one-time auth handoff marker. Consume it
    immediately, but never use it as proof of authentication.
  */
  try{
    sessionStorage.removeItem("KINGBOT_AUTH_HANDOFF");
  }catch(e){}

  const seen =
    (() => {
      try{
        return sessionStorage.getItem("KINGBOT_NEURAL_BOOT_SEEN")==="1";
      }catch(e){
        return false;
      }
    })();

  /*
    A verification/login handoff is only a one-time navigation
    hint. It must never permanently bypass authentication.
    Home still checks the real Firebase session below.
  */

  /*
    Home is the customer gateway. The visual loader is shown
    only once per browser session, while authentication is
    checked on every Home entry.
  */
  if(homeEntry && seen){
    /* Subsequent Home entries skip the visual startup and use
       the real Firebase-backed session for routing. */
    handoffHome();
    return;
  }

  if(homeEntry && !seen){
    /* First customer entry uses the loader as the top-level page.
       This removes the fragile iframe/postMessage dependency. */
    window.location.replace(
      "loader.html?duration=3000&next="+
      encodeURIComponent("access-stable.html?return=index.html#signin")+
      "&v=7"
    );
    return;
  }

  installStyle();
  document.documentElement.classList.add("kb-boot-lock");

  const frame=document.createElement("iframe");
  frame.id="kb-boot-frame";
  frame.title="KINGBOT FINTECH neural startup";
  frame.setAttribute("aria-label","KINGBOT FINTECH neural startup");
  const isAdminEntry=/\/admin-entry\.html$/i.test(window.location.pathname);
  frame.src="loader.html?embed=1&duration=3000&surface="+(isAdminEntry?"admin":"home")+"&v=6";
  (document.body||document.documentElement).appendChild(frame);

  let finished=false;

  const finish=()=>{
    if(finished) return;
    finished=true;
    window.removeEventListener("message",onMessage);

    try{
      sessionStorage.setItem("KINGBOT_NEURAL_BOOT_SEEN","1");
    }catch(e){}

    frame.classList.add("kb-boot-hide");
    window.dispatchEvent(
      new CustomEvent("kingbot:boot-complete")
    );

    window.setTimeout(()=>{
      frame.remove();
      document.documentElement.classList.remove("kb-boot-lock");

      /*
        The loader has completed. Only the customer Home entry
        performs the Sign In handoff. Admin uses its own gate.
      */
      if(homeEntry){
        window.location.replace(
          "access-stable.html?return="+
          encodeURIComponent("index.html")+
          "#signin"
        );
      }
    },460);
  };

  const onMessage=(event)=>{
    if(event.origin!==window.location.origin) return;
    if(event.source!==frame.contentWindow) return;
    if(event.data&&event.data.type==="KINGBOT_BOOT_COMPLETE"){
      finish();
    }
  };

  window.addEventListener("message",onMessage);

  /*
    Safety release if the embedded loader fails to signal.
    Home must still reach secure access rather than remain covered.
  */
  const isAdminEntry=/\/admin-entry\.html$/i.test(window.location.pathname);
  const releaseMs=isAdminEntry?4200:5200;
  window.setTimeout(finish,releaseMs);
}
start();
})(window,document);
