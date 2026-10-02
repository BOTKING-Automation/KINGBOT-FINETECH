import { getBotDefinitions } from "./bot-engines.js";
import { evaluateKingbotBrain } from "./kingbot-brain.js";

const SYMBOLS = ["XAUUSD","EURUSD","GBPUSD","USDJPY","BTCUSD"];

function symbolFromText(text, fallback="XAUUSD"){
  const t=String(text||"").toUpperCase();
  for(const s of SYMBOLS) if(t.includes(s)) return s;
  if(/GOLD|XAU/.test(t)) return "XAUUSD";
  if(/BITCOIN|BTC/.test(t)) return "BTCUSD";
  if(/EURO|EUR/.test(t)) return "EURUSD";
  if(/POUND|GBP/.test(t)) return "GBPUSD";
  if(/YEN|JPY/.test(t)) return "USDJPY";
  return fallback;
}

function intent(text){
  const t=String(text||"").toLowerCase();
  if(/trade|entry|signal|setup|buy|sell|long|short|gold|xau|eurusd|gbpusd|usdjpy|btcusd|market|analysis|forex/.test(t)) return "MARKET_INTELLIGENCE";
  if(/risk|drawdown|exposure|stop loss|sl|take profit|tp/.test(t)) return "RISK_REVIEW";
  if(/bot|strateg|flipper|breakout|smc|ladder|strategic/.test(t)) return "BOT_INTELLIGENCE";
  if(/account|balance|equity|position|portfolio|broker|mt5|deriv/.test(t)) return "ACCOUNT_INTELLIGENCE";
  if(/price|quote|how much|current/.test(t)) return "LIVE_MARKET";
  return "PLATFORM_SUPPORT";
}

async function latestSnapshot(pool, symbol, timeframe="5m"){
  if(!pool) return null;
  try{
    const q=await pool.query(
      `SELECT payload,symbol,timeframe,bar_time,received_at
         FROM kingbot_tradingview_snapshots
        WHERE symbol=$1 AND timeframe=$2
        ORDER BY bar_time DESC LIMIT 1`,
      [symbol,timeframe]
    );
    const r=q.rows[0];
    if(!r) return null;
    return {...r.payload,symbol:r.symbol,timeframe:r.timeframe,barTime:r.bar_time,receivedAt:r.received_at,timestamp:r.received_at};
  }catch{return null}
}

function nativeMarketAnswer({question,symbol,quote,snapshot,brain}){
  if(!quote?.available && !snapshot){
    return {
      answer:`KINGBOT cannot verify live ${symbol} market conditions yet. Connect a live market-data source and provide a fresh TradingView snapshot before making a trading analysis.`,
      facts:["No verified live market snapshot is available."],
      technicalAnalysis:[],
      setup:{signal:"DATA_INSUFFICIENT",entry:null,waitFor:"Fresh verified market data.",invalidation:"No valid market data."},
      riskFlags:["MARKET_DATA_UNAVAILABLE"],
      nextAction:"Connect Twelve Data and/or TradingView and wait for a fresh snapshot."
    };
  }
  if(snapshot){
    const b=brain;
    return {
      answer:`KINGBOT native intelligence read for ${symbol}: ${b.decision.signal} with ${b.decision.confidence}% confluence confidence. This is an analysis state, not execution authorization.`,
      facts:[
        `Verified quote: ${quote?.price ?? snapshot.close ?? snapshot.price}`,
        `Snapshot received: ${snapshot.receivedAt || snapshot.barTime}`,
        `Timeframe: ${snapshot.timeframe || "5m"}`
      ],
      technicalAnalysis:snapshot.technicalAnalysis || [],
      setup:{
        signal:b.decision.signal,
        entry:b.market.price || null,
        waitFor:b.decision.reasons.join(" · "),
        invalidation:b.riskGate.reason
      },
      riskFlags:b.decision.signal==="ENTRY_CONFIRMING"?["RISK_GATE_REQUIRED","EXECUTION_NOT_AUTHORIZED"]:["NO_EXECUTION_AUTHORIZATION"],
      nextAction:b.decision.signal==="ENTRY_CONFIRMING"?"Run the deterministic risk gate before any execution.":"Wait for stronger verified confluence."
    };
  }
  return {
    answer:`KINGBOT has a verified live ${symbol} quote, but not enough technical structure to issue a setup.`,
    facts:[`Live quote: ${quote.price}`],
    technicalAnalysis:[],
    setup:{signal:"DATA_INSUFFICIENT",entry:quote.price,waitFor:"Fresh technical snapshot.",invalidation:"Technical confirmation unavailable."},
    riskFlags:["TECHNICAL_SNAPSHOT_MISSING"],
    nextAction:"Wait for TradingView technical data."
  };
}

export async function runNativeKingbotAI({question,symbol,twelveData,pool,broker,userId}={}){
  const requested=symbolFromText(question,symbol||"XAUUSD");
  const kind=intent(question);
  const quotes=twelveData?.enabled?twelveData.quotes([requested]):[];
  const quote=quotes[0]||null;

  if(kind==="BOT_INTELLIGENCE"){
    const defs=getBotDefinitions();
    const requestedBot=Object.entries(defs).find(([id,d])=>new RegExp(id.replace("-","|"),"i").test(String(question||"")))||null;
    const list=requestedBot?[requestedBot]:Object.entries(defs);
    return {
      provider:"KINGBOT_NATIVE",
      model:"KINGBOT-CORE-1",
      intent:kind,
      symbol:requested,
      reply:{
        answer:requestedBot?`${requestedBot[1].name} is a deterministic KINGBOT strategy engine. Its configuration is verified from the platform core.`:"KINGBOT has five independent strategy engines working under the central confluence and risk architecture.",
        facts:list.map(([id,d])=>`${d.name}: ${d.mode}; threshold ${d.signalThreshold}; risk/trade ${d.risk.maxRiskPerTradePct}%`),
        technicalAnalysis:list.flatMap(([id,d])=>[`${d.name} strategies: ${d.strategies.join(", ")}`,`Timeframes: regime ${d.timeframeProfile.regime}, setup ${d.timeframeProfile.setup}, execution ${d.timeframeProfile.execution}`]),
        setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Market analysis is required for a trade setup.",invalidation:"Not applicable."},
        riskFlags:["STRATEGY_INFORMATION_ONLY"],
        nextAction:"Ask KINGBOT to analyze a specific symbol for current verified market conditions."
      }
    };
  }

  if(kind==="ACCOUNT_INTELLIGENCE" && broker && userId){
    try{
      const status=await broker.getStatus(userId);
      const account=status?.connected?await broker.getAccount(userId):null;
      const positions=status?.connected?await broker.getPositions(userId):[];
      const a=account?.data||account||{};
      const p=Array.isArray(positions?.data)?positions.data:(Array.isArray(positions)?positions:[]);
      return {
        provider:"KINGBOT_NATIVE",model:"KINGBOT-CORE-1",intent:kind,symbol:requested,
        reply:{
          answer:status?.connected?"KINGBOT verified the connected broker account and current positions.":"No connected broker account is available.",
          facts:[`Broker connected: ${Boolean(status?.connected)}`,`Balance: ${a.balance ?? "unavailable"}`,`Equity: ${a.equity ?? "unavailable"}`,`Open positions: ${p.length}`],
          technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Not a market setup request.",invalidation:"Not applicable."},
          riskFlags:status?.connected?[]:["BROKER_NOT_CONNECTED"],nextAction:status?.connected?"Review risk exposure before execution.":"Connect a broker account."
        }
      };
    }catch{}
  }

  const snapshot=await latestSnapshot(pool,requested,"5m");
  const brain=snapshot?evaluateKingbotBrain(snapshot,{maxAgeMs:Number(process.env.KINGBOT_BRAIN_MAX_DATA_AGE_MS||5000)}):null;
  const reply=nativeMarketAnswer({question,symbol:requested,quote,snapshot,brain});
  return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORE-1",intent:kind,symbol:requested,reply,verified:{quote:Boolean(quote?.available),technicalSnapshot:Boolean(snapshot),brain:Boolean(brain)}};
}
