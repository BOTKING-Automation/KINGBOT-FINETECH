const DEFAULTS={dailyDrawdownPct:5,totalDrawdownPct:10,maxRiskPerTradePct:1,maxPositions:3,maxSpreadAtrRatio:0.25,staleDataMs:5000};
const finite=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
export function evaluateRisk(input={}){
 const r={...DEFAULTS,...(input.limits||{})};
 const equity=finite(input.equity),dayStart=finite(input.dayStartEquity),peak=finite(input.peakEquity,equity),openPositions=finite(input.openPositions),riskPct=finite(input.requestedRiskPct),spread=finite(input.spread),atr=finite(input.atr),dataAgeMs=finite(input.dataAgeMs,0);
 const dailyDd=dayStart>0?Math.max(0,(dayStart-equity)/dayStart*100):0;
 const totalDd=peak>0?Math.max(0,(peak-equity)/peak*100):0;
 const checks=[
  ["DAILY_DRAWDOWN",dailyDd<r.dailyDrawdownPct],
  ["TOTAL_DRAWDOWN",totalDd<r.totalDrawdownPct],
  ["MAX_POSITIONS",openPositions<r.maxPositions],
  ["MAX_RISK_PER_TRADE",riskPct<=r.maxRiskPerTradePct],
  ["STALE_MARKET_DATA",dataAgeMs<=r.staleDataMs],
  ["SPREAD_FILTER",!(atr>0)||spread/atr<=r.maxSpreadAtrRatio]
 ];
 const blocked=checks.filter(x=>!x[1]).map(x=>x[0]);
 return {allowed:blocked.length===0,blockedReasons:blocked,dailyDrawdownPct:dailyDd,totalDrawdownPct:totalDd,limits:r};
}
export function authorizeOrder(input={}){
 if(input.killSwitch===true)return {allowed:false,reason:"KILL_SWITCH_ACTIVE"};
 if(input.executionMode!=="PAPER"&&input.executionMode!=="LIVE")return {allowed:false,reason:"EXECUTION_MODE_NOT_AUTHORIZED"};
 const risk=evaluateRisk(input); return risk.allowed?{allowed:true,risk}:{allowed:false,risk};
}
