const DEFAULT_POLL_MS=10000;
const DEFAULT_BRIDGE_WAIT_MS=60000;

export function createMt5HostSupervisor({api,adapter,pollMs=DEFAULT_POLL_MS,bridgeWaitMs=DEFAULT_BRIDGE_WAIT_MS}={}){
  if(typeof api!=="function")throw new Error("HOSTING_API_CLIENT_REQUIRED");
  if(!adapter)throw new Error("MT5_RUNTIME_ADAPTER_REQUIRED");

  const active=new Map();

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

  async function superviseDeployment(deployment){
    const id=String(deployment?.id||"").trim();
    if(!id||active.has(id))return;
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

      const deadline=Date.now()+Math.max(15000,Number(bridgeWaitMs)||DEFAULT_BRIDGE_WAIT_MS);
      while(Date.now()<deadline){
        const result=await api("/api/mt5/hosting/node/heartbeat",{method:"POST",body:"{}"});
        const current=(result.deployments||[]).find(item=>String(item.id)===id);
        if(current?.bridgeConnected){
          await mark(current,"RUNNING");
          active.get(id).stage="running";
          console.log(JSON.stringify({event:"mt5_host_running",deploymentId:id}));
          return;
        }
        await new Promise(resolve=>setTimeout(resolve,Math.min(Math.max(5000,Number(pollMs)||DEFAULT_POLL_MS),5000)));
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

  async function loop(deploymentsProvider){
    if(typeof deploymentsProvider!=="function")throw new Error("DEPLOYMENT_PROVIDER_REQUIRED");
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
      await new Promise(resolve=>setTimeout(resolve,Math.max(5000,Number(pollMs)||DEFAULT_POLL_MS)));
    }
  }

  return {superviseDeployment,loop,active};
}
