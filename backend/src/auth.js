import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";

const router = Router();

async function sendEmail({to,subject,text,html=""}){
  const apiKey=String(process.env.RESEND_API_KEY||"").trim();
  const from=String(process.env.MAIL_FROM||"").trim();
  if(!apiKey||!from) throw new Error("EMAIL_API_NOT_CONFIGURED");
  const response=await fetch("https://api.resend.com/emails",{
    method:"POST",
    headers:{"Authorization":"Bearer "+apiKey,"Content-Type":"application/json"},
    body:JSON.stringify({from,to,subject,text,html})
  });
  if(!response.ok) throw new Error("EMAIL_API_SEND_FAILED");
  return response.json().catch(()=>({}));
}
function verificationCode(){ return String(crypto.randomInt(100000,1000000)); }

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function newToken() {
  return crypto.randomBytes(48).toString("base64url");
}
function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
function validPhone(value) {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

export function createAuthRouter({ pool, sessionTtlHours = 24, limiter }) {
  if (limiter) router.use(limiter);

  router.post("/signup", async (req, res) => {
    if (!pool) return res.status(503).json({ ok:false, error:"Account service is not configured on the server yet." });

    const firstName=String(req.body?.firstName||"").trim();
    const lastName=String(req.body?.lastName||"").trim();
    const email=String(req.body?.email||"").trim().toLowerCase();
    const phone=String(req.body?.phone||"").trim();
    const password=String(req.body?.password||"");

    if (!firstName || !lastName || firstName.length>80 || lastName.length>80 ||
        !validEmail(email) || !validPhone(phone) || password.length<8 || password.length>128) {
      return res.status(400).json({ok:false,error:"Please provide valid registration details."});
    }

    try {
      const exists=await pool.query("SELECT id FROM kingbot_users WHERE email=$1",[email]);
      if (exists.rowCount) return res.status(409).json({ok:false,error:"An account with this email already exists."});

      const passwordHash=await bcrypt.hash(password,12);
      const user=await pool.query(
        "INSERT INTO kingbot_users (first_name,last_name,email,phone,password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id,email,first_name,last_name",
        [firstName,lastName,email,phone,passwordHash]
      );

      const token=newToken();
      await pool.query(
        "INSERT INTO kingbot_sessions (token_hash,user_id,expires_at) VALUES ($1,$2,NOW()+make_interval(hours => $3))",
        [hashToken(token),user.rows[0].id,sessionTtlHours]
      );

      try { await issueVerification(pool,user.rows[0].id,user.rows[0].email,user.rows[0].first_name); } catch(mailError) {
        console.error("[KINGBOT AUTH] verification email failed:",mailError?.message||mailError);
        await pool.query("DELETE FROM kingbot_sessions WHERE user_id=$1",[user.rows[0].id]).catch(()=>{});
        await pool.query("DELETE FROM kingbot_users WHERE id=$1",[user.rows[0].id]).catch(()=>{});
        return res.status(503).json({ok:false,error:"We could not send your verification email. Your signup was not completed. Please try again or contact support."});
      }
      res.cookie("kingbot_session",token,{httpOnly:true,secure:true,sameSite:"none",maxAge:sessionTtlHours*3600000});
      return res.status(201).json({
        ok:true,
        user:{id:user.rows[0].id,email:user.rows[0].email,name:`${user.rows[0].first_name} ${user.rows[0].last_name}`},
        verificationRequired:true
      });
    } catch (error) {
      console.error("[KINGBOT AUTH] signup failed:",error?.message||error);
      return res.status(500).json({ok:false,error:"Account creation failed. Please try again."});
    }
  });


  router.post("/signin", async (req,res) => {
    if (!pool) return res.status(503).json({ok:false,error:"Account service is not configured on the server yet."});
    const email=String(req.body?.email||"").trim().toLowerCase();
    const password=String(req.body?.password||"");
    if(!validEmail(email)||!password) return res.status(400).json({ok:false,error:"Enter a valid email and password."});
    try {
      const q=await pool.query("SELECT id,email,first_name,last_name,password_hash,email_verified,phone_verified FROM kingbot_users WHERE email=$1",[email]);
      if(!q.rowCount || !(await bcrypt.compare(password,q.rows[0].password_hash))) return res.status(401).json({ok:false,error:"Invalid email or password."});
      const u=q.rows[0];
      if(!u.email_verified) await issueVerification(pool,u.id,u.email,u.first_name);
      const token=newToken();
      await pool.query("DELETE FROM kingbot_sessions WHERE user_id=$1",[u.id]);
      await pool.query("INSERT INTO kingbot_sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+make_interval(hours => $3))",[hashToken(token),u.id,sessionTtlHours]);
      res.cookie("kingbot_session",token,{httpOnly:true,secure:true,sameSite:"none",maxAge:sessionTtlHours*3600000});
      return res.json({ok:true,emailVerified:u.email_verified,phoneVerified:u.phone_verified,user:{id:u.id,email:u.email,name:`${u.first_name} ${u.last_name}`,verified:u.email_verified}});
    } catch(error){ console.error("[KINGBOT AUTH] signin failed:",error?.message||error); return res.status(500).json({ok:false,error:"Authentication service unavailable."}); }
  });

  router.post("/verify", async (req,res) => {
    if(!pool) return res.status(503).json({ok:false,error:"Account service is not configured."});
    const email=String(req.body?.email||"").trim().toLowerCase(), code=String(req.body?.code||"").trim();
    if(!validEmail(email)||!/^\d{6}$/.test(code)) return res.status(400).json({ok:false,error:"Enter the six-digit verification code."});
    try {
      const q=await pool.query("SELECT u.id,u.email,u.first_name,u.last_name,v.code_hash,v.expires_at FROM kingbot_users u JOIN kingbot_verification_codes v ON v.user_id=u.id WHERE u.email=$1 ORDER BY v.expires_at DESC LIMIT 1",[email]);
      if(!q.rowCount || new Date(q.rows[0].expires_at)<new Date() || !crypto.timingSafeEqual(Buffer.from(q.rows[0].code_hash,"hex"),Buffer.from(crypto.createHash("sha256").update(code).digest("hex")))) return res.status(400).json({ok:false,error:"Invalid or expired verification code."});
      await pool.query("UPDATE kingbot_users SET email_verified=TRUE WHERE id=$1",[q.rows[0].id]);
      await pool.query("DELETE FROM kingbot_verification_codes WHERE user_id=$1",[q.rows[0].id]);
      return res.json({ok:true,verified:true});
    } catch(error){ console.error("[KINGBOT AUTH] verification failed:",error?.message||error); return res.status(500).json({ok:false,error:"Verification service unavailable."}); }
  });

  router.post("/forgot-password", async (req,res) => {
    if(!pool) return res.status(503).json({ok:false,error:"Account service is not configured."});
    const email=String(req.body?.email||"").trim().toLowerCase();
    if(!validEmail(email)) return res.status(400).json({ok:false,error:"Enter a valid email address."});
    try {
      const q=await pool.query("SELECT id,email,first_name FROM kingbot_users WHERE email=$1",[email]);
      if(!q.rowCount) return res.json({ok:true,sent:true});
      const token=newToken(); const hash=hashToken(token);
      await pool.query("DELETE FROM kingbot_password_resets WHERE user_id=$1",[q.rows[0].id]);
      await pool.query("INSERT INTO kingbot_password_resets(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 minutes')",[q.rows[0].id,hash]);
      const base=(process.env.FRONTEND_ORIGIN||"").replace(/\\/$/,"");
      const link=base+"/reset-password.html?token="+encodeURIComponent(token)+"&email="+encodeURIComponent(email);
      await sendEmail({to:email,subject:"KINGBOT FINTECH — Password reset",text:`Hello ${q.rows[0].first_name}, use this link to reset your KINGBOT password: ${link}. It expires in 30 minutes.`});
      return res.json({ok:true,sent:true});
    } catch(error){ console.error("[KINGBOT AUTH] password reset request failed:",error?.message||error); return res.status(500).json({ok:false,error:"Password recovery service unavailable."}); }
  });

  router.post("/reset-password", async (req,res) => {
    if(!pool) return res.status(503).json({ok:false,error:"Account service is not configured."});
    const token=String(req.body?.token||""), email=String(req.body?.email||"").trim().toLowerCase(), password=String(req.body?.password||"");
    if(!token||!validEmail(email)||password.length<8||password.length>128) return res.status(400).json({ok:false,error:"Invalid reset request."});
    try {
      const q=await pool.query("SELECT u.id,r.token_hash,r.expires_at FROM kingbot_password_resets r JOIN kingbot_users u ON u.id=r.user_id WHERE u.email=$1 AND r.token_hash=$2",[email,hashToken(token)]);
      if(!q.rowCount||new Date(q.rows[0].expires_at)<new Date()) return res.status(400).json({ok:false,error:"Reset link is invalid or expired."});
      const passwordHash=await bcrypt.hash(password,12);
      await pool.query("UPDATE kingbot_users SET password_hash=$1 WHERE id=$2",[passwordHash,q.rows[0].id]);
      await pool.query("DELETE FROM kingbot_password_resets WHERE user_id=$1",[q.rows[0].id]);
      await pool.query("DELETE FROM kingbot_sessions WHERE user_id=$1",[q.rows[0].id]);
      return res.json({ok:true,reset:true});
    } catch(error){ console.error("[KINGBOT AUTH] password reset failed:",error?.message||error); return res.status(500).json({ok:false,error:"Password reset service unavailable."}); }
  });

  router.post("/resend-verification", async (req,res) => {
    if(!pool) return res.status(503).json({ok:false,error:"Account service is not configured."});
    const email=String(req.body?.email||"").trim().toLowerCase();
    if(!validEmail(email)) return res.status(400).json({ok:false,error:"Enter a valid email address."});
    try { const q=await pool.query("SELECT id,email,first_name,email_verified FROM kingbot_users WHERE email=$1",[email]); if(!q.rowCount) return res.status(404).json({ok:false,error:"Account not found."}); if(q.rows[0].email_verified) return res.json({ok:true,verified:true}); await issueVerification(pool,q.rows[0].id,q.rows[0].email,q.rows[0].first_name); return res.json({ok:true,sent:true}); }
    catch(error){ console.error("[KINGBOT AUTH] resend failed:",error?.message||error); return res.status(500).json({ok:false,error:"Verification email could not be sent."}); }
  });

  router.get("/session", async (req,res) => {
    if (!pool) return res.status(503).json({ok:false,error:"Account service is not configured."});
    const token=req.cookies?.kingbot_session;
    if(!token) return res.status(401).json({ok:false});
    try {
      const q=await pool.query(
        "SELECT u.id,u.email,u.first_name,u.last_name,u.email_verified,u.phone_verified FROM kingbot_sessions s JOIN kingbot_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()",
        [hashToken(token)]
      );
      if(!q.rowCount) return res.status(401).json({ok:false});
      const u=q.rows[0];
      return res.json({ok:true,authenticated:true,user:{id:u.id,email:u.email,name:`${u.first_name} ${u.last_name}`,emailVerified:u.email_verified,phoneVerified:u.phone_verified,verified:u.email_verified}});
    } catch(error) {
      console.error("[KINGBOT AUTH] session check failed:",error?.message||error);
      return res.status(500).json({ok:false,error:"Session service unavailable."});
    }
  });

  router.post("/logout", async (req,res) => {
    const token=req.cookies?.kingbot_session;
    if(pool && token) await pool.query("DELETE FROM kingbot_sessions WHERE token_hash=$1",[hashToken(token)]).catch(()=>{});
    res.clearCookie("kingbot_session",{httpOnly:true,secure:true,sameSite:"none"});
    return res.json({ok:true});
  });

  return router;
}

async function issueVerification(pool,userId,email,firstName){

  const code=verificationCode();
  const hash=crypto.createHash("sha256").update(code).digest("hex");
  await pool.query("DELETE FROM kingbot_verification_codes WHERE user_id=$1",[userId]);
  await pool.query("INSERT INTO kingbot_verification_codes(user_id,code_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '15 minutes')",[userId,hash]);
  await sendEmail({to:email,subject:"KINGBOT FINTECH — Verify your account",text:`Hello ${firstName}, your KINGBOT verification code is ${code}. It expires in 15 minutes. If you did not create this account, ignore this email.`});
}

export async function ensureAuthSchema(pool) {
  if (!pool) return;
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_verification_codes (user_id UUID PRIMARY KEY REFERENCES kingbot_users(id) ON DELETE CASCADE, code_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_password_resets (user_id UUID PRIMARY KEY REFERENCES kingbot_users(id) ON DELETE CASCADE, token_hash TEXT UNIQUE NOT NULL, expires_at TIMESTAMPTZ NOT NULL);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  );`);
}
