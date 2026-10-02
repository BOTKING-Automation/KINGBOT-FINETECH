export function registerAiAgent(app){
  app.get("/api/ai/agent/status",(_req,res)=>{
    res.json({ok:true,agentReady:true,mode:"FAST_AGENT"});
  });
}
