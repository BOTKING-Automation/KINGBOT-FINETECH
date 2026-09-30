/* KINGBOT FINTECH — canonical neural startup bridge
   Uses the existing loader.html visual system as the startup surface.
   This bridge never decides authentication or performs a login redirect.
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
  installStyle();
  document.documentElement.classList.add("kb-boot-lock");

  const frame=document.createElement("iframe");
  frame.id="kb-boot-frame";
  frame.title="KINGBOT FINTECH neural startup";
  frame.setAttribute("aria-label","KINGBOT FINTECH neural startup");
  frame.src="loader.html?embed=1&duration=3200&surface=admin";
  document.body.appendChild(frame);

  let finished=false;
  const finish=()=>{
    if(finished) return;
    finished=true;
    window.removeEventListener("message",onMessage);
    frame.classList.add("kb-boot-hide");
    window.setTimeout(()=>{
      frame.remove();
      document.documentElement.classList.remove("kb-boot-lock");
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
  const releaseMs=location.search.includes("surface=admin")?4500:11000;
  window.setTimeout(finish,releaseMs);
}

if(document.readyState==="loading"){
  document.addEventListener("DOMContentLoaded",start,{once:true});
}else{
  start();
}
})(window,document);
