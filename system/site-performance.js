/* KINGBOT FINTECH — global performance + resilience runtime */
(function(window,document){
  "use strict";
  const state={network:navigator.onLine!==false,eventStream:null,prefetched:new Set(),started:false};

  function apiBase(){
    return String(
      window.KINGBOT_API?.baseUrl ||
      window.KINGBOT_FIREBASE?.API_BASE ||
      ""
    ).replace(/\/$/,"");
  }

  function mark(name,value){
    try{ performance.mark(name,{detail:value}); }catch{}
  }

  function optimizeImages(){
    document.querySelectorAll("img").forEach(img=>{
      if(!img.hasAttribute("loading")) img.setAttribute("loading","lazy");
      if(!img.hasAttribute("decoding")) img.setAttribute("decoding","async");
      if(!img.hasAttribute("fetchpriority")) img.setAttribute("fetchpriority","low");
    });
    const hero=document.querySelector("img[data-kb-hero],.hero img,header img");
    if(hero) hero.setAttribute("fetchpriority","high");
  }

  function preconnect(){
    const base=apiBase();
    if(!base) return;
    try{
      const url=new URL(base,window.location.href);
      const origin=url.origin;
      if(document.head.querySelector('link[rel="preconnect"][href="'+origin+'"]'))return;
      const link=document.createElement("link");
      link.rel="preconnect";
      link.href=origin;
      link.crossOrigin="";
      document.head.appendChild(link);
    }catch{}
  }

  function prefetch(url){
    if(!url||state.prefetched.has(url)||url.startsWith("#"))return;
    try{
      const target=new URL(url,window.location.href);
      if(target.origin!==window.location.origin || target.pathname===window.location.pathname)return;
      state.prefetched.add(url);
      const link=document.createElement("link");
      link.rel="prefetch";
      link.href=target.href;
      link.as="document";
      document.head.appendChild(link);
    }catch{}
  }

  function wirePrefetch(){
    document.addEventListener("pointerover",event=>{
      const a=event.target.closest("a[href]");
      if(!a)return;
      if(a.target==="_blank"||a.hasAttribute("download"))return;
      prefetch(a.getAttribute("href"));
    },{passive:true});
    document.addEventListener("focusin",event=>{
      const a=event.target.closest("a[href]");
      if(a)prefetch(a.getAttribute("href"));
    });
  }

  function networkUi(){
    const update=()=>{
      state.network=navigator.onLine!==false;
      document.documentElement.dataset.kbNetwork=state.network?"online":"offline";
      document.querySelectorAll("[data-kb-network-state]").forEach(el=>{
        el.textContent=state.network?"ONLINE":"OFFLINE";
        el.setAttribute("data-state",state.network?"online":"offline");
      });
      window.dispatchEvent(new CustomEvent("kingbot:network-change",{detail:{online:state.network}}));
    };
    window.addEventListener("online",update,{passive:true});
    window.addEventListener("offline",update,{passive:true});
    update();
  }

  function performanceBudget(){
    const connection=navigator.connection||navigator.mozConnection||navigator.webkitConnection;
    if(!connection)return;
    const save=Boolean(connection.saveData)||/2g/.test(String(connection.effectiveType||""));
    document.documentElement.dataset.kbSaveData=save?"true":"false";
    if(save) document.documentElement.classList.add("kb-low-bandwidth");
  }

  function globalRuntimeErrors(){
    window.addEventListener("error",event=>{
      window.dispatchEvent(new CustomEvent("kingbot:runtime-error",{detail:{
        message:String(event?.message||"Runtime error").slice(0,220),
        source:String(event?.filename||"").slice(-120),
        line:event?.lineno||null
      }}));
    });
    window.addEventListener("unhandledrejection",event=>{
      window.dispatchEvent(new CustomEvent("kingbot:runtime-error",{detail:{
        message:String(event?.reason?.message||event?.reason||"Unhandled promise rejection").slice(0,220)
      }}));
    });
  }

  async function connectEventStream(){
    const base=apiBase();
    const session=window.KINGBOT_SESSION;
    if(!base||!session?.isAuthenticated?.()||state.eventStream)return;
    try{
      const token=await (window.KINGBOT_FIREBASE?.getToken?.(true) || Promise.resolve(null));
      if(!token)return;
      const controller=new AbortController();
      state.eventStream=controller;
      const response=await fetch(base+"/api/events/live",{
        method:"GET",
        headers:{Authorization:"Bearer "+token,Accept:"text/event-stream"},
        cache:"no-store",
        signal:controller.signal
      });
      if(!response.ok||!response.body)throw new Error("EVENT_STREAM_UNAVAILABLE");
      window.dispatchEvent(new CustomEvent("kingbot:event-bus-connected"));
      const reader=response.body.getReader();
      const decoder=new TextDecoder();
      let buffer="";
      let eventName="message";
      let data="";
      const emit=()=>{
        if(!data)return;
        let parsed=data;
        try{parsed=JSON.parse(data);}catch{}
        if(eventName==="ready")window.dispatchEvent(new CustomEvent("kingbot:event-bus-ready",{detail:parsed}));
        else if(eventName==="kingbot")window.dispatchEvent(new CustomEvent("kingbot:event",{detail:parsed}));
        eventName="message";
        data="";
      };
      while(true){
        const chunk=await reader.read();
        if(chunk.done)break;
        buffer+=decoder.decode(chunk.value,{stream:true});
        const lines=buffer.split("\n");
        buffer=lines.pop()||"";
        for(const raw of lines){
          const line=raw.endsWith("\r")?raw.slice(0,-1):raw;
          if(!line){emit();continue;}
          if(line.startsWith("event:"))eventName=line.slice(6).trim()||"message";
          else if(line.startsWith("data:"))data+=(data?"\n":"")+line.slice(5).trim();
        }
      }
      emit();
    }catch(error){
      if(error?.name!=="AbortError")window.dispatchEvent(new CustomEvent("kingbot:event-bus-error",{detail:{message:String(error?.message||"EVENT_STREAM_UNAVAILABLE")}}));
    }finally{
      state.eventStream=null;
    }
  }

  function registerServiceWorker(){
    if(!("serviceWorker" in navigator)||!window.isSecureContext)return;
    window.addEventListener("load",()=>{
      navigator.serviceWorker.register("./sw.js",{scope:"./"}).catch(()=>{});
    },{once:true});
  }

  function setMeta(){
    if(!document.querySelector('meta[name="theme-color"]')){
      const meta=document.createElement("meta");
      meta.name="theme-color";
      meta.content="#02040a";
      document.head.appendChild(meta);
    }
    if(!document.querySelector('meta[name="description"]')){
      const meta=document.createElement("meta");
      meta.name="description";
      meta.content="KINGBOT FINTECH — intelligent trading technology, market intelligence, automation and controlled execution infrastructure.";
      document.head.appendChild(meta);
    }
    if(!document.querySelector('meta[name="color-scheme"]')){
      const meta=document.createElement("meta");
      meta.name="color-scheme";
      meta.content="dark light";
      document.head.appendChild(meta);
    }
  }

  function init(){
    if(state.started)return;
    state.started=true;
    mark("kingbot-shell-start");
    setMeta();
    preconnect();
    optimizeImages();
    wirePrefetch();
    networkUi();
    performanceBudget();
    globalRuntimeErrors();
    connectEventStream();
    registerServiceWorker();
    requestAnimationFrame(()=>mark("kingbot-shell-ready"));
  }

  window.KINGBOT_PERFORMANCE={
    state,
    init,
    reconnectEvents:()=>{
      try{state.eventStream?.abort?.();}catch{}
      state.eventStream=null;
      void connectEventStream();
    },
    prefetch
  };

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});
  else init();
})(window,document);
