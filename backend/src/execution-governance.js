import { Router } from "express";
import crypto from "node:crypto";
import { getBotDefinitions } from "./bot-engines.js";
import { isAdminEmail } from "./admin-access.js";

const LEASE_SECONDS=Number(process.env.KINGBOT_EXECUTION_LEASE_SECONDS||20);
const LICENSE_GRACE_SECONDS=Number(process.env.KINGBOT_LICENSE_GRACE_SECONDS||0);
const WORKER_ID=String(process.env.KINGBOT_WORKER_ID||("worker_"+crypto.randomBytes(6).toString("hex"))).slice(0,80);

function finite(v,d=null){const n=Number(v);return Number.isFinite(n)?n:d;}
function clean(v,max=120){return String(v??"").trim().slice(0,max);}
function idsFromValue(value,out=new Set(),depth=0){
  if(depth>4||value==null)return out;
  if(Array.isArray(value)){for(const x of value)idsFromValue(x,out,depth+1);return out;}
  if(typeof value!=="object")return out;
  for(const [k,v] of Object.entries(value)){
    const key=String(k).toLowerCase().replace(/[^a-z0-9]/g,"");
    if((key==="orderid"||key==="positionid"||key==="tradeid"||key==="dealid"||key==="contractid")&&(typeof v==="string"||typeof v==="number"))out.add(String(v));
    if(v&&typeof v==="object")idsFromValue(v,out,depth+1);
  }
  return out;
}
function brokerPositionIds(position){
  return [...idsFromValue(position)];
}
function brokerOrderIds(order){
  return [...idsFromValue(order)];
}
function slippageBps(intended,filled){
  const a=finite(intended),b=finite(filled);
  if(!(a>0)||!(b>0))return null;
  return Math.abs(b-a)/a*10000;
}

export function governanceWorkerId(){return WORKER_ID;}

export async function ensureExecutionGovernanceSchema(pool){
  if(!pool)return;
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_bot_catalog(
    bot_id TEXT PRIMARY KEY,
    version TEXT NOT NULL DEFAULT '1.0.0',
    name TEXT NOT NULL,
    family TEXT,
    release_status TEXT NOT NULL DEFAULT 'ACTIVE',
    risk_class TEXT,
    supported_symbols JSONB NOT NULL DEFAULT '[]'::jsonb,
    supported_timeframes JSONB NOT NULL DEFAULT '[]'::jsonb,
    strategies JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_broker_registry(
    id BIGSERIAL PRIMARY KEY,
    provider TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT '*',
    bot_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'UNVERIFIED',
    capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
    notes TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(provider,account_type,bot_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_bot_licenses(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '1.0.0',
    broker_account_id TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    issued_by UUID REFERENCES kingbot_users(id) ON DELETE SET NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    last_validated_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS kingbot_bot_licenses_lookup_idx ON kingbot_bot_licenses(user_id,bot_id,status,expires_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_execution_leases(
    user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    account_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    lease_token TEXT NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(user_id,provider,account_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_execution_controls(
    user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    account_id TEXT NOT NULL,
    halted BOOLEAN NOT NULL DEFAULT FALSE,
    reason TEXT,
    source TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id,provider,account_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_execution_health(
    user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL,
    provider TEXT,
    account_id TEXT,
    worker_id TEXT,
    last_heartbeat_at TIMESTAMPTZ,
    last_cycle_at TIMESTAMPTZ,
    last_quote_at TIMESTAMPTZ,
    last_order_at TIMESTAMPTZ,
    broker_ok BOOLEAN NOT NULL DEFAULT FALSE,
    data_ok BOOLEAN NOT NULL DEFAULT FALSE,
    risk_ok BOOLEAN NOT NULL DEFAULT FALSE,
    reconciliation_state TEXT NOT NULL DEFAULT 'UNKNOWN',
    latency_ms NUMERIC,
    slippage_bps NUMERIC,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id,bot_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_broker_position_snapshots(
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    account_id TEXT NOT NULL,
    bot_id TEXT,
    position_count INTEGER NOT NULL DEFAULT 0,
    position_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    positions JSONB NOT NULL DEFAULT '[]'::jsonb,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_execution_reconciliations(
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    account_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'UNKNOWN',
    reason TEXT,
    expected_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    observed_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_market_blackouts(
    id BIGSERIAL PRIMARY KEY,
    symbol TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    reason TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'ADMIN',
    severity TEXT NOT NULL DEFAULT 'HIGH',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES kingbot_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`ALTER TABLE kingbot_execution_journal ADD COLUMN IF NOT EXISTS broker_order_id TEXT`);
  await pool.query(`ALTER TABLE kingbot_execution_journal ADD COLUMN IF NOT EXISTS broker_position_id TEXT`);
  await pool.query(`ALTER TABLE kingbot_execution_journal ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE kingbot_execution_journal ADD COLUMN IF NOT EXISTS filled_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE kingbot_execution_journal ADD COLUMN IF NOT EXISTS latency_ms NUMERIC`);
  await pool.query(`ALTER TABLE kingbot_execution_journal ADD COLUMN IF NOT EXISTS slippage_bps NUMERIC`);
}

export async function seedExecutionGovernance(pool){
  if(!pool)return;
  const defs=getBotDefinitions();
  for(const b of Object.values(defs)){
    const family=b.mode||b.name||"KINGBOT";
    await pool.query(`INSERT INTO kingbot_bot_catalog(bot_id,version,name,family,release_status,risk_class,supported_symbols,supported_timeframes,strategies,metadata,updated_at)
      VALUES($1,$2,$3,$4,'ACTIVE',$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,NOW())
      ON CONFLICT(bot_id) DO UPDATE SET version=EXCLUDED.version,name=EXCLUDED.name,family=EXCLUDED.family,
      risk_class=EXCLUDED.risk_class,supported_timeframes=EXCLUDED.supported_timeframes,strategies=EXCLUDED.strategies,metadata=EXCLUDED.metadata,updated_at=NOW()`,
      [
        b.id,"1.0.0",b.name,family,
        Number(b.risk?.maxRiskPerTradePct||1)>=1?"HIGH":"CONTROLLED",
        JSON.stringify(["BROKER_DEFINED"]),
        JSON.stringify(Object.keys(b.timeframeProfile||{}).map(k=>b.timeframeProfile[k]).filter(Boolean)),
        JSON.stringify(b.strategies||[]),
        JSON.stringify({signalThreshold:b.signalThreshold||null,mode:b.mode||null})
      ]);
  }
  const bots=Object.keys(defs);
  const providers=[
    ["mt5-bridge","*","COMPATIBLE",{execution:true,marketData:true,positions:true},"Native KINGBOT MT5 Bridge"],
    ["deriv","*","RESTRICTED",{execution:true,marketData:true,positions:true},"Deriv Options is restricted to the dedicated Ladder V8 path"],
    ["deriv","*","COMPATIBLE",{execution:true,marketData:true,positions:true},"Dedicated Deriv path requires broker-supported contract type"],
    ["exness","*","UNVERIFIED",{execution:true,marketData:true,positions:true},"Adapter present; certification requires controlled account test"],
    ["oanda","*","UNVERIFIED",{execution:true,marketData:true,positions:true},"Adapter present; certification requires controlled account test"],
    ["metaapi","*","UNVERIFIED",{execution:true,marketData:true,positions:true},"Adapter route available; certification requires controlled account test"]
  ];
  for(const botId of bots){
    for(const [provider,accountType,baseStatus,capabilities,notes] of providers){
      let status=baseStatus;
      if(provider==="deriv"&&botId!=="ladder-flip")status="RESTRICTED";
      if(provider==="deriv"&&botId==="ladder-flip")status="COMPATIBLE";
      await pool.query(`INSERT INTO kingbot_broker_registry(provider,account_type,bot_id,status,capabilities,notes,updated_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,NOW())
        ON CONFLICT(provider,account_type,bot_id) DO UPDATE SET status=EXCLUDED.status,capabilities=EXCLUDED.capabilities,notes=EXCLUDED.notes,updated_at=NOW()`,
        [provider,accountType,botId,status,JSON.stringify(capabilities),notes]);
    }
  }
}

export async function acquireExecutionLease(pool,{userId,provider,accountId,botId}={}){
  if(!pool||!userId||!provider||!accountId||!botId)return {ok:false,error:"EXECUTION_LEASE_INPUT_INVALID"};
  const leaseToken=WORKER_ID+":"+crypto.createHash("sha256").update(String(userId)+":"+String(botId)).digest("hex").slice(0,16);
  const q=await pool.query(`INSERT INTO kingbot_execution_leases(user_id,provider,account_id,bot_id,worker_id,lease_token,acquired_at,heartbeat_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW(),NOW()+($7||' seconds')::interval)
    ON CONFLICT(user_id,provider,account_id) DO UPDATE SET bot_id=EXCLUDED.bot_id,worker_id=EXCLUDED.worker_id,lease_token=EXCLUDED.lease_token,
      acquired_at=NOW(),heartbeat_at=NOW(),expires_at=NOW()+($7||' seconds')::interval
      WHERE kingbot_execution_leases.expires_at<NOW() OR kingbot_execution_leases.lease_token=EXCLUDED.lease_token
    RETURNING worker_id,lease_token,expires_at`,[userId,provider,accountId,botId,WORKER_ID,leaseToken,String(LEASE_SECONDS)]);
  if(!q.rowCount)return {ok:false,error:"EXECUTION_LEASE_HELD"};
  return {ok:true,...q.rows[0]};
}

export async function heartbeatExecution(pool,{userId,provider,accountId,botId,error=null,brokerOk=false,dataOk=false,riskOk=false,reconciliationState="UNKNOWN",latencyMs=null}={}){
  if(!pool)return;
  await pool.query(`INSERT INTO kingbot_execution_health(user_id,bot_id,provider,account_id,worker_id,last_heartbeat_at,broker_ok,data_ok,risk_ok,reconciliation_state,latency_ms,last_error,updated_at)
    VALUES($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9,$10,$11,NOW())
    ON CONFLICT(user_id,bot_id) DO UPDATE SET provider=EXCLUDED.provider,account_id=EXCLUDED.account_id,worker_id=EXCLUDED.worker_id,
    last_heartbeat_at=NOW(),broker_ok=EXCLUDED.broker_ok,data_ok=EXCLUDED.data_ok,risk_ok=EXCLUDED.risk_ok,
    reconciliation_state=EXCLUDED.reconciliation_state,latency_ms=EXCLUDED.latency_ms,last_error=EXCLUDED.last_error,updated_at=NOW()`,
    [userId,botId,provider||null,accountId||null,WORKER_ID,Boolean(brokerOk),Boolean(dataOk),Boolean(riskOk),clean(reconciliationState,40)||"UNKNOWN",finite(latencyMs),error?clean(error,500):null]);
}

export async function touchExecutionCycle(pool,{userId,botId,quoteTime=null,orderTime=null,latencyMs=null}={}){
  if(!pool)return;
  await pool.query(`UPDATE kingbot_execution_health SET last_cycle_at=NOW(),last_quote_at=COALESCE($3,last_quote_at),last_order_at=COALESCE($4,last_order_at),
    latency_ms=COALESCE($5,latency_ms),updated_at=NOW() WHERE user_id=$1 AND bot_id=$2`,
    [userId,botId,quoteTime?new Date(quoteTime):null,orderTime?new Date(orderTime):null,finite(latencyMs)]);
}

export async function haltExecution(pool,{userId,provider,accountId,reason,source="GOVERNANCE"}={}){
  await pool.query(`INSERT INTO kingbot_execution_controls(user_id,provider,account_id,halted,reason,source,updated_at)
    VALUES($1,$2,$3,TRUE,$4,$5,NOW())
    ON CONFLICT(user_id,provider,account_id) DO UPDATE SET halted=TRUE,reason=EXCLUDED.reason,source=EXCLUDED.source,updated_at=NOW()`,
    [userId,provider,accountId,clean(reason,500)||"EXECUTION_HALTED",clean(source,80)]);
}

export async function clearExecutionHalt(pool,{userId,provider,accountId,source="ADMIN"}={}){
  const q=await pool.query(`UPDATE kingbot_execution_controls SET halted=FALSE,reason=NULL,source=$4,updated_at=NOW()
    WHERE user_id=$1 AND provider=$2 AND account_id=$3 RETURNING user_id`,[userId,provider,accountId,clean(source,80)]);
  return q.rowCount>0;
}

export async function validateExecutionGovernance(pool,{userId,userEmail,botId,provider,accountId,accountType="*",symbol,executionMode}={}){
  const blocked=[];
  if(!pool)return {allowed:false,blockedReasons:["DATABASE_REQUIRED"]};
  const control=await pool.query(`SELECT halted,reason FROM kingbot_execution_controls WHERE user_id=$1 AND provider=$2 AND account_id=$3`,[userId,provider,accountId]);
  if(control.rowCount&&control.rows[0].halted)blocked.push("ACCOUNT_EXECUTION_HALTED");
  const reg=await pool.query(`SELECT status FROM kingbot_broker_registry WHERE provider=$1 AND (account_type='*' OR account_type=$2) AND bot_id=$3
    ORDER BY CASE WHEN account_type=$2 THEN 0 ELSE 1 END LIMIT 1`,[provider,accountType||"*",botId]);
  if(reg.rowCount&&String(reg.rows[0].status)==="RESTRICTED")blocked.push("BROKER_BOT_RESTRICTED");
  if(symbol){
    const blackout=await pool.query(`SELECT id,reason,starts_at,ends_at,severity FROM kingbot_market_blackouts
      WHERE enabled=TRUE AND (symbol=$1 OR symbol='*') AND starts_at<=NOW() AND ends_at>=NOW()
      ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 ELSE 2 END,ends_at DESC LIMIT 1`,[symbol]);
    if(blackout.rowCount)blocked.push("MARKET_BLACKOUT_ACTIVE:"+clean(blackout.rows[0].reason,120));
  }
  const licenses=await pool.query(`SELECT status,expires_at,revoked_at FROM kingbot_bot_licenses WHERE user_id=$1 AND bot_id=$2
    ORDER BY issued_at DESC LIMIT 1`,[userId,botId]);
  if(licenses.rowCount){
    const l=licenses.rows[0];
    if(l.revoked_at||String(l.status)!=="ACTIVE")blocked.push("BOT_LICENSE_INACTIVE");
    if(l.expires_at && new Date(l.expires_at).getTime()+LICENSE_GRACE_SECONDS*1000<=Date.now())blocked.push("BOT_LICENSE_EXPIRED");
    if(l.broker_account_id && String(l.broker_account_id)!==String(accountId||""))blocked.push("BOT_LICENSE_ACCOUNT_MISMATCH");
  }
  if(executionMode==="LIVE"&&String(userEmail||"").length===0)blocked.push("LIVE_IDENTITY_REQUIRED");
  return {allowed:blocked.length===0,blockedReasons:blocked};
}

export async function reconcileBrokerPositions(pool,{userId,provider,accountId,botId,positions=[]}={}){
  if(!pool)return {status:"UNKNOWN"};
  const observed=[...new Set(positions.flatMap(brokerPositionIds).map(String))];
  await pool.query(`INSERT INTO kingbot_broker_position_snapshots(user_id,provider,account_id,bot_id,position_count,position_ids,positions)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,[userId,provider,accountId,botId,positions.length,JSON.stringify(observed),JSON.stringify(positions.slice(0,50))]);
  const ladder=await pool.query(`SELECT position_ids FROM kingbot_ladder_v8_state WHERE user_id=$1 AND bot_id=$2 AND active=TRUE LIMIT 1`,[userId,botId]);
  const expected=ladder.rowCount&&Array.isArray(ladder.rows[0].position_ids)?ladder.rows[0].position_ids.map(String):[];
  const missing=expected.filter(x=>!observed.includes(String(x)));
  let status="CONSISTENT",reason=null;
  if(missing.length){status="MISMATCH";reason="TRACKED_POSITIONS_MISSING_FROM_BROKER";}
  if(!expected.length&&status==="CONSISTENT")status="OBSERVED";
  const q=await pool.query(`INSERT INTO kingbot_execution_reconciliations(user_id,provider,account_id,bot_id,status,reason,expected_ids,observed_ids,details)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) RETURNING id`,
    [userId,provider,accountId,botId,status,reason,JSON.stringify(expected),JSON.stringify(observed),JSON.stringify({positionCount:positions.length,missing})]);
  if(status==="MISMATCH")await haltExecution(pool,{userId,provider,accountId,reason,source:"RECONCILIATION"});
  return {status,reason,expected,observed,reconciliationId:q.rows[0]?.id||null};
}

export async function recordExecutionOutcome(pool,{journalId,order,intendedPrice,submittedAt}={}){
  if(!pool||!journalId)return;
  const filled=finite(order?.fillPrice??order?.filledPrice??order?.executionPrice??order?.price);
  const ids=brokerOrderIds(order);
  const orderId=ids[0]||null;
  const posIds=[...idsFromValue(order)].filter((x)=>/position|trade|deal|contract/i.test(String(x))).map(String);
  const positionId=posIds[0]||null;
  const latency=Number.isFinite(new Date(submittedAt||0).getTime())&&Number.isFinite(Date.now()-new Date(submittedAt||0).getTime())?Math.max(0,Date.now()-new Date(submittedAt||0).getTime()):null;
  const slip=slippageBps(intendedPrice,filled);
  await pool.query(`UPDATE kingbot_execution_journal SET broker_order_id=COALESCE($2,broker_order_id),broker_position_id=COALESCE($3,broker_position_id),
    filled_at=CASE WHEN $4::numeric IS NOT NULL THEN NOW() ELSE filled_at END,latency_ms=$5,slippage_bps=$6,updated_at=NOW() WHERE id=$1`,
    [journalId,orderId,positionId,filled,latency,slip]);
  return {orderId,positionId,latencyMs:latency,slippageBps:slip,filledPrice:filled};
}

export function createExecutionGovernanceRouter({pool,requireUser}={}){
  const router=Router();
  async function admin(req,res){
    const u=await requireUser(pool,req,res);if(!u)return null;
    if(!isAdminEmail(u.email)){res.status(403).json({ok:false,error:"Administrator access required."});return null;}
    return u;
  }
  router.get("/overview",async(req,res)=>{
    const a=await admin(req,res);if(!a)return;
    try{
      const [health,recon,controls,blackouts,catalog,brokers,licenses]=await Promise.all([
        pool.query("SELECT * FROM kingbot_execution_health ORDER BY updated_at DESC LIMIT 500"),
        pool.query("SELECT * FROM kingbot_execution_reconciliations WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 500"),
        pool.query("SELECT * FROM kingbot_execution_controls WHERE halted=TRUE ORDER BY updated_at DESC LIMIT 500"),
        pool.query("SELECT * FROM kingbot_market_blackouts WHERE enabled=TRUE ORDER BY starts_at DESC LIMIT 100"),
        pool.query("SELECT * FROM kingbot_bot_catalog ORDER BY bot_id"),
        pool.query("SELECT * FROM kingbot_broker_registry ORDER BY provider,bot_id"),
        pool.query("SELECT l.*,u.email FROM kingbot_bot_licenses l JOIN kingbot_users u ON u.id=l.user_id ORDER BY l.issued_at DESC LIMIT 500")
      ]);
      res.json({ok:true,workerId:WORKER_ID,generatedAt:new Date().toISOString(),health:health.rows,reconciliation:recon.rows,halts:controls.rows,blackouts:blackouts.rows,catalog:catalog.rows,brokers:brokers.rows,licenses:licenses.rows});
    }catch(error){res.status(500).json({ok:false,error:"Governance overview unavailable."});}
  });
  router.get("/catalog",async(req,res)=>{const a=await admin(req,res);if(!a)return;const q=await pool.query("SELECT * FROM kingbot_bot_catalog ORDER BY bot_id");res.json({ok:true,catalog:q.rows});});
  router.get("/brokers",async(req,res)=>{const a=await admin(req,res);if(!a)return;const q=await pool.query("SELECT * FROM kingbot_broker_registry ORDER BY provider,bot_id");res.json({ok:true,brokers:q.rows});});
  router.get("/reconciliation",async(req,res)=>{const a=await admin(req,res);if(!a)return;const q=await pool.query("SELECT * FROM kingbot_execution_reconciliations WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 500");res.json({ok:true,items:q.rows});});
  router.post("/reconciliation/:id/resolve",async(req,res)=>{const a=await admin(req,res);if(!a)return;const note=clean(req.body?.note,300)||"Resolved by administrator.";const q=await pool.query("UPDATE kingbot_execution_reconciliations SET resolved_at=NOW(),details=details||$2::jsonb WHERE id=$1 RETURNING *",[req.params.id,JSON.stringify({resolutionNote:note,resolvedBy:a.email})]);if(!q.rowCount)return res.status(404).json({ok:false,error:"Reconciliation item not found."});res.json({ok:true,item:q.rows[0]});});
  router.post("/controls/:userId/clear-halt",async(req,res)=>{const a=await admin(req,res);if(!a)return;const provider=clean(req.body?.provider,50),accountId=clean(req.body?.accountId,120);if(!provider||!accountId)return res.status(400).json({ok:false,error:"provider and accountId are required."});const ok=await clearExecutionHalt(pool,{userId:req.params.userId,provider,accountId,source:"ADMIN_CLEAR"});res.json({ok:true,cleared:ok,admin:a.email});});
  router.get("/worker-health",async(req,res)=>{const a=await admin(req,res);if(!a)return;const q=await pool.query("SELECT * FROM kingbot_execution_health ORDER BY updated_at DESC LIMIT 500");res.json({ok:true,workerId:WORKER_ID,health:q.rows});});
  router.get("/blackouts",async(req,res)=>{const a=await admin(req,res);if(!a)return;const q=await pool.query("SELECT * FROM kingbot_market_blackouts ORDER BY starts_at DESC LIMIT 200");res.json({ok:true,blackouts:q.rows});});
  router.post("/blackouts",async(req,res)=>{const a=await admin(req,res);if(!a)return;const symbol=clean(req.body?.symbol,40).toUpperCase()||"*";const starts=new Date(req.body?.startsAt),ends=new Date(req.body?.endsAt),reason=clean(req.body?.reason,240);const severity=clean(req.body?.severity,20).toUpperCase()||"HIGH";if(!Number.isFinite(starts.getTime())||!Number.isFinite(ends.getTime())||ends<=starts||reason.length<4)return res.status(400).json({ok:false,error:"Valid blackout window and reason are required."});if(!["LOW","HIGH","CRITICAL"].includes(severity))return res.status(400).json({ok:false,error:"Invalid blackout severity."});const q=await pool.query("INSERT INTO kingbot_market_blackouts(symbol,starts_at,ends_at,reason,severity,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[symbol,starts.toISOString(),ends.toISOString(),reason,severity,a.id]);res.status(201).json({ok:true,blackout:q.rows[0]});});
  router.patch("/blackouts/:id",async(req,res)=>{const a=await admin(req,res);if(!a)return;const enabled=req.body?.enabled;const q=await pool.query("UPDATE kingbot_market_blackouts SET enabled=COALESCE($2,enabled) WHERE id=$1 RETURNING *",[req.params.id,enabled==null?null:Boolean(enabled)]);if(!q.rowCount)return res.status(404).json({ok:false,error:"Blackout not found."});res.json({ok:true,blackout:q.rows[0]});});
  router.get("/license",async(req,res)=>{const u=await requireUser(pool,req,res);if(!u)return;const q=await pool.query("SELECT l.*,b.name FROM kingbot_bot_licenses l LEFT JOIN kingbot_bot_catalog b ON b.bot_id=l.bot_id WHERE l.user_id=$1 ORDER BY l.issued_at DESC",[u.id]);res.json({ok:true,licenses:q.rows});});
  router.post("/license/:botId",async(req,res)=>{const a=await admin(req,res);if(!a)return;const userId=clean(req.body?.userId,80),version=clean(req.body?.version,30)||"1.0.0",accountId=clean(req.body?.brokerAccountId,120)||null,expiresAt=req.body?.expiresAt?new Date(req.body.expiresAt):null;if(!userId)return res.status(400).json({ok:false,error:"userId is required."});if(expiresAt&&!Number.isFinite(expiresAt.getTime()))return res.status(400).json({ok:false,error:"Invalid expiresAt."});const q=await pool.query("INSERT INTO kingbot_bot_licenses(user_id,bot_id,version,broker_account_id,expires_at,issued_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[userId,req.params.botId,version,accountId,expiresAt?expiresAt.toISOString():null,a.id]);res.status(201).json({ok:true,license:q.rows[0]});});
  router.post("/license/:id/revoke",async(req,res)=>{const a=await admin(req,res);if(!a)return;const q=await pool.query("UPDATE kingbot_bot_licenses SET status='REVOKED',revoked_at=NOW() WHERE id=$1 RETURNING *",[req.params.id]);if(!q.rowCount)return res.status(404).json({ok:false,error:"License not found."});res.json({ok:true,license:q.rows[0]});});
  return router;
}