import { Router } from "express";
import crypto from "node:crypto";
import { getFirebaseAuth, verifyFirebaseToken } from "./firebase-admin.js";

function normalizeEmail(value){return String(value||"").trim().toLowerCase().slice(0,320);}
function hashRecoveryValue(value){return crypto.createHash("sha256").update(String(value||""),"utf8").digest("hex");}
function makeSixDigitCode(){return String(crypto.randomInt(0,1000000)).padStart(6,"0");}
function makeRecoveryToken(){return crypto.randomBytes(32).toString("base64url");}
async function sendPasswordCodeEmail({email,code}){
 const apiKey=String(process.env.BREVO_API_KEY||"").trim();
 const senderEmail=normalizeEmail(process.env.MAIL_FROM_EMAIL||"");
 const senderName=String(process.env.MAIL_FROM_NAME||"KINGBOT FINTECH").trim().slice(0,100);
 if(!apiKey||!senderEmail)throw new Error("PASSWORD_EMAIL_PROVIDER_NOT_CONFIGURED");
 const response=await fetch("https://api.brevo.com/v3/smtp/email",{method:"POST",headers:{"accept":"application/json","api-key":apiKey,"content-type":"application/json"},body:JSON.stringify({
  sender:{name:senderName,email:senderEmail},
  to:[{email}],
  subject:"KINGBOT FINTECH — Password verification code",
  htmlContent:`<div style="font-family:Arial,sans-serif;background:#050812;color:#eef2ff;padding:32px"><h2 style="color:#19e6ff">KINGBOT FINTECH</h2><p>Your password recovery verification code is:</p><div style="font-size:34px;letter-spacing:10px;font-weight:800;padding:18px 0;color:#ffc84a">${code}</div><p>This code expires in 10 minutes. Do not share it with anyone.</p><p style="color:#8791a8">If you did not request a password reset, you can ignore this email.</p></div>`
 })});
 if(!response.ok){const body=await response.text().catch(()=> "");throw new Error("PASSWORD_EMAIL_SEND_FAILED:"+body.slice(0,300));}
}

const recoveryMemory=new Map();
function pruneRecoveryMemory(){const now=Date.now();for(const [email,row] of recoveryMemory.entries()){if(row.expiresAt<=now||row.consumed)recoveryMemory.delete(email);}}
function safeName(displayName,email){
 const n=String(displayName||"").trim();
 if(n)return n.slice(0,160);
 return String(email||"").split("@")[0].slice(0,80)||"KINGBOT User";
}
function splitName(displayName,email){
 const parts=safeName(displayName,email).split(/\s+/).filter(Boolean);
 return {firstName:parts[0]||"KINGBOT",lastName:parts.slice(1).join(" ")||"User"};
}
async function firebaseUser(req){
 try{return await verifyFirebaseToken(req);}catch{return null;}
}
export async function resolveFirebaseUser(pool,req){
 if(!pool)return null;
 const fb=await firebaseUser(req);
 if(!fb||fb.email_verified!==true)return null;

 const q=await pool.query("SELECT id,email,first_name,last_name,email_verified,phone_verified,admin_blocked FROM kingbot_users WHERE firebase_uid=$1 LIMIT 1",[fb.uid]);
 if(q.rowCount)return q.rows[0];

 const email=String(fb.email||"").trim().toLowerCase();
 if(!email)return null;

 const byEmail=await pool.query("SELECT id,email,first_name,last_name,email_verified,phone_verified,admin_blocked FROM kingbot_users WHERE email=$1 LIMIT 1",[email]);
 if(byEmail.rowCount){
  await pool.query("UPDATE kingbot_users SET firebase_uid=$1,email_verified=TRUE WHERE id=$2",[fb.uid,byEmail.rows[0].id]);
  return {...byEmail.rows[0],email_verified:true};
 }

 // Recover the KINGBOT profile automatically when Firebase authentication
 // succeeded but the frontend/backend synchronization did not complete.
 const names=splitName(fb.name,email);
 const created=await pool.query(
  "INSERT INTO kingbot_users(firebase_uid,first_name,last_name,email,email_verified,phone_verified) VALUES($1,$2,$3,$4,TRUE,FALSE) ON CONFLICT(email) DO UPDATE SET firebase_uid=EXCLUDED.firebase_uid,email_verified=TRUE RETURNING id,email,first_name,last_name,email_verified,phone_verified,admin_blocked",
  [fb.uid,names.firstName,names.lastName,email]
 );
 return created.rows[0]||null;
}
export function createAuthRouter({pool}){
 const router=Router();
 router.post("/sync",async(req,res)=>{
  if(!pool)return res.status(503).json({ok:false,error:"Account service is not configured."});
  try{
   const fb=await firebaseUser(req);
   if(!fb)return res.status(401).json({ok:false,error:"Invalid Firebase authentication token."});
   const email=String(fb.email||"").trim().toLowerCase();
   if(!email)return res.status(400).json({ok:false,error:"Firebase account email is required."});
   const names=splitName(req.body?.displayName||fb.name,email);
   const phone=String(req.body?.phone||"").trim()||null;
   const q=await pool.query("SELECT id FROM kingbot_users WHERE firebase_uid=$1 OR email=$2 LIMIT 1",[fb.uid,email]);
   let row;
   if(q.rowCount){
    const u=await pool.query("UPDATE kingbot_users SET firebase_uid=$1,email=$2,first_name=COALESCE(NULLIF($3,''),first_name),last_name=COALESCE(NULLIF($4,''),last_name),phone=COALESCE($5,phone),email_verified=$6 WHERE id=$7 RETURNING id,email,first_name,last_name,email_verified,phone_verified",[fb.uid,email,names.firstName,names.lastName,phone,Boolean(fb.email_verified),q.rows[0].id]);
    row=u.rows[0];
   }else{
    const u=await pool.query("INSERT INTO kingbot_users(firebase_uid,first_name,last_name,email,phone,email_verified,phone_verified) VALUES($1,$2,$3,$4,$5,$6,FALSE) RETURNING id,email,first_name,last_name,email_verified,phone_verified",[fb.uid,names.firstName,names.lastName,email,phone,Boolean(fb.email_verified)]);
    row=u.rows[0];
   }
   res.json({ok:true,authenticated:true,user:{id:row.id,email:row.email,name:`${row.first_name} ${row.last_name}`.trim(),emailVerified:row.email_verified,phoneVerified:row.phone_verified,verified:row.email_verified,firebaseUid:fb.uid}});
  }catch(error){console.error("[KINGBOT AUTH] Firebase sync failed:",error?.message||error);res.status(500).json({ok:false,error:"Account synchronization failed."});}
 });
 router.get("/session",async(req,res)=>{
  try{
   const fb=await firebaseUser(req);
   if(!fb)return res.status(401).json({ok:false});
   if(!pool)return res.status(503).json({ok:false,error:"Account service is not configured."});
   const u=await resolveFirebaseUser(pool,req);
   if(!u)return res.status(401).json({ok:false,error:"KINGBOT account profile is not synchronized."});
   res.json({ok:true,authenticated:true,user:{id:u.id,email:u.email,name:`${u.first_name} ${u.last_name}`.trim(),emailVerified:u.email_verified,phoneVerified:u.phone_verified,verified:u.email_verified,firebaseUid:fb.uid}});
  }catch(error){console.error("[KINGBOT AUTH] Firebase session failed:",error?.message||error);res.status(401).json({ok:false,error:"Authentication session unavailable."});}
 });
 router.post("/password/request-code",async(req,res)=>{
  const email=normalizeEmail(req.body?.email);
  if(!email)return res.status(400).json({ok:false,error:"Enter your email address."});
  const generic={ok:true,message:"If a KINGBOT account exists for that email, a six-digit verification code has been sent."};
  pruneRecoveryMemory();
  try{
   const recent=recoveryMemory.get(email);
   if(recent&&recent.lastSentAt>Date.now()-15*60*1000&&recent.sendCount>=3)return res.json(generic);
   let fbUser;
   try{fbUser=await getFirebaseAuth().getUserByEmail(email);}catch{return res.json(generic);}
   if(!fbUser?.uid)return res.json(generic);
   const code=makeSixDigitCode();
   try{await sendPasswordCodeEmail({email,code});}
   catch(error){console.error("[KINGBOT AUTH] Password code email failed:",error?.message||error);return res.status(503).json({ok:false,error:"Password recovery email service is not configured or unavailable."});}
   recoveryMemory.set(email,{firebaseUid:fbUser.uid,codeHash:hashRecoveryValue(code),expiresAt:Date.now()+10*60*1000,attempts:0,verified:false,recoveryTokenHash:"",recoveryExpiresAt:0,lastSentAt:Date.now(),sendCount:(recent?.sendCount||0)+1,consumed:false});
   if(pool){
    try{
     await pool.query("UPDATE kingbot_password_resets SET consumed_at=COALESCE(consumed_at,NOW()) WHERE email=$1 AND consumed_at IS NULL",[email]);
     await pool.query("INSERT INTO kingbot_password_resets(firebase_uid,email,code_hash,expires_at,attempts,created_at) VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes',0,NOW())",[fbUser.uid,email,hashRecoveryValue(code)]);
    }catch(error){console.warn("[KINGBOT AUTH] Persistent password recovery storage unavailable; using secure memory fallback:",error?.message||error);}
   }
   return res.json(generic);
  }catch(error){console.error("[KINGBOT AUTH] Password code request failed:",error?.message||error);return res.status(500).json({ok:false,error:"Password recovery is temporarily unavailable."});}
 });
 router.post("/password/verify-code",async(req,res)=>{
  const email=normalizeEmail(req.body?.email),code=String(req.body?.code||"").replace(/\D/g,"").slice(0,6);
  if(!email||code.length!==6)return res.status(400).json({ok:false,error:"Enter the six-digit verification code."});
  pruneRecoveryMemory();
  try{
   const memory=recoveryMemory.get(email);
   let row=null;
   if(memory)row={id:null,firebase_uid:memory.firebaseUid,code_hash:memory.codeHash,expires_at:new Date(memory.expiresAt),attempts:memory.attempts};
   if(!row&&pool){
    const q=await pool.query("SELECT id,firebase_uid,code_hash,expires_at,attempts FROM kingbot_password_resets WHERE email=$1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1",[email]);
    if(q.rowCount)row=q.rows[0];
   }
   if(!row)return res.status(400).json({ok:false,error:"The code is invalid or expired."});
   if(new Date(row.expires_at).getTime()<=Date.now())return res.status(400).json({ok:false,error:"The code has expired. Request a new code."});
   if(Number(row.attempts)>=5)return res.status(429).json({ok:false,error:"Too many code attempts. Request a new code."});
   if(memory)memory.attempts=Number(memory.attempts||0)+1;
   else if(pool)await pool.query("UPDATE kingbot_password_resets SET attempts=attempts+1 WHERE id=$1",[row.id]);
   if(hashRecoveryValue(code)!==row.code_hash)return res.status(400).json({ok:false,error:"The code is invalid or expired."});
   const recoveryToken=makeRecoveryToken(),expiresAt=Date.now()+10*60*1000;
   if(memory){memory.verified=true;memory.recoveryTokenHash=hashRecoveryValue(recoveryToken);memory.recoveryExpiresAt=expiresAt;}
   if(pool&&row.id){await pool.query("UPDATE kingbot_password_resets SET verified_at=NOW(),recovery_token_hash=$2,recovery_expires_at=NOW()+INTERVAL '10 minutes' WHERE id=$1",[row.id,hashRecoveryValue(recoveryToken)]);}
   return res.json({ok:true,verified:true,recoveryToken,expiresInSeconds:600});
  }catch(error){console.error("[KINGBOT AUTH] Password code verification failed:",error?.message||error);return res.status(500).json({ok:false,error:"Password verification is temporarily unavailable."});}
 });
 router.post("/password/reset",async(req,res)=>{
  const email=normalizeEmail(req.body?.email),token=String(req.body?.recoveryToken||""),password=String(req.body?.password||"");
  if(!email||!token)return res.status(400).json({ok:false,error:"Password recovery session is missing."});
  if(password.length<8)return res.status(400).json({ok:false,error:"Password must contain at least 8 characters."});
  pruneRecoveryMemory();
  try{
   let uid=null,valid=false,dbRow=null;
   const memory=recoveryMemory.get(email);
   if(memory&&memory.verified&&memory.recoveryExpiresAt>Date.now()&&hashRecoveryValue(token)===memory.recoveryTokenHash){uid=memory.firebaseUid;valid=true;}
   if(!valid&&pool){
    const q=await pool.query("SELECT id,firebase_uid,recovery_token_hash,recovery_expires_at,verified_at,consumed_at FROM kingbot_password_resets WHERE email=$1 ORDER BY created_at DESC LIMIT 1",[email]);
    if(q.rowCount){
     dbRow=q.rows[0];
     valid=!dbRow.consumed_at&&dbRow.verified_at&&dbRow.recovery_expires_at&&new Date(dbRow.recovery_expires_at).getTime()>Date.now()&&hashRecoveryValue(token)===dbRow.recovery_token_hash;
     if(valid)uid=dbRow.firebase_uid;
    }
   }
   if(!valid||!uid)return res.status(400).json({ok:false,error:"Password recovery session is invalid or expired."});
   const firebaseAuth=getFirebaseAuth();
   const fbUser=await firebaseAuth.getUser(uid);
   await firebaseAuth.updateUser(fbUser.uid,{password});
   await firebaseAuth.revokeRefreshTokens(fbUser.uid);
   if(dbRow?.id)await pool.query("UPDATE kingbot_password_resets SET consumed_at=NOW() WHERE id=$1",[dbRow.id]);
   recoveryMemory.delete(email);
   return res.json({ok:true,passwordReset:true,message:"Password reset successfully. You can sign in with your new password."});
  }catch(error){console.error("[KINGBOT AUTH] Password reset failed:",error?.message||error);return res.status(500).json({ok:false,error:"Password reset failed. Please request a new code and try again."});}
 });

 router.post("/logout",(_req,res)=>res.json({ok:true}));
 router.post("/signup",(req,res)=>res.status(410).json({ok:false,error:"Signup is handled by Firebase Authentication."}));
 router.post("/signin",(req,res)=>res.status(410).json({ok:false,error:"Sign in is handled by Firebase Authentication."}));
 router.post("/verify",(req,res)=>res.status(410).json({ok:false,error:"Email verification is handled by Firebase Authentication."}));
 router.post("/resend-verification",(req,res)=>res.status(410).json({ok:false,error:"Verification emails are handled by Firebase Authentication."}));
 router.post("/forgot-password",(req,res)=>res.status(410).json({ok:false,error:"Password recovery is handled by Firebase Authentication."}));
 router.post("/reset-password",(req,res)=>res.status(410).json({ok:false,error:"Password reset is handled by Firebase Authentication."}));
 return router;
}
export async function ensureAuthSchema(pool){
 if(!pool)return;
 await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
 await pool.query("ALTER TABLE kingbot_users ALTER COLUMN password_hash DROP NOT NULL").catch(()=>{});
 await pool.query("ALTER TABLE kingbot_users ALTER COLUMN phone DROP NOT NULL").catch(()=>{});
 await pool.query("ALTER TABLE kingbot_users ADD COLUMN IF NOT EXISTS firebase_uid TEXT").catch(()=>{});
 await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS kingbot_users_firebase_uid_unique ON kingbot_users(firebase_uid) WHERE firebase_uid IS NOT NULL").catch(()=>{});
 await pool.query("ALTER TABLE kingbot_users ADD COLUMN IF NOT EXISTS admin_blocked BOOLEAN NOT NULL DEFAULT FALSE").catch(()=>{});
 await pool.query("CREATE TABLE IF NOT EXISTS kingbot_users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),firebase_uid TEXT UNIQUE,first_name TEXT NOT NULL,last_name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,phone TEXT,password_hash TEXT,email_verified BOOLEAN NOT NULL DEFAULT FALSE,phone_verified BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());");
 await pool.query("CREATE TABLE IF NOT EXISTS kingbot_password_resets (id BIGSERIAL PRIMARY KEY,firebase_uid TEXT NOT NULL,email TEXT NOT NULL,code_hash TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,verified_at TIMESTAMPTZ,recovery_token_hash TEXT,recovery_expires_at TIMESTAMPTZ,consumed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());");
 await pool.query("CREATE INDEX IF NOT EXISTS kingbot_password_resets_email_created_idx ON kingbot_password_resets(email,created_at DESC);");
}
