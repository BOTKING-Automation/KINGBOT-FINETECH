import { Mt5RuntimeAdapter } from "./mt5-runtime-adapter.mjs";

const API_ORIGIN=String(process.env.KINGBOT_API_ORIGIN||"").replace(/\/$/,"");
const BOOTSTRAP_TOKEN=String(process.env.KINGBOT_HOSTING_BOOTSTRAP_TOKEN||"").trim();
const NODE_ID=String(process.env.KINGBOT_HOST_NODE_ID||"").trim();
const NODE_TOKEN=String(process.env.KINGBOT_HOST_NODE_TOKEN||"").trim();
const POLL_MS=Math.max(5000,Number(process.env.KINGBOT_HOST_SUPERVISOR_POLL_MS||10000));
const BRIDGE_WAIT_MS=Math.max(15000,Number(process.env.KINGBOT_HOST_BRIDGE_WAIT_MS||60000));

if(!API_ORIGIN)throw new Error("KINGBOT_API_ORIGIN_REQUIRED");
if(!BOOTSTRAP_TOKEN && !NODE_TOKEN)throw new Error("KINGBOT_HOST_AUTH_REQUIRED");
if(!NODE_ID)throw new Error("KINGBOT_HOST_NODE_ID_REQUIRED");

const adapter=new Mt5RuntimeAdapter();
const active=new Map();

async function api(path,options={}){
  const response=await fetch(API_ORIGIN+path,{
    ...options,
    headers:{
      "content-type":"application/json",
      ...(NODE_TOKEN?{"x-kingbot-node-token":NODE_TOKEN}:{}),
      ...(options.headers||{})
    }
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(String(body.error||response.statusText||"HOSTING_API_ERROR"));
  return body;
}

async function mark(deployment,status,extra={}){
  return api("/api/mt5/hosting/node/deployment-state",{
    method:"POST",
    body:JSON.stringify({
      deploymentId:deployment.id,
      status,
      brokerProvider:deployment.broker_provider||"",
      accountId:deployment.account_id||"",
      ...extra
    })
  });
}

export async function superviseDeployment(deployment){
  const id=String(deployment?.id||"").trim();
  if(!id || active.has(id))return;
  active.set(id,{startedAt:Date.now(),stage:"starting"});
  try{
    if(String(deployment.broker_provider||"").toLowerCase()!=="mt5-bridge"){
      throw new Error("HOSTED_MT5_REQUIRES_MT5_BRIDGE");
    }

    active.get(id).stage="preflight";
    const preflight=await adapter.preflight();
    if(!preflight.ok)throw new Error(preflight.error);

    active.get(id).stage="prepare";
    await adapter.prepareDeployment(deployment);

    active.get(id).stage="launch";
    const launched=await adapter.launchDeployment(deployment);
    console.log(JSON.stringify({
      event:"mt5_terminal_started",
      deploymentId:id,
      pid:launched.pid||null
    }));

    const deadline=Date.now()+BRIDGE_WAIT_MS;
    while(Date.now()<deadline){
      const result=await api("/api/mt5/hosting/node/heartbeat",{method:"POST",body:"{}"});
      const current=(result.deployments||[]).find(item=>String(item.id)===id);
      if(current?.bridgeConnected){
        await mark(current,"RUNNING");
        active.get(id).stage="running";
        console.log(JSON.stringify({event:"mt5_host_running",deploymentId:id}));
        return;
      }
      await new Promise(resolve=>setTimeout(resolve,Math.min(POLL_MS,5000)));
    }

    await mark(deployment,"ERROR");
    console.error(JSON.stringify({
      event:"mt5_host_wait_timeout",
      deploymentId:id,
      reason:"MT5_EA_HEARTBEAT_TIMEOUT"
    }));
  }catch(error){
    try{await mark(deployment,"ERROR");}catch{}
    console.error(JSON.stringify({
      event:"mt5_host_error",
      deploymentId:id,
      message:String(error?.message||error)
    }));
  }finally{
    active.delete(id);
  }
}

export async function supervisorLoop(deploymentsProvider){
  while(true){
    try{
      const deployments=await deploymentsProvider();
      for(const deployment of deployments||[]){
        if(String(deployment.status||"").toUpperCase()==="PROVISIONING"){
          void superviseDeployment(deployment);
        }
      }
    }catch(error){
      console.error(JSON.stringify({event:"supervisor_loop_error",message:String(error?.message||error)}));
    }
    await new Promise(resolve=>setTimeout(resolve,POLL_MS));
  }
}
