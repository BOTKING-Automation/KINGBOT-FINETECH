import { GoogleGenAI } from "@google/genai";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const API_KEY = String(process.env.GEMINI_API_KEY || "").trim();
const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;
const lastReview = new Map();
const REVIEW_TTL_MS = 60000;

const SYSTEM = `You are the KINGBOT Strategy Supervisor. You monitor autonomous bot decisions without slowing execution.
You are a supervisory layer, not the execution authority.
Review only the supplied market, strategy, risk and trade-plan facts.
Return compact JSON with:
{"status":"CLEAR|CAUTION|BLOCK_REVIEW","note":"...","checks":["..."]}
Do not invent market data, performance, confidence, broker state, or fills.
A BLOCK_REVIEW is advisory only; the deterministic KINGBOT risk engine remains authoritative.
Keep note under 220 characters.`;

export async function monitorBotDecision({userId,botId,analysis,market,risk,tradePlan,force=false}={}) {
  if (!ai || !userId || !botId || !analysis) return null;

  const key=String(userId)+":"+String(botId);
  const now=Date.now();
  const previous=lastReview.get(key)||0;
  if(!force && now-previous<REVIEW_TTL_MS)return null;
  lastReview.set(key,now);

  const prompt=`BOT: ${botId}
ANALYSIS: ${JSON.stringify(analysis)}
MARKET: ${JSON.stringify(market)}
RISK: ${JSON.stringify(risk)}
TRADE PLAN: ${JSON.stringify(tradePlan)}
Review setup quality, strategy alignment, execution conditions and obvious risk contradictions. Output JSON only.`;

  try{
    const response=await ai.models.generateContent({
      model:MODEL,
      contents:prompt,
      config:{systemInstruction:SYSTEM,temperature:0.1,maxOutputTokens:180,responseMimeType:"application/json"}
    });
    const parsed=JSON.parse(String(response.text||"").trim());
    const status=["CLEAR","CAUTION","BLOCK_REVIEW"].includes(parsed.status)?parsed.status:"CAUTION";
    return {
      status,
      note:String(parsed.note||"Supervisor review completed.").slice(0,220),
      checks:Array.isArray(parsed.checks)?parsed.checks.slice(0,5).map(x=>String(x).slice(0,100)):[],
      at:new Date().toISOString()
    };
  }catch(error){
    console.error("[KINGBOT AI SUPERVISOR]",error?.message||error);
    return {
      status:"CAUTION",
      note:"AI supervisor temporarily unavailable; deterministic risk gates remain authoritative.",
      checks:["AI_MONITOR_UNAVAILABLE"],
      at:new Date().toISOString()
    };
  }
}
