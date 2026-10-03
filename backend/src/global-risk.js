import os from "node:os";

const STALE_WORKER_MS = Math.max(5000, Number(process.env.KINGBOT_WORKER_STALE_MS || 15000));

export async function ensureGlobalRiskSchema(pool){
  if(!pool) return;
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_global_risk_state(
    id SMALLINT PRIMARY KEY CHECK(id=1),
    trading_paused BOOLEAN NOT NULL DEFAULT FALSE,
    global_kill_switch BOOLEAN NOT NULL DEFAULT FALSE,
    reason TEXT,
    changed_by UUID REFERENCES kingbot_users(id) ON DELETE SET NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`INSERT INTO kingbot_global_risk_state(id,trading_paused,global_kill_switch,reason)
    VALUES(1,FALSE,FALSE,'SYSTEM_INITIALIZED')
    ON CONFLICT(id) DO NOTHING`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_worker_heartbeats(
    worker_id TEXT PRIMARY KEY,
    worker_role TEXT NOT NULL DEFAULT 'execution',
    status TEXT NOT NULL DEFAULT 'STARTING',
    process_id INTEGER,
    host TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    details JSONB NOT NULL DEFAULT '{}'::jsonb
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_broker_reconciliation(
    user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    account_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'UNKNOWN',
    broker_positions INTEGER NOT NULL DEFAULT 0,
    journal_open INTEGER NOT NULL DEFAULT 0,
    known_position_matches INTEGER NOT NULL DEFAULT 0,
    unresolved_references INTEGER NOT NULL DEFAULT 0,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id,provider,account_id)
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_worker_heartbeat_seen_idx ON kingbot_worker_heartbeats(last_seen_at DESC);");
}

export async function getGlobalRiskState(pool){
  if(!pool){
    return {tradingPaused:false,globalKillSwitch:false,reason:"DATABASE_UNAVAILABLE",changedBy:null,changedAt:null,updatedAt:null};
  }
  try{
    const q=await pool.query("SELECT trading_paused,global_kill_switch,reason,changed_by,changed_at,updated_at FROM kingbot_global_risk_state WHERE id=1");
    const row=q.rows[0];
    return {
      tradingPaused:Boolean(row?.trading_paused),
      globalKillSwitch:Boolean(row?.global_kill_switch),
      reason:row?.reason||null,
      changedBy:row?.changed_by||null,
      changedAt:row?.changed_at||null,
      updatedAt:row?.updated_at||null
    };
  }catch(error){
    return {
      tradingPaused:true,
      globalKillSwitch:true,
      reason:"GLOBAL_RISK_STATE_UNAVAILABLE",
      error:String(error?.message||"GLOBAL_RISK_STATE_UNAVAILABLE").slice(0,180)
    };
  }
}

export async function setGlobalRiskState(pool,{tradingPaused=false,globalKillSwitch=false,reason="",changedBy=null}={}){
  if(!pool) throw new Error("DATABASE_URL_REQUIRED");
  const paused=Boolean(tradingPaused);
  const kill=Boolean(globalKillSwitch);
  const why=String(reason||"").trim().slice(0,500) || (kill ? "GLOBAL_KILL_SWITCH_ACTIVE" : paused ? "NEW_ORDERS_PAUSED" : "RESUMED");
  const q=await pool.query(
    `INSERT INTO kingbot_global_risk_state(id,trading_paused,global_kill_switch,reason,changed_by,changed_at,updated_at)
     VALUES(1,$1,$2,$3,$4,NOW(),NOW())
     ON CONFLICT(id) DO UPDATE SET trading_paused=EXCLUDED.trading_paused,
       global_kill_switch=EXCLUDED.global_kill_switch,reason=EXCLUDED.reason,
       changed_by=EXCLUDED.changed_by,changed_at=NOW(),updated_at=NOW()
     RETURNING trading_paused,global_kill_switch,reason,changed_by,changed_at,updated_at`,
    [paused,kill,why,changedBy||null]
  );
  const row=q.rows[0];
  return {
    tradingPaused:Boolean(row.trading_paused),
    globalKillSwitch:Boolean(row.global_kill_switch),
    reason:row.reason||null,
    changedBy:row.changed_by||null,
    changedAt:row.changed_at||null,
    updatedAt:row.updated_at||null
  };
}

export function globalExecutionGate(state={}){
  if(Boolean(state.globalKillSwitch)){
    return {allowed:false,reason:"GLOBAL_KILL_SWITCH_ACTIVE",level:"CRITICAL"};
  }
  if(Boolean(state.tradingPaused)){
    return {allowed:false,reason:"GLOBAL_TRADING_PAUSED",level:"HIGH"};
  }
  return {allowed:true,reason:null,level:"NORMAL"};
}

export async function recordWorkerHeartbeat(pool,{workerId,workerRole="execution",status="RUNNING",details={}}={}){
  if(!pool) return null;
  const id=String(workerId||"").trim() || `worker-${process.pid}-${Date.now()}`;
  await pool.query(
    `INSERT INTO kingbot_worker_heartbeats(worker_id,worker_role,status,process_id,host,started_at,last_seen_at,details)
     VALUES($1,$2,$3,$4,$5,NOW(),NOW(),$6::jsonb)
     ON CONFLICT(worker_id) DO UPDATE SET status=EXCLUDED.status,process_id=EXCLUDED.process_id,
       host=EXCLUDED.host,last_seen_at=NOW(),details=EXCLUDED.details`,
    [id,String(workerRole||"execution"),String(status||"RUNNING"),Number(process.pid)||null,os.hostname(),JSON.stringify(details&&typeof details==="object"?details:{})]
  );
  return {workerId:id,status:String(status||"RUNNING"),lastSeenAt:new Date().toISOString()};
}

export async function getWorkerHealth(pool,staleMs=STALE_WORKER_MS){
  if(!pool)return {healthy:false,workers:[],staleMs};
  try{
    const q=await pool.query(
      "SELECT worker_id,worker_role,status,process_id,host,started_at,last_seen_at,details FROM kingbot_worker_heartbeats ORDER BY last_seen_at DESC LIMIT 20"
    );
    const now=Date.now();
    const workers=q.rows.map(row=>({
      workerId:row.worker_id,role:row.worker_role,status:row.status,pid:row.process_id,host:row.host,
      startedAt:row.started_at,lastSeenAt:row.last_seen_at,
      ageMs:Math.max(0,now-new Date(row.last_seen_at).getTime()),
      healthy:(String(row.status).toUpperCase()==="RUNNING" && now-new Date(row.last_seen_at).getTime()<=staleMs),
      details:row.details||{}
    }));
    return {healthy:workers.some(w=>w.healthy),workers,staleMs};
  }catch(error){
    return {healthy:false,workers:[],staleMs,error:String(error?.message||"WORKER_HEALTH_UNAVAILABLE").slice(0,180)};
  }
}
