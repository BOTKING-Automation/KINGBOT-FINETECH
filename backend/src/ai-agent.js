import { GoogleGenAI } from "@google/genai";
import { TwelveDataFeed } from "./twelve-data-feed.js";
import { getBotDefinitions } from "./bot-engines.js";

const DEFAULT_SYMBOLS=["XAUUSD","EURUSD","GBPUSD","USDJPY","BTCUSD"];
const MODEL=String(process.env.GEMINI_AGENT_MODEL||process.env.GEMINI_MODEL||"gemini-2.5-flash-lite").trim();
const API_KEY=String(process.env.GEMINI_API_KEY||"").trim();
const ai=API_KEY?new GoogleGenAI({apiKey:API_KEY}):null;

const SYSTEM=`You are KINGBOT AI, the proprietary intelligence agent for KINGBOT FINTECH.
You are a market-intelligence and platform-operations agent, not a profit predictor.
Use ONLY supplied verified context. Never invent prices, trades, broker state, account values, performance, news, or technical indicators.
When live market context is unavailable, say so clearly.
For trading analysis, distinguish FACTS, TECHNICAL READ, SETUP, WAIT CONDITION, INVALIDATION, and RISK.
Do not promise profit or certainty.
Never place, modify, close, or authorize a live trade from chat. Execution authority remains with deterministic strategy and risk engines.
You understand the five KINGBOT engines: strategic, flipper, breakout, smc-pro, ladder-flip.
Be concise but technically deep. Return JSON only.`;

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
      ok:true,agentReady:Boolean(ai),model:ai?MODEL:null,mode:"KINGBOT_INTELLIGENCE_AGENT",
      authority:"ANALYSIS_ONLY",marketData:feed.status(),brokerConnected:Boolean(brokerStatus?.connected),
      engines:Object.keys(getBotDefinitions())
    });
  });

  app.post("/api/ai/agent",limiter,async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const question=String(req.body?.message||"").trim().slice(0,3000);
    const symbol=cleanSymbol(req.body?.symbol);
    if(!question)return res.status(400).json({ok:false,error:"AI_AGENT_MESSAGE_REQUIRED"});
    if(!ai)return res.status(503).json({ok:false,error:"KINGBOT_AI_NOT_CONFIGURED",message:"Configure GEMINI_API_KEY on the backend."});

    const context=buildContext({symbol,twelveData:feed,broker,botDefinitions:getBotDefinitions()});
    let account=null,positions=[];
    try{
      const status=await broker.getStatus(user.id);
      if(status?.connected){
        try{const a=await broker.getAccount(user.id);const r=a?.data||a;account={balance:Number.isFinite(Number(r?.balance))?Number(r.balance):null,equity:Number.isFinite(Number(r?.equity))?Number(r.equity):null,currency:r?.currency||null,executionMode:status.executionMode||null}}catch{}
        try{const p=await broker.getPositions(user.id);positions=(Array.isArray(p?.data)?p.data:Array.isArray(p)?p:[]).slice(0,20).map(x=>({symbol:x.symbol||null,type:x.type||x.side||null,volume:Number.isFinite(Number(x.volume))?Number(x.volume):null,profit:Number.isFinite(Number(x.profit))?Number(x.profit):null}))}catch{}
      }
    }catch{}
    context.account=account;
    context.positions=positions;

    const prompt=`USER REQUEST:
${question}

VERIFIED KINGBOT CONTEXT:
${JSON.stringify(context)}

Respond with JSON:
{
 "answer":"...",
 "symbol":"...",
 "intent":"MARKET_ANALYSIS|BOT_INTELLIGENCE|RISK_REVIEW|PLATFORM_HELP|GENERAL",
 "facts":["..."],
 "technicalAnalysis":["..."],
 "setup":{"signal":"ENTRY_CONFIRMING|WAIT|NO_TRADE|DATA_INSUFFICIENT","entry":null,"waitFor":"...","invalidation":"..."},
 "riskFlags":["..."],
 "nextAction":"..."
}`;

    try{
      const response=await ai.models.generateContent({
        model:MODEL,
        contents:prompt,
        config:{systemInstruction:SYSTEM,responseMimeType:"application/json",maxOutputTokens:900,temperature:0.15}
      });
      const parsed=safeJson(response.text)||{answer:String(response.text||"KINGBOT AI returned no structured answer.")};
      return res.json({ok:true,agent:"KINGBOT",model:MODEL,symbol,context,reply:parsed,generatedAt:new Date().toISOString()});
    }catch(error){
      console.error("[KINGBOT AI AGENT]",error?.message||error);
      return res.status(502).json({ok:false,error:"KINGBOT_AI_AGENT_FAILED",message:String(error?.message||"AI agent failed").slice(0,220)});
    }
  });
}
