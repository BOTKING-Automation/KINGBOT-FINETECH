import { Router } from "express";
import { requireUser } from "./subscriptions.js";
import { mt5BridgeRegistry } from "./mt5-bridge.js";

export function createMt5BridgeRouter({pool,broker}={}){
  const router=Router();
  router.post("/token",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    try{
      const requestedMode=String(req.body?.executionMode||"DEMO").toUpperCase();
      if(!["DEMO","PAPER","LIVE"].includes(requestedMode))return res.status(400).json({ok:false,error:"INVALID_EXECUTION_MODE"});
      const mode=requestedMode==="PAPER"?"DEMO":requestedMode;
      res.status(201).json(await mt5BridgeRegistry.issueToken({userId:user.id,mode,label:req.body?.label}));
    }catch(error){
      res.status(error?.message==="BROKER_ALREADY_CONNECTED"?409:500).json({ok:false,error:error?.message||"MT5_BRIDGE_TOKEN_CREATE_FAILED"});
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
