import crypto from "node:crypto";
import { Router } from "express";
import { resolveFirebaseUser } from "./auth.js";
import { isAdminEmail } from "./admin-access.js";

const PLANS = {
  starter: { id:"starter", name:"Basic", priceUsd:130, billing:"monthly", botLimit:1, selectableBots:["strategic","breakout"], bots:["strategic","breakout"], requiresBotSelection:true, features:["Choose 1 of 2 entry bots","Strategic or Breakout","Core risk controls","Equity tracking"] },
  pro: { id:"pro", name:"Professional", priceUsd:465, billing:"monthly", botLimit:3, selectableBots:[], bots:["strategic","breakout","smc-pro"], requiresBotSelection:false, features:["3 of 5 bot engines","Strategic + Breakout","SMC PRO","Advanced analytics","AI intelligence","Advanced risk controls"] },
  institutional: { id:"institutional", name:"Institutional", priceUsd:800, billing:"monthly", botLimit:5, selectableBots:[], bots:["strategic","breakout","smc-pro","flipper","ladder-flip"], requiresBotSelection:false, features:["All 5 bot engines","Full trading OS","Advanced intelligence","MT5 integration layer","Kill switch"] }
};
const BOT_NAMES = { strategic:"KINGBOT STRATEGIC", flipper:"KINGBOT FLIPPER", breakout:"KINGBOT BREAKOUT", "smc-pro":"KINGBOT SMC PRO", "ladder-flip":"KINGBOT LADDER FLIP V8" };
const hashToken = token => crypto.createHash("sha256").update(token).digest("hex");
const planId = value => String(value || "").trim().toLowerCase();
const mpesaCode = value => String(value || "").trim().toUpperCase().replace(/\s+/g,"");
const normalizeBotId = value => String(value || "").trim().toLowerCase();

function resolvePlanBots(plan, selectedBotId){
  if(plan?.id==="starter"){
    const selected=normalizeBotId(selectedBotId);
    return plan.selectableBots.includes(selected) ? [selected] : [];
  }
  return plan ? [...plan.bots] : [];
}

export async function expireStaleSubscriptions(pool){
  if(!pool)return {expired:0};
  const expired=await pool.query("UPDATE kingbot_subscriptions SET status='expired' WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=NOW() RETURNING id,user_id,plan_id,expires_at");
  if(expired.rowCount){
    const ids=expired.rows.map(row=>row.id);
    await pool.query("UPDATE kingbot_bot_entitlements SET active=FALSE WHERE subscription_id=ANY($1::uuid[])",[ids]);
    for(const row of expired.rows){
      await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,'SUBSCRIPTION_EXPIRED',$2::jsonb)",[row.user_id,JSON.stringify({subscriptionId:row.id,planId:row.plan_id,expiredAt:row.expires_at})]);
    }
  }
  return {expired:expired.rowCount};
}

async function currentUser(pool, req) {
  return resolveFirebaseUser(pool, req);
}
export async function requireUser(pool, req, res) {
  const u = await currentUser(pool,req);
  if (!u) { res.status(401).json({ok:false,error:"Authentication required."}); return null; }
  if (!u.email_verified) { res.status(403).json({ok:false,error:"Email verification is required."}); return null; }
  if (u.admin_blocked) { res.status(403).json({ok:false,error:"This account has been disabled by KINGBOT administration."}); return null; }
  return u;
}
async function requireAdmin(pool, req, res) {
  const u = await requireUser(pool,req,res); if (!u) return null;
  if (!isAdminEmail(u.email)) { res.status(403).json({ok:false,error:"Administrator access required."}); return null; }
  return u;
}
export function createSubscriptionRouter({pool,broker}) {
  const router = Router();

  router.get("/plans",(_req,res)=>res.json({ok:true,plans:Object.values(PLANS).map(p=>({...p,selectableBotDetails:p.selectableBots.map(bot=>({botId:bot,botName:BOT_NAMES[bot]}))})),mpesaReceiver:process.env.MPESA_RECEIVER_PHONE||"0748275015"}));

  router.get("/me",async(req,res)=>{
    const u=await requireUser(pool,req,res); if(!u)return;
    try {
      await expireStaleSubscriptions(pool);
      const s=await pool.query("SELECT id,plan_id,status,started_at,expires_at,approved_at FROM kingbot_subscriptions WHERE user_id=$1 AND status='active' AND expires_at>NOW() ORDER BY expires_at DESC LIMIT 1",[u.id]);
      const e=await pool.query("SELECT e.bot_id FROM kingbot_bot_entitlements e JOIN kingbot_subscriptions s ON s.id=e.subscription_id WHERE e.user_id=$1 AND e.active=TRUE AND s.status='active' AND s.expires_at>NOW() ORDER BY e.bot_id",[u.id]);
      const p=await pool.query("SELECT id,plan_id,status,mpesa_code,amount_kes,payer_phone,payer_name,submitted_at,reviewed_at,reviewer_note,selected_bot_id FROM kingbot_payments WHERE user_id=$1 ORDER BY submitted_at DESC LIMIT 20",[u.id]);
      res.json({
        ok:true,
        isAdmin:isAdminEmail(u.email),
        subscription:s.rows[0]||null,
        entitlements:e.rows.map(x=>({botId:x.bot_id,botName:BOT_NAMES[x.bot_id]||x.bot_id})),
        payments:p.rows,
        latestPayment:p.rows[0]||null,
        accessState:p.rows[0]?.status==="approved" ? "approved" : p.rows[0]?.status==="rejected" ? "denied" : p.rows[0]?.status==="pending" ? "waiting" : (s.rows[0] ? "approved" : "waiting")
      });
    } catch(err){console.error("[KINGBOT BILLING]",err?.message||err);res.status(500).json({ok:false,error:"Subscription service unavailable."});}
  });

  router.post("/payments",async(req,res)=>{
    const u=await requireUser(pool,req,res); if(!u)return;
    const p=planId(req.body?.planId), code=mpesaCode(req.body?.mpesaCode), amount=Number(req.body?.amountKes), phone=String(req.body?.payerPhone||"").trim(), payerName=String(req.body?.payerName||"").trim().replace(/\s+/g," "), selectedBot=normalizeBotId(req.body?.selectedBotId);
    if(!PLANS[p])return res.status(400).json({ok:false,error:"Invalid subscription plan."});
    if(PLANS[p].requiresBotSelection && !PLANS[p].selectableBots.includes(selectedBot))return res.status(400).json({ok:false,error:"Basic requires selecting either Strategic or Breakout."});
    if(!PLANS[p].requiresBotSelection && selectedBot && !PLANS[p].bots.includes(selectedBot))return res.status(400).json({ok:false,error:"The selected bot is not included in this plan."});
    if(!/^[A-Z0-9]{6,30}$/.test(code))return res.status(400).json({ok:false,error:"Enter a valid M-Pesa transaction code."});
    if(!Number.isFinite(amount)||amount<=0||amount>100000000)return res.status(400).json({ok:false,error:"Enter the exact amount paid in KES."});
    if(!phone||!/^\+?[0-9]{9,15}$/.test(phone.replace(/[\s-]/g,"")))return res.status(400).json({ok:false,error:"Enter the M-Pesa phone number used for payment."});
    if(!payerName||payerName.length<2)return res.status(400).json({ok:false,error:"Enter the M-Pesa account name used for payment."});
    if(payerName.length>120)return res.status(400).json({ok:false,error:"M-Pesa account name is too long."});
    try {
      const d=await pool.query("SELECT id,status FROM kingbot_payments WHERE mpesa_code=$1",[code]);
      if(d.rowCount){
        const state=String(d.rows[0].status||"submitted").toLowerCase();
        const message=state==="approved"
          ? "FAILED: This M-Pesa transaction code has already been verified and cannot be reused."
          : "FAILED: This M-Pesa transaction code has already been submitted and cannot be reused.";
        return res.status(409).json({ok:false,code:"MPESA_CODE_REUSED",error:message});
      }
      const q=await pool.query("INSERT INTO kingbot_payments(user_id,plan_id,amount_kes,mpesa_code,payer_phone,payer_name,selected_bot_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id,plan_id,amount_kes,mpesa_code,payer_phone,payer_name,status,submitted_at",[u.id,p,amount,code,phone,payerName,selectedBot||null]);
      await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,'PAYMENT_SUBMITTED',$2::jsonb)",[u.id,JSON.stringify({paymentId:q.rows[0].id,planId:p,mpesaCode:code,selectedBotId:selectedBot||null})]);
      res.status(201).json({ok:true,payment:q.rows[0],message:"Payment submitted for manual verification. Access remains locked until an administrator approves it."});
    } catch(err){
      if(err?.code==="23505" && String(err?.constraint||"").toLowerCase().includes("mpesa")){
        return res.status(409).json({
          ok:false,
          code:"MPESA_CODE_REUSED",
          error:"FAILED: This M-Pesa transaction code has already been used and cannot be reused."
        });
      }
      console.error("[KINGBOT BILLING]",err?.message||err);
      res.status(500).json({ok:false,error:"Payment submission failed."});
    }
  });

  router.get("/access/:botId",async(req,res)=>{
    const u=await requireUser(pool,req,res); if(!u)return;
    const bot=String(req.params.botId||"").trim().toLowerCase();
    if(!BOT_NAMES[bot]) return res.status(404).json({ok:false,error:"Unknown bot engine."});
    const allowed=isAdminEmail(u.email) ? true : Boolean((await pool.query("SELECT 1 FROM kingbot_bot_entitlements e JOIN kingbot_subscriptions s ON s.id=e.subscription_id WHERE e.user_id=$1 AND e.bot_id=$2 AND e.active=TRUE AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at>NOW()) LIMIT 1",[u.id,bot])).rowCount);
    res.json({ok:true,isAdmin:isAdminEmail(u.email),botId:bot,botName:BOT_NAMES[bot],allowed});
  });

  router.get("/admin/payments",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try {
      const q=await pool.query("SELECT p.id,p.user_id,u.first_name,u.last_name,u.email,u.phone,p.plan_id,p.amount_kes,p.mpesa_code,p.payer_phone,p.payer_name,p.selected_bot_id,p.status,p.submitted_at,p.reviewed_at,p.reviewed_by,p.reviewer_note FROM kingbot_payments p JOIN kingbot_users u ON u.id=p.user_id ORDER BY CASE WHEN p.status='pending' THEN 0 ELSE 1 END,p.submitted_at DESC LIMIT 200");
      res.json({ok:true,payments:q.rows});
    }catch(err){console.error("[KINGBOT ADMIN]",err?.message||err);res.status(500).json({ok:false,error:"Payment queue unavailable."});}
  });

  router.post("/admin/payments/:id/approve",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    const client=await pool.connect();
    try {
      await client.query("BEGIN");
      const q=await client.query("SELECT id,user_id,plan_id,selected_bot_id,status FROM kingbot_payments WHERE id=$1 FOR UPDATE",[String(req.params.id||"")]);
      if(!q.rowCount){await client.query("ROLLBACK");return res.status(404).json({ok:false,error:"Payment not found."});}
      const p=q.rows[0]; if(p.status!=="pending"){await client.query("ROLLBACK");return res.status(409).json({ok:false,error:"Payment has already been reviewed."});}
      const plan=PLANS[p.plan_id];
      if(!plan){await client.query("ROLLBACK");return res.status(400).json({ok:false,error:"Payment references an invalid subscription plan."});}
      const grantedBots=resolvePlanBots(plan,p.selected_bot_id);
      if(!grantedBots.length){await client.query("ROLLBACK");return res.status(409).json({ok:false,error:"Basic plan requires a valid Strategic or Breakout bot selection."});}
      await client.query("UPDATE kingbot_payments SET status='approved',reviewed_at=NOW(),reviewed_by=$1,reviewer_note=$2 WHERE id=$3",[a.email,String(req.body?.note||"").trim().slice(0,500)||null,p.id]);
      await client.query("UPDATE kingbot_subscriptions SET status='superseded' WHERE user_id=$1 AND status='active'",[p.user_id]);
      const s=await client.query("INSERT INTO kingbot_subscriptions(user_id,plan_id,status,started_at,expires_at,approved_at,approved_by,payment_id) VALUES($1,$2,'active',NOW(),NOW()+INTERVAL '1 month',NOW(),$3,$4) RETURNING id,plan_id,status,started_at,expires_at",[p.user_id,p.plan_id,a.email,p.id]);
      await client.query("UPDATE kingbot_bot_entitlements SET active=FALSE WHERE user_id=$1",[p.user_id]);
      for(const bot of grantedBots) await client.query("INSERT INTO kingbot_bot_entitlements(user_id,bot_id,subscription_id,active) VALUES($1,$2,$3,TRUE)",[p.user_id,bot,s.rows[0].id]);
      await client.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,'PAYMENT_APPROVED',$2::jsonb)",[p.user_id,JSON.stringify({paymentId:p.id,subscriptionId:s.rows[0].id,planId:p.plan_id,selectedBotId:p.selected_bot_id||null,grantedBots,approvedBy:a.email})]);
      await client.query("COMMIT");
      res.json({ok:true,subscription:s.rows[0],grantedBots:grantedBots.map(x=>BOT_NAMES[x])});
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
  router.get("/admin/overview",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try{
      await expireStaleSubscriptions(pool);
      const [users,verified,active,pending,approved,rejected,running,revenue]=await Promise.all([
        pool.query("SELECT COUNT(*)::int AS count FROM kingbot_users"),
        pool.query("SELECT COUNT(*)::int AS count FROM kingbot_users WHERE email_verified=TRUE"),
        pool.query("SELECT COUNT(*)::int AS count FROM kingbot_subscriptions WHERE status='active' AND expires_at>NOW()"),
        pool.query("SELECT COUNT(*)::int AS count FROM kingbot_payments WHERE status='pending'"),
        pool.query("SELECT COUNT(*)::int AS count FROM kingbot_payments WHERE status='approved'"),
        pool.query("SELECT COUNT(*)::int AS count FROM kingbot_payments WHERE status='rejected'"),
        pool.query("SELECT COUNT(*)::int AS count FROM kingbot_bot_runtime WHERE state='RUNNING'"),
        pool.query("SELECT COALESCE(SUM(amount_kes),0)::numeric(14,2) AS total FROM kingbot_payments WHERE status='approved'")
      ]);
      res.json({ok:true,adminEmail:a.email,metrics:{
        totalUsers:users.rows[0].count,verifiedUsers:verified.rows[0].count,activeSubscriptions:active.rows[0].count,
        pendingPayments:pending.rows[0].count,approvedPayments:approved.rows[0].count,rejectedPayments:rejected.rows[0].count,
        runningBots:running.rows[0].count,approvedRevenueKes:Number(revenue.rows[0].total)
      }});
    }catch(error){console.error("[KINGBOT ADMIN OVERVIEW]",error?.message||error);res.status(500).json({ok:false,error:"Admin overview unavailable."});}
  });

  router.get("/admin/users",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try{
      await expireStaleSubscriptions(pool);
      const q=await pool.query(`
        SELECT u.id,u.first_name,u.last_name,u.email,u.phone,u.email_verified,u.phone_verified,u.admin_blocked,u.created_at,
               s.plan_id,s.status AS subscription_status,s.started_at,s.expires_at,
               COALESCE((SELECT json_agg(json_build_object('botId',e.bot_id,'active',e.active) ORDER BY e.bot_id)
                         FROM kingbot_bot_entitlements e
                         WHERE e.user_id=u.id AND e.subscription_id=s.id),'[]'::json) AS entitlements,
               lp.status AS latest_payment_status,lp.plan_id AS latest_payment_plan,lp.amount_kes AS latest_payment_amount,
               lp.mpesa_code AS latest_mpesa_code,lp.submitted_at AS latest_payment_at,lp.reviewer_note AS latest_payment_note
        FROM kingbot_users u
        LEFT JOIN LATERAL (
          SELECT * FROM kingbot_subscriptions s1
          WHERE s1.user_id=u.id
          ORDER BY CASE WHEN s1.status='active' AND s1.expires_at>NOW() THEN 0 ELSE 1 END,s1.started_at DESC
          LIMIT 1
        ) s ON TRUE
        LEFT JOIN LATERAL (
          SELECT status,plan_id,amount_kes,mpesa_code,submitted_at,reviewer_note
          FROM kingbot_payments p1 WHERE p1.user_id=u.id
          ORDER BY submitted_at DESC LIMIT 1
        ) lp ON TRUE
        ORDER BY u.created_at DESC
        LIMIT 500
      `);
      res.json({ok:true,users:q.rows});
    }catch(error){console.error("[KINGBOT ADMIN USERS]",error?.message||error);res.status(500).json({ok:false,error:"User registry unavailable."});}
  });

  router.post("/admin/users/:id/status",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    const userId=String(req.params.id||""),blocked=Boolean(req.body?.blocked);
    try{
      const target=await pool.query("SELECT id,email FROM kingbot_users WHERE id=$1",[userId]);
      if(!target.rowCount)return res.status(404).json({ok:false,error:"User not found."});
      if(String(target.rows[0].email).toLowerCase()===String(a.email).toLowerCase() && blocked)return res.status(400).json({ok:false,error:"You cannot disable the currently signed-in administrator account."});
      const q=await pool.query("UPDATE kingbot_users SET admin_blocked=$2 WHERE id=$1 RETURNING id,email,admin_blocked",[userId,blocked]);
      if(blocked)await pool.query("UPDATE kingbot_bot_runtime SET state='STOPPED',last_error='ADMIN_ACCOUNT_DISABLED',updated_at=NOW() WHERE user_id=$1 AND state='RUNNING'",[userId]);
      await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,$2,$3::jsonb)",[userId,blocked?"ADMIN_USER_DISABLED":"ADMIN_USER_ENABLED",JSON.stringify({admin:a.email,targetEmail:q.rows[0].email,blocked})]);
      res.json({ok:true,user:q.rows[0],message:blocked?"User access disabled.":"User access restored."});
    }catch(error){console.error("[KINGBOT ADMIN USER STATUS]",error?.message||error);res.status(500).json({ok:false,error:"User access update failed."});}
  });

  router.post("/admin/users/:id/grant-bot",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    const userId=String(req.params.id||""),bot=normalizeBotId(req.body?.botId);
    if(!BOT_NAMES[bot])return res.status(400).json({ok:false,error:"Unknown bot engine."});
    try{
      const s=await pool.query("SELECT id FROM kingbot_subscriptions WHERE user_id=$1 AND status='active' AND expires_at>NOW() ORDER BY expires_at DESC LIMIT 1",[userId]);
      if(!s.rowCount)return res.status(409).json({ok:false,error:"User has no active subscription."});
      await pool.query("INSERT INTO kingbot_bot_entitlements(user_id,bot_id,subscription_id,active) VALUES($1,$2,$3,TRUE) ON CONFLICT(user_id,bot_id,subscription_id) DO UPDATE SET active=TRUE",[userId,bot,s.rows[0].id]);
      await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,'ADMIN_BOT_GRANTED',$2::jsonb)",[userId,JSON.stringify({admin:a.email,botId:bot,subscriptionId:s.rows[0].id})]);
      res.json({ok:true,botId:bot,botName:BOT_NAMES[bot]});
    }catch(error){console.error("[KINGBOT ADMIN GRANT BOT]",error?.message||error);res.status(500).json({ok:false,error:"Bot grant failed."});}
  });

  router.post("/admin/users/:id/revoke-bot",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    const userId=String(req.params.id||""),bot=normalizeBotId(req.body?.botId);
    if(!BOT_NAMES[bot])return res.status(400).json({ok:false,error:"Unknown bot engine."});
    try{
      const q=await pool.query("UPDATE kingbot_bot_entitlements e SET active=FALSE FROM kingbot_subscriptions s WHERE e.subscription_id=s.id AND e.user_id=$1 AND e.bot_id=$2 AND s.status='active' RETURNING e.bot_id",[userId,bot]);
      if(!q.rowCount)return res.status(404).json({ok:false,error:"Active bot entitlement not found."});
      await pool.query("UPDATE kingbot_bot_runtime SET state='STOPPED',last_error='ADMIN_BOT_ACCESS_REVOKED',updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[userId,bot]);
      await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,'ADMIN_BOT_REVOKED',$2::jsonb)",[userId,JSON.stringify({admin:a.email,botId:bot})]);
      res.json({ok:true,botId:bot,botName:BOT_NAMES[bot]});
    }catch(error){console.error("[KINGBOT ADMIN REVOKE BOT]",error?.message||error);res.status(500).json({ok:false,error:"Bot revoke failed."});}
  });

  router.get("/admin/activity",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try{
      const q=await pool.query(`SELECT l.id,l.event_type,l.metadata,l.created_at,u.email FROM kingbot_audit_log l LEFT JOIN kingbot_users u ON u.id=l.user_id ORDER BY l.created_at DESC LIMIT 250`);
      res.json({ok:true,activity:q.rows});
    }catch(error){console.error("[KINGBOT ADMIN ACTIVITY]",error?.message||error);res.status(500).json({ok:false,error:"Activity stream unavailable."});}
  });


  router.get("/admin/runtime",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try{
      const q=await pool.query(`
        SELECT r.user_id,u.first_name,u.last_name,u.email,
               r.bot_id,r.state,r.symbol,r.timeframe,r.last_signal,r.last_run_at,r.last_error,r.updated_at,
               COALESCE(s.plan_id,'') AS plan_id,
               COALESCE(rs.execution_mode,'PAPER') AS execution_mode,
               COALESCE(rs.kill_switch,FALSE) AS kill_switch,
               COALESCE(rs.max_risk_per_trade_pct,0) AS max_risk_per_trade_pct,
               COALESCE(rs.daily_drawdown_pct,5) AS daily_drawdown_pct,
               COALESCE(rs.total_drawdown_pct,10) AS total_drawdown_pct
        FROM kingbot_bot_runtime r
        JOIN kingbot_users u ON u.id=r.user_id
        LEFT JOIN LATERAL (
          SELECT plan_id FROM kingbot_subscriptions s1
          WHERE s1.user_id=r.user_id
          ORDER BY CASE WHEN s1.status='active' AND (s1.expires_at IS NULL OR s1.expires_at>NOW()) THEN 0 ELSE 1 END,s1.started_at DESC
          LIMIT 1
        ) s ON TRUE
        LEFT JOIN kingbot_bot_risk_settings rs ON rs.user_id=r.user_id AND rs.bot_id=r.bot_id
        ORDER BY CASE WHEN r.state='RUNNING' THEN 0 WHEN r.state='ERROR' THEN 1 ELSE 2 END,r.updated_at DESC
        LIMIT 500
      `);
      res.json({ok:true,runtimes:q.rows});
    }catch(error){
      console.error("[KINGBOT ADMIN RUNTIME]",error?.message||error);
      res.status(500).json({ok:false,error:"Runtime registry unavailable."});
    }
  });

  router.get("/admin/risk",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try{
      const q=await pool.query(`
        SELECT r.user_id,u.first_name,u.last_name,u.email,r.bot_id,
               r.daily_drawdown_pct,r.total_drawdown_pct,r.max_risk_per_trade_pct,r.max_positions,
               r.max_spread_atr_ratio,r.stale_data_ms,r.max_consecutive_losses,
               r.auto_pause_on_loss_streak,r.execution_mode,r.kill_switch,r.updated_at
        FROM kingbot_bot_risk_settings r
        JOIN kingbot_users u ON u.id=r.user_id
        ORDER BY r.updated_at DESC
        LIMIT 500
      `);
      res.json({ok:true,risk:q.rows});
    }catch(error){
      console.error("[KINGBOT ADMIN RISK]",error?.message||error);
      res.status(500).json({ok:false,error:"Risk registry unavailable."});
    }
  });

  router.get("/admin/brokers",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try{
      const q=await pool.query(`
        SELECT b.id,b.user_id,u.first_name,u.last_name,u.email,
               b.provider,b.account_id,b.execution_mode,b.enabled,b.created_at,b.updated_at
        FROM kingbot_broker_accounts b
        JOIN kingbot_users u ON u.id=b.user_id
        ORDER BY b.updated_at DESC
        LIMIT 500
      `);
      const accounts=await Promise.all(q.rows.map(async(row)=>{
        let status={configured:true,connected:false,broker:row.provider,accountId:row.account_id,executionMode:row.execution_mode};
        try{
          if(broker?.getStatus)status=await broker.getStatus(row.user_id);
        }catch(error){
          status={...status,connected:false,reason:"BROKER_STATUS_UNAVAILABLE"};
        }
        return {...row,connected:Boolean(status.connected),statusReason:status.reason||null};
      }));
      res.json({ok:true,brokers:accounts});
    }catch(error){
      console.error("[KINGBOT ADMIN BROKERS]",error?.message||error);
      res.status(500).json({ok:false,error:"Broker registry unavailable."});
    }
  });

  router.get("/admin/executions",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try{
      const q=await pool.query(`
        SELECT j.id,j.user_id,u.email,j.bot_id,j.client_id,j.execution_mode,j.symbol,j.side,
               j.volume,j.status,j.error_message,j.created_at,j.updated_at
        FROM kingbot_execution_journal j
        JOIN kingbot_users u ON u.id=j.user_id
        ORDER BY j.created_at DESC
        LIMIT 300
      `);
      res.json({ok:true,executions:q.rows});
    }catch(error){
      console.error("[KINGBOT ADMIN EXECUTIONS]",error?.message||error);
      res.status(500).json({ok:false,error:"Execution journal unavailable."});
    }
  });

  router.post("/admin/runtime/:userId/:botId/stop",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    const userId=String(req.params.userId||"");
    const botId=normalizeBotId(req.params.botId);
    if(!BOT_NAMES[botId])return res.status(400).json({ok:false,error:"Unknown bot engine."});
    try{
      const q=await pool.query(
        "UPDATE kingbot_bot_runtime SET state='STOPPED',last_error='ADMIN_RUNTIME_STOPPED',updated_at=NOW() WHERE user_id=$1 AND bot_id=$2 RETURNING bot_id,state",
        [userId,botId]
      );
      if(!q.rowCount)return res.status(404).json({ok:false,error:"Bot runtime not found."});
      await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,'ADMIN_RUNTIME_STOPPED',$2::jsonb)",[userId,JSON.stringify({admin:a.email,botId})]);
      res.json({ok:true,...q.rows[0]});
    }catch(error){
      console.error("[KINGBOT ADMIN STOP]",error?.message||error);
      res.status(500).json({ok:false,error:"Runtime stop failed."});
    }
  });

  router.post("/admin/risk/kill-switch",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    const active=Boolean(req.body?.active);
    const userId=req.body?.userId ? String(req.body.userId) : null;
    const botId=req.body?.botId ? normalizeBotId(req.body.botId) : null;
    if(botId&&!BOT_NAMES[botId])return res.status(400).json({ok:false,error:"Unknown bot engine."});
    try{
      if(userId&&botId){
        const q=await pool.query("UPDATE kingbot_bot_risk_settings SET kill_switch=$3,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2 RETURNING user_id,bot_id,kill_switch",[userId,botId,active]);
        if(!q.rowCount)return res.status(404).json({ok:false,error:"Risk profile not found."});
      }else if(userId){
        await pool.query("UPDATE kingbot_bot_risk_settings SET kill_switch=$2,updated_at=NOW() WHERE user_id=$1",[userId,active]);
      }else{
        await pool.query("UPDATE kingbot_bot_risk_settings SET kill_switch=$1,updated_at=NOW()",[active]);
        if(active)await pool.query("UPDATE kingbot_bot_runtime SET state='STOPPED',last_error='ADMIN_GLOBAL_KILL_SWITCH',updated_at=NOW() WHERE state='RUNNING'");
      }
      await pool.query("INSERT INTO kingbot_audit_log(event_type,metadata) VALUES('ADMIN_KILL_SWITCH_UPDATED',$1::jsonb)",[JSON.stringify({admin:a.email,active,userId,botId})]);
      res.json({ok:true,active,userId,botId});
    }catch(error){
      console.error("[KINGBOT ADMIN KILL SWITCH]",error?.message||error);
      res.status(500).json({ok:false,error:"Kill switch update failed."});
    }
  });

  router.post("/admin/brokers/:userId/disconnect",async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    const userId=String(req.params.userId||"");
    try{
      const result=broker?.disconnect ? await broker.disconnect(userId) : {connected:false,mode:"NOT_CONNECTED"};
      await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,'ADMIN_BROKER_DISCONNECTED',$2::jsonb)",[userId,JSON.stringify({admin:a.email})]);
      res.json({ok:true,...result});
    }catch(error){
      console.error("[KINGBOT ADMIN BROKER DISCONNECT]",error?.message||error);
      res.status(502).json({ok:false,error:"Broker disconnect failed."});
    }
  });

  return router;
}
export async function ensureSubscriptionSchema(pool){
  if(!pool)return;
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_payments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE, plan_id TEXT NOT NULL, amount_kes NUMERIC(14,2) NOT NULL, mpesa_code TEXT UNIQUE NOT NULL, payer_phone TEXT, payer_name TEXT, selected_bot_id TEXT, status TEXT NOT NULL DEFAULT 'pending', submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ, reviewed_by TEXT, reviewer_note TEXT)");
  await pool.query("ALTER TABLE kingbot_payments ADD COLUMN IF NOT EXISTS payer_phone TEXT");
  await pool.query("ALTER TABLE kingbot_payments ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'");
  await pool.query("ALTER TABLE kingbot_payments ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await pool.query("ALTER TABLE kingbot_payments ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE kingbot_payments ADD COLUMN IF NOT EXISTS reviewed_by TEXT");
  await pool.query("ALTER TABLE kingbot_payments ADD COLUMN IF NOT EXISTS reviewer_note TEXT");
  await pool.query("ALTER TABLE kingbot_payments ADD COLUMN IF NOT EXISTS selected_bot_id TEXT");
  await pool.query("ALTER TABLE kingbot_payments ADD COLUMN IF NOT EXISTS payer_name TEXT");
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_subscriptions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE, plan_id TEXT NOT NULL, status TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ, approved_at TIMESTAMPTZ, approved_by TEXT, payment_id UUID REFERENCES kingbot_payments(id))");
  await pool.query("ALTER TABLE kingbot_subscriptions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await pool.query("ALTER TABLE kingbot_subscriptions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE kingbot_subscriptions ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE kingbot_subscriptions ADD COLUMN IF NOT EXISTS approved_by TEXT");
  await pool.query("ALTER TABLE kingbot_subscriptions ADD COLUMN IF NOT EXISTS payment_id UUID");
  await pool.query("UPDATE kingbot_subscriptions SET expires_at=started_at+INTERVAL '1 month' WHERE status='active' AND expires_at IS NULL");
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_bot_entitlements (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE, bot_id TEXT NOT NULL, subscription_id UUID REFERENCES kingbot_subscriptions(id) ON DELETE CASCADE, active BOOLEAN NOT NULL DEFAULT TRUE, granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id,bot_id,subscription_id))");
  await pool.query("CREATE TABLE IF NOT EXISTS kingbot_audit_log (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES kingbot_users(id) ON DELETE SET NULL, event_type TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
}
export function getPlans(){return PLANS;}
export { BOT_NAMES };
