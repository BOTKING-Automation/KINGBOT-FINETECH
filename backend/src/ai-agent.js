export function registerAiAgent(app,{requireUser,pool,broker,rateLimit}={}){
  const limiter=rateLimit?rateLimit({
    windowMs:60000,
    limit:Number(process.env.AI_AGENT_MAX_REQUESTS_PER_MINUTE||12),
    standardHeaders:"draft-8",
    legacyHeaders:false
  }):(_req,_res,next)=>next();

  app.get("/api/ai/agent/status",async(req,res)=>{
    const user=await requireUser(pool,req,res); if(!user)return;
    res.json({
      ok:true,
      agentReady:Boolean(process.env.XAI_API_KEY),
      model:String(process.env.XAI_AGENT_MODEL||"grok-4.3"),
      mode:"FAST_AGENT",
      authority:"ANALYSIS_ONLY"
    });
  });

  app.post("/api/ai/agent",limiter,async(req,res)=>{
    const user=await requireUser(pool,req,res); if(!user)return;
    const question=String(req.body?.message||"").trim().slice(0,3000);
    const symbol=String(req.body?.symbol||"XAUUSD").trim().toUpperCase().slice(0,30);
    if(!question)return res.status(400).json({ok:false,error:"AI_AGENT_MESSAGE_REQUIRED"});

    res.json({
      ok:true,
      agent:"KINGBOT",
      question,
      symbol,
      contextReady:Boolean(broker)
    });
  });
}
