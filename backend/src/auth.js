import { Router } from "express";
import { verifyFirebaseToken } from "./firebase-admin.js";

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
 const q=await pool.query("SELECT id,email,first_name,last_name,email_verified,phone_verified FROM kingbot_users WHERE firebase_uid=$1 LIMIT 1",[fb.uid]);
 if(q.rowCount)return q.rows[0];
 const byEmail=await pool.query("SELECT id,email,first_name,last_name,email_verified,phone_verified FROM kingbot_users WHERE email=$1 LIMIT 1",[String(fb.email||"").toLowerCase()]);
 if(byEmail.rowCount){
  await pool.query("UPDATE kingbot_users SET firebase_uid=$1,email_verified=TRUE WHERE id=$2",[fb.uid,byEmail.rows[0].id]);
  return {...byEmail.rows[0],email_verified:true};
 }
 return null;
}
export async function createAuthRouter({pool}){
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
 await pool.query("CREATE TABLE IF NOT EXISTS kingbot_users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),firebase_uid TEXT UNIQUE,first_name TEXT NOT NULL,last_name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,phone TEXT,password_hash TEXT,email_verified BOOLEAN NOT NULL DEFAULT FALSE,phone_verified BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());");
}
