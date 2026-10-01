import { Router } from "express";
import { requireUser } from "./subscriptions.js";
import { mt5BridgeRegistry, TOKEN_TTL_DAYS } from "./mt5-bridge.js";

export function createMt5BridgeRouter({pool,broker}={}){
  const router=Router();
  router.post("/token",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    try{
      const requestedMode=String(req.body?.executionMode||"DEMO").toUpperCase();
      if(!["DEMO","LIVE"].includes(requestedMode))return res.status(400).json({ok:false,error:"INVALID_EXECUTION_MODE"});
      const mode=requestedMode;
      res.status(201).json(await mt5BridgeRegistry.issueToken({userId:user.id,mode,label:req.body?.label}));
    }catch(error){
      const message=String(error?.message||"MT5_BRIDGE_TOKEN_CREATE_FAILED");
      if(message==="BROKER_ALREADY_CONNECTED"){
        const active=await broker.getMapping(user.id).catch(()=>null);
        return res.status(409).json({
          ok:false,
          error:"BROKER_ALREADY_CONNECTED",
          currentProvider:active?.provider||null,
          currentAccountId:active?.account_id||null,
          currentExecutionMode:active?.execution_mode||null,
          switchRequired:true
        });
      }
      res.status(500).json({ok:false,error:message});
    }
  });

  router.post("/switch",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    try{
      const requestedMode=String(req.body?.executionMode||"DEMO").toUpperCase();
      if(!["DEMO","LIVE"].includes(requestedMode))return res.status(400).json({ok:false,error:"INVALID_EXECUTION_MODE"});
      const active=await broker.getMapping(user.id).catch(()=>null);
      const provider=String(active?.provider||"").toLowerCase();
      if(provider==="mt5-bridge"){
        const token=await mt5BridgeRegistry.issueToken({userId:user.id,mode:requestedMode,label:req.body?.label||"KINGBOT MT5 Bridge"});
        return res.status(201).json({ok:true,switched:false,stoppedRunningBots:0,...token});
      }
      let stoppedRunningBots=0;
      if(active){
        await broker.disconnect(user.id);
        const stopped=await pool.query(
          "UPDATE kingbot_bot_runtime SET state='STOPPED',last_error=$2,updated_at=NOW() WHERE user_id=$1 AND state='RUNNING'",
          [user.id,"BROKER_SWITCHED_TO_MT5"]
        );
        stoppedRunningBots=Number(stopped.rowCount||0);
        await pool.query(
          "INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,'BROKER_DISCONNECTED',$2::jsonb)",
          [user.id,JSON.stringify({reason:"MT5_BRIDGE_SWITCH",previousProvider:active.provider,stoppedRunningBots})]
        );
      }
      const token=await mt5BridgeRegistry.issueToken({userId:user.id,mode:requestedMode,label:req.body?.label||"KINGBOT MT5 Bridge"});
      res.status(201).json({ok:true,switched:Boolean(active),stoppedRunningBots,...token});
    }catch(error){
      console.error("[KINGBOT MT5 BRIDGE] switch failed:",error?.message||error);
      res.status(500).json({ok:false,error:"MT5_BRIDGE_SWITCH_FAILED",reason:String(error?.message||"MT5_BRIDGE_SWITCH_FAILED").slice(0,300)});
    }
  });
  router.get("/status",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    try{res.json({ok:true,...await mt5BridgeRegistry.statusForUser(user.id)});}
    catch(error){res.status(503).json({ok:false,error:"MT5_BRIDGE_STATUS_UNAVAILABLE",reason:error?.message||"MT5_BRIDGE_STATUS_UNAVAILABLE"});}
  });
  router.post("/revoke",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    try{
      const result=await mt5BridgeRegistry.revokeToken({userId:user.id,tokenId:req.body?.tokenId});
      await broker.disconnect(user.id).catch(()=>{});
      res.json(result);
    }catch(error){res.status(500).json({ok:false,error:"MT5_BRIDGE_REVOKE_FAILED"});}
  });
  router.post("/poll",async(req,res)=>{
    try{
      const result=await mt5BridgeRegistry.poll({token:req.body?.token,login:req.body?.login,server:req.body?.server,accountType:req.body?.accountType,state:req.body?.state});
      if(!result.ok&&result.error==="MT5_BRIDGE_ACCOUNT_MISMATCH")return res.status(409).json(result);
      if(!result.ok)return res.status(result.status||409).json(result);
      const active=await broker.getMapping(result.userId);
      if(!active){
        const saved=await broker.saveMapping({userId:result.userId,provider:"mt5-bridge",accountId:result.login,accountToken:String(req.body?.token||""),executionMode:result.mode});
        if(!saved?.ok)return res.status(saved.error==="BROKER_ALREADY_CONNECTED"?409:400).json(saved);
        const connected=await broker.connect(result.userId,result.mode);
        if(!connected.connected)return res.status(503).json({ok:false,error:"MT5_BRIDGE_REGISTER_FAILED",reason:connected.reason});
        const retried=await mt5BridgeRegistry.poll({token:req.body?.token,login:req.body?.login,server:req.body?.server,accountType:req.body?.accountType,state:req.body?.state});
        return res.status(retried.ok?200:(retried.status||409)).json(retried);
      }
      if(String(active.provider).toLowerCase()!=="mt5-bridge")return res.status(409).json({ok:false,error:"BROKER_ALREADY_CONNECTED"});
      return res.json(result);
    }catch(error){
      console.error("[KINGBOT MT5 BRIDGE] poll failed:",error?.message||error);
      res.status(503).json({ok:false,error:"MT5_BRIDGE_POLL_FAILED",reason:String(error?.message||"MT5_BRIDGE_POLL_FAILED").slice(0,300)});
    }
  });
  router.post("/ack",async(req,res)=>{
    try{
      const result=await mt5BridgeRegistry.ack({token:req.body?.token,commandId:req.body?.commandId,status:req.body?.status,result:req.body?.result,message:req.body?.message});
      res.status(result.ok?200:(result.status||404)).json(result);
    }catch(error){res.status(503).json({ok:false,error:"MT5_BRIDGE_ACK_FAILED",reason:error?.message||"MT5_BRIDGE_ACK_FAILED"});}
  });
  router.get("/manifest",(_req,res)=>res.json({ok:true,name:"KINGBOT MT5 EA Bridge",protocol:"HTTP/JSON",endpoint:"/api/mt5/bridge/poll",ackEndpoint:"/api/mt5/bridge/ack",pollIntervalMs:500,telemetryIntervalMs:1000,tokenTtlDays:TOKEN_TTL_DAYS,execution:"native MT5 broker execution",sizeModel:"LOTS",modes:["DEMO","LIVE"],demoMode:"Deriv broker-side MT5 demo account"}));
  return router;
}
export async function ensureMt5BridgeSchema(pool){await mt5BridgeRegistry.ensureSchema();}
