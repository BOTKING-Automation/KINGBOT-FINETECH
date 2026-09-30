/*
 KINGBOT FINTECH — Firebase session manager
 Identity is handled by Firebase Authentication.
 Backend APIs receive Firebase ID tokens; no custom browser
 session cookie or Resend verification is used.
*/
(function(window){
"use strict";
const API_BASE="https://kingbot-fintech-api-etfv.onrender.com/api";
const API_ORIGIN=API_BASE.replace(/\/api\/?$/i,"");
const state={checked:false,checking:false,authenticated:false,user:null,error:null,checkedAt:0};
let activeCheck=null;
async function firebaseClient(){
 if(window.KINGBOT_FIREBASE)return window.KINGBOT_FIREBASE;
 try{await import(new URL("system/firebase-auth.js",window.location.href).href);}catch{}
 return window.KINGBOT_FIREBASE||null;
}
function apiUrl(path){
 const value=String(path||"");
 if(/^https?:\/\//i.test(value))return value;
 return value.startsWith("/api/")?API_ORIGIN+value:API_BASE+(value.startsWith("/")?value:"/"+value);
}
function withTimeout(promise,ms){
 return Promise.race([
  promise,
  new Promise((_,reject)=>setTimeout(()=>reject(new Error("REQUEST_TIMEOUT")),ms))
 ]);
}
async function apiRequest(path,options={}){
 const firebase=await firebaseClient();
 const headers=new Headers(options.headers||{});
 headers.set("Accept","application/json");
 if(options.body&&!headers.has("Content-Type"))headers.set("Content-Type","application/json");
 let token=null;
 try{token=await firebase?.getToken(false)||null;}catch{}
 const send=authorization=>{
  const requestHeaders=new Headers(headers);
  if(authorization)requestHeaders.set("Authorization","Bearer "+authorization);
  return fetch(apiUrl(path),{...options,headers:requestHeaders,credentials:"omit",cache:"no-store"});
 };
 let response=await send(token);
 if(response.status===401&&token){
  try{const refreshed=await firebase?.getToken(true);if(refreshed)response=await send(refreshed);}catch{}
 }
 return response;
}
async function apiJson(path,options={}){
 const response=await apiRequest(path,options);
 const data=await response.json().catch(()=>({}));
 if(!response.ok||data?.ok===false)throw new Error(data.error||data.reason||data.message||("Backend HTTP "+response.status));
 return data;
}
window.KINGBOT_API={baseUrl:API_BASE,request:apiRequest,json:apiJson};
const session={
 config:{apiBase:API_BASE,sessionEndpoint:API_BASE+"/auth/session",logoutEndpoint:API_BASE+"/auth/logout",cacheDuration:15000},
 async check(options={}){
  const force=Boolean(options.force);
  if(activeCheck)return activeCheck;
  if(!force&&state.checked&&Date.now()-state.checkedAt<this.config.cacheDuration)return this.getState();
    if(!window.KINGBOT_FIREBASE){try{await import(new URL("system/firebase-auth.js",window.location.href).href);}catch(error){state.error=error;} }
    if(!window.KINGBOT_FIREBASE){state.error=state.error||new Error("Firebase Authentication is not loaded.");state.checked=true;state.checkedAt=Date.now();state.authenticated=false;state.user=null;return this.getState();}
  state.checking=true;state.error=null;
  activeCheck=(async()=>{
  try{
   const fb=await window.KINGBOT_FIREBASE.waitForAuthReady(10000).catch(()=>window.KINGBOT_FIREBASE?.auth?.currentUser||null);
   if(!fb){
    state.authenticated=false;
    state.user=null;
   }else{
    const user=window.KINGBOT_FIREBASE.auth.currentUser||fb;
    if(!user){
      state.authenticated=false;
      state.user=null;
    }else{
      // Firebase is the source of truth for browser authentication.
      // Do not block protected-page startup on Render/backend latency.
      state.authenticated=true;
      state.user={
        id:user.uid,
        email:user.email||"",
        name:user.displayName||user.email||"KINGBOT User",
        verified:user.emailVerified===true,
        emailVerified:user.emailVerified===true
      };

      // Refresh backend account linkage opportunistically in the background.
      if(user.emailVerified){
        void (async()=>{
          try{
            const token=await user.getIdToken();
            const response=await withTimeout(fetch(this.config.sessionEndpoint,{
              headers:{Authorization:"Bearer "+token,Accept:"application/json"},
              cache:"no-store"
            }),2500);
            if(response.ok){
              const data=await response.json().catch(()=>({}));
              if(data.authenticated&&data.user){
                state.user={...state.user,...data.user,verified:true,emailVerified:true};
              }
            }else if(window.KINGBOT_FIREBASE?.syncAccount){
              await withTimeout(window.KINGBOT_FIREBASE.syncAccount(),2500);
            }
          }catch(error){
            console.warn("[KINGBOT SESSION] Background backend sync deferred:",error?.message||error);
          }
        })();
      }
    }
   }
   state.checked=true;state.checkedAt=Date.now();return this.getState();
  }catch(error){console.error("[KINGBOT SESSION]",error);state.error=error;state.authenticated=false;state.user=null;state.checked=true;state.checkedAt=Date.now();return this.getState();}
  finally{state.checking=false;}
  })();
  try{return await activeCheck;}finally{activeCheck=null;}
 },
 getState(){return {...state};},
 isAuthenticated(){return state.authenticated===true;},
 isVerified(){return this.isAuthenticated()&&Boolean(state.user?.verified);},
 getUser(){return state.user;},
 getDisplayName(){return state.user?.name||state.user?.displayName||state.user?.email||"Guest";},
 getEmail(){return state.user?.email||"";},
 getUserId(){return state.user?.id||"";},
 getReturnUrl(){return window.location.pathname+window.location.search+window.location.hash;},
 redirectToSignIn(){window.location.replace("access-stable.html?return="+encodeURIComponent(this.getReturnUrl())+"#signin");},
 redirectAfterLogin(){const p=new URLSearchParams(location.search),r=p.get("return");if(r&&r.startsWith("/")&&!r.startsWith("//")&&!/^\/(signin|signup)/i.test(r))return location.replace(r);location.replace("index.html");},
 async requireAuth({redirect=true}={}){const x=await this.check({force:true});if(x.authenticated)return true;if(redirect)this.redirectToSignIn();return false;},
 async requireVerified({redirect=true}={}){const x=await this.check({force:true});if(!x.authenticated){if(redirect)this.redirectToSignIn();return false;}if(x.user?.verified)return true;if(redirect)location.replace("verify.html?return="+encodeURIComponent(this.getReturnUrl()));return false;},
 async logout({redirect=true}={}){try{sessionStorage.removeItem("KINGBOT_AUTH_HANDOFF");}catch{}try{await window.KINGBOT_FIREBASE?.signOut();}finally{this.clear();if(redirect)location.replace("access-stable.html#signin");}},
 clear(){Object.assign(state,{checked:true,checking:false,authenticated:false,user:null,error:null,checkedAt:Date.now()});},
 updateUserElements(){document.querySelectorAll("[data-kingbot-user]").forEach(e=>e.textContent=this.getDisplayName());document.querySelectorAll("[data-kingbot-email]").forEach(e=>e.textContent=this.getEmail());document.querySelectorAll("[data-kingbot-id]").forEach(e=>e.textContent=this.getUserId());document.querySelectorAll("[data-kingbot-auth-status]").forEach(e=>e.textContent=this.isAuthenticated()?"Authenticated":"Not Authenticated");},
 emitChange(){window.dispatchEvent(new CustomEvent("kingbot:session-change",{detail:this.getState()}));},
 async refresh(){const x=await this.check({force:true});this.updateUserElements();this.emitChange();return x;}
};
function fbAuthChange(callback){return window.KINGBOT_FIREBASE.onChange(callback);}
window.KINGBOT_SESSION=session;
async function bootSession(){await session.check();session.updateUserElements();session.emitChange();}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bootSession,{once:true});else void bootSession();
})(window);
