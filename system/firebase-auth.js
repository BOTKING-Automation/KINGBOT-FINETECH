/*
 KINGBOT FINTECH — Firebase Authentication client
 Firebase is the identity provider. No passwords, verification codes,
 SMTP credentials, or Resend calls are handled by KINGBOT frontend code.
*/
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
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
const db = getFirestore(app);

async function saveUserProfile(user, extra={}, initialize=false) {
  if (!user) throw new Error("Cannot save a missing Firebase user.");
  const ref = doc(db, "users", user.uid);
  const now = serverTimestamp();

  const profile = {
    uid: user.uid,
    email: user.email || "",
    emailVerified: user.emailVerified === true,
    displayName: extra.displayName || user.displayName || "",
    firstName: extra.firstName || "",
    lastName: extra.lastName || "",
    phone: extra.phone || "",
    lastLoginAt: now,
    updatedAt: now
  };

  // Initialize trading/account fields only when the account is first created.
  // Sign-in updates identity metadata without resetting trading state.
  if (initialize) {
    Object.assign(profile, {
      createdAt: now,
      botRunning: false,
      lastTradeTime: 0,
      trades: [],
      totalTrades: 0,
      wins: 0,
      losses: 0,
      balance: 0
    });
  }

  await setDoc(ref, profile, { merge: true });
  return { ...profile, uid: user.uid, email: user.email || "" };
}

const API_BASE = window.KINGBOT_API?.baseUrl || "https://kingbot-fintech-api-etfv.onrender.com/api";

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
  app,auth,db,API_BASE,persist,
  createAccount:async({email,password,firstName,lastName,phone,remember=true})=>{
    await persist(remember);
    let credential;
    try{
      credential=await createUserWithEmailAndPassword(auth,email,password);
    }catch(error){
      if(error?.code!=="auth/email-already-in-use") throw error;
      try{
        credential=await signInWithEmailAndPassword(auth,email,password);
        await reload(credential.user);
        if(!credential.user.emailVerified){
          await sendEmailVerification(credential.user);
          return {user:credential.user,existing:true,verified:false,backendSynced:false,syncError:null};
        }
      }catch(signInError){
        throw error;
      }
      throw error;
    }
    const user=credential.user;
    const displayName=[firstName,lastName].filter(Boolean).join(" ").trim();
    await sendEmailVerification(user);
    let backendSynced=false;
    let syncError=null;
    try{
      await saveUserProfile(user,{firstName,lastName,phone,displayName},true);
    }catch(error){
      console.error("[KINGBOT AUTH] Firestore profile save failed:",error?.message||error);
      throw new Error("Account was created, but the user profile could not be saved. Check Firebase Firestore rules.");
    }
    try{
      await backendSync({firstName,lastName,phone,displayName});
      backendSynced=true;
    }catch(error){
      syncError=error;
      console.warn("[KINGBOT AUTH] Backend sync deferred after signup:",error?.message||error);
    }
    return {user,backendSynced,syncError};
  },
  signIn:async({email,password,remember=true})=>{
    await persist(remember);
    const credential=await signInWithEmailAndPassword(auth,email,password);
    await reload(credential.user);
    if(!credential.user.emailVerified) return {user:credential.user,verified:false,backendSynced:false,syncError:null};
    let backendSynced=false;
    let syncError=null;
    try{
      await saveUserProfile(credential.user);
    }catch(error){
      console.error("[KINGBOT AUTH] Firestore profile save failed after sign-in:",error?.message||error);
      throw new Error("Sign-in succeeded, but your user profile could not be saved. Check Firebase Firestore rules.");
    }
    try{
      await backendSync();
      backendSynced=true;
    }catch(error){
      syncError=error;
      console.warn("[KINGBOT AUTH] Backend sync deferred after sign-in:",error?.message||error);
    }
    return {user:credential.user,verified:true,backendSynced,syncError};
  },
  syncAccount:async extra=>backendSync(extra),
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
