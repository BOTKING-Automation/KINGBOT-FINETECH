/*
 * KINGBOT CORTEX BOT SUPERVISOR
 * Deterministic supervisory review; no external model dependency.
 */
const lastReview=new Map();
const REVIEW_TTL_MS=60000;

const n=v=>Number.isFinite(Number(v))?Number(v):0;

export async function monitorBotDecision({userId,botId,analysis,market,risk,tradePlan,force=false}={}){
  if(!userId||!botId||!analysis)return null;
  const key=String(userId)+":"+String(botId);
  const now=Date.now();
  if(!force&&now-(lastReview.get(key)||0)<REVIEW_TTL_MS)return null;
  lastReview.set(key,now);

  const checks=[];
  const blocks=Array.isArray(risk?.blocks)?risk.blocks.map(String):[];
  const flags=Array.isArray(risk?.flags)?risk.flags.map(String):[];
  const score=n(analysis?.score);
  const signal=String(analysis?.signal||"NO_SIGNAL").toUpperCase();
  const planSide=String(tradePlan?.side||"").toUpperCase();
  const marketDirection=n(market?.trend)+n(market?.momentum);

  if(score>=70)checks.push("DETERMINISTIC_SCORE_STRONG"); else checks.push("DETERMINISTIC_SCORE_BELOW_STRONG_THRESHOLD");
  if(blocks.length)checks.push("RISK_BLOCKS_PRESENT");
  else checks.push("NO_RISK_BLOCKS");
  if(planSide&&((planSide==="BUY"&&marketDirection<0)||(planSide==="SELL"&&marketDirection>0)))checks.push("PLAN_MARKET_DIRECTION_CONFLICT");
  if(n(market?.spread)>0&&n(market?.atr)>0&&n(market.spread)/Math.max(n(market.atr),1e-12)>.25)checks.push("SPREAD_ELEVATED");
  if(/NO_SIGNAL|WAIT/.test(signal))checks.push("NO_EXECUTABLE_SIGNAL");

  const hardBlock=blocks.length||checks.includes("PLAN_MARKET_DIRECTION_CONFLICT");
  return {
    status:hardBlock?"BLOCK_REVIEW":checks.length>2?"CAUTION":"CLEAR",
    note:hardBlock
      ?"KINGBOT Cortex detected a deterministic risk or direction conflict; execution remains blocked by the authoritative controls."
      :"KINGBOT Cortex completed a deterministic supervisory review of strategy, market and risk evidence.",
    checks:checks.slice(0,8),
    at:new Date().toISOString(),
    provider:"KINGBOT_CORTEX",
    model:"KINGBOT-CORTEX-1"
  };
}
