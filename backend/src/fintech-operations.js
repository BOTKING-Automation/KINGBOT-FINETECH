import crypto from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { resolveFirebaseUser } from "./auth.js";
import { requireUser } from "./subscriptions.js";
import { isAdminEmail } from "./admin-access.js";
import { getGlobalRiskState, setGlobalRiskState, getWorkerHealth } from "./global-risk.js";

const SCOPES = ["profile:read","account:read","bots:read","trades:read"];
const STATUS_VALUES = ["pending","approved","rejected","under_review","blocked"];
const now = () => new Date().toISOString();

function clean(value,max=500){ return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g,"").slice(0,max); }
function normalizeStatus(value,fallback="pending"){ const v=clean(value,40).toLowerCase(); return STATUS_VALUES.includes(v)?v:fallback; }
async function requireAdmin(pool,req,res){ const u=await requireUser(pool,req,res); if(!u)return null; if(!isAdminEmail(u.email)){res.status(403).json({ok:false,error:"Administrator access required."});return null;} return u; }
function ipHash(req){ const salt=String(process.env.SECURITY_EVENT_SALT||process.env.BROKER_CREDENTIALS_KEY||"kingbot-security-salt"); const ip=String(req.ip||req.headers["x-forwarded-for"]||"unknown").split(",")[0].trim(); return crypto.createHmac("sha256",salt).update(ip).digest("hex"); }
function userAgent(req){ return clean(req.headers["user-agent"]||"unknown",400); }
async function audit(pool,userId,eventType,metadata={}){ if(!pool)return; await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,$2,$3::jsonb)",[userId||null,eventType,JSON.stringify(metadata)]).catch(error=>console.warn("[KINGBOT FINOPS] audit failed:",error?.message||error)); }
async function notify(pool,userId,type,title,body,metadata={}){ if(!pool||!userId)return; await pool.query("INSERT INTO kingbot_notifications(user_id,type,title,body,metadata) VALUES($1,$2,$3,$4,$5::jsonb)",[userId,type,clean(title,140),clean(body,1000),JSON.stringify(metadata)]).catch(error=>console.warn("[KINGBOT FINOPS] notification failed:",error?.message||error)); }
function createApiKey(){ const secret="kb_read_"+crypto.randomBytes(30).toString("base64url"); return {secret,prefix:secret.slice(0,15),hash:crypto.createHash("sha256").update(secret).digest("hex")}; }
async function authenticateApiKey(pool,req,res,next){
  const raw=clean(req.headers["x-api-key"]||"",160);
  if(!raw)return res.status(401).json({ok:false,error:"API key required in X-API-Key."});
  const hash=crypto.createHash("sha256").update(raw).digest("hex");
  try{
    const q=await pool.query("SELECT id,user_id,scopes,revoked_at,expires_at FROM kingbot_api_keys WHERE key_hash=$1 LIMIT 1",[hash]);
    if(!q.rowCount||q.rows[0].revoked_at)return res.status(401).json({ok:false,error:"API key is invalid or revoked."});
    if(q.rows[0].expires_at && new Date(q.rows[0].expires_at).getTime()<=Date.now())return res.status(401).json({ok:false,error:"API key has expired."});
    await pool.query("UPDATE kingbot_api_keys SET last_used_at=NOW() WHERE id=$1",[q.rows[0].id]);
    req.kingbotApiKey=q.rows[0]; next();
  }catch(error){ console.error("[KINGBOT API KEY]",error?.message||error); res.status(503).json({ok:false,error:"Developer API unavailable."}); }
}
function hasScope(req,scope){ const scopes=Array.isArray(req.kingbotApiKey?.scopes)?req.kingbotApiKey.scopes:SCOPES; return scopes.includes(scope); }

export async function ensureFintechOpsSchema(pool){
  if(!pool)return;
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_kyc_profiles(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending', country_code TEXT, date_of_birth DATE, address TEXT,
    document_type TEXT, document_reference TEXT, provider TEXT, provider_reference TEXT,
    risk_level TEXT NOT NULL DEFAULT 'standard', submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ, reviewer_id UUID, reviewer_note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS kingbot_kyc_profiles_user_unique ON kingbot_kyc_profiles(user_id);");
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_kyc_documents(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    kyc_profile_id UUID REFERENCES kingbot_kyc_profiles(id) ON DELETE CASCADE, document_type TEXT NOT NULL,
    document_reference TEXT, provider TEXT, provider_reference TEXT, status TEXT NOT NULL DEFAULT 'pending',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_compliance_alerts(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES kingbot_users(id) ON DELETE SET NULL,
    alert_type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'open',
    source TEXT NOT NULL DEFAULT 'system', details JSONB NOT NULL DEFAULT '{}'::jsonb, assigned_to UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_payment_intents(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL, external_reference TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'subscription',
    amount NUMERIC(18,2) NOT NULL, currency TEXT NOT NULL DEFAULT 'KES',
    status TEXT NOT NULL DEFAULT 'pending', metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS kingbot_payment_intents_provider_ref ON kingbot_payment_intents(provider,external_reference);");
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_payment_events(
    id BIGSERIAL PRIMARY KEY, payment_intent_id UUID REFERENCES kingbot_payment_intents(id) ON DELETE SET NULL,
    provider TEXT NOT NULL, event_id TEXT NOT NULL, event_type TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS kingbot_payment_events_provider_event ON kingbot_payment_events(provider,event_id);");
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_reconciliation_items(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_type TEXT NOT NULL, external_reference TEXT,
    internal_reference TEXT, amount NUMERIC(18,2), currency TEXT DEFAULT 'KES',
    status TEXT NOT NULL DEFAULT 'unmatched', details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_at TIMESTAMPTZ, resolved_by UUID
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_support_tickets(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general', priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'open', description TEXT NOT NULL, assigned_to UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_support_messages(
    id BIGSERIAL PRIMARY KEY, ticket_id UUID NOT NULL REFERENCES kingbot_support_tickets(id) ON DELETE CASCADE,
    author_user_id UUID REFERENCES kingbot_users(id) ON DELETE SET NULL, author_type TEXT NOT NULL DEFAULT 'USER',
    body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_notifications(
    id BIGSERIAL PRIMARY KEY, user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_security_events(
    id BIGSERIAL PRIMARY KEY, user_id UUID REFERENCES kingbot_users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL, ip_hash TEXT, user_agent TEXT, details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_api_keys(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL,
    scopes JSONB NOT NULL DEFAULT '[]'::jsonb, last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("ALTER TABLE kingbot_api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ");
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_api_keys_expiry_idx ON kingbot_api_keys(user_id,revoked_at,expires_at)");
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_invoices(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    subscription_id UUID, number TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'issued',
    amount NUMERIC(18,2) NOT NULL, currency TEXT NOT NULL DEFAULT 'KES',
    line_items JSONB NOT NULL DEFAULT '[]'::jsonb, issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    due_at TIMESTAMPTZ, paid_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_incidents(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), severity TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'open', title TEXT NOT NULL, summary TEXT NOT NULL,
    service TEXT NOT NULL DEFAULT 'platform', created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_finops_alert_status_idx ON kingbot_compliance_alerts(status,severity,created_at DESC);");
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_finops_ticket_status_idx ON kingbot_support_tickets(status,priority,updated_at DESC);");
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_finops_security_user_idx ON kingbot_security_events(user_id,created_at DESC);");
}

export function createFintechOpsRouter({pool}){
  const router=Router();
  const adminLimit=rateLimit({windowMs:60000,limit:120,standardHeaders:"draft-8",legacyHeaders:false});
  const userLimit=rateLimit({windowMs:60000,limit:90,standardHeaders:"draft-8",legacyHeaders:false});
  router.use((req,res,next)=>{if(!pool)return res.status(503).json({ok:false,error:"Fintech operations database is not configured."});next();});

  router.get("/summary",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try{
      const queries={
        customers:"SELECT COUNT(*)::int AS n FROM kingbot_users",
        verified:"SELECT COUNT(*)::int AS n FROM kingbot_users WHERE email_verified=TRUE",
        subscriptions:"SELECT COUNT(*)::int AS n FROM kingbot_subscriptions WHERE status='active' AND (expires_at IS NULL OR expires_at>NOW())",
        brokers:"SELECT COUNT(*)::int AS n FROM kingbot_broker_accounts WHERE enabled=TRUE",
        runningBots:"SELECT COUNT(*)::int AS n FROM kingbot_bot_runtime WHERE state='RUNNING'",
        kycPending:"SELECT COUNT(*)::int AS n FROM kingbot_kyc_profiles WHERE status IN ('pending','under_review')",
        compliance:"SELECT COUNT(*)::int AS n FROM kingbot_compliance_alerts WHERE status='open'",
        payments:"SELECT COUNT(*)::int AS n FROM kingbot_payment_intents WHERE status IN ('pending','processing')",
        tickets:"SELECT COUNT(*)::int AS n FROM kingbot_support_tickets WHERE status IN ('open','in_progress')",
        reconciliation:"SELECT COUNT(*)::int AS n FROM kingbot_reconciliation_items WHERE status IN ('unmatched','investigating')",
        incidents:"SELECT COUNT(*)::int AS n FROM kingbot_incidents WHERE status='open'",
        apiKeys:"SELECT COUNT(*)::int AS n FROM kingbot_api_keys WHERE revoked_at IS NULL"
      };
      const entries=await Promise.all(Object.entries(queries).map(async([k,sql])=>{try{const q=await pool.query(sql);return [k,Number(q.rows[0]?.n||0)];}catch{return [k,0];}}));
      res.json({ok:true,summary:Object.fromEntries(entries),generatedAt:now(),scope:"KINGBOT FINTECH OPERATIONS"});
    }catch(error){console.error("[KINGBOT FINOPS SUMMARY]",error?.message||error);res.status(500).json({ok:false,error:"Operations summary unavailable."});}
  });

  router.get("/kyc",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try{
      const q=await pool.query(`SELECT k.*,u.email,u.first_name,u.last_name FROM kingbot_kyc_profiles k JOIN kingbot_users u ON u.id=k.user_id
        ORDER BY CASE WHEN k.status='under_review' THEN 0 WHEN k.status='pending' THEN 1 ELSE 2 END,k.updated_at DESC LIMIT 500`);
      res.json({ok:true,profiles:q.rows});
    }catch(error){res.status(500).json({ok:false,error:"KYC queue unavailable."});}
  });
  router.get("/kyc/me",userLimit,async(req,res)=>{const u=await requireUser(pool,req,res);if(!u)return;const q=await pool.query("SELECT * FROM kingbot_kyc_profiles WHERE user_id=$1 LIMIT 1",[u.id]);res.json({ok:true,profile:q.rows[0]||null});});
  router.post("/kyc/submit",userLimit,async(req,res)=>{
    const u=await requireUser(pool,req,res);if(!u);
    if(!u)return;
    const country=clean(req.body?.countryCode,3).toUpperCase(),dob=clean(req.body?.dateOfBirth,10),address=clean(req.body?.address,300),documentType=clean(req.body?.documentType,50).toLowerCase(),documentReference=clean(req.body?.documentReference,240);
    if(!/^[A-Z]{2,3}$/.test(country))return res.status(400).json({ok:false,error:"Valid country code is required."});
    if(!/^\d{4}-\d{2}-\d{2}$/.test(dob))return res.status(400).json({ok:false,error:"Date of birth must use YYYY-MM-DD."});
    if(!address||address.length<6)return res.status(400).json({ok:false,error:"Residential address is required."});
    if(!documentType||!documentReference)return res.status(400).json({ok:false,error:"Identity document type and reference are required."});
    try{
      const q=await pool.query(`INSERT INTO kingbot_kyc_profiles(user_id,status,country_code,date_of_birth,address,document_type,document_reference,submitted_at,updated_at)
        VALUES($1,'pending',$2,$3::date,$4,$5,$6,NOW(),NOW())
        ON CONFLICT(user_id) DO UPDATE SET status='pending',country_code=EXCLUDED.country_code,date_of_birth=EXCLUDED.date_of_birth,address=EXCLUDED.address,
          document_type=EXCLUDED.document_type,document_reference=EXCLUDED.document_reference,reviewer_id=NULL,reviewer_note=NULL,updated_at=NOW()
        RETURNING *`,[u.id,country,dob,address,documentType,documentReference]);
      await pool.query("INSERT INTO kingbot_kyc_documents(user_id,kyc_profile_id,document_type,document_reference,status) VALUES($1,$2,$3,$4,'pending')",[u.id,q.rows[0].id,documentType,documentReference]);
      await audit(pool,u.id,"KYC_SUBMITTED",{kycId:q.rows[0].id});
      res.status(201).json({ok:true,profile:q.rows[0],message:"KYC case submitted for review."});
    }catch(error){console.error("[KINGBOT KYC]",error?.message||error);res.status(500).json({ok:false,error:"KYC submission failed."});}
  });
  router.post("/kyc/:id/review",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    const id=clean(req.params.id,80),status=normalizeStatus(req.body?.status),note=clean(req.body?.note,600),risk=clean(req.body?.riskLevel,30).toLowerCase()||"standard";
    if(!["approved","rejected","under_review","blocked"].includes(status))return res.status(400).json({ok:false,error:"Invalid KYC review status."});
    try{
      const q=await pool.query("UPDATE kingbot_kyc_profiles SET status=$2,reviewed_at=NOW(),reviewer_id=$3,reviewer_note=$4,risk_level=$5,updated_at=NOW() WHERE id=$1 RETURNING *",[id,status,a.id,note||null,risk]);
      if(!q.rowCount)return res.status(404).json({ok:false,error:"KYC case not found."});
      await audit(pool,q.rows[0].user_id,"KYC_REVIEWED",{kycId:id,status,riskLevel:risk,reviewer:a.email});
      await notify(pool,q.rows[0].user_id,"kyc","KYC "+status.replace("_"," "),note||("Your KINGBOT KYC status is now "+status.replace("_"," ") + "."),{kycId:id,status});
      res.json({ok:true,profile:q.rows[0]});
    }catch(error){res.status(500).json({ok:false,error:"KYC review failed."});}
  });

  router.get("/compliance/alerts",adminLimit,async(req,res)=>{const a=await requireAdmin(pool,req,res);if(!a)return;try{const q=await pool.query(`SELECT c.*,u.email,u.first_name,u.last_name FROM kingbot_compliance_alerts c LEFT JOIN kingbot_users u ON u.id=c.user_id ORDER BY CASE c.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,c.created_at DESC LIMIT 500`);res.json({ok:true,alerts:q.rows});}catch(error){res.status(500).json({ok:false,error:"Compliance queue unavailable."});}});
  router.post("/compliance/alerts",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    const userId=clean(req.body?.userId,80)||null,alertType=clean(req.body?.alertType,80)||"MANUAL_REVIEW",severity=clean(req.body?.severity,20).toLowerCase()||"medium",details=req.body?.details&&typeof req.body.details==="object"?req.body.details:{note:clean(req.body?.note,500)};
    if(!["low","medium","high","critical"].includes(severity))return res.status(400).json({ok:false,error:"Invalid alert severity."});
    try{const q=await pool.query("INSERT INTO kingbot_compliance_alerts(user_id,alert_type,severity,status,source,details,assigned_to) VALUES($1,$2,$3,'open','admin',$4::jsonb,$5) RETURNING *",[userId,alertType,severity,JSON.stringify(details),a.id]);if(userId)await notify(pool,userId,"compliance","KINGBOT compliance review opened","A compliance review has been opened on your account.",{alertId:q.rows[0].id,severity});res.status(201).json({ok:true,alert:q.rows[0]});}catch(error){res.status(500).json({ok:false,error:"Compliance alert creation failed."});}
  });
  router.patch("/compliance/alerts/:id",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    const status=clean(req.body?.status,30).toLowerCase();
    if(!["open","investigating","resolved","dismissed"].includes(status))return res.status(400).json({ok:false,error:"Invalid compliance status."});
    try{const q=await pool.query("UPDATE kingbot_compliance_alerts SET status=$2,assigned_to=COALESCE($3,assigned_to),resolved_at=CASE WHEN $2 IN ('resolved','dismissed') THEN NOW() ELSE NULL END WHERE id=$1 RETURNING *",[req.params.id,status,a.id]);if(!q.rowCount)return res.status(404).json({ok:false,error:"Compliance alert not found."});if(q.rows[0].user_id)await notify(pool,q.rows[0].user_id,"compliance","Compliance case "+status,"Your KINGBOT compliance case is now "+status+".",{alertId:req.params.id,status});res.json({ok:true,alert:q.rows[0]});}catch(error){res.status(500).json({ok:false,error:"Compliance alert update failed."});}
  });
  router.get("/system-risk",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try{
      const [executionControl,workerHealth,reconciliation]=await Promise.all([
        getGlobalRiskState(pool),
        getWorkerHealth(pool),
        pool.query("SELECT provider,account_id,status,broker_positions,journal_open,known_position_matches,unresolved_references,checked_at,details FROM kingbot_broker_reconciliation ORDER BY checked_at DESC LIMIT 100")
      ]);
      res.json({ok:true,executionControl,workerHealth,reconciliation:reconciliation.rows,generatedAt:now()});
    }catch(error){
      console.error("[KINGBOT SYSTEM RISK]",error?.message||error);
      res.status(500).json({ok:false,error:"System risk state unavailable."});
    }
  });

  router.post("/system-risk",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    const tradingPaused=Boolean(req.body?.tradingPaused);
    const globalKillSwitch=Boolean(req.body?.globalKillSwitch);
    if(tradingPaused&&globalKillSwitch!==true && String(req.body?.action||"").toLowerCase()==="resume"){
      return res.status(400).json({ok:false,error:"Resume requests must explicitly clear both global controls."});
    }
    const reason=clean(req.body?.reason,500)||(globalKillSwitch?"ADMIN_GLOBAL_KILL_SWITCH":tradingPaused?"ADMIN_NEW_ORDERS_PAUSED":"ADMIN_EXECUTION_RESUMED");
    try{
      const state=await setGlobalRiskState(pool,{tradingPaused,globalKillSwitch,reason,changedBy:a.id});
      await audit(pool,a.id,"GLOBAL_EXECUTION_CONTROL_CHANGED",{tradingPaused,globalKillSwitch,reason});
      res.json({
        ok:true,
        executionControl:state,
        policy:"Global controls block new order authorization. Existing position-management logic remains responsible for protective exits and broker state handling."
      });
    }catch(error){
      console.error("[KINGBOT SYSTEM RISK]",error?.message||error);
      res.status(500).json({ok:false,error:"Global execution control update failed."});
    }
  });

  router.get("/risk/overview",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try{
      const [risk,losses,failed,disabled]=await Promise.all([
        pool.query("SELECT COUNT(*)::int AS n FROM kingbot_bot_risk_settings WHERE kill_switch=TRUE"),
        pool.query("SELECT COUNT(*)::int AS n FROM kingbot_execution_journal WHERE status='REJECTED' AND created_at>NOW()-INTERVAL '24 hours'"),
        pool.query("SELECT COUNT(*)::int AS n FROM kingbot_payment_intents WHERE status IN ('failed','rejected') AND created_at>NOW()-INTERVAL '24 hours'"),
        pool.query("SELECT COUNT(*)::int AS n FROM kingbot_users WHERE admin_blocked=TRUE")
      ]);
      const executionControl=await getGlobalRiskState(pool);
      const reconciliation=await pool.query("SELECT COUNT(*)::int AS n FROM kingbot_broker_reconciliation WHERE status='MISMATCH' AND checked_at>NOW()-INTERVAL '24 hours'");
      res.json({ok:true,overview:{
        accountsWithKillSwitch:Number(risk.rows[0]?.n||0),
        rejectedExecutions24h:Number(losses.rows[0]?.n||0),
        failedPayments24h:Number(failed.rows[0]?.n||0),
        disabledAccounts:Number(disabled.rows[0]?.n||0),
        brokerReconciliationMismatches24h:Number(reconciliation.rows[0]?.n||0),
        globalTradingPaused:Boolean(executionControl.tradingPaused),
        globalKillSwitch:Boolean(executionControl.globalKillSwitch)
      },generatedAt:now()});
    }catch(error){res.status(500).json({ok:false,error:"Risk overview unavailable."});}
  });

  router.post("/risk/sweep",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);
    if(!a)return;
    try{
      let created=0;
      const checks=[
        ["EXECUTION_REJECTION_SPIKE","high","SELECT COUNT(*)::int AS n FROM kingbot_execution_journal WHERE status='REJECTED' AND created_at>NOW()-INTERVAL '1 hour'","rejected executions in the last hour"],
        ["PAYMENT_FAILURE_SPIKE","medium","SELECT COUNT(*)::int AS n FROM kingbot_payment_intents WHERE status='failed' AND created_at>NOW()-INTERVAL '1 hour'","failed payment intents in the last hour"]
      ];
      for(const [type,severity,sql,label] of checks){
        const q=await pool.query(sql);
        if(Number(q.rows[0]?.n||0)>=5){
          const exists=await pool.query("SELECT 1 FROM kingbot_compliance_alerts WHERE alert_type=$1 AND status IN ('open','investigating') AND created_at>NOW()-INTERVAL '6 hours' LIMIT 1",[type]);
          if(!exists.rowCount){
            await pool.query("INSERT INTO kingbot_compliance_alerts(alert_type,severity,status,source,details,assigned_to) VALUES($1,$2,'open','risk_sweep',$3::jsonb,$4)",[type,severity,JSON.stringify({count:Number(q.rows[0].n),label,window:"1 hour"}),a.id]);
            created++;
          }
        }
      }
      await audit(pool,a.id,"RISK_SWEEP",{created});
      res.json({ok:true,created});
    }catch(error){res.status(500).json({ok:false,error:"Risk sweep failed."});}
  });

  router.post("/compliance/sweep",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try{
      const created=[],dupPhones=await pool.query("SELECT phone,COUNT(*)::int AS n FROM kingbot_users WHERE phone IS NOT NULL AND phone<>'' GROUP BY phone HAVING COUNT(*)>1");
      for(const row of dupPhones.rows){const exists=await pool.query("SELECT 1 FROM kingbot_compliance_alerts WHERE alert_type='DUPLICATE_PHONE' AND status IN ('open','investigating') AND details->>'phone'=$1 LIMIT 1",[row.phone]);if(!exists.rowCount){const q=await pool.query("INSERT INTO kingbot_compliance_alerts(alert_type,severity,status,source,details,assigned_to) VALUES('DUPLICATE_PHONE','medium','open','automated_sweep',$1::jsonb,$2) RETURNING id",[JSON.stringify({phone:row.phone,userCount:row.n}),a.id]);created.push(q.rows[0].id);}}
      const reused=await pool.query("SELECT p.mpesa_code,COUNT(*)::int AS n FROM kingbot_payments p GROUP BY p.mpesa_code HAVING COUNT(*)>1").catch(()=>({rows:[]}));
      for(const row of reused.rows){const exists=await pool.query("SELECT 1 FROM kingbot_compliance_alerts WHERE alert_type='DUPLICATE_PAYMENT_REFERENCE' AND status IN ('open','investigating') AND details->>'reference'=$1 LIMIT 1",[row.mpesa_code]);if(!exists.rowCount){const q=await pool.query("INSERT INTO kingbot_compliance_alerts(alert_type,severity,status,source,details,assigned_to) VALUES('DUPLICATE_PAYMENT_REFERENCE','high','open','automated_sweep',$1::jsonb,$2) RETURNING id",[JSON.stringify({reference:row.mpesa_code,count:row.n}),a.id]);created.push(q.rows[0].id);}}
      res.json({ok:true,created:created.length,alertIds:created});
    }catch(error){res.status(500).json({ok:false,error:"Compliance sweep failed."});}
  });

  router.post("/payments/intents",userLimit,async(req,res)=>{
    const u=await requireUser(pool,req,res);if(!u)return;
    const provider=clean(req.body?.provider,40).toLowerCase()||"mpesa",externalReference=clean(req.body?.externalReference,120),purpose=clean(req.body?.purpose,80).toLowerCase()||"subscription",amount=Number(req.body?.amount),currency=clean(req.body?.currency,8).toUpperCase()||"KES";
    if(!externalReference||!Number.isFinite(amount)||amount<=0)return res.status(400).json({ok:false,error:"Payment reference and positive amount are required."});
    try{const q=await pool.query(`INSERT INTO kingbot_payment_intents(user_id,provider,external_reference,purpose,amount,currency,status,metadata) VALUES($1,$2,$3,$4,$5,$6,'pending',$7::jsonb) ON CONFLICT(provider,external_reference) DO NOTHING RETURNING *`,[u.id,provider,externalReference,purpose,amount,currency,JSON.stringify(req.body?.metadata&&typeof req.body.metadata==="object"?req.body.metadata:{})]);if(!q.rowCount)return res.status(409).json({ok:false,error:"Payment reference already exists."});await audit(pool,u.id,"PAYMENT_INTENT_CREATED",{paymentIntentId:q.rows[0].id,provider,externalReference,amount,currency});res.status(201).json({ok:true,paymentIntent:q.rows[0]});}catch(error){res.status(500).json({ok:false,error:"Payment intent creation failed."});}
  });
  router.get("/payments/intents",adminLimit,async(req,res)=>{const a=await requireAdmin(pool,req,res);if(!a)return;try{const q=await pool.query(`SELECT p.*,u.email,u.first_name,u.last_name FROM kingbot_payment_intents p JOIN kingbot_users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 500`);res.json({ok:true,payments:q.rows});}catch(error){res.status(500).json({ok:false,error:"Payment operations queue unavailable."});}});
  router.post("/payments/sync-subscriptions",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try{
      const source=await pool.query("SELECT id,user_id,plan_id,amount_kes,mpesa_code,status,submitted_at,reviewed_at FROM kingbot_payments ORDER BY submitted_at DESC LIMIT 1000");let synced=0,skipped=0;
      for(const p of source.rows){const ref="subscription:"+p.mpesa_code;const q=await pool.query(`INSERT INTO kingbot_payment_intents(user_id,provider,external_reference,purpose,amount,currency,status,metadata,created_at,updated_at)
        VALUES($1,'mpesa',$2,'subscription',$3,'KES',$4,$5::jsonb,COALESCE($6,NOW()),COALESCE($7,NOW())) ON CONFLICT(provider,external_reference) DO NOTHING RETURNING id`,[p.user_id,ref,Number(p.amount_kes||0),String(p.status||"pending").toLowerCase(),JSON.stringify({sourcePaymentId:p.id,planId:p.plan_id,mpesaCode:p.mpesa_code}),p.submitted_at,p.reviewed_at||p.submitted_at]);if(q.rowCount)synced++;else skipped();}
      await audit(pool,a.id,"PAYMENT_SUBSCRIPTION_SYNC",{synced,skipped});res.json({ok:true,synced,skipped});
    }catch(error){res.status(500).json({ok:false,error:"Payment synchronization failed."});}
  });
  router.post("/payments/webhook",async(req,res)=>{
    const secret=String(process.env.PAYMENT_WEBHOOK_SECRET||"").trim();if(!secret)return res.status(503).json({ok:false,error:"Payment webhook secret is not configured."});
    const raw=JSON.stringify(req.body||{}),supplied=String(req.headers["x-kingbot-signature"]||"").replace(/^sha256=/i,"").trim().toLowerCase(),expected=crypto.createHmac("sha256",secret).update(raw).digest("hex");
    if(!supplied||supplied.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))return res.status(401).json({ok:false,error:"Invalid webhook signature."});
    const provider=clean(req.body?.provider,40).toLowerCase(),eventId=clean(req.body?.eventId,160),eventType=clean(req.body?.eventType,120).toLowerCase(),externalReference=clean(req.body?.externalReference,120);if(!provider||!eventId||!eventType)return res.status(400).json({ok:false,error:"provider, eventId and eventType are required."});
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const ev=await client.query("INSERT INTO kingbot_payment_events(provider,event_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(provider,event_id) DO NOTHING RETURNING id",[provider,eventId,eventType,JSON.stringify(req.body)]);
      if(!ev.rowCount){await client.query("COMMIT");return res.json({ok:true,duplicate:true});}
      let intent=null;if(externalReference){const q=await client.query("SELECT id,user_id FROM kingbot_payment_intents WHERE provider=$1 AND external_reference=$2 LIMIT 1",[provider,externalReference]);intent=q.rows[0]||null;}
      if(intent){const mapped=eventType.includes("fail")||eventType.includes("reject")?"failed":eventType.includes("success")||eventType.includes("paid")||eventType.includes("complete")?"completed":eventType.includes("process")?"processing":"pending";await client.query("UPDATE kingbot_payment_intents SET status=$2,updated_at=NOW(),metadata=metadata||$3::jsonb WHERE id=$1",[intent.id,mapped,JSON.stringify({lastEventId:eventId,lastEventType:eventType})]);}
      await client.query("COMMIT");if(intent)await notify(pool,intent.user_id,"payment","Payment status updated","KINGBOT recorded a "+eventType+" payment event.",{paymentIntentId:intent.id,eventId,eventType});res.json({ok:true,recorded:true,paymentIntentId:intent?.id||null});
    }catch(error){await client.query("ROLLBACK").catch(()=>{});console.error("[KINGBOT PAYMENT WEBHOOK]",error?.message||error);res.status(500).json({ok:false,error:"Payment webhook processing failed."});}finally{client.release();}
  });

  router.get("/reconciliation",adminLimit,async(req,res)=>{const a=await requireAdmin(pool,req,res);if(!a)return;try{const q=await pool.query("SELECT r.*,u.email AS resolver_email FROM kingbot_reconciliation_items r LEFT JOIN kingbot_users u ON u.id=r.resolved_by ORDER BY CASE r.status WHEN 'unmatched' THEN 0 WHEN 'investigating' THEN 1 ELSE 2 END,r.created_at DESC LIMIT 500");res.json({ok:true,items:q.rows});}catch(error){res.status(500).json({ok:false,error:"Reconciliation queue unavailable."});}});
  router.post("/reconciliation",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    const sourceType=clean(req.body?.sourceType,40)||"external",externalReference=clean(req.body?.externalReference,120)||null,internalReference=clean(req.body?.internalReference,120)||null,amount=Number(req.body?.amount),currency=clean(req.body?.currency,8).toUpperCase()||"KES",details=req.body?.details&&typeof req.body.details==="object"?req.body.details:{};
    if(!Number.isFinite(amount)||amount<0)return res.status(400).json({ok:false,error:"Reconciliation amount must be a valid non-negative number."});
    try{const q=await pool.query("INSERT INTO kingbot_reconciliation_items(source_type,external_reference,internal_reference,amount,currency,status,details) VALUES($1,$2,$3,$4,$5,'unmatched',$6::jsonb) RETURNING *",[sourceType,externalReference,internalReference,amount,currency,JSON.stringify(details)]);await audit(pool,a.id,"RECONCILIATION_ITEM_CREATED",{itemId:q.rows[0].id,sourceType});res.status(201).json({ok:true,item:q.rows[0]});}catch(error){res.status(500).json({ok:false,error:"Reconciliation item creation failed."});}
  });
  router.post("/reconciliation/:id/resolve",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;const status=clean(req.body?.status,30).toLowerCase();if(!["matched","investigating","written_off"].includes(status))return res.status(400).json({ok:false,error:"Invalid reconciliation status."});
    try{const q=await pool.query("UPDATE kingbot_reconciliation_items SET status=$2,resolved_at=CASE WHEN $2 IN ('matched','written_off') THEN NOW() ELSE NULL END,resolved_by=$3 WHERE id=$1 RETURNING *",[req.params.id,status,a.id]);if(!q.rowCount)return res.status(404).json({ok:false,error:"Reconciliation item not found."});res.json({ok:true,item:q.rows[0]});}catch(error){res.status(500).json({ok:false,error:"Reconciliation resolution failed."});}
  });

  router.get("/support/tickets",userLimit,async(req,res)=>{const u=await requireUser(pool,req,res);if(!u)return;const admin=isAdminEmail(u.email);try{const q=admin?await pool.query("SELECT t.*,u.email FROM kingbot_support_tickets t JOIN kingbot_users u ON u.id=t.user_id ORDER BY t.updated_at DESC LIMIT 500"):await pool.query("SELECT * FROM kingbot_support_tickets WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100",[u.id]);res.json({ok:true,tickets:q.rows});}catch(error){res.status(500).json({ok:false,error:"Support tickets unavailable."});}});
  router.post("/support/tickets",userLimit,async(req,res)=>{
    const u=await requireUser(pool,req,res);if(!u)return;const subject=clean(req.body?.subject,160),category=clean(req.body?.category,60).toLowerCase()||"general",priority=clean(req.body?.priority,20).toLowerCase()||"normal",description=clean(req.body?.description,3000);
    if(subject.length<4||description.length<10)return res.status(400).json({ok:false,error:"Subject and a useful description are required."});
    if(!["low","normal","high","urgent"].includes(priority))return res.status(400).json({ok:false,error:"Invalid priority."});
    try{const q=await pool.query("INSERT INTO kingbot_support_tickets(user_id,subject,category,priority,status,description) VALUES($1,$2,$3,$4,'open',$5) RETURNING *",[u.id,subject,category,priority,description]);await pool.query("INSERT INTO kingbot_support_messages(ticket_id,author_user_id,author_type,body) VALUES($1,$2,'USER',$3)",[q.rows[0].id,u.id,description]);await audit(pool,u.id,"SUPPORT_TICKET_CREATED",{ticketId:q.rows[0].id,category,priority});res.status(201).json({ok:true,ticket:q.rows[0]});}catch(error){res.status(500).json({ok:false,error:"Ticket creation failed."});}
  });
  router.get("/support/tickets/:id",userLimit,async(req,res)=>{const u=await requireUser(pool,req,res);if(!u)return;const admin=isAdminEmail(u.email);try{const t=admin?await pool.query("SELECT t.*,u.email FROM kingbot_support_tickets t JOIN kingbot_users u ON u.id=t.user_id WHERE t.id=$1",[req.params.id]):await pool.query("SELECT * FROM kingbot_support_tickets WHERE id=$1 AND user_id=$2",[req.params.id,u.id]);if(!t.rowCount)return res.status(404).json({ok:false,error:"Ticket not found."});const m=await pool.query("SELECT * FROM kingbot_support_messages WHERE ticket_id=$1 ORDER BY created_at ASC",[req.params.id]);res.json({ok:true,ticket:t.rows[0],messages:m.rows});}catch(error){res.status(500).json({ok:false,error:"Ticket details unavailable."});}});
  router.post("/support/tickets/:id/messages",userLimit,async(req,res)=>{
    const u=await requireUser(pool,req,res);if(!u)return;const body=clean(req.body?.body,3000);if(body.length<2)return res.status(400).json({ok:false,error:"Message cannot be empty."});const admin=isAdminEmail(u.email);
    try{
      const t=admin?await pool.query("SELECT * FROM kingbot_support_tickets WHERE id=$1",[req.params.id]):await pool.query("SELECT * FROM kingbot_support_tickets WHERE id=$1 AND user_id=$2",[req.params.id,u.id]);
      if(!t.rowCount)return res.status(404).json({ok:false,error:"Ticket not found."});
      const author=admin?"ADMIN":"USER",q=await pool.query("INSERT INTO kingbot_support_messages(ticket_id,author_user_id,author_type,body) VALUES($1,$2,$3,$4) RETURNING *",[req.params.id,u.id,author,body]);
      await pool.query("UPDATE kingbot_support_tickets SET status=$2,updated_at=NOW() WHERE id=$1",[req.params.id,admin?"in_progress":"open"]);
      if(admin)await notify(pool,t.rows[0].user_id,"support","KINGBOT Support replied","Your support ticket has a new response.",{ticketId:req.params.id});
      res.status(201).json({ok:true,message:q.rows[0]});
    }catch(error){res.status(500).json({ok:false,error:"Support reply failed."});}
  });
  router.patch("/support/tickets/:id",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;const status=clean(req.body?.status,30).toLowerCase(),priority=clean(req.body?.priority,20).toLowerCase(),assignee=clean(req.body?.assignedTo,80)||null;
    if(!["open","in_progress","waiting_customer","resolved","closed"].includes(status))return res.status(400).json({ok:false,error:"Invalid ticket status."});
    if(priority&&!["low","normal","high","urgent"].includes(priority))return res.status(400).json({ok:false,error:"Invalid ticket priority."});
    try{const q=await pool.query("UPDATE kingbot_support_tickets SET status=$2,priority=COALESCE(NULLIF($3,''),priority),assigned_to=COALESCE($4::uuid,assigned_to),updated_at=NOW() WHERE id=$1 RETURNING *",[req.params.id,status,priority,assignee]);if(!q.rowCount)return res.status(404).json({ok:false,error:"Ticket not found."});await notify(pool,q.rows[0].user_id,"support","Support ticket "+status.replace("_"," "),"Your KINGBOT support ticket is now "+status.replace("_"," ")+"." ,{ticketId:req.params.id,status});res.json({ok:true,ticket:q.rows[0]});}catch(error){res.status(500).json({ok:false,error:"Ticket update failed."});}
  });

  router.get("/notifications",userLimit,async(req,res)=>{const u=await requireUser(pool,req,res);if(!u)return;const q=await pool.query("SELECT id,type,title,body,metadata,read_at,created_at FROM kingbot_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",[u.id]);res.json({ok:true,notifications:q.rows});});
  router.post("/notifications/:id/read",userLimit,async(req,res)=>{const u=await requireUser(pool,req,res);if(!u)return;const q=await pool.query("UPDATE kingbot_notifications SET read_at=COALESCE(read_at,NOW()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at",[req.params.id,u.id]);if(!q.rowCount)return res.status(404).json({ok:false,error:"Notification not found."});res.json({ok:true,notification:q.rows[0]});});

  router.get("/security/events",userLimit,async(req,res)=>{const u=await requireUser(pool,req,res);if(!u)return;const admin=isAdminEmail(u.email);const q=admin?await pool.query("SELECT s.*,u.email FROM kingbot_security_events s LEFT JOIN kingbot_users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT 300"):await pool.query("SELECT * FROM kingbot_security_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",[u.id]);res.json({ok:true,events:q.rows});});
  router.post("/security/events",userLimit,async(req,res)=>{const u=await requireUser(pool,req,res);if(!u)return;const eventType=clean(req.body?.eventType,80)||"SECURITY_VIEWED";const details=req.body?.details&&typeof req.body.details==="object"?req.body.details:{};const q=await pool.query("INSERT INTO kingbot_security_events(user_id,event_type,ip_hash,user_agent,details) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id,event_type,created_at",[u.id,eventType,ipHash(req),userAgent(req),JSON.stringify(details)]);res.status(201).json({ok:true,event:q.rows[0]});});

  router.get("/api-keys",userLimit,async(req,res)=>{const u=await requireUser(pool,req,res);if(!u)return;const q=await pool.query("SELECT id,name,key_prefix,scopes,last_used_at,revoked_at,created_at FROM kingbot_api_keys WHERE user_id=$1 ORDER BY created_at DESC",[u.id]);res.json({ok:true,keys:q.rows});});
  router.post("/api-keys",userLimit,async(req,res)=>{
    const u=await requireUser(pool,req,res);if(!u)return;const name=clean(req.body?.name,80)||"KINGBOT API key",requested=Array.isArray(req.body?.scopes)?req.body.scopes.map(x=>clean(x,50)).filter(x=>SCOPES.includes(x)):[],scopes=requested.length?Array.from(new Set(requested)):["profile:read","account:read"];const key=createApiKey();
    try{const q=await pool.query("INSERT INTO kingbot_api_keys(user_id,name,key_hash,key_prefix,scopes,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,NOW()+INTERVAL '90 days') RETURNING id,name,key_prefix,scopes,expires_at,created_at",[u.id,name,key.hash,key.prefix,JSON.stringify(scopes)]);await audit(pool,u.id,"API_KEY_CREATED",{keyId:q.rows[0].id,scopes});res.status(201).json({ok:true,key:q.rows[0],secret:key.secret,warning:"Store this secret now. KINGBOT does not display the full API key again."});}catch(error){res.status(500).json({ok:false,error:"API key creation failed."});}
  });
  router.post("/api-keys/:id/revoke",userLimit,async(req,res)=>{const u=await requireUser(pool,req,res);if(!u)return;const q=await pool.query("UPDATE kingbot_api_keys SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=$1 AND user_id=$2 RETURNING id,revoked_at",[req.params.id,u.id]);if(!q.rowCount)return res.status(404).json({ok:false,error:"API key not found."});await audit(pool,u.id,"API_KEY_REVOKED",{keyId:req.params.id});res.json({ok:true,key:q.rows[0]});});

  router.get("/invoices/me",userLimit,async(req,res)=>{
    const u=await requireUser(pool,req,res);if(!u)return;
    try{
      const q=await pool.query("SELECT number,status,amount,currency,line_items,issued_at,due_at,paid_at FROM kingbot_invoices WHERE user_id=$1 ORDER BY issued_at DESC LIMIT 100",[u.id]);
      res.json({ok:true,invoices:q.rows});
    }catch(error){res.status(500).json({ok:false,error:"Invoice history unavailable."});}
  });

  router.get("/invoices",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try{
      const q=await pool.query("SELECT i.*,u.email FROM kingbot_invoices i JOIN kingbot_users u ON u.id=i.user_id ORDER BY i.issued_at DESC LIMIT 500");
      res.json({ok:true,invoices:q.rows});
    }catch(error){res.status(500).json({ok:false,error:"Invoice registry unavailable."});}
  });

  router.post("/invoices",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    const userId=clean(req.body?.userId,80),amount=Number(req.body?.amount),currency=clean(req.body?.currency,8).toUpperCase()||"KES";
    const lineItems=Array.isArray(req.body?.lineItems)?req.body.lineItems.slice(0,30):[];
    if(!userId||!Number.isFinite(amount)||amount<=0)return res.status(400).json({ok:false,error:"Invoice user and positive amount are required."});
    const number="KB-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(3).toString("hex").toUpperCase();
    try{
      const q=await pool.query("INSERT INTO kingbot_invoices(user_id,number,status,amount,currency,line_items) VALUES($1,$2,'issued',$3,$4,$5::jsonb) RETURNING *",[userId,number,amount,currency,JSON.stringify(lineItems)]);
      await audit(pool,a.id,"INVOICE_CREATED",{invoiceId:q.rows[0].id,number,userId,amount,currency});
      await notify(pool,userId,"invoice","KINGBOT invoice issued","A new KINGBOT invoice has been issued to your account.",{invoiceId:q.rows[0].id,number});
      res.status(201).json({ok:true,invoice:q.rows[0]});
    }catch(error){res.status(500).json({ok:false,error:"Invoice creation failed."});}
  });

  router.post("/invoices/:id/mark-paid",adminLimit,async(req,res)=>{
    const a=await requireAdmin(pool,req,res);if(!a)return;
    try{
      const q=await pool.query("UPDATE kingbot_invoices SET status='paid',paid_at=COALESCE(paid_at,NOW()) WHERE id=$1 RETURNING *",[req.params.id]);
      if(!q.rowCount)return res.status(404).json({ok:false,error:"Invoice not found."});
      await audit(pool,a.id,"INVOICE_MARKED_PAID",{invoiceId:req.params.id,number:q.rows[0].number});
      await notify(pool,q.rows[0].user_id,"invoice","KINGBOT invoice paid","Your KINGBOT invoice has been marked paid.",{invoiceId:req.params.id,number:q.rows[0].number});
      res.json({ok:true,invoice:q.rows[0]});
    }catch(error){res.status(500).json({ok:false,error:"Invoice payment update failed."});}
  });

  router.get("/reports/me",userLimit,async(req,res)=>{
    const u=await requireUser(pool,req,res);if(!u)return;
    try{
      const [sub,bots,trades,tickets,kyc,invoices]=await Promise.all([
        pool.query("SELECT plan_id,status,started_at,expires_at,approved_at FROM kingbot_subscriptions WHERE user_id=$1 ORDER BY started_at DESC LIMIT 20",[u.id]),
        pool.query("SELECT bot_id,state,symbol,timeframe,last_signal,last_run_at,last_error,updated_at FROM kingbot_bot_runtime WHERE user_id=$1 ORDER BY updated_at DESC",[u.id]),
        pool.query("SELECT client_id,bot_id,execution_mode,symbol,side,volume,status,error_message,created_at,updated_at FROM kingbot_execution_journal WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200",[u.id]),
        pool.query("SELECT id,subject,category,priority,status,created_at,updated_at FROM kingbot_support_tickets WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 50",[u.id]),
        pool.query("SELECT status,country_code,risk_level,submitted_at,reviewed_at,reviewer_note FROM kingbot_kyc_profiles WHERE user_id=$1 LIMIT 1",[u.id]),
        pool.query("SELECT number,status,amount,currency,issued_at,due_at,paid_at,line_items FROM kingbot_invoices WHERE user_id=$1 ORDER BY issued_at DESC LIMIT 100",[u.id])
      ]);
      res.json({ok:true,generatedAt:now(),subscriptionHistory:sub.rows,bots:bots.rows,tradeExecutions:trades.rows,support:tickets.rows,kyc:kyc.rows[0]||null,invoices:invoices.rows});
    }catch(error){console.error("[KINGBOT REPORT]",error?.message||error);res.status(500).json({ok:false,error:"Report generation failed."});}
  });

  router.get("/incidents",adminLimit,async(req,res)=>{const a=await requireAdmin(pool,req,res);if(!a)return;try{const q=await pool.query("SELECT i.*,u.email AS creator_email FROM kingbot_incidents i LEFT JOIN kingbot_users u ON u.id=i.created_by ORDER BY CASE i.status WHEN 'open' THEN 0 ELSE 1 END,i.created_at DESC LIMIT 300");res.json({ok:true,incidents:q.rows});}catch(error){res.status(500).json({ok:false,error:"Incident registry unavailable."});}});
  router.post("/incidents",adminLimit,async(req,res)=>{const a=await requireAdmin(pool,req,res);if(!a)return;const title=clean(req.body?.title,160),summary=clean(req.body?.summary,2000),severity=clean(req.body?.severity,20).toLowerCase()||"medium",service=clean(req.body?.service,80)||"platform";if(title.length<4||summary.length<10)return res.status(400).json({ok:false,error:"Incident title and summary are required."});if(!["low","medium","high","critical"].includes(severity))return res.status(400).json({ok:false,error:"Invalid incident severity."});try{const q=await pool.query("INSERT INTO kingbot_incidents(severity,status,title,summary,service,created_by) VALUES($1,'open',$2,$3,$4,$5) RETURNING *",[severity,title,summary,service,a.id]);await audit(pool,a.id,"INCIDENT_CREATED",{incidentId:q.rows[0].id,severity,service});res.status(201).json({ok:true,incident:q.rows[0]});}catch(error){res.status(500).json({ok:false,error:"Incident creation failed."});}});
  router.patch("/incidents/:id",adminLimit,async(req,res)=>{const a=await requireAdmin(pool,req,res);if(!a)return;const status=clean(req.body?.status,30).toLowerCase();if(!["open","investigating","resolved","closed"].includes(status))return res.status(400).json({ok:false,error:"Invalid incident status."});try{const q=await pool.query("UPDATE kingbot_incidents SET status=$2,resolved_at=CASE WHEN $2 IN ('resolved','closed') THEN NOW() ELSE NULL END WHERE id=$1 RETURNING *",[req.params.id,status]);if(!q.rowCount)return res.status(404).json({ok:false,error:"Incident not found."});await audit(pool,a.id,"INCIDENT_UPDATED",{incidentId:req.params.id,status});res.json({ok:true,incident:q.rows[0]});}catch(error){res.status(500).json({ok:false,error:"Incident update failed."});}});

  router.get("/api-access",userLimit,async(req,res)=>{const u=await requireUser(pool,req,res);if(!u)return;res.json({ok:true,scopes:SCOPES,rateLimitPerMinute:60,authentication:"X-API-Key",basePath:"/api/developer/v1"});});
  const developer=Router();
  developer.use(rateLimit({windowMs:60000,limit:60,standardHeaders:"draft-8",legacyHeaders:false}));
  developer.use((req,res,next)=>authenticateApiKey(pool,req,res,next));
  developer.get("/profile",async(req,res)=>{if(!hasScope(req,"profile:read"))return res.status(403).json({ok:false,error:"Scope profile:read required."});const q=await pool.query("SELECT id,email,first_name,last_name,email_verified,phone_verified,created_at FROM kingbot_users WHERE id=$1",[req.kingbotApiKey.user_id]);res.json({ok:true,user:q.rows[0]||null});});
  developer.get("/account",async(req,res)=>{if(!hasScope(req,"account:read"))return res.status(403).json({ok:false,error:"Scope account:read required."});const broker=await pool.query("SELECT provider,account_id,execution_mode,enabled,created_at,updated_at FROM kingbot_broker_accounts WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 10",[req.kingbotApiKey.user_id]);const sub=await pool.query("SELECT plan_id,status,started_at,expires_at FROM kingbot_subscriptions WHERE user_id=$1 ORDER BY started_at DESC LIMIT 1",[req.kingbotApiKey.user_id]);res.json({ok:true,subscription:sub.rows[0]||null,brokerAccounts:broker.rows});});
  developer.get("/bots",async(req,res)=>{if(!hasScope(req,"bots:read"))return res.status(403).json({ok:false,error:"Scope bots:read required."});const q=await pool.query("SELECT bot_id,state,symbol,timeframe,last_signal,last_run_at,last_error,updated_at FROM kingbot_bot_runtime WHERE user_id=$1 ORDER BY bot_id",[req.kingbotApiKey.user_id]);res.json({ok:true,bots:q.rows});});
  developer.get("/trades",async(req,res)=>{if(!hasScope(req,"trades:read"))return res.status(403).json({ok:false,error:"Scope trades:read required."});const q=await pool.query("SELECT client_id,bot_id,execution_mode,symbol,side,volume,status,created_at,updated_at FROM kingbot_execution_journal WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200",[req.kingbotApiKey.user_id]);res.json({ok:true,trades:q.rows});});
  router.use("/developer/v1",developer);
  return router;
}
