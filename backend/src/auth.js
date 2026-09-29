import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";

const router = Router();

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

      res.cookie("kingbot_session",token,{httpOnly:true,secure:true,sameSite:"lax",maxAge:sessionTtlHours*3600000});
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
      return res.json({ok:true,authenticated:true,user:{id:u.id,email:u.email,name:`${u.first_name} ${u.last_name}`,emailVerified:u.email_verified,phoneVerified:u.phone_verified}});
    } catch(error) {
      console.error("[KINGBOT AUTH] session check failed:",error?.message||error);
      return res.status(500).json({ok:false,error:"Session service unavailable."});
    }
  });

  router.post("/logout", async (req,res) => {
    const token=req.cookies?.kingbot_session;
    if(pool && token) await pool.query("DELETE FROM kingbot_sessions WHERE token_hash=$1",[hashToken(token)]).catch(()=>{});
    res.clearCookie("kingbot_session",{httpOnly:true,secure:true,sameSite:"lax"});
    return res.json({ok:true});
  });

  return router;
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
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  );`);
}
