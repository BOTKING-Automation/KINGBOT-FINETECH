import crypto from "node:crypto";
import { Mt5RuntimeAdapter } from "./mt5-runtime-adapter.mjs";
import { createMt5HostSupervisor } from "./mt5-host-supervisor.mjs";

const API_ORIGIN=String(process.env.KINGBOT_API_ORIGIN||"").replace(/\/$/,"");
const BOOTSTRAP_TOKEN=String(process.env.KINGBOT_HOSTING_BOOTSTRAP_TOKEN||"").trim();
const VPS_ENROLLMENT_TOKEN=String(process.env.KINGBOT_VPS_ENROLLMENT_TOKEN||"").trim();
const NODE_ID=String(process.env.KINGBOT_HOST_NODE_ID||crypto.randomUUID()).trim();
const NODE_NAME=String(process.env.KINGBOT_HOST_NODE_NAME||NODE_ID).trim();
const NODE_REGION=String(process.env.KINGBOT_HOST_NODE_REGION||"unknown").trim();
const NODE_ENDPOINT=String(process.env.KINGBOT_HOST_NODE_ENDPOINT||"").trim();
const HEARTBEAT_MS=Math.max(5000,Number(process.env.KINGBOT_HOST_HEARTBEAT_MS||10000));
const BRIDGE_WAIT_MS=Math.max(15000,Number(process.env.KINGBOT_HOST_BRIDGE_WAIT_MS||60000));

if(!API_ORIGIN)throw new Error("KINGBOT_API_ORIGIN_REQUIRED");
if(!BOOTSTRAP_TOKEN&&!VPS_ENROLLMENT_TOKEN&&!String(process.env.KINGBOT_HOST_NODE_TOKEN||"").trim())throw new Error("KINGBOT_HOST_AUTH_REQUIRED");

let nodeToken=String(process.env.KINGBOT_HOST_NODE_TOKEN||"").trim();

async function api(path,options={}){
  const response=await fetch(API_ORIGIN+path,{
    ...options,
    headers:{
      "content-type":"application/json",
      ...(nodeToken?{"x-kingbot-node-token":nodeToken}:{}),
      ...(options.headers||{})
    }
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(String(body.error||response.statusText||"HOSTING_API_ERROR"));
  return body;
}

async function register(){
  if(nodeToken){
    console.log(JSON.stringify({event:"node_token_loaded",nodeId:NODE_ID}));
    return;
  }
  const path=VPS_ENROLLMENT_TOKEN?"/api/mt5/hosting/node/register-vps":"/api/mt5/hosting/node/register";
  const body=VPS_ENROLLMENT_TOKEN
    ? {enrollmentToken:VPS_ENROLLMENT_TOKEN,nodeId:NODE_ID,name:NODE_NAME,region:NODE_REGION,endpoint:NODE_ENDPOINT}
    : {bootstrapToken:BOOTSTRAP_TOKEN,nodeId:NODE_ID,name:NODE_NAME,region:NODE_REGION,endpoint:NODE_ENDPOINT};
  const result=await api(path,{method:"POST",body:JSON.stringify(body)});
  nodeToken=result.nodeToken;
  console.log(JSON.stringify({
    event:"node_registered",
    nodeId:NODE_ID,
    profileId:result.profileId||null,
    scope:result.profileId?"USER_VPS":"MANAGED_NODE",
    expiresInDays:result.expiresInDays
  }));
}

async function heartbeat(){
  const result=await api("/api/mt5/hosting/node/heartbeat",{method:"POST",body:"{}"});
  console.log(JSON.stringify({
    event:"node_heartbeat",
    nodeId:result.nodeId,
    deployments:Array.isArray(result.deployments)?result.deployments.length:0,
    serverTime:result.serverTime
  }));
  return result.deployments||[];
}

async function main(){
  await register();
  const adapter=new Mt5RuntimeAdapter();
  const supervisor=createMt5HostSupervisor({
    api,
    adapter,
    pollMs:HEARTBEAT_MS,
    bridgeWaitMs:BRIDGE_WAIT_MS
  });
  await supervisor.loop(heartbeat);
}

main().catch(error=>{
  console.error(JSON.stringify({event:"node_fatal",message:error?.message||String(error)}));
  process.exit(1);
});
