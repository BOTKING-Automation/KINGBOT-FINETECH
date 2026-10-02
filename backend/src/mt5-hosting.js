import crypto from "node:crypto";
import { Router } from "express";

const NODE_TOKEN_TTL_DAYS = 30;
const HEARTBEAT_TIMEOUT_MS = 20_000;

function clean(value,max=200){return String(value??"").trim().slice(0,max);}
function hashToken(token){return crypto.createHash("sha256").update(String(token||""),"utf8").digest("hex");}

export function createMt5HostingRouter({pool,requireUser}={}){
  const router=Router();

  async function requireNode(req){
    const token=String(req.get("x-kingbot-node-token")||"").trim();
    if(!pool||token.length<24)return null;
    const q=await pool.query(
      "SELECT id,node_id,name,region,endpoint,status,expires_at FROM kingbot_mt5_host_nodes WHERE token_hash=$1 AND revoked=FALSE LIMIT 1",
      [hashToken(token)]
    );
    if(!q.rowCount)return null;
    const node=q.rows[0];
    if(new Date(node.expires_at).getTime()<=Date.now())return null;
    return node;
  }

  router.get("/status",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const deployments=await pool.query(
      "SELECT id,node_id,status,broker_provider,account_id,execution_mode,bot_id,last_heartbeat_at,created_at,updated_at FROM kingbot_mt5_host_deployments WHERE user_id=$1 ORDER BY created_at DESC",
      [user.id]
    );
    res.json({ok:true,deployments:deployments.rows.map(d=>({
      ...d,
      account_id:d.account_id?String(d.account_id).replace(/.(?=.{4})/g,"•"):null,
      online:Boolean(d.last_heartbeat_at&&Date.now()-new Date(d.last_heartbeat_at).getTime()<HEARTBEAT_TIMEOUT_MS)
    }))});
  });

  router.post("/provision",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const botId=clean(req.body?.botId||"strategic",60).toLowerCase();
    const executionMode=clean(req.body?.executionMode||"DEMO",10).toUpperCase();
    if(!["DEMO","LIVE"].includes(executionMode))return res.status(400).json({ok:false,error:"INVALID_EXECUTION_MODE"});
    const q=await pool.query(
      "SELECT id FROM kingbot_mt5_host_deployments WHERE user_id=$1 AND status IN ('PROVISIONING','RUNNING','PAUSED') ORDER BY created_at DESC LIMIT 1",
      [user.id]
    );
    const mapping=await pool.query(
      "SELECT provider,account_id,execution_mode,live_execution_authorized FROM kingbot_broker_accounts WHERE user_id=$1 AND enabled=TRUE ORDER BY updated_at DESC LIMIT 1",
      [user.id]
    );
    if(!mapping.rowCount)return res.status(409).json({ok:false,error:"BROKER_CONNECTION_REQUIRED",message:"Connect and verify a broker account before provisioning hosted MT5."});
    const brokerProvider=String(mapping.rows[0].provider||"").toLowerCase();
    const brokerAccountId=String(mapping.rows[0].account_id||"").trim();
    if(brokerProvider!=="mt5-bridge")return res.status(409).json({ok:false,error:"NATIVE_MT5_HOST_REQUIRES_MT5_BRIDGE",message:"Hosted MT5 currently provisions only through the verified native MT5 bridge route."});
    const brokerMode=String(mapping.rows[0].execution_mode||"DEMO").toUpperCase();
    if(brokerMode!==executionMode)return res.status(409).json({ok:false,error:"EXECUTION_MODE_BROKER_MISMATCH",brokerExecutionMode:brokerMode,requestedExecutionMode:executionMode});
    if(executionMode==="LIVE"&&!mapping.rows[0].live_execution_authorized)
      return res.status(409).json({ok:false,error:"LIVE_EXECUTION_NOT_AUTHORIZED",message:"Explicit live execution authorization is required before hosted LIVE provisioning."});
    if(q.rowCount)return res.status(409).json({ok:false,error:"MT5_HOST_ALREADY_PROVISIONING"});
    const nodeQ=await pool.query(`
      SELECT n.node_id
      FROM kingbot_mt5_host_nodes n
      LEFT JOIN kingbot_mt5_host_deployments d
        ON d.node_id=n.node_id AND d.status IN ('PROVISIONING','RUNNING','PAUSED')
      WHERE n.revoked=FALSE AND n.status='ONLINE' AND n.expires_at>NOW()
      GROUP BY n.node_id
      ORDER BY COUNT(d.id) ASC, MIN(n.updated_at) ASC
      LIMIT 1
    `);
    if(!nodeQ.rowCount)return res.status(503).json({ok:false,error:"NO_MT5_HOST_NODE_AVAILABLE"});
    const nodeId=nodeQ.rows[0].node_id;
    const deploymentId=crypto.randomUUID();
    await pool.query(
      "INSERT INTO kingbot_mt5_host_deployments(id,user_id,node_id,status,bot_id,execution_mode,broker_provider,account_id,created_at,updated_at) VALUES($1,$2,$3,'PROVISIONING',$4,$5,$6,$7,NOW(),NOW())",
      [deploymentId,user.id,nodeId,botId,executionMode,brokerProvider,brokerAccountId]
    );
    res.status(202).json({
      ok:true,deploymentId,status:"PROVISIONING",botId,executionMode,
      passwordRequiredByKingbot:false,
      message:"KINGBOT queued the hosted MT5 deployment for the verified broker account. Broker credentials remain under the existing secure broker-connection layer."
    });
  });

  router.post("/node/register",async(req,res)=>{
    const bootstrap=String(req.body?.bootstrapToken||"").trim();
    const expected=String(process.env.KINGBOT_HOSTING_BOOTSTRAP_TOKEN||"").trim();
    if(!expected||!bootstrap||bootstrap!==expected)return res.status(401).json({ok:false,error:"HOST_NODE_BOOTSTRAP_INVALID"});
    const nodeId=clean(req.body?.nodeId||crypto.randomUUID(),100);
    const name=clean(req.body?.name||nodeId,120);
    const region=clean(req.body?.region||"unknown",80);
    const endpoint=clean(req.body?.endpoint||"",500);
    const token=crypto.randomBytes(32).toString("base64url");
    await pool.query(
      "INSERT INTO kingbot_mt5_host_nodes(id,node_id,name,region,endpoint,token_hash,status,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'ONLINE',NOW()+INTERVAL '"+NODE_TOKEN_TTL_DAYS+" days',NOW(),NOW()) ON CONFLICT(node_id) DO UPDATE SET name=EXCLUDED.name,region=EXCLUDED.region,endpoint=EXCLUDED.endpoint,token_hash=EXCLUDED.token_hash,status='ONLINE',expires_at=EXCLUDED.expires_at,updated_at=NOW()",
      [crypto.randomUUID(),nodeId,name,region,endpoint,hashToken(token)]
    );
    res.status(201).json({ok:true,nodeId,nodeToken:token,expiresInDays:NODE_TOKEN_TTL_DAYS});
  });

  router.post("/node/heartbeat",async(req,res)=>{
    const node=await requireNode(req);
    if(!node)return res.status(401).json({ok:false,error:"HOST_NODE_TOKEN_INVALID"});
    await pool.query("UPDATE kingbot_mt5_host_nodes SET status='ONLINE',last_heartbeat_at=NOW(),updated_at=NOW() WHERE id=$1",[node.id]);
    const deployments=await pool.query(
      "SELECT id,user_id,status,bot_id,execution_mode,broker_provider,account_id,last_heartbeat_at FROM kingbot_mt5_host_deployments WHERE node_id=$1 AND status IN ('PROVISIONING','RUNNING','PAUSED') ORDER BY created_at",
      [node.node_id]
    );
    const userIds=[...new Set(deployments.rows.map(d=>String(d.user_id||"")).filter(Boolean))];
    let bridgeRows=[];
    if(userIds.length){
      const bridgeQ=await pool.query(
        "SELECT user_id,mt5_login,last_seen_at,account_type FROM kingbot_mt5_bridge_tokens WHERE user_id = ANY($1::uuid[]) AND revoked=FALSE AND expires_at>NOW() AND mt5_login IS NOT NULL",
        [userIds]
      );
      bridgeRows=bridgeQ.rows;
    }
    const bridgeByUser=new Map();
    for(const row of bridgeRows){
      const current=bridgeByUser.get(String(row.user_id));
      if(!current||new Date(row.last_seen_at||0).getTime()>new Date(current.last_seen_at||0).getTime())bridgeByUser.set(String(row.user_id),row);
    }
    const enriched=[];
    for(const deployment of deployments.rows){
      const bridge=bridgeByUser.get(String(deployment.user_id));
      const bridgeConnected=Boolean(
        String(deployment.broker_provider||"").toLowerCase()==="mt5-bridge" &&
        bridge &&
        String(bridge.mt5_login||"")===String(deployment.account_id||"") &&
        bridge.last_seen_at &&
        Date.now()-new Date(bridge.last_seen_at).getTime()<20_000
      );
      if(bridgeConnected){
        await pool.query(
          "UPDATE kingbot_mt5_host_deployments SET last_heartbeat_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN ('RUNNING','PAUSED','PROVISIONING')",
          [deployment.id]
        );
      }
      enriched.push({...deployment,bridgeConnected,bridgeLastSeenAt:bridge?.last_seen_at||null});
    }
    res.json({ok:true,nodeId:node.node_id,serverTime:new Date().toISOString(),deployments:enriched});
  });

  router.post("/node/deployment-state",async(req,res)=>{
    const node=await requireNode(req);
    if(!node)return res.status(401).json({ok:false,error:"HOST_NODE_TOKEN_INVALID"});
    const deploymentId=clean(req.body?.deploymentId,100);
    const status=clean(req.body?.status,30).toUpperCase();
    if(!deploymentId||!["PROVISIONING","RUNNING","PAUSED","STOPPED","ERROR"].includes(status))
      return res.status(400).json({ok:false,error:"INVALID_DEPLOYMENT_STATE"});
    const q=await pool.query(
      "UPDATE kingbot_mt5_host_deployments SET status=$1,node_id=$2,account_id=COALESCE(NULLIF($3,''),account_id),broker_provider=COALESCE(NULLIF($4,''),broker_provider),last_heartbeat_at=NOW(),updated_at=NOW() WHERE id=$5 RETURNING id,status,node_id",
      [status,node.node_id,clean(req.body?.accountId,100),clean(req.body?.brokerProvider,80),deploymentId]
    );
    if(!q.rowCount)return res.status(404).json({ok:false,error:"DEPLOYMENT_NOT_FOUND"});
    res.json({ok:true,deployment:q.rows[0]});
  });

  return router;
}

export async function ensureMt5HostingSchema(pool){
  if(!pool)return;
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_mt5_host_nodes(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT 'unknown',
    endpoint TEXT,
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'OFFLINE',
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMPTZ NOT NULL,
    last_heartbeat_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_mt5_host_deployments(
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    node_id TEXT,
    status TEXT NOT NULL DEFAULT 'PROVISIONING',
    bot_id TEXT NOT NULL,
    execution_mode TEXT NOT NULL DEFAULT 'DEMO' CHECK(execution_mode IN ('DEMO','LIVE')),
    broker_provider TEXT,
    account_id TEXT,
    last_heartbeat_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_mt5_host_deployments_user_idx ON kingbot_mt5_host_deployments(user_id,status)");
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_mt5_host_deployments_node_idx ON kingbot_mt5_host_deployments(node_id,status)");
}
