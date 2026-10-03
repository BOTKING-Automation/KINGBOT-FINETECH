import { getBotDefinitions } from "./bot-engines.js";
import { runStandaloneMarketScan } from "./ai-market-scanner.js";
import { evaluateKingbotBrain } from "./kingbot-brain.js";
import { searchWeb, webSearchStatus } from "./kingbot-web-search.js";
import { getPlans, BOT_NAMES } from "./subscriptions.js";
import { searchTechnicalAnalysisBook, technicalAnalysisBookContext } from "./technical-analysis-book.js";
import { buildCognitivePlan, capabilitySet, identitySnapshot, qualityAudit, normalizeThinkingLevel, thinkingProfile } from "./kingbot-intelligence-core.js";
import { orchestrateKingbotIntelligence } from "./intelligence-orchestrator.js";
import { loadAdaptivePerformance } from "./adaptive-intelligence.js";
import { think } from "./kingbot-cognitive-engine.js";
import { conversationalReply, conversationSignals, conversationFrame } from "./kingbot-dialogue-cortex.js";
import { createKingbotAgent, agentAnswer } from "./kingbot-agent-core.js";
import { getMarketPageSnapshot } from "./market-page-feed.js";
import { loadUserMemory, learnExplicitUserMemory, summarizeUserMemory } from "./kingbot-user-memory.js";
import { executeKingbotAgentTools, summarizeToolContext, verifiedToolFacts } from "./kingbot-agent-tools.js";

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

function intent(text, conversation=[]){
  const t=String(text||"").toLowerCase().trim();
  const signals=conversationSignals(text,conversation)||{};
  const dialogueIntent=String(signals.intent||"");
  const mapped={
    GREETING:"CONVERSATION",
    WELLBEING:"CONVERSATION",
    FOLLOW_UP:"CONVERSATION",
    PRESENCE:"CONVERSATION",
    THANKS:"CONVERSATION",
    APPRECIATION:"CONVERSATION",
    GOODBYE:"CONVERSATION",
    IDENTITY:"CONVERSATION",
    INTELLIGENCE:"CONVERSATION",
    CAPABILITY:"CONVERSATION",
    EMOTION_PROBE:"CONVERSATION",
    HELP:"CONVERSATION",
    META_FEEDBACK:"CONVERSATION",
    CASUAL:"CONVERSATION",
    RESEARCH:"WEB_RESEARCH",
    CONNECTION:"CONNECTION_INTELLIGENCE",
    ACCOUNT:"ACCOUNT_INTELLIGENCE",
    RISK:"RISK_REVIEW",
    BOT:"BOT_INTELLIGENCE",
    MARKET:"MARKET_INTELLIGENCE",
    PLATFORM:"PLATFORM_SUPPORT",
    GENERAL:"PLATFORM_SUPPORT",
    GENERAL_KNOWLEDGE:"GENERAL_KNOWLEDGE",
    PROGRAMMING:"PROGRAMMING"
  };
  // Specific KINGBOT identity questions must beat the generic PLATFORM route.
  if(/^(what is|what's|tell me about|explain)\s+(kingbot|kingbot fintech|this platform|the platform)\b/.test(t)
    ||/\bwhat does kingbot do\b|\bwhat is kingbot fintech\b|\bwhat can kingbot do\b/.test(t)) return "KINGBOT_KNOWLEDGE";

  if(mapped[dialogueIntent]) return mapped[dialogueIntent];
  if(/^(hi|hello|hey|yo|good morning|good afternoon|good evening|howdy|greetings)\b/.test(t)||/\bhow are you\b|\bwho are you\b|\bwhat are you\b|\bthank you\b|\bthanks\b|\bbye\b|\bgood night\b/.test(t)) return "CONVERSATION";
  if(/^(what is|what's|tell me about|explain)\s+(kingbot|kingbot fintech|this platform|the platform)\b/.test(t)
    ||/\bwhat does kingbot do\b|\bwhat is kingbot fintech\b|\bwhat can kingbot do\b/.test(t)) return "KINGBOT_KNOWLEDGE";
  if(/\bwhat time is it\b|\bcurrent time\b|\bwhat is the time\b|\bwhat's the time\b|\btime now\b|\bwhat day is it\b|\bwhat date is it\b|\btoday'?s date\b|\bcurrent date\b/.test(t)) return "TIME";
  if(/\b(my )?(broker )?(connection|connected|connect|disconnect|connection status)\b|\bwhich broker\b|\bbroker status\b|\bderiv connection\b|\bmt5 connection\b/.test(t)) return "CONNECTION_INTELLIGENCE";
  if(/\b(account|balance|equity|margin|free margin|position|positions|portfolio|account status)\b/.test(t)) return "ACCOUNT_INTELLIGENCE";
  if(/\bbot status\b|\bis .*running\b|\bwhat is running\b|\bruntime\b|\bdiagnos(e|is)\b|\berror\b|\bwhy is .*bot\b|\bstopped\b|\bpaused\b/.test(t)) return "RUNTIME_INTELLIGENCE";
  if(/\b(what is happening|what happened|latest|today|this week|news|headline|headlines|breaking)\b/.test(t) && /\b(gold|xau|eurusd|gbpusd|usdjpy|btcusd|bitcoin|forex|market)\b/.test(t)) return "MARKET_RESEARCH";
  if(/google|search the web|search online|look up|find online|latest news|news about|research online|internet/.test(t)) return "WEB_RESEARCH";
  if(/technical analysis book|ta book|analysis book|charting book|technical analysis chapter|learn technical analysis/.test(t)) return "TECHNICAL_ANALYSIS_BOOK";
  if(/risk|drawdown|exposure|stop loss|\bsl\b|take profit|\btp\b/.test(t)) return "RISK_REVIEW";
  if(/bot|strateg|flipper|breakout|smc|ladder|strategic/.test(t)) return "BOT_INTELLIGENCE";
  if(/store|shop|product|pricing|plan|subscription|purchase|checkout|payment|mpesa|license|upgrade|professional|institutional|basic/.test(t)) return "STORE_INTELLIGENCE";
  if(/trade|entry|signal|setup|sell|long|short|gold|xau|eurusd|gbpusd|usdjpy|btcusd|market|analysis|forex|quote|price|candles|trend/.test(t)) return "MARKET_INTELLIGENCE";
  return "PLATFORM_SUPPORT";
}
function utilityReply(question){
  const t=String(question||"").toLowerCase().trim();
  if(/\bwhat time is it\b|\bcurrent time\b|\bwhat is the time\b|\bwhat's the time\b|\btime now\b|\bwhat day is it\b|\bwhat date is it\b|\btoday'?s date\b|\bcurrent date\b/.test(t)){
    const now=new Date();
    const eat=new Intl.DateTimeFormat("en-KE",{timeZone:"Africa/Nairobi",dateStyle:"full",timeStyle:"medium"}).format(now);
    const utc=new Intl.DateTimeFormat("en-GB",{timeZone:"UTC",dateStyle:"full",timeStyle:"medium"}).format(now);
    return {answer:"The current East Africa Time (EAT) is "+eat+".",facts:["EAT timezone: Africa/Nairobi (UTC+3).","Server UTC: "+utc],technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"No market analysis requested.",invalidation:"Not applicable."},riskFlags:[],nextAction:"Ask KINGBOT your next question."};
  }
  return null;
}

function technicalAnalysisBookReply(question){
  const chapters=searchTechnicalAnalysisBook(question);
  const listed=chapters.map(ch=>`Chapter ${ch.id}: ${ch.title} — ${ch.principles.join(" ")}`);
  return {
    answer:"KINGBOT Technical Analysis AI Book is the methodology reference used to teach and explain the scanner's evidence-first analysis process.",
    facts:listed,
    technicalAnalysis:[
      "Evidence before conclusion.",
      "Structure before indicator.",
      "Context before pattern.",
      "Volatility before fixed distances.",
      "Invalidation before execution.",
      "Predicted pending-order zones are structural inference, not confirmed broker orders."
    ],
    setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Use the relevant chapter as a learning framework, then verify live market data before making a setup decision.",invalidation:"Education does not override live-data, risk or execution controls."},
    riskFlags:["EDUCATIONAL_REFERENCE","NO_PROFIT_GUARANTEE"],
    nextAction:"Open the KINGBOT Technical Analysis AI Book page or ask for a specific chapter such as RSI, market structure, liquidity, FVG or pending-order inference."
  };
}

function kingbotKnowledgeReply(question){
  const t=String(question||"").toLowerCase().trim();

  if(/\bdoes kingbot hold my money\b|\bis kingbot a broker\b|\bkingbot a broker\b|\bwho is the broker\b/.test(t)){
    return {
      answer:"KINGBOT FINTECH is a trading-technology and automation platform; it is not itself a broker or a bank. Broker accounts remain with the connected broker, while KINGBOT provides the intelligence, strategy, risk and automation layer around the authorized account.",
      facts:[
        "KINGBOT: trading technology, intelligence and automation layer.",
        "Broker: the external trading account provider.",
        "Account data: read from verified backend/broker connections when available.",
        "Execution: subject to broker validation plus KINGBOT server-side strategy and risk controls."
      ],
      technicalAnalysis:[],
      setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"No market setup requested.",invalidation:"Not applicable."},
      riskFlags:["BROKER_AND_PLATFORM_ARE_SEPARATE"],
      nextAction:"Ask “how does KINGBOT work?” or “what are the five KINGBOT engines?”"
    };
  }

  if(/\bcan kingbot trade\b|\bdoes kingbot trade\b|\bkingbot execute trades\b|\bcan it execute\b/.test(t)){
    return {
      answer:"KINGBOT is designed to automate trading only through an authorized broker connection and the platform's server-side execution path. AI chat itself is not the execution authority.",
      facts:[
        "Broker authorization is required.",
        "Strategy engines generate candidate actions from market context.",
        "Risk controls evaluate whether execution is allowed.",
        "The execution layer sends broker orders only after its own validation gates.",
        "AI conversation cannot bypass those controls or independently authorize a live order."
      ],
      technicalAnalysis:[],
      setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"A verified broker connection and strategy/risk conditions.",invalidation:"Execution controls reject invalid or unauthorized requests."},
      riskFlags:["EXECUTION_REMAINS_SERVER_CONTROLLED"],
      nextAction:"Ask about broker connection, risk controls, or a specific bot engine."
    };
  }

  if(/\bfive (kingbot )?(bot|strategy|engine)s?\b|\bwhat are the (five|5)\b.*\bkingbot\b/.test(t)){
    const defs=getBotDefinitions();
    return {
      answer:"KINGBOT currently defines five specialized strategy engines. They share the platform's risk architecture but use different market-selection logic and time horizons.",
      facts:Object.values(defs).map(d=>d.name+" · "+d.mode),
      technicalAnalysis:Object.values(defs).map(d=>d.name+": "+d.strategies.join(", ")+" · regime "+d.timeframeProfile.regime+" · setup "+d.timeframeProfile.setup+" · execution "+d.timeframeProfile.execution),
      setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Choose a specific engine for deeper explanation.",invalidation:"Not applicable."},
      riskFlags:["STRATEGY_DESCRIPTIONS_ARE_NOT_PERFORMANCE_GUARANTEES"],
      nextAction:"Ask “explain KINGBOT SMC PRO” or “explain LADDER FLIP V8”."
    };
  }

  return {
    answer:"KINGBOT FINTECH is a trading-technology and automation platform that brings together market data, AI intelligence, strategy engines, risk controls, broker connectivity, execution infrastructure and analytics in one system.",
    facts:[
      "MARKET DATA: broker quotes and supported external market feeds provide verified inputs when connected.",
      "INTELLIGENCE: KINGBOT AI explains platform state, account context, strategy logic and market information.",
      "STRATEGY: five engines — Strategic, Flipper, Breakout, SMC PRO and Ladder Flip V8.",
      "RISK: server-side drawdown, position, spread, stale-data and kill-switch controls.",
      "RUNTIME: worker services manage configured bot cycles and record state, signals and execution telemetry.",
      "EXECUTION: broker orders remain outside the conversational AI layer and require the platform's authorization and risk gates.",
      "TRUST: account-specific values are shown only when verified by backend sources."
    ],
    technicalAnalysis:[
      "Strategic: trend-following, mean-reversion, volatility-regime and multi-factor consensus.",
      "Flipper: micro-momentum, impulse continuation, rapid reversal and spread filtering.",
      "Breakout: range compression, level breakout, volatility confirmation and retest continuation.",
      "SMC PRO: market structure, liquidity sweeps, order blocks, fair-value gaps and displacement.",
      "Ladder Flip V8: EMA20/EMA50 trend gate, ADX strength, RSI confirmation, velocity pyramiding and staircase profit-lock logic."
    ],
    setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Ask for a subsystem, engine, broker, risk layer or market analysis.",invalidation:"Not applicable."},
    riskFlags:["AI_OUTPUT_IS_DECISION_SUPPORT","NO_PROFIT_GUARANTEE"],
    nextAction:"Ask a specific follow-up such as “how does KINGBOT work?”, “what is SMC PRO?”, or “what is my connection?”"
  };
}


function marketTimeframes(baseTimeframe, thinkingLevel){
  const base=String(baseTimeframe||"15m").toLowerCase();
  const ordered=["5m","15m","1h","4h"];
  const level=normalizeThinkingLevel(thinkingLevel);
  const count=thinkingProfile(level).timeframes;
  const set=new Set([base]);
  for(const tf of ordered){ if(set.size>=count) break; set.add(tf); }
  return [...set].slice(0,count);
}

async function multiTimeframeMarketScan({pool,twelveData,symbol,timeframe,thinkingLevel}={}){
  const levels=marketTimeframes(timeframe,thinkingLevel);
  const scans=await Promise.all(levels.map(async tf=>{
    try{
      const scan=await runStandaloneMarketScan({pool,twelveData,symbols:[symbol],timeframe:tf});
      const item=(scan.technical||[]).find(x=>x.symbol===symbol)||{};
      const quote=(scan.quotes||[]).find(x=>x.symbol===symbol)||null;
      return {
        timeframe:tf, ok:Boolean(scan.ok), price:item.price??quote?.price??null,
        trend:String(item.trend||"NEUTRAL").toUpperCase(), momentum:Number(item.momentum||0),
        volatility:Number(item.volatility||0), structure:String(item.structure||item.bias||"unknown").toLowerCase(),
        adx:Number(item.adx||item.adx14||0), rsi:Number(item.rsi||item.rsi14||0),
        emaFast:Number(item.emaFast||item.ema20||0), emaSlow:Number(item.emaSlow||item.ema50||0),
        breakout:Boolean(item.breakout), retest:Boolean(item.retest),
        signal:String(item.signal||"WAIT"), score:Number(item.score||0),
        source:scan.source||item.source||"KINGBOT market engine",
        timestamp:quote?.timestamp||item.receivedAt||item.barTime||null,
        technicalCount:Number(scan.technicalCount||0)
      };
    }catch(error){
      return {timeframe:tf,ok:false,signal:"DATA_INSUFFICIENT",error:String(error?.message||"TIMEFRAME_SCAN_FAILED").slice(0,140)};
    }
  }));
  const usable=scans.filter(x=>x.ok);
  const bull=usable.filter(x=>x.trend==="BULLISH").length;
  const bear=usable.filter(x=>x.trend==="BEARISH").length;
  return {
    level:normalizeThinkingLevel(thinkingLevel), timeframes:scans,
    alignment:{bullish:bull,bearish:bear,total:usable.length,
      ratio:usable.length?Number((Math.max(bull,bear)/usable.length).toFixed(2)):0,
      direction:bull>bear?"BULLISH":bear>bull?"BEARISH":"MIXED"}
  };
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


function storeCatalog(){
  const plans=getPlans();
  return Object.values(plans).map(p=>({
    id:p.id,name:p.name,priceUsd:p.priceUsd,billing:p.billing,
    botLimit:p.botLimit,bots:p.bots.map(id=>({id,name:BOT_NAMES[id]||id})),
    selectableBots:p.selectableBots.map(id=>({id,name:BOT_NAMES[id]||id})),
    features:[...p.features]
  }));
}

async function storeSupport(pool,userId,question){
  const t=String(question||"").toLowerCase();
  const catalog=storeCatalog();
  const requestedPlan=Object.values(getPlans()).find(p =>
    t.includes(p.id) || t.includes(p.name.toLowerCase()) ||
    (p.id==="starter" && /basic/.test(t)) ||
    (p.id==="pro" && /professional/.test(t))
  );
  if(/my|my order|my payment|payment status|purchase status|subscription status|what did i buy|what do i own|my plan|my access/.test(t)){
    if(!pool||!userId) return {answer:"Sign in so KINGBOT can securely inspect your private store records.",facts:[],riskFlags:["AUTHENTICATION_REQUIRED"],nextAction:"Sign in and ask again."};
    try{
      await pool.query("UPDATE kingbot_subscriptions SET status='expired' WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=NOW()");
      const [sub,payments,entitlements]=await Promise.all([
        pool.query("SELECT plan_id,status,started_at,expires_at,approved_at FROM kingbot_subscriptions WHERE user_id=$1 ORDER BY started_at DESC LIMIT 5",[userId]),
        pool.query("SELECT plan_id,status,amount_kes,submitted_at,reviewed_at,selected_bot_id FROM kingbot_payments WHERE user_id=$1 ORDER BY submitted_at DESC LIMIT 10",[userId]),
        pool.query("SELECT e.bot_id,e.active,s.plan_id,s.status,s.expires_at FROM kingbot_bot_entitlements e LEFT JOIN kingbot_subscriptions s ON s.id=e.subscription_id WHERE e.user_id=$1 ORDER BY e.granted_at DESC LIMIT 20",[userId])
      ]);
      return {
        answer:"KINGBOT verified your private store, payment and entitlement records.",
        facts:[
          ...sub.rows.map(x=>`Subscription: ${x.plan_id||"—"} · ${x.status||"—"} · expires ${x.expires_at||"—"}`),
          ...payments.rows.map(x=>`Payment: ${x.plan_id||"—"} · ${x.status||"—"} · KES ${x.amount_kes??"—"} · submitted ${x.submitted_at||"—"}`),
          ...entitlements.rows.filter(x=>x.active).map(x=>`Active entitlement: ${BOT_NAMES[x.bot_id]||x.bot_id} · ${x.plan_id||"—"} · expires ${x.expires_at||"—"}`)
        ],
        riskFlags:[],
        nextAction:"Use the Subscription Command Center for payment submission or access details."
      };
    }catch{
      return {answer:"KINGBOT could not verify your private store records right now.",facts:[],riskFlags:["STORE_DATA_UNAVAILABLE"],nextAction:"Retry when the billing database is available."};
    }
  }
  if(requestedPlan){
    const p=requestedPlan;
    const bots=p.bots.map(id=>BOT_NAMES[id]||id).join(", ");
    const selectable=p.selectableBots.map(id=>BOT_NAMES[id]||id).join(" or ");
    return {
      answer:`${p.name} is a ${p.billing} KINGBOT plan at ${p.priceUsd}. The store currently lists ${p.botLimit} bot entitlement(s).`,
      facts:[
        `Plan ID: ${p.id}`,
        `Price: ${p.priceUsd} / ${p.billing}`,
        `Included engines: ${bots}`,
        ...(p.selectableBots.length?[`Selectable entry engine: ${selectable}`]:[]),
        ...p.features.map(x=>`Feature: ${x}`)
      ],
      riskFlags:[],
      nextAction:"Open the Subscription Command Center to select the plan and submit the M-Pesa payment reference."
    };
  }
  return {
    answer:"KINGBOT Store is the subscription and access layer for the five-engine ecosystem. I can explain the plans, included bots, payment flow, or verify your private subscription and payment records.",
    facts:catalog.map(p=>`${p.name}: ${p.priceUsd}/${p.billing} · ${p.botLimit} bot(s) · ${p.bots.map(b=>b.name).join(", ")}`),
    riskFlags:[],
    nextAction:"Ask: “What is in the Professional plan?”, “How do I buy?”, or “What is my subscription status?”"
  };
}

async function databaseSupport(pool,userId,question){
  if(!pool||!userId)return null;
  const t=String(question||"").toLowerCase();
  try{
    if(/subscription|plan|billing|access|expire/.test(t)){
      const q=await pool.query("SELECT plan_id,status,expires_at,created_at FROM kingbot_subscriptions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5",[userId]);
      return {answer:"KINGBOT verified your subscription records.",facts:q.rows.map(x=>`Plan ${x.plan_id||"—"} · status ${x.status||"—"} · expires ${x.expires_at||"—"}`),riskFlags:[],nextAction:"Open the subscription page for the full entitlement view."};
    }
    if(/history|trade history|deals|past trades|performance/.test(t)){
      const q=await pool.query("SELECT bot_id,symbol,side,volume,status,execution_mode,created_at,error_message FROM kingbot_execution_journal WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20",[userId]);
      return {answer:"KINGBOT retrieved the latest execution journal records.",facts:q.rows.map(x=>`${x.created_at} · ${x.bot_id} · ${x.symbol} · ${x.side} · ${x.volume} · ${x.status} · ${x.execution_mode}`),riskFlags:[],nextAction:"Use Analytics for the complete performance breakdown."};
    }
    if(/risk|drawdown|kill switch|risk limit/.test(t)){
      const q=await pool.query("SELECT bot_id,daily_drawdown_pct,total_drawdown_pct,max_risk_per_trade_pct,max_positions,execution_mode,kill_switch FROM kingbot_bot_risk_settings WHERE user_id=$1 ORDER BY bot_id",[userId]);
      return {answer:"KINGBOT verified the saved risk controls for your bot engines.",facts:q.rows.map(x=>`${x.bot_id}: trade risk ${x.max_risk_per_trade_pct}% · daily DD ${x.daily_drawdown_pct}% · total DD ${x.total_drawdown_pct}% · max positions ${x.max_positions} · mode ${x.execution_mode} · kill switch ${Boolean(x.kill_switch)}`),riskFlags:[],nextAction:"Keep risk controls server-side and review them before enabling execution."};
    }
  }catch(error){ return {answer:"KINGBOT could not verify that support record right now.",facts:[],riskFlags:["VERIFICATION_UNAVAILABLE"],nextAction:"Retry after the backend data service recovers."}; }
  return null;
}
async function connectionSupport(broker,userId){
  if(!broker||!userId) return {answer:"I cannot inspect a private broker connection until you are signed in.",facts:[],technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Authenticated broker context.",invalidation:"Not applicable."},riskFlags:["AUTHENTICATION_REQUIRED"],nextAction:"Sign in, connect your broker, then ask “what is my connection?”"};
  try{
    const status=await broker.getStatus(userId);
    const connected=Boolean(status?.connected);
    const snap=status?.accountSnapshot||{};
    const facts=["Broker configured: "+Boolean(status?.configured),"Broker connected: "+connected,"Broker: "+(status?.broker||status?.provider||"—"),"Execution mode: "+(status?.executionMode||"—"),"Account ID: "+(status?.accountId||"—"),"Account type: "+(status?.accountType||snap.accountType||"—")];
    if(snap.currency) facts.push("Currency: "+String(snap.currency));
    return {answer:connected?"KINGBOT verified that your broker connection is active.":"KINGBOT verified that no broker connection is currently active.",facts,technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:connected?"No connection action required.":"Connect a supported broker account.",invalidation:"Not applicable."},riskFlags:connected?[]:["BROKER_NOT_CONNECTED"],nextAction:connected?"Ask about your account, positions, balance, or runtime status.":"Open Broker Connect and complete authorization."};
  }catch(error){
    return {answer:"KINGBOT could not verify the broker connection state right now.",facts:[String(error?.message||"BROKER_STATUS_UNAVAILABLE").slice(0,180)],technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Backend broker status.",invalidation:"Not applicable."},riskFlags:["BROKER_STATUS_UNAVAILABLE"],nextAction:"Retry after the broker service is reachable."};
  }
}

async function runtimeSupport(pool,userId){
  if(!pool||!userId) return {answer:"Sign in so KINGBOT can inspect the private bot runtime state.",facts:[],technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Authenticated runtime context.",invalidation:"Not applicable."},riskFlags:["AUTHENTICATION_REQUIRED"],nextAction:"Sign in and ask again."};
  try{
    const q=await pool.query("SELECT bot_id,state,symbol,execution_mode,last_error,last_signal,updated_at FROM kingbot_bot_runtime WHERE user_id=$1 ORDER BY bot_id",[userId]);
    if(!q.rows.length) return {answer:"KINGBOT found no stored bot runtime rows for your account.",facts:[],technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Start or configure a bot.",invalidation:"Not applicable."},riskFlags:[],nextAction:"Open the Bot Command Center to configure a bot."};
    return {answer:"KINGBOT verified the current bot runtime state from the backend.",facts:q.rows.map(x=>String(x.bot_id)+": "+(x.state||"—")+" · "+(x.symbol||"—")+" · "+(x.execution_mode||"—")+(x.last_error?" · error: "+x.last_error:"")),technicalAnalysis:q.rows.filter(x=>x.last_signal).map(x=>String(x.bot_id)+" last signal: "+x.last_signal),setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Runtime diagnostics only.",invalidation:"Not applicable."},riskFlags:q.rows.some(x=>x.last_error)?["RUNTIME_ERRORS_PRESENT"]:[],nextAction:"Review any reported error or risk gate in the Bot Command Center."};
  }catch{return null;}
}

function platformSupportReply(question){
  const t=String(question||"").toLowerCase();
  if(/\bwhat can you do\b|\bwhat do you do\b|\bcapabilities\b/.test(t)) return {answer:"I route each request to the right KINGBOT capability instead of forcing everything through market analysis.",facts:["Conversation: natural-language platform help","Account/connection: verified broker state","Market: verified quotes and technical snapshots","Bots/runtime: engine definitions and backend state","Risk: saved risk controls","Research: Google-backed web research when configured"],technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Choose a capability or ask naturally.",invalidation:"Not applicable."},riskFlags:[],nextAction:"Ask a normal question such as “what time is it?”, “what is my connection?”, or “analyze XAUUSD”."};
  if(/\bhow does (kingbot|this platform) work\b|\bhow does it work\b/.test(t)) return {answer:"KINGBOT separates verified data from reasoning and execution: broker/runtime data is read from the backend, intelligence explains that data, and server-side risk and execution controls remain authoritative.",facts:["AI is not the execution authority.","Broker/account values must come from verified backend state.","Market analysis requires fresh market data."],technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Ask for a specific subsystem.",invalidation:"Not applicable."},riskFlags:["EXECUTION_REMAINS_SERVER_CONTROLLED"],nextAction:"Ask about the broker connection, a bot engine, risk controls, or a supported market."};
  return {answer:"I understand the request as a KINGBOT platform question, not a market-analysis request.",facts:["No market-analysis trigger was detected.","No unsupported account or market values were fabricated."],technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"A specific platform question.",invalidation:"Not applicable."},riskFlags:[],nextAction:"Ask your question directly and I will route it to the appropriate intelligence capability."};
}


function generalKnowledgeReply(question,search){
  if(!search?.ok){
    return {
      answer:"I understand the question, but KINGBOT does not currently have a verified knowledge source for it. The native brain will not invent an answer.",
      facts:[String(search?.error||"VERIFIED_KNOWLEDGE_SOURCE_UNAVAILABLE").slice(0,220)],
      technicalAnalysis:[],
      setup:{signal:"DATA_INSUFFICIENT",entry:null,waitFor:"A verified knowledge source.",invalidation:"No verified source available."},
      riskFlags:["KNOWLEDGE_SOURCE_UNAVAILABLE"],
      nextAction:"Configure the research service or ask a KINGBOT-specific question."
    };
  }
  const results=Array.isArray(search.results)?search.results.slice(0,6):[];
  const facts=results.map(r=>{
    const title=String(r.title||"Source");
    const snippet=String(r.snippet||"").replace(/\s+/g," ").trim();
    const published=r.publishedAt?(" · "+String(r.publishedAt)):"";
    const url=r.url?(" · "+String(r.url)):"";
    return title+published+" — "+snippet+url;
  });
  const lead=results[0];
  const answer=lead
    ? "KINGBOT researched “"+String(search.query||question).trim()+"” and found "+results.length+" relevant source(s). The answer below is source-grounded rather than invented by the system."
    : "KINGBOT searched for the requested information but found no useful verified result.";
  return {
    answer,
    facts,
    technicalAnalysis:[],
    setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"No market setup requested.",invalidation:"Research is informational and not execution authorization."},
    riskFlags:["EXTERNAL_SOURCE_RESEARCH","NO_EXECUTION_AUTHORIZATION"],
    nextAction:"Ask KINGBOT to compare the sources, explain the subject, or connect the answer to a KINGBOT task.",
    knowledge:{
      query:String(search.query||question),
      sourceCount:results.length,
      synthesisMode:"EXTRACTIVE_VERIFIED_SOURCE_SYNTHESIS"
    }
  };
}

async function runNativeKingbotAIBase({question,symbol,twelveData,pool,broker,userId,conversation=[],thinkingLevel="EXPERT",timeframe="15m",userMemory=null}={}){
  const signals=conversationSignals(question,conversation)||{};
  const effectiveQuestion=String(signals.resolvedQuestion||question).trim();
  const userFrame=conversationFrame(question,conversation);
  const memoryRows = Array.isArray(userMemory) ? userMemory : await loadUserMemory(pool,userId,{limit:30});
  const memorySummary = summarizeUserMemory(memoryRows);
  const requested=symbolFromText(effectiveQuestion,symbol||"XAUUSD");
  const kind=intent(effectiveQuestion,conversation);
  const agent=createKingbotAgent({
    question,
    intent:kind,
    symbol:requested,
    conversation,
    frame:userFrame,
    thinkingLevel,
    verified:{},
    memory:memoryRows
  });
  const utility=utilityReply(effectiveQuestion);
  if(kind==="TECHNICAL_ANALYSIS_BOOK"){
    return {
      provider:"KINGBOT_NATIVE",
      model:"KINGBOT-CORTEX-1",
      intent:kind,
      symbol:requested,
      reply:technicalAnalysisBookReply(question),
      book:{
        title:"KINGBOT Technical Analysis AI Book",
        version:"1.0",
        chapters:searchTechnicalAnalysisBook(question).map(x=>({id:x.id,title:x.title}))
      },
      verified:{technicalAnalysisBook:true}
    };
  }
  if(kind==="KINGBOT_KNOWLEDGE"){
    const reply=kingbotKnowledgeReply(effectiveQuestion);
    return {
      provider:"KINGBOT_NATIVE",
      model:"KINGBOT-CORTEX-1",
      intent:kind,
      symbol:requested,
      reply,
      userFrame,
      verified:{platformKnowledge:true,engineDefinitions:true}
    };
  }
  if(utility) return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORTEX-1",intent:"TIME",symbol:requested,reply:utility,verified:{native:true,timeSource:"server"}};
  if(["GREETING","WELLBEING","FOLLOW_UP","PRESENCE","APPRECIATION","GOODBYE","IDENTITY","INTELLIGENCE","CAPABILITY","EMOTION_PROBE","CASUAL"].includes(kind)) return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORTEX-1",intent:"CONVERSATION",symbol:requested,reply:conversationalReply(question,conversation),verified:{native:true,dialogueCortex:true}};
  if(kind==="CONNECTION_INTELLIGENCE"){
    return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORTEX-1",intent:kind,symbol:requested,reply:await connectionSupport(broker,userId),verified:{broker:true,userSpecific:Boolean(userId)}};
  }
  if(kind==="RUNTIME_INTELLIGENCE"){
    const runtime=await runtimeSupport(pool,userId);
    if(runtime) return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORTEX-1",intent:kind,symbol:requested,reply:runtime,verified:{runtime:true,userSpecific:Boolean(userId)}};
  }
  if(kind==="STORE_INTELLIGENCE"){
    const support=await storeSupport(pool,userId,question);
    return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORTEX-1",intent:kind,symbol:requested,reply:{
      ...support,
      technicalAnalysis:[],
      setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Not a market setup request.",invalidation:"Not applicable."}
    },verified:{store:true,userSpecific:Boolean(userId)}};
  }

  if(kind==="GENERAL_KNOWLEDGE"){
    try{
      const query=String(effectiveQuestion||question).trim();
      const search=await searchWeb(query,{limit:8,freshnessDays:0});
      const reply=generalKnowledgeReply(query,search);
      return {
        provider:"KINGBOT_NATIVE",
        model:"KINGBOT-CORTEX-1",
        intent:kind,
        symbol:requested,
        reply,
        sources:Array.isArray(search?.results)?search.results:[],
        research:{generalKnowledge:true},
        verified:{knowledgeSource:Boolean(search?.ok)}
      };
    }catch(error){
      return {
        provider:"KINGBOT_NATIVE",
        model:"KINGBOT-CORTEX-1",
        intent:kind,
        symbol:requested,
        reply:generalKnowledgeReply(effectiveQuestion||question,{ok:false,error:String(error?.message||"KNOWLEDGE_LOOKUP_FAILED")}),
        verified:{knowledgeSource:false}
      };
    }
  }

  if(kind==="PROGRAMMING"){
    const query=String(effectiveQuestion||question).trim();
    const search=await searchWeb(query+" programming documentation",{limit:6,freshnessDays:0});
    const reply=generalKnowledgeReply(query,search);
    reply.nextAction="Ask KINGBOT to explain the code, identify the bug, or design the implementation from the verified sources.";
    reply.knowledge={...(reply.knowledge||{}),domain:"PROGRAMMING"};
    return {
      provider:"KINGBOT_NATIVE",
      model:"KINGBOT-CORTEX-1",
      intent:kind,
      symbol:requested,
      reply,
      sources:Array.isArray(search?.results)?search.results:[],
      research:{programmingKnowledge:true},
      verified:{knowledgeSource:Boolean(search?.ok)}
    };
  }

  if(kind==="WEB_RESEARCH" || kind==="MARKET_RESEARCH"){
    const rawQuery=String(question||"").replace(/\b(google|search the web|search online|look up|find online|research online|on the internet)\b/gi,"").trim()||question;
    const fresh=/\b(today|latest|current|now|breaking|headline|headlines|this week)\b/i.test(rawQuery)
      ? (/\b(today|now)\b/i.test(rawQuery)?1:7)
      : 0;
    const search=await searchWeb(rawQuery,{limit:8,freshnessDays:fresh});
    if(!search.ok){
      return {
        provider:"KINGBOT_NATIVE",model:"KINGBOT-CORTEX-1",intent:kind,symbol:requested,
        reply:{
          answer:"Google research is available to the KINGBOT brain, but the Google connector is not configured on the backend yet.",
          facts:[search.error||"GOOGLE_SEARCH_NOT_CONFIGURED",...(search.setup?[search.setup]:[])],
          technicalAnalysis:[],
          setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Google Search credentials.",invalidation:"No verified web sources available."},
          riskFlags:["WEB_SEARCH_UNAVAILABLE"],
          nextAction:"Configure GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX on the backend."
        },
        verified:{google:false}
      };
    }
    const facts=search.results.map(r=>String(r.rank)+". "+r.title+(r.publishedAt?" · "+r.publishedAt:"")+" — "+r.snippet+" — "+r.url);
    let marketContext=null;
    if(kind==="MARKET_RESEARCH"){
      const quote=twelveData?.enabled ? (twelveData.quotes([requested])||[])[0]||null : null;
      const snapshot=await latestSnapshot(pool,requested,"5m");
      const brain=snapshot ? evaluateKingbotBrain(snapshot,{maxAgeMs:Number(process.env.KINGBOT_BRAIN_MAX_DATA_AGE_MS||5000)}) : null;
      marketContext={
        quote:quote?.available?{symbol:quote.symbol,price:quote.price,bid:quote.bid,ask:quote.ask,time:quote.time}:null,
        technicalSnapshot:snapshot?{symbol:snapshot.symbol,timeframe:snapshot.timeframe,price:snapshot.price,receivedAt:snapshot.receivedAt}:null,
        brain:brain?{signal:brain.decision.signal,direction:brain.decision.direction,confidence:brain.decision.confidence,engineAgreement:brain.decision.engineAgreement,reasons:brain.decision.reasons}:null
      };
      if(marketContext.quote)facts.unshift("LIVE MARKET CONTEXT · "+requested+" price "+String(marketContext.quote.price)+" at "+String(marketContext.quote.time||"—"));
      if(marketContext.technicalSnapshot)facts.unshift("TECHNICAL SNAPSHOT · "+String(marketContext.technicalSnapshot.timeframe)+" received "+String(marketContext.technicalSnapshot.receivedAt||"—"));
      if(!marketContext.quote&&!marketContext.technicalSnapshot)facts.unshift("LIVE MARKET CONTEXT · unavailable; Google research is available but price/structure was not verified.");
    }
    const answer=kind==="MARKET_RESEARCH"
      ? "KINGBOT combined current Google research with the market context available from the trading-data layer for "+requested+". Research and market observations are kept separate from execution authorization."
      : "KINGBOT searched Google for “"+search.query+"” and returned "+search.results.length+" result(s). The source metadata is preserved for the reasoning layer.";
    return {
      provider:"KINGBOT_NATIVE",model:"KINGBOT-CORTEX-1",intent:kind,symbol:requested,
      reply:{answer,facts,technicalAnalysis:marketContext?.brain?[String(marketContext.brain.signal)+" · direction "+String(marketContext.brain.direction)+" · "+String(marketContext.brain.confidence)+"% confluence confidence"]:[ ],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"No direct execution request.",invalidation:"Research is informational and is not execution authorization."},riskFlags:["AI_RESEARCH_IS_NOT_EXECUTION_AUTHORIZATION"],nextAction:kind==="MARKET_RESEARCH"?"Ask KINGBOT for a deeper market/news synthesis.":"Ask me to summarize, compare, or investigate the sources."},
      sources:search.results,
      research:{google:true,freshnessDays:fresh,marketContext},
      verified:{google:true,freshnessDays:fresh,marketContext:Boolean(marketContext)}
    };
  }
  if(kind==="MARKET_INTELLIGENCE"){
    try{
      const thinking=normalizeThinkingLevel(thinkingLevel);
      const primaryTimeframe=String(timeframe||"15m").toLowerCase();
      const scan=await runStandaloneMarketScan({
        pool,
        twelveData,
        symbols:[requested],
        timeframe:primaryTimeframe
      });
      let sharedMarket=null;
      try {
        sharedMarket=await getMarketPageSnapshot({twelveData,includeSynthetics:true});
      } catch {}
      const sharedSymbol=requested==="BTCUSD" ? "BTCUSDT" : requested;
      const sharedQuote=(sharedMarket?.quotes||[]).find(x=>String(x.symbol||"").toUpperCase()===sharedSymbol)||null;
      if(scan.ok){
        const item=(scan.technical||[]).find(x=>x.symbol===requested)||{};
        const parsed=safeJson(scan.analysis);
        const ranked=Array.isArray(parsed?.ranked_symbols)?parsed.ranked_symbols:[];
        const rankedItem=ranked.find(x=>x.symbol===requested)||item;
        const quote=(scan.quotes||[]).find(x=>x.symbol===requested)||sharedQuote||null;
        const market={
          ...item,
          ...quote,
          symbol:requested,
          timeframe:String(scan.timeframe||"5m").toLowerCase(),
          timestamp:quote?.timestamp ? new Date(quote.timestamp).toISOString() : (item?.dataFreshness||item?.barTime||null),
          crossMarketSnapshot:sharedMarket||null,
          crossMarket:sharedMarket?.crossMarket||null
        };
        const adaptivePerformance=await loadAdaptivePerformance(pool,{userId,symbol:requested});
        const multiTimeframe=await multiTimeframeMarketScan({
          pool,twelveData,symbol:requested,timeframe:primaryTimeframe,thinkingLevel:thinking
        });
        market.multiTimeframe=multiTimeframe;
        const orchestration=await orchestrateKingbotIntelligence({
          market,
          riskContext:{},
          options:{thinkingLevel:thinking},
          memory:[],
          adaptivePerformance,
          thinkingLevel:thinking
        });
        const signal=orchestration?.routing?.direction==="BUY"
          ?"ENTRY_CANDIDATE_BUY"
          :orchestration?.routing?.direction==="SELL"
            ?"ENTRY_CANDIDATE_SELL"
            :"WAIT";
        const selectedEngine=orchestration?.routing?.selectedEngine||"NO_ROUTE";
        const summary=orchestration?.summary?.summary||"KINGBOT did not find sufficient aligned evidence for a routed candidate.";
        const analystFacts=(orchestration?.analysts||[]).flatMap(a=>[
          String(a.name||a.id||"ANALYST")+": "+String(a.bias||"NEUTRAL"),
          ...(Array.isArray(a.evidence)?a.evidence.slice(0,3).map(v=>String(v)):[])
        ]).slice(0,10);
        const riskFlags=[...(orchestration?.riskCouncil?.blocks||[]),...(orchestration?.riskCouncil?.flags||[])];
        if(!riskFlags.includes("EXECUTION_AUTHORIZATION_NOT_GRANTED"))riskFlags.push("EXECUTION_AUTHORIZATION_NOT_GRANTED");
        return {
          provider:"KINGBOT_NATIVE",
          model:"KINGBOT-CORTEX-1",
          intent:kind,
          symbol:requested,
          scanner:scan,
          marketPageFeed:sharedMarket,
          orchestration,
          reply:{
            answer:"KINGBOT CORE completed a multi-stage intelligence pass on live "+requested+" data: "+summary,
            facts:[
              "Identity: KINGBOT INTELLIGENCE CORE",
              "Cognitive loop: IDENTIFY → OBSERVE → CORRELATE → CHALLENGE → ADAPT → VERIFY → EXPLAIN",
              "Market source: "+String(scan.source||"live market-data engine"),
              "Shared Market page feed: "+String(sharedMarket?.crossMarket?.breadth?.live ?? 0)+"/"+String(sharedMarket?.crossMarket?.breadth?.tracked ?? 0)+" live instruments",
              "Primary timeframe: "+String(scan.timeframe||primaryTimeframe),
              "Thinking level: "+thinking+" · native passes: "+String(thinkingProfile(thinking).passes),
              "Multi-timeframe alignment: "+String(multiTimeframe.alignment.direction)+" ("+String(multiTimeframe.alignment.total)+" frames)",
              ...(quote?.available?["Verified quote: "+quote.price]:[]),
              ...(selectedEngine!=="NO_ROUTE"?["Strategy route: "+selectedEngine]:["Strategy route: no candidate"]),
              ...analystFacts
            ],
            technicalAnalysis:[
              ...(Array.isArray(rankedItem?.technicalAnalysis)?rankedItem.technicalAnalysis:[]),
              ...(orchestration?.analysts||[]).flatMap(a=>Array.isArray(a.evidence)?a.evidence.slice(0,2):[]).map(v=>String(v))
            ].slice(0,14),
            setup:{
              signal,
              entry:orchestration?.tradePlan?.entry??rankedItem?.entry??item?.entry??null,
              waitFor:orchestration?.tradePlan?.entry
                ? "Deterministic risk gate must verify the plan before execution."
                : (orchestration?.summary?.watch||[]).join(" · ") || "Wait for stronger aligned evidence.",
              invalidation:orchestration?.tradePlan?.stop??rankedItem?.invalidation??item?.invalidation??"Structure invalidation or stale data."
            },
            riskFlags,
            nextAction:orchestration?.routing?.selectedEngine && !(orchestration?.riskCouncil?.blocks||[]).length
              ?"Review the routed trade-plan through the deterministic risk gate; chat remains non-executing."
              :"Wait, improve data quality, or resolve the reported risk blockers."
          },
          sources:[],
          verified:{
            standaloneScanner:true,
            liveQuote:Boolean(quote?.available),
            technicalData:Boolean(scan.technicalCount),
            multiAgentOrchestration:true,
            adaptiveContext:true,
            thinkingLevel:thinking,
            multiTimeframe:true
          }
        };
      }
      if(sharedQuote?.available){
        return {
          provider:"KINGBOT_NATIVE",
          model:"KINGBOT-CORTEX-1",
          intent:kind,
          symbol:requested,
          marketPageFeed:sharedMarket,
          reply:{
            answer:"KINGBOT synchronized the live Market page feed for "+requested+" but the deeper technical snapshot is not currently available.",
            facts:[
              "Shared Market feed: LIVE",
              "Live instruments tracked: "+String(sharedMarket?.crossMarket?.breadth?.live ?? 0),
              "Verified live price: "+String(sharedQuote.price),
              "Market source: "+String(sharedQuote.source||"KINGBOT shared market feed"),
              "Technical engine: waiting for fresh OHLC/structure data."
            ],
            technicalAnalysis:[],
            setup:{signal:"DATA_INSUFFICIENT",entry:sharedQuote.price,waitFor:"Fresh OHLC/technical structure for "+requested+".",invalidation:"Technical snapshot unavailable."},
            riskFlags:["TECHNICAL_SNAPSHOT_UNAVAILABLE"],
            nextAction:"Retry the analysis while the shared Market feed remains live."
          },
          verified:{sharedMarketFeed:true,liveQuote:true,technicalData:false}
        };
      }

      return {
        provider:"KINGBOT_NATIVE",
        model:"KINGBOT-CORTEX-1",
        intent:kind,
        symbol:requested,
        marketPageFeed:sharedMarket,
        reply:{
          answer:"KINGBOT AI could not obtain fresh verified market data for "+requested+".",
          facts:[String(scan.message||scan.reason||scan.error||"LIVE_MARKET_DATA_UNAVAILABLE").slice(0,220)],
          technicalAnalysis:[],
          setup:{signal:"DATA_INSUFFICIENT",entry:null,waitFor:"Fresh verified market data.",invalidation:"No valid market data."},
          riskFlags:["LIVE_MARKET_DATA_UNAVAILABLE"],
          nextAction:"Check the shared Market feed and technical-data configuration."
        },
        verified:{standaloneScanner:false,sharedMarketFeed:Boolean(sharedMarket?.ok)}
      };
    }catch(error){
      return {
        provider:"KINGBOT_NATIVE",
        model:"KINGBOT-CORTEX-1",
        intent:kind,
        symbol:requested,
        reply:{
          answer:"KINGBOT AI market scanner is temporarily unavailable.",
          facts:[String(error?.message||"LIVE_MARKET_DATA_UNAVAILABLE").slice(0,220)],
          technicalAnalysis:[],
          setup:{signal:"DATA_INSUFFICIENT",entry:null,waitFor:"Fresh verified market data.",invalidation:"No valid market data."},
          riskFlags:["SCANNER_UNAVAILABLE"],
          nextAction:"Retry the standalone scanner."
        },
        verified:{standaloneScanner:false}
      };
    }
  }

  const quotes=twelveData?.enabled?twelveData.quotes([requested]):[];
  const quote=quotes[0]||null;

  if(kind==="BOT_INTELLIGENCE"){
    const defs=getBotDefinitions();
    const requestedBot=Object.entries(defs).find(([id,d])=>new RegExp(id.replace("-","|"),"i").test(String(question||"")))||null;
    const list=requestedBot?[requestedBot]:Object.entries(defs);
    return {
      provider:"KINGBOT_NATIVE",
      model:"KINGBOT-CORTEX-1",
      intent:kind,
      symbol:requested,
      reply:{
        answer:requestedBot?`${requestedBot[1].name} is a specialized KINGBOT strategy engine. It analyzes a defined market regime, applies its own signal logic and timeframe stack, then passes any candidate action through the platform risk and execution gates. It is analysis logic, not an autonomous authority to place trades.`:"KINGBOT is an AI-assisted algorithmic trading platform built to turn verified market data into structured analysis, strategy signals, risk decisions and controlled broker execution. It combines five specialized engines — Strategic, Flipper, Breakout, SMC PRO and Ladder Flip V8 — under a shared confluence, risk and runtime architecture. The engines do not blindly trade at the same time: each evaluates the market using its own logic and timeframe profile, while the risk layer controls exposure, drawdown, position limits, stale data, spread conditions and kill-switch rules. AI can explain, research and synthesize information, but deterministic strategy, risk and broker execution controls remain authoritative.",
        facts:list.map(([id,d])=>`${d.name}: ${d.mode}; threshold ${d.signalThreshold}; risk/trade ${d.risk.maxRiskPerTradePct}%`),
        technicalAnalysis:list.flatMap(([id,d])=>[`${d.name} strategies: ${d.strategies.join(", ")}`,`Timeframes: regime ${d.timeframeProfile.regime}, setup ${d.timeframeProfile.setup}, execution ${d.timeframeProfile.execution}`]),
        setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Market analysis is required for a trade setup.",invalidation:"Not applicable."},
        riskFlags:["STRATEGY_INFORMATION_ONLY"],
        nextAction:"Ask KINGBOT to analyze a specific symbol for current verified market conditions."
      }
    };
  }

  if(["RISK_REVIEW","PLATFORM_SUPPORT"].includes(kind) && userId){
    const support=await databaseSupport(pool,userId,question);
    if(support) return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORTEX-1",intent:kind,symbol:requested,reply:{...support,technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Not a market setup request.",invalidation:"Not applicable."}}};
  }

  if(kind==="ACCOUNT_INTELLIGENCE" && broker && userId){
    try{
      const status=await broker.getStatus(userId);
      const account=status?.connected?await broker.getAccount(userId):null;
      const positions=status?.connected?await broker.getPositions(userId):[];
      const a=account?.data||account||{};
      const p=Array.isArray(positions?.data)?positions.data:(Array.isArray(positions)?positions:[]);
      return {
        provider:"KINGBOT_NATIVE",model:"KINGBOT-CORTEX-1",intent:kind,symbol:requested,
        reply:{
          answer:status?.connected?"KINGBOT verified the connected broker account and current positions.":"No connected broker account is available.",
          facts:[`Broker connected: ${Boolean(status?.connected)}`,`Balance: ${a.balance ?? "unavailable"}`,`Equity: ${a.equity ?? "unavailable"}`,`Open positions: ${p.length}`],
          technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Not a market setup request.",invalidation:"Not applicable."},
          riskFlags:status?.connected?[]:["BROKER_NOT_CONNECTED"],nextAction:status?.connected?"Review risk exposure before execution.":"Connect a broker account."
        }
      };
    }catch{}
  }

  if(kind==="PLATFORM_SUPPORT"){ const dialogue=conversationalReply(question,conversation);
  if(dialogue) return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORTEX-1",intent:"CONVERSATION",symbol:requested,reply:dialogue,verified:{native:true,dialogueCortex:true}};
  return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORTEX-1",intent:kind,symbol:requested,reply:platformSupportReply(question),verified:{native:true}}; }

  const snapshot=await latestSnapshot(pool,requested,"5m");
  const brain=snapshot?evaluateKingbotBrain(snapshot,{maxAgeMs:Number(process.env.KINGBOT_BRAIN_MAX_DATA_AGE_MS||5000)}):null;
  const reply=nativeMarketAnswer({question,symbol:requested,quote,snapshot,brain});
  return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORTEX-1",intent:kind,symbol:requested,reply,verified:{quote:Boolean(quote?.available),technicalSnapshot:Boolean(snapshot),brain:Boolean(brain)}};
}


export async function runNativeKingbotAI(input = {}) {
  const learnedMemory = await learnExplicitUserMemory(input?.pool,input?.userId,{question:input?.question||"",conversation:input?.conversation||[]}).catch(()=>[]);
  const persistentMemory = await loadUserMemory(input?.pool,input?.userId,{limit:30}).catch(()=>[]);
  const conversationSignalsResult = conversationSignals(input?.question || "", input?.conversation || []) || {};
  const conversationMode = String(conversationSignalsResult.intent || "");
  const socialModes = new Set([
    "GREETING","WELLBEING","WHAT_IS_UP","PRESENCE","THANKS","APPRECIATION",
    "GOODBYE","IDENTITY","INTELLIGENCE","CAPABILITY","EMOTION_PROBE","TONE_FEEDBACK","HELP",
    "META_FEEDBACK","CASUAL"
  ]);

  // Final guard: ordinary conversation must never fall through into market
  // analysis just because an earlier routing branch changed or failed.
  const result = socialModes.has(conversationMode)
    ? {
        provider:"KINGBOT_NATIVE",
        model:"KINGBOT-CORTEX-1",
        intent:"CONVERSATION",
        symbol:symbolFromText(input?.question || input?.symbol || "XAUUSD","XAUUSD"),
        reply:conversationalReply(input?.question || "", input?.conversation || []),
        verified:{native:true,dialogueCortex:true,conversationFirst:true}
      }
    : await runNativeKingbotAIBase({...input,userMemory:persistentMemory});
  const thinkingLevel = normalizeThinkingLevel(input?.thinkingLevel || "EXPERT");
  const plan = buildCognitivePlan({
    intent: result?.intent || "PLATFORM_SUPPORT",
    symbol: result?.symbol || input?.symbol || "XAUUSD",
    conversation: input?.conversation || [],
    thinkingLevel
  });
  const identity = identitySnapshot();
  const capabilities = capabilitySet(plan);
  const agentTools = await executeKingbotAgentTools({
    intent: result?.intent || "PLATFORM_SUPPORT",
    goal: conversationSignals(input?.question || "", input?.conversation || [])?.userGoals?.[0] || "UNDERSTAND",
    pool: input?.pool,
    broker: input?.broker,
    twelveData: input?.twelveData,
    userId: input?.userId,
    symbol: result?.symbol || input?.symbol || "XAUUSD",
    timeframe: input?.timeframe || "15m",
    eventBus: input?.eventBus
  }).catch(error => ({ plan:{selected:[],count:0,executionPolicy:"READ_ONLY_VERIFIED_TOOLS"}, results:{}, error:String(error?.message||"AGENT_TOOL_ORCHESTRATION_FAILED").slice(0,180) }));
  const audit = qualityAudit({
    reply: result?.reply || {},
    plan,
    verified: result?.verified || {}
  });
  const thought = think({
    question: input?.question || "",
    intent: result?.intent || "PLATFORM_SUPPORT",
    reply: result?.reply || {},
    conversation: input?.conversation || [],
    thinkingLevel
  });

  // Internal thinking is used for quality control only. It is never returned
  // as chat content or exposed as a reasoning trace to the browser.
  const reply = {
    ...(result?.reply || {}),
    intelligence: {
      identity: identity.id,
      mode: plan.mode,
      capabilities: [...capabilities, "PROPRIETARY_REASONING_KERNEL"],
      authority: "NONE"
    }
  };

  const publicAnswer = agentAnswer(
    result?.reply?.answer || "I’m here. Tell me what you want to work through.",
    conversationFrame(input?.question || "", input?.conversation || [])
  );
  const publicReply = {
    ...(result?.reply || {}),
    answer: publicAnswer,
    agent: agent.snapshot
  };

  return {
    ...result,
    conversationState: {
      ...(conversationSignals(input?.question || "", input?.conversation || []) || {}),
      frame: conversationFrame(input?.question || "", input?.conversation || []),
      effectiveQuestion: String(conversationSignals(input?.question || "", input?.conversation || [])?.resolvedQuestion || input?.question || "")
    },
    identity,
    cognition: {
      plan,
      memory: { available: persistentMemory.length > 0, count: persistentMemory.length, learned: learnedMemory.length },
      capabilities: [...capabilities, "PROPRIETARY_REASONING_KERNEL"],
      userFrame: conversationFrame(input?.question || "", input?.conversation || []),
      agentTools,
      agentPlan: agent.plan,
      tools: summarizeToolContext(agentTools)
    },
    reply: {
      ...publicReply,
      toolFacts: verifiedToolFacts(agentTools),
      intelligence: {
        identity: identity.id,
        mode: plan.mode,
        capabilities: [...capabilities, "PROPRIETARY_REASONING_KERNEL"],
        authority: "NONE"
      }
    }
  };
}
