/*
 KINGBOT FINTECH — Firebase session manager
 Identity is handled by Firebase Authentication.
 Backend APIs receive Firebase ID tokens; no custom browser
 session cookie or Resend verification is used.
*/
(function(window){
"use strict";
const API_BASE="https://kingbot-fintech-api.onrender.com/api";
const state={checked:false,checking:false,authenticated:false,user:null,error:null,checkedAt:0};
const session={
 config:{sessionEndpoint:API_BASE+"/auth/session",logoutEndpoint:API_BASE+"/auth/logout",cacheDuration:15000},
 async check(options={}){
  const force=Boolean(options.force);
  if(!force&&state.checked&&Date.now()-state.checkedAt<this.config.cacheDuration)return this.getState();
  if(!window.KINGBOT_FIREBASE){state.error=new Error("Firebase Authentication is not loaded.");state.checked=true;state.checkedAt=Date.now();state.authenticated=false;state.user=null;return this.getState();}
  state.checking=true;state.error=null;
  try{
   const fb=await new Promise(resolve=>{
    let done=false;
    const finish=u=>{if(done)return;done=true;resolve(u);};
    const unsub=fbAuthChange(finish); setTimeout(()=>{try{unsub?.();}catch{} finish(window.KINGBOT_FIREBASE.auth.currentUser);},1200);
   });
   if(!fb){state.authenticated=false;state.user=null;}
   else{
    await window.KINGBOT_FIREBASE.refresh();
    const user=window.KINGBOT_FIREBASE.auth.currentUser;
    if(!user){state.authenticated=false;state.user=null;}
    else{
     const token=await user.getIdToken();
     const r=await fetch(this.config.sessionEndpoint,{headers:{Authorization:"Bearer "+token,Accept:"application/json"},cache:"no-store"});
     const d=await r.json().catch(()=>({}));
     if(r.ok&&d.authenticated){state.authenticated=true;state.user=d.user||{id:user.uid,email:user.email,name:user.displayName,verified:user.emailVerified};}
     else if(user.emailVerified){state.authenticated=true;state.user={id:user.uid,email:user.email,name:user.displayName,verified:true,emailVerified:true};}
     else{state.authenticated=true;state.user={id:user.uid,email:user.email,name:user.displayName,verified:false,emailVerified:false};}
    }
   }
   state.checked=true;state.checkedAt=Date.now();return this.getState();
  }catch(error){console.error("[KINGBOT SESSION]",error);state.error=error;state.authenticated=false;state.user=null;state.checked=true;state.checkedAt=Date.now();return this.getState();}
  finally{state.checking=false;}
 },
 getState(){return {...state};},
 isAuthenticated(){return state.authenticated===true;},
 isVerified(){return this.isAuthenticated()&&Boolean(state.user?.verified);},
 getUser(){return state.user;},
 getDisplayName(){return state.user?.name||state.user?.displayName||state.user?.email||"Guest";},
 getEmail(){return state.user?.email||"";},
 getUserId(){return state.user?.id||"";},
 getReturnUrl(){return window.location.pathname+window.location.search+window.location.hash;},
 redirectToSignIn(){window.location.replace("signin.html?return="+encodeURIComponent(this.getReturnUrl()));},
 redirectAfterLogin(){const p=new URLSearchParams(location.search),r=p.get("return");if(r&&r.startsWith("/")&&!r.startsWith("//")&&!/^\/(signin|signup)/i.test(r))return location.replace(r);location.replace("index.html");},
 async requireAuth({redirect=true}={}){const x=await this.check({force:true});if(x.authenticated)return true;if(redirect)this.redirectToSignIn();return false;},
 async requireVerified({redirect=true}={}){const x=await this.check({force:true});if(!x.authenticated){if(redirect)this.redirectToSignIn();return false;}if(x.user?.verified)return true;if(redirect)location.replace("verify.html?return="+encodeURIComponent(this.getReturnUrl()));return false;},
 async logout({redirect=true}={}){try{await window.KINGBOT_FIREBASE?.signOut();}finally{this.clear();if(redirect)location.replace("signin.html");}},
 clear(){Object.assign(state,{checked:true,checking:false,authenticated:false,user:null,error:null,checkedAt:Date.now()});},
 updateUserElements(){document.querySelectorAll("[data-kingbot-user]").forEach(e=>e.textContent=this.getDisplayName());document.querySelectorAll("[data-kingbot-email]").forEach(e=>e.textContent=this.getEmail());document.querySelectorAll("[data-kingbot-id]").forEach(e=>e.textContent=this.getUserId());document.querySelectorAll("[data-kingbot-auth-status]").forEach(e=>e.textContent=this.isAuthenticated()?"Authenticated":"Not Authenticated");},
 emitChange(){window.dispatchEvent(new CustomEvent("kingbot:session-change",{detail:this.getState()}));},
 async refresh(){const x=await this.check({force:true});this.updateUserElements();this.emitChange();return x;}
};
function fbAuthChange(callback){return window.KINGBOT_FIREBASE.onChange(callback);}
window.KINGBOT_SESSION=session;
document.addEventListener("DOMContentLoaded",async()=>{await session.check();session.updateUserElements();session.emitChange();});
})(window);
