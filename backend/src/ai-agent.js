import { TwelveDataFeed } from "./twelve-data-feed.js";
import { getBotDefinitions } from "./bot-engines.js";
import { runNativeKingbotAI } from "./kingbot-native-ai.js";
import { webSearchStatus } from "./kingbot-web-search.js";
import { identitySnapshot, buildCognitivePlan, capabilitySet, qualityAudit } from "./kingbot-intelligence-core.js";

const DEFAULT_SYMBOLS=["XAUUSD","EURUSD","GBPUSD","USDJPY","BTCUSD"];
const MODEL="KINGBOT-CORTEX-1";
const EXTERNAL_PROVIDER="none";

const SYSTEM=`You are KINGBOT AI, the proprietary intelligence agent for KINGBOT FINTECH.
You operate as a persistent intelligence core, not a chatbot. Maintain the KINGBOT identity, mission and cognitive discipline supplied in context.
You are a market-intelligence and platform-operations agent, not a profit predictor.
Use ONLY supplied verified context. Never invent prices, trades, broker state, account values, performance, news, or technical indicators.
When live market context is unavailable, say so clearly.
For trading analysis, distinguish FACTS, TECHNICAL READ, SETUP, WAIT CONDITION, INVALIDATION, and RISK.
Do not promise profit or certainty.
Never place, modify, close, or authorize a live trade from chat. Execution authority remains with deterministic strategy and risk engines.
You understand the five KINGBOT engines: strategic, flipper, breakout, smc-pro, ladder-flip.
Be concise but technically deep. Never expose hidden chain-of-thought. Return a compact reasoning summary, evidence conflicts, uncertainty and validation steps instead. Return JSON only.`;

function cleanSymbol(value){const v=String(value||"XAUUSD").trim().toUpperCase();return DEFAULT_SYMBOLS.includes(v)?v:"XAUUSD";}
function safeJson(value){try{return JSON.parse(String(value||"").trim())}catch{return null}}
function buildContext({symbol,twelveData,broker,botDefinitions}){
  const quotes=twelveData?.enabled?twelveData.quotes(DEFAULT_SYMBOLS):[];
  return {
    timestamp:new Date().toISOString(),
    marketData:twelveData?.status?.()||{configured:false},
    liveQuotes:quotes,
    requestedSymbol:symbol,
    botEngines:Object.fromEntries(Object.entries(botDefinitions||{}).map(([id,b])=>[id,{name:b.name,mode:b.mode,strategies:b.strategies,signalThreshold:b.signalThreshold,risk:b.risk,timeframeProfile:b.timeframeProfile}])),
    executionAuthority:"DETERMINISTIC_ENGINE_AND_RISK_GATE_ONLY"
  };
}

export function registerAiAgent(app,{requireUser,pool,broker,rateLimit,twelveData}={}){
  const feed=twelveData||new TwelveDataFeed();
  if(!twelveData)feed.start();
  const limiter=rateLimit?rateLimit({windowMs:60000,limit:Number(process.env.AI_AGENT_MAX_REQUESTS_PER_MINUTE||12),standardHeaders:"draft-8",legacyHeaders:false}):(_req,_res,next)=>next();

  app.get("/api/ai/agent/status",async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    let brokerStatus={connected:false};
    try{brokerStatus=await broker.getStatus(user.id)}catch{}
    res.json({
      ok:true,agentReady:true,nativeReady:true,externalProvider:EXTERNAL_PROVIDER,model:EXTERNAL_PROVIDER==="gemini"&&ai?MODEL:"KINGBOT-CORE-1",mode:"KINGBOT_NATIVE_INTELLIGENCE_AGENT",
      authority:"ANALYSIS_ONLY",marketData:feed.status(),brokerConnected:Boolean(brokerStatus?.connected),
      engines:Object.keys(getBotDefinitions()),webResearch:webSearchStatus(),identity:identitySnapshot(),cognitiveLoop:identitySnapshot().cognitiveLoop
    });
  });

  app.post("/api/ai/agent",limiter,async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const question=String(req.body?.message||"").trim().slice(0,3000);
    const symbol=cleanSymbol(req.body?.symbol);
    if(!question)return res.status(400).json({ok:false,error:"AI_AGENT_MESSAGE_REQUIRED"});
    const conversation=Array.isArray(req.body?.conversation)?req.body.conversation.slice(-6).map(item=>({role:item?.role==="assistant"?"assistant":"user",content:String(item?.content||"").slice(0,1800)})):[];
    const native=await runNativeKingbotAI({question,symbol,twelveData:feed,pool,broker,userId:user.id,conversation});
    const cognitivePlan=native?.cognition?.plan || buildCognitivePlan({intent:native?.intent || "PLATFORM_SUPPORT",symbol,conversation});

    // Connection/account/runtime questions must stay on the verified native
    // path so an external language model cannot invent or reinterpret private
    // broker state when the account is not connected.
    if(["CONNECTION_INTELLIGENCE","ACCOUNT_INTELLIGENCE","RUNTIME_INTELLIGENCE"].includes(String(native?.intent||""))){
      return res.json({ok:true,agent:"KINGBOT",...native,cognitivePlan,sources:native.sources||[],generatedAt:new Date().toISOString(),executionAuthority:"NONE"});
    }

    return res.json({
      ok:true,
      agent:"KINGBOT",
      model:MODEL,
      provider:"KINGBOT_NATIVE",
      symbol,
      identity:identitySnapshot(),
      cognitivePlan,
      cognitionAudit:native?.cognition?.audit||null,
      cognition:native?.cognition||null,
      reply:native?.reply||{},
      sources:native.sources||[],
      generatedAt:new Date().toISOString(),
      executionAuthority:"NONE"
    });
  });
}
