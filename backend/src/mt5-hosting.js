import crypto from "node:crypto";
import { Router } from "express";

const NODE_TOKEN_TTL_DAYS = 30;
const HEARTBEAT_TIMEOUT_MS = 20_000;

function clean(value,max=200){return String(value??"").trim().slice(0,max);}
function hashToken(token){return crypto.createHash("sha256").update(String(token||""),"utf8").digest("hex");}
function encryptionKey(){
  const raw=String(process.env.BROKER_CREDENTIALS_KEY||"").trim();
  if(!raw||raw.length<32)throw new Error("BROKER_CREDENTIALS_KEY_NOT_CONFIGURED");
  return crypto.createHash("sha256").update(raw,"utf8").digest();
}
function encryptSecret(value){
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv("aes-256-gcm",encryptionKey(),iv);
  const ciphertext=Buffer.concat([cipher.update(String(value),"utf8"),cipher.final()]);
  return {ciphertext:ciphertext.toString("base64"),iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64")};
}
function decryptSecret(row){
  const decipher=crypto.createDecipheriv("aes-256-gcm",encryptionKey(),Buffer.from(row.credential_iv,"base64"));
  decipher.setAuthTag(Buffer.from(row.credential_tag,"base64"));
  return Buffer.concat([decipher.update(Buffer.from(row.credential_ciphertext,"base64")),decipher.final()]).toString("utf8");
}
const MT5_BOTS=new Set(["strategic","flipper","breakout","smc-pro","ladder-flip"]);
function cleanHost(value){
  const host=clean(value,253).replace(/^https?:\/\//i,"").replace(/\/$/,"");
  if(!host||/[\s/]/.test(host))throw new Error("INVALID_VPS_HOST");
  return host;
}
function maskHost(value){
  const host=String(value||"");
  if(host.length<=6)return "••••";
  return host.slice(0,3)+"••••"+host.slice(-3);
}
function apiOrigin(req){
  const configured=String(process.env.PUBLIC_API_ORIGIN||"").trim().replace(/\/$/,"");
  return configured||("https://"+String(req.get("host")||"").trim());
}

export function createMt5HostingRouter({pool,requireUser}={}){
  const router=Router();

  async function requireNode(req){
    const token=String(req.get("x-kingbot-node-token")||"").trim();
    if(!pool||token.length<24)return null;
    const q=await pool.query(
      "SELECT id,node_id,user_id,vps_profile_id,name,region,endpoint,status,expires_at FROM kingbot_mt5_host_nodes WHERE token_hash=$1 AND revoked=FALSE LIMIT 1",
      [hashToken(token)]
    );
    if(!q.rowCount)return null;
    const node=q.rows[0];
    if(new Date(node.expires_at).getTime()<=Date.now())return null;
    return node;
  }

  router.get("/status",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const profileQ=await pool.query(
      "SELECT id,vps_host,vps_port,vps_protocol,vps_os,username,mt5_server,mt5_login,terminal_path,symbol,timeframe,bot_id,execution_mode,enrollment_expires_at,enrollment_used_at,updated_at FROM kingbot_mt5_vps_profiles WHERE user_id=$1 LIMIT 1",
      [user.id]
    ).catch(()=>({rowCount:0,rows:[]}));
    const profile=profileQ.rowCount?profileQ.rows[0]:null;
    const deployments=await pool.query(
      "SELECT id,node_id,vps_profile_id,status,broker_provider,account_id,execution_mode,bot_id,last_heartbeat_at,created_at,updated_at FROM kingbot_mt5_host_deployments WHERE user_id=$1 ORDER BY created_at DESC",
      [user.id]
    );
    res.json({ok:true,deployments:deployments.rows.map(d=>({
      ...d,
      account_id:d.account_id?String(d.account_id).replace(/.(?=.{4})/g,"•"):null,
      vps_profile_id:d.vps_profile_id||null,
      hostingMode:d.vps_profile_id?"USER_VPS":"MANAGED_NODE",
      online:Boolean(d.last_heartbeat_at&&Date.now()-new Date(d.last_heartbeat_at).getTime()<HEARTBEAT_TIMEOUT_MS)
    })),
    vpsProfile:profile?{
      id:profile.id,
      vpsHost:maskHost(profile.vps_host),
      vpsPort:profile.vps_port,
      vpsProtocol:profile.vps_protocol,
      vpsOs:profile.vps_os,
      username:profile.username,
      mt5Server:profile.mt5_server,
      mt5Login:profile.mt5_login,
      terminalPath:profile.terminal_path,
      symbol:profile.symbol,
      timeframe:profile.timeframe,
      botId:profile.bot_id,
      executionMode:profile.execution_mode,
      enrollmentReady:Boolean(profile.enrollment_expires_at&&new Date(profile.enrollment_expires_at).getTime()>Date.now()),
      enrollmentUsed:Boolean(profile.enrollment_used_at),
      enrollmentExpiresAt:profile.enrollment_expires_at,
      updatedAt:profile.updated_at
    }:null
  });
  });

  router.get("/vps-profile",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const q=await pool.query(
      "SELECT id,vps_host,vps_port,vps_protocol,vps_os,username,mt5_server,mt5_login,terminal_path,symbol,timeframe,bot_id,execution_mode,enrollment_token_hash,enrollment_expires_at,enrollment_used_at,updated_at FROM kingbot_mt5_vps_profiles WHERE user_id=$1 LIMIT 1",
      [user.id]
    );
    if(!q.rowCount)return res.json({ok:true,configured:false,profile:null});
    const p=q.rows[0];
    res.json({
      ok:true,
      configured:true,
      profile:{
        id:p.id,
        vpsHost:maskHost(p.vps_host),
        vpsPort:p.vps_port,
        vpsProtocol:p.vps_protocol,
        vpsOs:p.vps_os,
        username:p.username,
        mt5Server:p.mt5_server,
        mt5Login:p.mt5_login,
        terminalPath:p.terminal_path,
        symbol:p.symbol,
        timeframe:p.timeframe,
        botId:p.bot_id,
        executionMode:p.execution_mode,
        enrollmentReady:Boolean(p.enrollment_expires_at&&new Date(p.enrollment_expires_at).getTime()>Date.now()),
        enrollmentUsed:Boolean(p.enrollment_used_at),
        enrollmentExpiresAt:p.enrollment_expires_at,
        updatedAt:p.updated_at
      }
    });
  });

  router.post("/vps-profile",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    try{
      const vpsHost=cleanHost(req.body?.vpsHost);
      const vpsPort=Number(req.body?.vpsPort||3389);
      const vpsProtocol=clean(req.body?.vpsProtocol||"RDP",10).toUpperCase();
      const vpsOs=clean(req.body?.vpsOs||"WINDOWS",20).toUpperCase();
      const username=clean(req.body?.vpsUsername,120);
      const vpsPassword=String(req.body?.vpsPassword||"");
      const mt5Server=clean(req.body?.mt5Server,160);
      const mt5Login=clean(req.body?.mt5Login,64);
      const mt5Password=String(req.body?.mt5Password||"");
      const terminalPath=clean(req.body?.terminalPath||"C:\\Program Files\\MetaTrader 5\\terminal64.exe",260);
      const symbol=clean(req.body?.symbol||"XAUUSD",40).toUpperCase();
      const timeframe=clean(req.body?.timeframe||"M1",20).toUpperCase();
      const botId=clean(req.body?.botId||"strategic",60).toLowerCase();
      const executionMode=clean(req.body?.executionMode||"DEMO",10).toUpperCase();
      if(!Number.isInteger(vpsPort)||vpsPort<1||vpsPort>65535)throw new Error("INVALID_VPS_PORT");
      if(!["RDP","SSH"].includes(vpsProtocol))throw new Error("INVALID_VPS_PROTOCOL");
      if(vpsOs!=="WINDOWS")throw new Error("MT5_VPS_REQUIRES_WINDOWS");
      if(!username)throw new Error("VPS_USERNAME_REQUIRED");
      if(!vpsPassword)throw new Error("VPS_PASSWORD_REQUIRED");
      if(!mt5Server)throw new Error("MT5_SERVER_REQUIRED");
      if(!/^\d+$/.test(mt5Login))throw new Error("MT5_LOGIN_REQUIRED");
      if(!mt5Password)throw new Error("MT5_PASSWORD_REQUIRED");
      if(!terminalPath.toLowerCase().endsWith(".exe"))throw new Error("MT5_TERMINAL_PATH_REQUIRED");
      if(!MT5_BOTS.has(botId))throw new Error("UNSUPPORTED_BOT_ID");
      if(!["DEMO","LIVE"].includes(executionMode))throw new Error("INVALID_EXECUTION_MODE");
      if(executionMode==="LIVE"&&String(req.body?.liveConfirmation||"")!=="ENABLE_LIVE_TRADING")
        throw new Error("LIVE_CONFIRMATION_REQUIRED");

      const current=await pool.query("SELECT id FROM kingbot_mt5_vps_profiles WHERE user_id=$1 LIMIT 1",[user.id]);

      const active=await pool.query(
        "SELECT provider,account_id,execution_mode FROM kingbot_broker_accounts WHERE user_id=$1 AND enabled=TRUE ORDER BY updated_at DESC LIMIT 1"
      ,[user.id]);
      if(active.rowCount){
        const provider=String(active.rows[0].provider||"").toLowerCase();
        if(provider!=="mt5-bridge")
          return res.status(409).json({ok:false,error:"BROKER_ALREADY_CONNECTED",message:"Disconnect the current broker connection before binding a user VPS to MT5."});
        if(String(active.rows[0].account_id||"")!==mt5Login)
          return res.status(409).json({ok:false,error:"MT5_ACCOUNT_MISMATCH",message:"The VPS MT5 login must match the current KINGBOT MT5 account or the old broker mapping must be disconnected."});
      }

      const activeDeployment=await pool.query(
        "SELECT id,status FROM kingbot_mt5_host_deployments WHERE user_id=$1 AND status IN ('PROVISIONING','RUNNING','PAUSED') ORDER BY created_at DESC LIMIT 1",
        [user.id]
      );
      if(activeDeployment.rowCount){
        return res.status(409).json({ok:false,error:"VPS_DEPLOYMENT_ACTIVE",deploymentId:activeDeployment.rows[0].id,message:"Stop the current VPS deployment before replacing its VPS or MT5 credentials."});
      }

      const bridge=await import("./mt5-bridge.js");
      const tokenResult=await bridge.mt5BridgeRegistry.issueToken({userId:user.id,mode:executionMode,label:"KINGBOT User VPS · "+mt5Login});
      const secretPayload=JSON.stringify({
        vpsPassword,
        mt5Password,
        bridgeToken:tokenResult.token,
        bridgeUrl:apiOrigin(req)+"/api/mt5/bridge/poll",
        ackUrl:apiOrigin(req)+"/api/mt5/bridge/ack"
      });
      const encrypted=encryptSecret(secretPayload);
      let q;
      if(current.rowCount){
        q=await pool.query(
          "UPDATE kingbot_mt5_vps_profiles SET vps_host=$2,vps_port=$3,vps_protocol=$4,vps_os=$5,username=$6,credential_ciphertext=$7,credential_iv=$8,credential_tag=$9,mt5_server=$10,mt5_login=$11,terminal_path=$12,symbol=$13,timeframe=$14,bot_id=$15,execution_mode=$16,live_execution_authorized=$17,live_authorized_at=CASE WHEN $17 THEN NOW() ELSE NULL END,enrollment_token_hash=NULL,enrollment_expires_at=NULL,enrollment_used_at=NULL,updated_at=NOW() WHERE user_id=$1 RETURNING id,user_id,vps_host,vps_port,vps_protocol,vps_os,username,mt5_server,mt5_login,terminal_path,symbol,timeframe,bot_id,execution_mode,updated_at",
          [user.id,vpsHost,vpsPort,vpsProtocol,vpsOs,username,encrypted.ciphertext,encrypted.iv,encrypted.tag,mt5Server,mt5Login,terminalPath,symbol,timeframe,botId,executionMode,executionMode==="LIVE"]
        );
      }else{
        q=await pool.query(
          "INSERT INTO kingbot_mt5_vps_profiles(user_id,vps_host,vps_port,vps_protocol,vps_os,username,credential_ciphertext,credential_iv,credential_tag,mt5_server,mt5_login,terminal_path,symbol,timeframe,bot_id,execution_mode,live_execution_authorized,live_authorized_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,CASE WHEN $17 THEN NOW() ELSE NULL END) RETURNING id,user_id,vps_host,vps_port,vps_protocol,vps_os,username,mt5_server,mt5_login,terminal_path,symbol,timeframe,bot_id,execution_mode,updated_at",
          [user.id,vpsHost,vpsPort,vpsProtocol,vpsOs,username,encrypted.ciphertext,encrypted.iv,encrypted.tag,mt5Server,mt5Login,terminalPath,symbol,timeframe,botId,executionMode,executionMode==="LIVE"]
        );
      }
      const p=q.rows[0];
      res.status(200).json({
        ok:true,
        profile:{
          id:p.id,vpsHost:maskHost(p.vps_host),vpsPort:p.vps_port,vpsProtocol:p.vps_protocol,vpsOs:p.vps_os,username:p.username,
          mt5Server:p.mt5_server,mt5Login:p.mt5_login,terminalPath:p.terminal_path,symbol:p.symbol,timeframe:p.timeframe,botId:p.bot_id,
          executionMode:p.execution_mode
        },
        bridgeTokenGenerated:true,
        message:"VPS and MT5 configuration saved. Generate the VPS agent enrollment token, run the KINGBOT agent on the Windows VPS, then deploy the selected KINGBOT strategy."
      });
    }catch(error){
      const message=String(error?.message||"VPS_PROFILE_SAVE_FAILED");
      const code=/REQUIRED|INVALID_|UNSUPPORTED_|MT5_|VPS_|LIVE_/.test(message)?400:503;
      res.status(code).json({ok:false,error:message});
    }
  });

  router.post("/vps-profile/enrollment",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    try{
      const existing=await pool.query("SELECT id FROM kingbot_mt5_vps_profiles WHERE user_id=$1 LIMIT 1",[user.id]);
      if(!existing.rowCount)return res.status(409).json({ok:false,error:"VPS_PROFILE_REQUIRED"});
      const token=crypto.randomBytes(32).toString("base64url");
      const expiresHours=24;
      await pool.query(
        "UPDATE kingbot_mt5_vps_profiles SET enrollment_token_hash=$2,enrollment_expires_at=NOW()+INTERVAL '24 hours',enrollment_used_at=NULL,updated_at=NOW() WHERE user_id=$1",
        [user.id,hashToken(token)]
      );
      res.status(201).json({
        ok:true,
        enrollmentToken:token,
        expiresInHours:expiresHours,
        apiOrigin:apiOrigin(req),
        command:'$env:KINGBOT_API_ORIGIN="'+apiOrigin(req)+'"; $env:KINGBOT_VPS_ENROLLMENT_TOKEN="'+token+'"; node .\\hosting\\mt5-node-agent.mjs'
      });
    }catch(error){res.status(503).json({ok:false,error:"VPS_ENROLLMENT_FAILED",reason:String(error?.message||"").slice(0,220)});}
  });

  router.post("/provision-vps",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    try{
      const botId=clean(req.body?.botId||"",60).toLowerCase();
      const executionMode=clean(req.body?.executionMode||"DEMO",10).toUpperCase();
      if(!MT5_BOTS.has(botId))return res.status(400).json({ok:false,error:"UNSUPPORTED_BOT_ID"});
      if(!["DEMO","LIVE"].includes(executionMode))return res.status(400).json({ok:false,error:"INVALID_EXECUTION_MODE"});
      const profileQ=await pool.query(
        "SELECT * FROM kingbot_mt5_vps_profiles WHERE user_id=$1 LIMIT 1",
        [user.id]
      );
      if(!profileQ.rowCount)return res.status(409).json({ok:false,error:"VPS_PROFILE_REQUIRED",message:"Save the VPS and MT5 details before deployment."});
      const p=profileQ.rows[0];
      if(String(p.execution_mode||"DEMO").toUpperCase()!==executionMode)return res.status(409).json({ok:false,error:"EXECUTION_MODE_PROFILE_MISMATCH"});
      if(executionMode==="LIVE"&&!p.live_execution_authorized)return res.status(409).json({ok:false,error:"LIVE_EXECUTION_NOT_AUTHORIZED"});
      const active=await pool.query(
        "SELECT id FROM kingbot_mt5_host_deployments WHERE user_id=$1 AND status IN ('PROVISIONING','RUNNING','PAUSED') ORDER BY created_at DESC LIMIT 1",
        [user.id]
      );
      if(active.rowCount)return res.status(409).json({ok:false,error:"MT5_HOST_ALREADY_PROVISIONING",deploymentId:active.rows[0].id});
      const deploymentId=crypto.randomUUID();
      await pool.query(
        "INSERT INTO kingbot_mt5_host_deployments(id,user_id,vps_profile_id,node_id,status,bot_id,execution_mode,broker_provider,account_id,created_at,updated_at) VALUES($1,$2,$3,NULL,'PROVISIONING',$4,$5,'mt5-bridge',$6,NOW(),NOW())",
        [deploymentId,user.id,p.id,botId,executionMode,p.mt5_login]
      );
      res.status(202).json({
        ok:true,deploymentId,status:"PROVISIONING",botId,executionMode,hostingMode:"USER_VPS",
        message:"KINGBOT queued this deployment for the user's Windows VPS. The VPS agent will claim it, configure MT5, launch the KINGBOT bridge and wait for the authenticated heartbeat."
      });
    }catch(error){
      res.status(503).json({ok:false,error:"VPS_PROVISION_FAILED",reason:String(error?.message||"").slice(0,220)});
    }
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
      "INSERT INTO kingbot_mt5_host_deployments(id,user_id,node_id,vps_profile_id,status,bot_id,execution_mode,broker_provider,account_id,created_at,updated_at) VALUES($1,$2,$3,NULL,'PROVISIONING',$4,$5,$6,$7,NOW(),NOW())",
      [deploymentId,user.id,nodeId,botId,executionMode,brokerProvider,brokerAccountId]
    );
    res.status(202).json({
      ok:true,deploymentId,status:"PROVISIONING",botId,executionMode,
      passwordRequiredByKingbot:false,
      message:"KINGBOT queued the hosted MT5 deployment for the verified broker account. Broker credentials remain under the existing secure broker-connection layer."
    });
  });

  router.post("/node/register-vps",async(req,res)=>{
    const enrollment=String(req.body?.enrollmentToken||"").trim();
    if(!pool||enrollment.length<24)return res.status(401).json({ok:false,error:"VPS_ENROLLMENT_INVALID"});
    const q=await pool.query(
      "SELECT id,user_id,vps_host,vps_port,vps_protocol,vps_os,enrollment_expires_at FROM kingbot_mt5_vps_profiles WHERE enrollment_token_hash=$1 LIMIT 1",
      [hashToken(enrollment)]
    );
    if(!q.rowCount)return res.status(401).json({ok:false,error:"VPS_ENROLLMENT_INVALID"});
    const profile=q.rows[0];
    if(!profile.enrollment_expires_at||new Date(profile.enrollment_expires_at).getTime()<=Date.now())
      return res.status(401).json({ok:false,error:"VPS_ENROLLMENT_EXPIRED"});
    const nodeId=clean(req.body?.nodeId||("VPS-"+String(profile.id).slice(0,8)+"-"+crypto.randomUUID().slice(0,8)),120);
    const name=clean(req.body?.name||("KINGBOT VPS · "+nodeId),120);
    const region=clean(req.body?.region||"user-vps",80);
    const endpoint=clean(req.body?.endpoint||"",500);
    const token=crypto.randomBytes(32).toString("base64url");
    await pool.query(
      "INSERT INTO kingbot_mt5_host_nodes(id,node_id,user_id,vps_profile_id,name,region,endpoint,token_hash,status,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ONLINE',NOW()+INTERVAL '30 days',NOW(),NOW()) ON CONFLICT(node_id) DO UPDATE SET user_id=EXCLUDED.user_id,vps_profile_id=EXCLUDED.vps_profile_id,name=EXCLUDED.name,region=EXCLUDED.region,endpoint=EXCLUDED.endpoint,token_hash=EXCLUDED.token_hash,status='ONLINE',revoked=FALSE,expires_at=EXCLUDED.expires_at,updated_at=NOW()",
      [crypto.randomUUID(),nodeId,profile.user_id,profile.id,name,region,endpoint,hashToken(token)]
    );
    await pool.query("UPDATE kingbot_mt5_vps_profiles SET enrollment_token_hash=NULL,enrollment_expires_at=NULL,enrollment_used_at=NOW(),updated_at=NOW() WHERE id=$1",[profile.id]);
    res.status(201).json({ok:true,nodeId,nodeToken:token,profileId:profile.id,expiresInDays:30});
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
      "SELECT id,user_id,vps_profile_id,status,bot_id,execution_mode,broker_provider,account_id,last_heartbeat_at FROM kingbot_mt5_host_deployments WHERE status IN ('PROVISIONING','RUNNING','PAUSED') AND (node_id=$1 OR (node_id IS NULL AND vps_profile_id=$2)) ORDER BY created_at",
      [node.node_id,node.vps_profile_id]
    );
    if(deployments.rowCount){
      for(const deployment of deployments.rows){
        if(!deployment.node_id && String(deployment.vps_profile_id||"")===String(node.vps_profile_id||"")){
          await pool.query("UPDATE kingbot_mt5_host_deployments SET node_id=$1,updated_at=NOW() WHERE id=$2 AND node_id IS NULL",[node.node_id,deployment.id]);
          deployment.node_id=node.node_id;
        }
      }
    }
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

  router.get("/node/deployment-config",async(req,res)=>{
    const node=await requireNode(req);
    if(!node)return res.status(401).json({ok:false,error:"HOST_NODE_TOKEN_INVALID"});
    const deploymentId=clean(req.query?.deploymentId,100);
    if(!deploymentId)return res.status(400).json({ok:false,error:"DEPLOYMENT_ID_REQUIRED"});
    const q=await pool.query(
      "SELECT d.id,d.user_id,d.node_id,d.vps_profile_id,d.status,d.bot_id,d.execution_mode,d.broker_provider,d.account_id,p.vps_host,p.vps_port,p.vps_protocol,p.vps_os,p.mt5_server,p.mt5_login,p.terminal_path,p.symbol,p.timeframe,p.credential_ciphertext,p.credential_iv,p.credential_tag FROM kingbot_mt5_host_deployments d JOIN kingbot_mt5_vps_profiles p ON p.id=d.vps_profile_id WHERE d.id=$1 AND (d.node_id=$2 OR (d.node_id IS NULL AND p.id=$3)) LIMIT 1",
      [deploymentId,node.node_id,node.vps_profile_id]
    );
    if(!q.rowCount)return res.status(404).json({ok:false,error:"DEPLOYMENT_NOT_FOUND"});
    const d=q.rows[0];
    if(String(d.broker_provider||"").toLowerCase()!=="mt5-bridge")return res.status(409).json({ok:false,error:"HOSTED_MT5_REQUIRES_BRIDGE"});
    let secret;
    try{secret=JSON.parse(decryptSecret(d));}catch(error){return res.status(503).json({ok:false,error:"VPS_CREDENTIAL_DECRYPTION_FAILED"});}
    res.json({
      ok:true,
      deploymentId:d.id,
      config:{
        botId:d.bot_id,
        executionMode:d.execution_mode,
        vps:{host:maskHost(d.vps_host),port:d.vps_port,protocol:d.vps_protocol,os:d.vps_os},
        mt5:{
          server:d.mt5_server,
          login:d.mt5_login,
          password:secret.mt5Password,
          terminalPath:d.terminal_path,
          symbol:d.symbol||"XAUUSD",
          timeframe:d.timeframe||"M1",
          bridgeToken:secret.bridgeToken,
          bridgeUrl:secret.bridgeUrl,
          ackUrl:secret.ackUrl
        }
      }
    });
  });

  router.post("/node/deployment-state",async(req,res)=>{
    const node=await requireNode(req);
    if(!node)return res.status(401).json({ok:false,error:"HOST_NODE_TOKEN_INVALID"});
    const deploymentId=clean(req.body?.deploymentId,100);
    const status=clean(req.body?.status,30).toUpperCase();
    if(!deploymentId||!["PROVISIONING","RUNNING","PAUSED","STOPPED","ERROR"].includes(status))
      return res.status(400).json({ok:false,error:"INVALID_DEPLOYMENT_STATE"});
    const q=await pool.query(
      "UPDATE kingbot_mt5_host_deployments SET status=$1,node_id=$2,account_id=COALESCE(NULLIF($3,''),account_id),broker_provider=COALESCE(NULLIF($4,''),broker_provider),last_heartbeat_at=NOW(),updated_at=NOW() WHERE id=$5 AND (node_id=$2 OR (node_id IS NULL AND vps_profile_id=$6)) RETURNING id,status,node_id",
      [status,node.node_id,clean(req.body?.accountId,100),clean(req.body?.brokerProvider,80),deploymentId,node.vps_profile_id]
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
    user_id UUID REFERENCES kingbot_users(id) ON DELETE CASCADE,
    vps_profile_id UUID,
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
    vps_profile_id UUID,
    status TEXT NOT NULL DEFAULT 'PROVISIONING',
    bot_id TEXT NOT NULL,
    execution_mode TEXT NOT NULL DEFAULT 'DEMO' CHECK(execution_mode IN ('DEMO','LIVE')),
    broker_provider TEXT,
    account_id TEXT,
    last_heartbeat_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_mt5_vps_profiles(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES kingbot_users(id) ON DELETE CASCADE,
    vps_host TEXT NOT NULL,
    vps_port INTEGER NOT NULL DEFAULT 3389 CHECK(vps_port BETWEEN 1 AND 65535),
    vps_protocol TEXT NOT NULL DEFAULT 'RDP' CHECK(vps_protocol IN ('RDP','SSH')),
    vps_os TEXT NOT NULL DEFAULT 'WINDOWS' CHECK(vps_os='WINDOWS'),
    username TEXT NOT NULL,
    credential_ciphertext TEXT NOT NULL,
    credential_iv TEXT NOT NULL,
    credential_tag TEXT NOT NULL,
    mt5_server TEXT NOT NULL,
    mt5_login TEXT NOT NULL,
    terminal_path TEXT NOT NULL,
    symbol TEXT NOT NULL DEFAULT 'XAUUSD',
    timeframe TEXT NOT NULL DEFAULT 'M1',
    bot_id TEXT NOT NULL DEFAULT 'strategic',
    execution_mode TEXT NOT NULL DEFAULT 'DEMO' CHECK(execution_mode IN ('DEMO','LIVE')),
    live_execution_authorized BOOLEAN NOT NULL DEFAULT FALSE,
    live_authorized_at TIMESTAMPTZ,
    enrollment_token_hash TEXT UNIQUE,
    enrollment_expires_at TIMESTAMPTZ,
    enrollment_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("ALTER TABLE kingbot_mt5_host_nodes ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES kingbot_users(id) ON DELETE CASCADE");
  await pool.query("ALTER TABLE kingbot_mt5_host_nodes ADD COLUMN IF NOT EXISTS vps_profile_id UUID");
  await pool.query("ALTER TABLE kingbot_mt5_host_deployments ADD COLUMN IF NOT EXISTS vps_profile_id UUID");
  await pool.query("ALTER TABLE kingbot_mt5_vps_profiles ADD COLUMN IF NOT EXISTS vps_protocol TEXT DEFAULT 'RDP'");
  await pool.query("ALTER TABLE kingbot_mt5_vps_profiles ADD COLUMN IF NOT EXISTS vps_os TEXT DEFAULT 'WINDOWS'");
  await pool.query("ALTER TABLE kingbot_mt5_vps_profiles ADD COLUMN IF NOT EXISTS live_execution_authorized BOOLEAN NOT NULL DEFAULT FALSE");
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_mt5_host_nodes_profile_idx ON kingbot_mt5_host_nodes(vps_profile_id,revoked,status)");
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_mt5_host_deployments_vps_idx ON kingbot_mt5_host_deployments(vps_profile_id,status)");
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_mt5_host_deployments_user_idx ON kingbot_mt5_host_deployments(user_id,status)");
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_mt5_host_deployments_node_idx ON kingbot_mt5_host_deployments(node_id,status)");
}
