const DEFAULTS={dailyDrawdownPct:5,totalDrawdownPct:10,maxRiskPerTradePct:1,maxPositions:3,lotSize:0.01,maxSpreadAtrRatio:0.25,staleDataMs:5000,maxConsecutiveLosses:3,autoPauseOnLossStreak:true};
const finite=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const clamp=(v,min,max)=>Math.min(max,Math.max(min,finite(v,min)));
export function normalizeRiskSettings(input={},defaults=DEFAULTS){
 const x={...defaults,...input};
 return {
  dailyDrawdownPct:clamp(x.dailyDrawdownPct,0.5,20),
  totalDrawdownPct:clamp(x.totalDrawdownPct,1,30),
  maxRiskPerTradePct:clamp(x.maxRiskPerTradePct,0.1,5),
  maxPositions:Math.round(clamp(x.maxPositions,1,50)),
  lotSize:Number(Math.max(0.01,Math.min(100,finite(x.lotSize,Number(defaults.lotSize||0.01))))),
  maxSpreadAtrRatio:clamp(x.maxSpreadAtrRatio,0.05,1),
  staleDataMs:Math.round(clamp(x.staleDataMs,500,30000)),
  maxConsecutiveLosses:Math.round(clamp(x.maxConsecutiveLosses,1,20)),
  autoPauseOnLossStreak:Boolean(x.autoPauseOnLossStreak)
 };
}
export function evaluateRisk(input={}){
 const r=normalizeRiskSettings(input.limits||{});
 const equity=finite(input.equity),dayStart=finite(input.dayStartEquity),peak=finite(input.peakEquity,equity),openPositions=finite(input.openPositions),riskPct=finite(input.requestedRiskPct),spread=finite(input.spread),atr=finite(input.atr),dataAgeMs=finite(input.dataAgeMs,0),consecutiveLosses=Math.max(0,finite(input.consecutiveLosses));
 const dailyDd=dayStart>0?Math.max(0,(dayStart-equity)/dayStart*100):0;
 const totalDd=peak>0?Math.max(0,(peak-equity)/peak*100):0;
 const checks=[
  ["DAILY_DRAWDOWN",dailyDd<r.dailyDrawdownPct],
  ["TOTAL_DRAWDOWN",totalDd<r.totalDrawdownPct],
  ["MAX_POSITIONS",openPositions<r.maxPositions],
  ["MAX_RISK_PER_TRADE",riskPct<=r.maxRiskPerTradePct],
  ["STALE_MARKET_DATA",dataAgeMs<=r.staleDataMs],
  ["SPREAD_FILTER",input.skipSpreadAtr===true||!(atr>0)||spread/atr<=r.maxSpreadAtrRatio],
  ["LOSS_STREAK",!r.autoPauseOnLossStreak||consecutiveLosses<r.maxConsecutiveLosses]
 ];
 const blocked=checks.filter(x=>!x[1]).map(x=>x[0]);
 return {allowed:blocked.length===0,blockedReasons:blocked,dailyDrawdownPct:dailyDd,totalDrawdownPct:totalDd,consecutiveLosses,limits:r};
}
export function authorizeOrder(input={}){
 if(input.killSwitch===true)return {allowed:false,reason:"KILL_SWITCH_ACTIVE"};
 if(input.executionMode!=="DEMO"&&input.executionMode!=="LIVE")return {allowed:false,reason:"EXECUTION_MODE_NOT_AUTHORIZED"};
 const risk=evaluateRisk(input); return risk.allowed?{allowed:true,risk}:{allowed:false,risk};
}
export { DEFAULTS };