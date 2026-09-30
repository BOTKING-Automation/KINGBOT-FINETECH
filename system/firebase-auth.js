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
  reload,
  updateProfile
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-storage.js";

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
const storage = getStorage(app);
let authReadyResolve;
const authReady = new Promise(resolve => { authReadyResolve = resolve; });
let authReadyUnsubscribe = null;
authReadyUnsubscribe = onAuthStateChanged(auth, user => { authReadyResolve(user || null); try{authReadyUnsubscribe?.();}catch{} });

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

  // Optional profile-only fields are written only when explicitly supplied.
  // This prevents a normal sign-in from clearing an existing profile photo.
  if (Object.prototype.hasOwnProperty.call(extra, "photoURL")) {
    profile.photoURL = String(extra.photoURL || "");
  }
  if (Object.prototype.hasOwnProperty.call(extra, "profilePhotoData")) {
    profile.profilePhotoData = String(extra.profilePhotoData || "");
  }

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
async function waitForAuthReady(timeoutMs=10000){
  return await Promise.race([
    authReady,
    new Promise((_,reject)=>setTimeout(()=>reject(new Error("Authentication service did not finish loading. Please refresh once.")),Number(timeoutMs)||10000))
  ]);
}
async function getProfile(){
  const user=await waitForAuthReady().catch(()=>auth.currentUser);
  if(!user)return null;
  const snap=await getDoc(doc(db,"users",user.uid));
  const data=snap.exists()?snap.data():{};
  return {
    uid:user.uid,
    email:user.email||data.email||"",
    emailVerified:user.emailVerified===true,
    displayName:user.displayName||data.displayName||[data.firstName,data.lastName].filter(Boolean).join(" ").trim(),
    firstName:data.firstName||"",
    lastName:data.lastName||"",
    phone:data.phone||"",
    photoURL:user.photoURL||data.photoURL||"",
    profilePhotoData:data.profilePhotoData||""
  };
}
function readBlobAsDataUrl(blob){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result||""));
    reader.onerror=()=>reject(new Error("Unable to prepare the profile photo."));
    reader.readAsDataURL(blob);
  });
}
function readFileAsDataUrl(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result||""));
    reader.onerror=()=>reject(new Error("Unable to read the selected image."));
    reader.readAsDataURL(file);
  });
}
async function compressProfileImage(file){
  if(!file||!String(file.type||"").startsWith("image/"))throw new Error("Select a JPG, PNG or WebP image.");
  if(Number(file.size)>5*1024*1024)throw new Error("Profile photo must be 5 MB or smaller.");
  const source=await readFileAsDataUrl(file);
  const image=await new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>resolve(img);
    img.onerror=()=>reject(new Error("The selected image could not be decoded."));
    img.src=source;
  });
  const max=640;
  const scale=Math.min(1,max/Math.max(image.naturalWidth||image.width,image.naturalHeight||image.height));
  const w=Math.max(1,Math.round((image.naturalWidth||image.width)*scale));
  const h=Math.max(1,Math.round((image.naturalHeight||image.height)*scale));
  const canvas=document.createElement("canvas");
  canvas.width=w;canvas.height=h;
  const ctx=canvas.getContext("2d");
  if(!ctx)throw new Error("Image processor is unavailable in this browser.");
  ctx.drawImage(image,0,0,w,h);
  return await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("Image compression failed.")),"image/jpeg",0.78));
}
async function uploadProfilePhoto(file){
  const user=await waitForAuthReady();
  if(!user)throw new Error("Please sign in before uploading a profile photo.");
  const blob=await compressProfileImage(file);
  try{
    const fileRef=storageRef(storage,"profile-photos/"+user.uid+".jpg");
    await uploadBytes(fileRef,blob,{contentType:"image/jpeg",cacheControl:"public,max-age=3600"});
    const photoURL=await getDownloadURL(fileRef);
    await updateProfile(user,{photoURL});
    await saveUserProfile(user,{displayName:user.displayName||"",photoURL});
    return {photoURL,stored:"storage"};
  }catch(storageError){
    console.warn("[KINGBOT PROFILE] Firebase Storage upload unavailable; using Firestore profile fallback:",storageError?.message||storageError);
    const dataUrl=await readBlobAsDataUrl(blob);
    if(dataUrl.length>700000)throw new Error("Profile photo is too large after compression. Choose a smaller image.");
    await saveUserProfile(user,{displayName:user.displayName||"",profilePhotoData:dataUrl});
    return {photoURL:dataUrl,stored:"firestore"};
  }
}
async function updateProfileDetails({firstName="",lastName="",phone=""}={}){
  const user=await waitForAuthReady();
  if(!user)throw new Error("Please sign in first.");
  const cleanFirst=String(firstName||"").trim().slice(0,80);
  const cleanLast=String(lastName||"").trim().slice(0,80);
  const cleanPhone=String(phone||"").trim().slice(0,40);
  const displayName=[cleanFirst,cleanLast].filter(Boolean).join(" ").trim();
  if(!displayName)throw new Error("Enter your first and last name.");
  await updateProfile(user,{displayName});
  await saveUserProfile(user,{firstName:cleanFirst,lastName:cleanLast,phone:cleanPhone,displayName});
  try{await backendSync({firstName:cleanFirst,lastName:cleanLast,phone:cleanPhone});}catch(error){console.warn("[KINGBOT PROFILE] Backend sync deferred:",error?.message||error);}
  return getProfile();
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
  app,auth,db,storage,API_BASE,persist,waitForAuthReady,getProfile,uploadProfilePhoto,updateProfileDetails,
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
