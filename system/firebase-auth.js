/*
 KINGBOT FINTECH — Firebase Authentication client
 Firebase is the identity provider. No passwords, verification codes,
 SMTP credentials, or Resend calls are handled by KINGBOT frontend code.
*/
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  reload
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyC5FpdO2YRysvERSGjLhO8AprfiB-d4_28",
  authDomain: "kingbot-fintech-web.firebaseapp.com",
  projectId: "kingbot-fintech-web",
  storageBucket: "kingbot-fintech-web.firebasestorage.app",
  messagingSenderId: "58162193481",
  appId: "1:58162193481:web:3b35c0948aa00f92704b98",
  measurementId: "G-JFCTDR7TX8"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const API_BASE = "https://kingbot-fintech-api.onrender.com/api";

async function persist(remember=true){
  await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
}

async function backendSync(extra={}){
  const user=auth.currentUser;
  if(!user) return null;
  const token=await user.getIdToken(true);
  const response=await fetch(API_BASE+"/auth/sync",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},
    body:JSON.stringify({
      uid:user.uid,email:user.email||"",emailVerified:user.emailVerified,
      displayName:user.displayName||"",...extra
    })
  });
  if(!response.ok) throw new Error((await response.json().catch(()=>({}))).error||"Account synchronization failed.");
  return response.json();
}

window.KINGBOT_FIREBASE={
  app,auth,API_BASE,persist,
  createAccount:async({email,password,firstName,lastName,phone,remember=true})=>{
    await persist(remember);
    const credential=await createUserWithEmailAndPassword(auth,email,password);
    const user=credential.user;
    const displayName=[firstName,lastName].filter(Boolean).join(" ").trim();
    await sendEmailVerification(user);
    await backendSync({firstName,lastName,phone,displayName});
    return user;
  },
  signIn:async({email,password,remember=true})=>{
    await persist(remember);
    const credential=await signInWithEmailAndPassword(auth,email,password);
    await reload(credential.user);
    if(!credential.user.emailVerified) return {user:credential.user,verified:false};
    await backendSync();
    return {user:credential.user,verified:true};
  },
  resendVerification:async()=>{
    if(!auth.currentUser) throw new Error("Please sign in first.");
    await sendEmailVerification(auth.currentUser);
  },
  sendPasswordReset:async email=>sendPasswordResetEmail(auth,email),
  signOut:async()=>signOut(auth),
  refresh:async()=>{
    if(!auth.currentUser) return null;
    await reload(auth.currentUser);
    return auth.currentUser;
  },
  getToken:async(force=false)=>auth.currentUser?auth.currentUser.getIdToken(force):null,
  onChange:callback=>onAuthStateChanged(auth,callback)
};
