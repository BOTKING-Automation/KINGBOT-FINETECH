/* KINGBOT FINTECH — shared client state fabric
   Read-only coordination layer for product pages. Execution authority remains server-side. */
(function(window,document){
  "use strict";
  const root=window.KINGBOT_CLIENT_STATE||{};
  const state={auth:null,broker:null,account:null,subscription:null,risk:null,bot:null,market:null,events:[],updatedAt:0,loading:false};
  const listeners=new Set();
  const inflight=new Map();
  let bc=null;

  const apiBase=()=>{
    const from=window.KINGBOT_API?.baseUrl||window.KINGBOT_FIREBASE?.API_BASE||"";
    return String(from||"").replace(/\/$/,"");
  };
  const emit=(reason)=>{
    state.updatedAt=Date.now();
    const snapshot=Object.freeze({
      ...state,
      events:Object.freeze(state.events.slice()),
    });
    listeners.forEach(fn=>{try{fn(snapshot,reason)}catch(e){console.warn("[KINGBOT STATE] listener",e)}});
    try{window.dispatchEvent(new CustomEvent("kingbot:state",{detail:{state:snapshot,reason}}))}catch{}
    if(bc)try{bc.postMessage({type:"STATE_UPDATE",reason,payload:snapshot})}catch{}
  };
  const token=async(force=false)=>{
    try{return window.KINGBOT_FIREBASE?.getToken?await window.KINGBOT_FIREBASE.getToken(Boolean(force)):null}catch{return null}
  };
  async function request(path,opts={}){
    const key=String(opts.method||"GET")+":"+path;
    if(inflight.has(key))return inflight.get(key);
    const p=(async()=>{
      const t=await token(Boolean(opts.forceToken));
      const headers=new Headers(opts.headers||{});
      headers.set("Accept","application/json");
      if(t)headers.set("Authorization","Bearer "+t);
      const res=await fetch(apiBase()+path,{...opts,headers,cache:"no-store"});
      if(!res.ok)throw new Error("HTTP_"+res.status+"_"+path);
      return res.json();
    })().finally(()=>inflight.delete(key));
    inflight.set(key,p);
    return p;
  }

  const set=(key,value,reason)=>{state[key]=value;emit(reason||key);};
  async function refresh({includeMarket=false,reason="refresh"}={}){
    if(state.loading)return;
    state.loading=true;emit("refresh:start");
    try{
      try{state.auth=await request("/api/auth/session",{forceToken:false});}
      catch(error){
        state.auth={ok:false,authenticated:false,error:String(error?.message||error)};
        state.broker=null;state.account=null;state.subscription=null;state.risk=null;state.market=null;
        emit(reason+":guest");
        return {...state};
      }
      const tasks=[
        ["broker",request("/api/connection")],
        ["subscription",request("/api/subscription/status")],
        ["risk",request("/api/execution-control")]
      ];
      if(includeMarket)tasks.push(["market",request("/api/intelligence/context")]);
      for(const [key,p] of tasks){
        try{state[key]=await p}catch(e){state[key]={ok:false,unavailable:true,error:String(e?.message||e)}}
      }
      emit(reason);
      return {...state};
    }finally{state.loading=false;}
  }
  function subscribe(fn){if(typeof fn!=="function")return()=>{};listeners.add(fn);fn({...state,events:state.events.slice()},"subscribe");return()=>listeners.delete(fn)}
  function addEvent(event){
    if(!event||typeof event!=="object")return;
    state.events.unshift(event);
    if(state.events.length>80)state.events.length=80;
    emit("event");
  }
  function initBroadcast(){
    if(!("BroadcastChannel" in window))return;
    try{
      bc=new BroadcastChannel("kingbot-client-state");
      bc.onmessage=e=>{
        if(e?.data?.type==="STATE_UPDATE"&&e.data.payload){
          const incoming=e.data.payload;
          Object.keys(state).forEach(k=>{if(Object.prototype.hasOwnProperty.call(incoming,k)&&k!=="events")state[k]=incoming[k]});
          if(Array.isArray(incoming.events))state.events=incoming.events.slice(0,80);
          emit("cross-tab");
        }
      };
    }catch{}
  }
  root.state=state;
  root.getState=()=>({...state,events:state.events.slice()});
  root.subscribe=subscribe;
  root.request=request;
  root.refresh=refresh;
  root.set=set;
  root.addEvent=addEvent;
  root.apiBase=apiBase;
  root.ready=true;
  window.KINGBOT_CLIENT_STATE=root;
  initBroadcast();
  window.addEventListener("kingbot:event",e=>addEvent(e.detail));
  window.addEventListener("kingbot:session-change",()=>refresh({reason:"session-change"}));
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>refresh(),{once:true}); else void refresh();
})(window,document);
