import crypto from "node:crypto";
import { Router } from "express";
import { resolveFirebaseUser } from "./auth.js";

const PLANS = {
  starter: { id:"starter", name:"Starter", priceUsd:100, botLimit:1, bots:["smc-pro"], features:["One bot engine","Core risk controls","Equity tracking"] },
  pro: { id:"pro", name:"Pro Trader Bot", priceUsd:250, botLimit:5, bots:["strategic","flipper","breakout","smc-pro","ladder-flip"], features:["All five bot engines","AI explanations","Advanced risk controls","Drawdown protection"] },
  institutional: { id:"institutional", name:"Institutional OS", priceUsd:1200, botLimit:999, bots:["strategic","flipper","breakout","smc-pro","ladder-flip"], features:["Full bot ecosystem","Trading OS","Advanced intelligence","MT5 integration layer","Kill switch"] }
};
const BOT_NAMES = { strategic:"KINGBOT STRATEGIC", flipper:"KINGBOT FLIPPER", breakout:"KINGBOT BREAKOUT", "smc-pro":"KINGBOT SMC PRO", "ladder-flip":"KINGBOT LADDER FLIP V8" };
const hashToken = token => crypto.createHash("sha256").update(token).digest("hex");
const planId = value => String(value || "").trim().toLowerCase();
const mpesaCode = value => String(value || "").trim().toUpperCase().replace(/\s+/g,"");

async function currentUser(pool, req) {
  return resolveFirebaseUser(pool, req);
}
export async function requireUser(pool, req, res) {
  const u = await currentUser(pool,req);
  if (!u) { res.status(401).json({ok:false,error:"Authentication required."}); return null; }
  if (!u.email_verified) { res.status(403).json({ok:false,error:"Email verification is required."}); return null; }
  return u;
}
async function requireAdmin(pool, req, res) {
  const u = await requireUser(pool,req,res); if (!u) return null;
  const admins = String(process.env.KINGBOT_ADMIN_EMAILS || process.env.ADMIN_EMAIL || "").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
  if (!admins.includes(String(u.email).toLowerCase())) { res.status(403).json({ok:false,error:"Administrator access required."}); return null; }
  return u;
}
export function createSubscriptionRouter({pool}) {
  const router = Router();

  router.get("/plans",(_req,res)=>res.json({ok:true,plans:Object.values(PLANS),mpesaReceiver:process.env.MPESA_RECEIVER_PHONE||"0748275015"}));

  router.get("/me",async(req,res)=>{
    const u=await requireUser(pool,req,res); if(!u)return;
    try {
      const s=await pool.query("SELECT id,plan_id,status,started_at,expires_at,approved_at FROM kingbot_subscriptions WHERE user_id=$1 AND status='active' AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY expires_at DESC NULLS LAST LIMIT 1",[u.id]);
      const e=await pool.query("SELECT bot_id FROM kingbot_bot_entitlements WHERE user_id=$1 AND active=TRUE ORDER BY bot_id",[u.id]);
      const p=await pool.query("SELECT id,plan_id,status,mpesa_code,amount_kes,submitted_at,reviewed_at,reviewer_note FROM kingbot_payments WHERE user_id=$1 ORDER BY submitted_at DESC LIMIT 20",[u.id]);
      res.json({ok:true,subscription:s.rows[0]||null,entitlements:e.rows.map(x=>({botId:x.bot_id,botName:BOT_NAMES[x.bot_id]||x.bot_id})),payments:p.rows});
    } catch(err){console.error("[KINGBOT BILLING]",err?.message||err);res.status(500).json({ok:false,error:"Subscription service unavailable."});}
  });

  router.post("/payments",async(req,res)=>{
    const u=await requireUser(pool,req,res); if(!u)return;
    const p=planId(req.body?.planId), code=mpesaCode(req.body?.mpesaCode), amount=Number(req.body?.amountKes), phone=String(req.body?.payerPhone||"").trim();
    if(!PLANS[p])return res.status(400).json({ok:false,error:"Invalid subscription plan."});
    if(!/^[A-Z0-9]{6,30}$/.test(code))return res.status(400).json({ok:false,error:"Enter a valid M-Pesa transaction code."});
    if(!Number.isFinite(amount)||amount<=0||amount>100000000)return res.status(400).json({ok:false,error:"Enter the exact amount paid in KES."});
    if(phone&&!/^\+?[0-9]{9,15}$/.test(phone.replace(/[\s-]/g,"")))return res.status(400).json({ok:false,error:"Enter a valid payer phone number."});
    try {
      const d=await pool.query("SELECT id FROM kingbot_payments WHERE mpesa_code=$1",[code]);
      if(d.rowCount)return res.status(409).json({ok:false,error:"That M-Pesa transaction code has already been submitted."});
      const q=await pool.query("INSERT INTO kingbot_payments(user_id,plan_id,amount_kes,mpesa_code,payer_phone,status) VALUES($1,$2,$3,$4,$5,'pending') RETURNING id,plan_id,amount_kes,mpesa_code,status,submitted_at",[u.id,p,amount,code,phone||null]);
      await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,'PAYMENT_SUBMITTED',$2::jsonb)",[u.id,JSON.stringify({paymentId:q.rows[0].id,planId:p,mpesaCode:code})]);
      res.status(201).json({ok:true,payment:q.rows[0],message:"Payment submitted for manual verification. Access remains locked until an administrator approves it."});
    } catch(err){console.error("[KINGBOT BILLING]",err?.message||err);res.status(500).json({ok:false,error:"Payment submission failed."});}
  });

  router.get("/access/:botId",async(req,res)=>{
    const u=await requireUser(pool,req,res); if(!u)return;
    const bot=String(req.params.botId||"").trim().toLowerCase();
    if(!BOT_NAMES[bot]) return res.status(404).json({ok:false,error:"Unknown bot engine."});
    const q=await pool.query("SELECT 1 FROM kingbot_bot_entitlements e JOIN kingbot_subscriptions s ON s.id=e.subscription_id WHERE e.user_id=$1 AND e.bot_id=$2 AND e.active=TRUE AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at>NOW()) LIMIT 1",[u.id,bot]);
    res.json({ok:true,botId:bot,botName:BOT_NAMES[bot],allowed:Boolean(q.rowCount)});
  });

  router.get("/admin/payments",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try {
      const q=await pool.query("SELECT p.id,p.user_id,u.first_name,u.last_name,u.email,u.phone,p.plan_id,p.amount_kes,p.mpesa_code,p.payer_phone,p.status,p.submitted_at,p.reviewed_at,p.reviewed_by,p.reviewer_note FROM kingbot_payments p JOIN kingbot_users u ON u.id=p.user_id ORDER BY CASE WHEN p.status='pending' THEN 0 ELSE 1 END,p.submitted_at DESC LIMIT 200");
      res.json({ok:true,payments:q.rows});
    }catch(err){console.error("[KINGBOT ADMIN]",err?.message||err);res.status(500).json({ok:false,error:"Payment queue unavailable."});}
  });

  router.post("/admin/payments/:id/approve",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    const client=await pool.connect();
    try {
      await client.query("BEGIN");
      const q=await client.query("SELECT id,user_id,plan_id,status FROM kingbot_payments WHERE id=$1 FOR UPDATE",[String(req.params.id||"")]);
      if(!q.rowCount){await client.query("ROLLBACK");return res.status(404).json({ok:false,error:"Payment not found."});}
      const p=q.rows[0]; if(p.status!=="pending"){await client.query("ROLLBACK");return res.status(409).json({ok:false,error:"Payment has already been reviewed."});}
      const plan=PLANS[p.plan_id];
      await client.query("UPDATE kingbot_payments SET status='approved',reviewed_at=NOW(),reviewed_by=$1,reviewer_note=$2 WHERE id=$3",[a.email,String(req.body?.note||"").trim().slice(0,500)||null,p.id]);
      await client.query("UPDATE kingbot_subscriptions SET status='superseded' WHERE user_id=$1 AND status='active'",[p.user_id]);
      const s=await client.query("INSERT INTO kingbot_subscriptions(user_id,plan_id,status,started_at,expires_at,approved_at,approved_by,payment_id) VALUES($1,$2,'active',NOW(),NOW()+INTERVAL '30 days',NOW(),$3,$4) RETURNING id,plan_id,status,started_at,expires_at",[p.user_id,p.plan_id,a.email,p.id]);
      await client.query("UPDATE kingbot_bot_entitlements SET active=FALSE WHERE user_id=$1",[p.user_id]);
      for(const bot of plan.bots) await client.query("INSERT INTO kingbot_bot_entitlements(user_id,bot_id,subscription_id,active) VALUES($1,$2,$3,TRUE)",[p.user_id,bot,s.rows[0].id]);
      await client.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,'PAYMENT_APPROVED',$2::jsonb)",[p.user_id,JSON.stringify({paymentId:p.id,subscriptionId:s.rows[0].id,planId:p.plan_id,approvedBy:a.email})]);
      await client.query("COMMIT");
      res.json({ok:true,subscription:s.rows[0],grantedBots:plan.bots.map(x=>BOT_NAMES[x])});
    }catch(err){await client.query("ROLLBACK").catch(()=>{});console.error("[KINGBOT ADMIN]",err?.message||err);res.status(500).json({ok:false,error:"Payment approval failed."});}finally{client.release();}
  });

  router.post("/admin/payments/:id/reject",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    const note=String(req.body?.note||"").trim().slice(0,500);if(!note)return res.status(400).json({ok:false,error:"A rejection note is required."});
    try {
      const q=await pool.query("UPDATE kingbot_payments SET status='rejected',reviewed_at=NOW(),reviewed_by=$1,reviewer_note=$2 WHERE id=$3 AND status='pending' RETURNING id,status,reviewed_at",[a.email,note,String(req.params.id||"")]);
      if(!q.rowCount)return res.status(404).json({ok:false,error:"Pending payment not found."});
      await pool.query("INSERT INTO kingbot_audit_log(event_type,metadata) VALUES('PAYMENT_REJECTED',$1::jsonb)",[JSON.stringify({paymentId:q.rows[0].id,reviewedBy:a.email,note})]);
      res.json({ok:true,payment:q.rows[0]});
    }catch(err){console.error("[KINGBOT ADMIN]",err?.message||err);res.status(500).json({ok:false,error:"Payment rejection failed."});}
  });

  router.get("/admin/entitlements",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    const q=await pool.query("SELECT e.user_id,u.email,e.bot_id,e.active,e.granted_at,s.plan_id,s.status,s.expires_at FROM kingbot_bot_entitlements e JOIN kingbot_users u ON u.id=e.user_id LEFT JOIN kingbot_subscriptions s ON s.id=e.subscription_id ORDER BY e.granted_at DESC LIMIT 300");
    res.json({ok:true,entitlements:q.rows});
  });

  return router;
}
export async function ensureSubscriptionSchema(pool){
  if(!pool)return;
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_payments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE, plan_id TEXT NOT NULL, amount_kes NUMERIC(14,2) NOT NULL, mpesa_code TEXT UNIQUE NOT NULL, payer_phone TEXT, status TEXT NOT NULL DEFAULT 'pending', submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ, reviewed_by TEXT, reviewer_note TEXT)");
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_subscriptions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE, plan_id TEXT NOT NULL, status TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ, approved_at TIMESTAMPTZ, approved_by TEXT, payment_id UUID REFERENCES kingbot_payments(id))");
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_bot_entitlements (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE, bot_id TEXT NOT NULL, subscription_id UUID REFERENCES kingbot_subscriptions(id) ON DELETE CASCADE, active BOOLEAN NOT NULL DEFAULT TRUE, granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id,bot_id,subscription_id))");
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_audit_log (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES kingbot_users(id) ON DELETE SET NULL, event_type TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
}
export function getPlans(){return PLANS;}
export { BOT_NAMES };
