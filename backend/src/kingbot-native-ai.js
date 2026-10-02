import { getBotDefinitions } from "./bot-engines.js";
import { evaluateKingbotBrain } from "./kingbot-brain.js";
import { searchWeb, webSearchStatus } from "./kingbot-web-search.js";
import { getPlans, BOT_NAMES } from "./subscriptions.js";

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
  const t=String(text||"").toLowerCase().trim();
  if(/^(hi|hello|hey|yo|good morning|good afternoon|good evening|howdy|greetings)\b/.test(t)||/\bhow are you\b|\bwho are you\b|\bwhat are you\b|\bthank you\b|\bthanks\b|\bbye\b|\bgood night\b/.test(t)) return "CONVERSATION";
  if(/^(what is|what's|tell me about|explain)\s+(kingbot|kingbot fintech|this platform|the platform)\b/.test(t)
    ||/\bwhat does kingbot do\b|\bwhat is kingbot fintech\b|\bwhat can kingbot do\b/.test(t)) return "KINGBOT_KNOWLEDGE";
  if(/\bwhat time is it\b|\bcurrent time\b|\bwhat is the time\b|\bwhat's the time\b|\btime now\b|\bwhat day is it\b|\bwhat date is it\b|\btoday'?s date\b|\bcurrent date\b/.test(t)) return "TIME";
  if(/\b(my )?(broker )?(connection|connected|connect|disconnect|connection status)\b|\bwhich broker\b|\bbroker status\b|\bderiv connection\b|\bmt5 connection\b/.test(t)) return "CONNECTION_INTELLIGENCE";
  if(/\b(account|balance|equity|margin|free margin|position|positions|portfolio|account status)\b/.test(t)) return "ACCOUNT_INTELLIGENCE";
  if(/\bbot status\b|\bis .*running\b|\bwhat is running\b|\bruntime\b|\bdiagnos(e|is)\b|\berror\b|\bwhy is .*bot\b|\bstopped\b|\bpaused\b/.test(t)) return "RUNTIME_INTELLIGENCE";
  if(/\b(what is happening|what happened|latest|today|this week|news|headline|headlines|breaking)\b/.test(t) && /\b(gold|xau|eurusd|gbpusd|usdjpy|btcusd|bitcoin|forex|market)\b/.test(t)) return "MARKET_RESEARCH";
  if(/google|search the web|search online|look up|find online|latest news|news about|research online|internet/.test(t)) return "WEB_RESEARCH";
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
    answer:"KINGBOT FINTECH is the trading-technology operating layer behind the KINGBOT ecosystem. It combines broker connectivity, verified market/account telemetry, specialized strategy engines, risk controls, runtime automation, analytics and an AI intelligence interface.",
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

function conversationalReply(question){
  const t=String(question||"").toLowerCase().trim();
  if(/^(hi|hello|hey|yo|good morning|good afternoon|good evening|howdy|greetings)\b/.test(t)) return {answer:"Hey! 👋 KINGBOT AI is online. I can chat with you, explain the platform, research information online, or use verified live market intelligence. What would you like to do?",facts:["Native KINGBOT conversational layer is active."],technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Ask a question or choose an intelligence function.",invalidation:"Not applicable."},riskFlags:[],nextAction:"Ask KINGBOT anything about the platform, bots, markets, risk, or online research."};
  if(/\bhow are you\b/.test(t)) return {answer:"I'm online and ready to work. 🤖 Give me a question and I'll choose the right KINGBOT intelligence capability.",facts:["Native KINGBOT communication layer is active."],technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Your next request.",invalidation:"Not applicable."},riskFlags:[],nextAction:"Try: What can you do? or Analyze gold."};
  if(/\bwho are you\b|\bwhat are you\b/.test(t)) return {answer:"I'm KINGBOT AI — the native intelligence and communication layer of KINGBOT FINTECH. I can communicate naturally, explain the five bot engines, inspect verified account and risk data, analyze supported live market data, and search Google when configured. I never invent live data or authorize trades from chat.",facts:["Provider: KINGBOT_NATIVE","Core: KINGBOT-CORE-1","Execution authority: deterministic strategy and risk gates"],technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"A specific request.",invalidation:"Not applicable."},riskFlags:["EXECUTION_REMAINS_SERVER_CONTROLLED"],nextAction:"Tell me what you need."};
  if(/\bthank you\b|\bthanks\b/.test(t)) return {answer:"You're welcome. 🤝 I'm here. Send me the next question whenever you're ready.",facts:[],technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Your next request.",invalidation:"Not applicable."},riskFlags:[],nextAction:"Continue the conversation."};
  return {answer:"I'm ready. Tell me what you need and I'll route it to the appropriate KINGBOT intelligence capability.",facts:[],technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Your request.",invalidation:"Not applicable."},riskFlags:[],nextAction:"Ask a question."};
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

export async function runNativeKingbotAI({question,symbol,twelveData,pool,broker,userId,conversation=[]}={}){
  const requested=symbolFromText(question,symbol||"XAUUSD");
  const kind=intent(question);
  const utility=utilityReply(question);
  if(kind==="KINGBOT_KNOWLEDGE"){
    return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORE-1",intent:kind,symbol:requested,reply:kingbotKnowledgeReply(question),verified:{platformKnowledge:true,engineDefinitions:true}};
  }
  if(utility) return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORE-1",intent:"TIME",symbol:requested,reply:utility,verified:{native:true,timeSource:"server"}};
  if(kind==="CONVERSATION") return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORE-1",intent:kind,symbol:requested,reply:conversationalReply(question),verified:{native:true}};
  if(kind==="CONNECTION_INTELLIGENCE"){
    return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORE-1",intent:kind,symbol:requested,reply:await connectionSupport(broker,userId),verified:{broker:true,userSpecific:Boolean(userId)}};
  }
  if(kind==="RUNTIME_INTELLIGENCE"){
    const runtime=await runtimeSupport(pool,userId);
    if(runtime) return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORE-1",intent:kind,symbol:requested,reply:runtime,verified:{runtime:true,userSpecific:Boolean(userId)}};
  }
  if(kind==="STORE_INTELLIGENCE"){
    const support=await storeSupport(pool,userId,question);
    return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORE-1",intent:kind,symbol:requested,reply:{
      ...support,
      technicalAnalysis:[],
      setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Not a market setup request.",invalidation:"Not applicable."}
    },verified:{store:true,userSpecific:Boolean(userId)}};
  }

  if(kind==="WEB_RESEARCH" || kind==="MARKET_RESEARCH"){
    const rawQuery=String(question||"").replace(/\b(google|search the web|search online|look up|find online|research online|on the internet)\b/gi,"").trim()||question;
    const fresh=/\b(today|latest|current|now|breaking|headline|headlines|this week)\b/i.test(rawQuery)
      ? (/\b(today|now)\b/i.test(rawQuery)?1:7)
      : 0;
    const search=await searchWeb(rawQuery,{limit:8,freshnessDays:fresh});
    if(!search.ok){
      return {
        provider:"KINGBOT_NATIVE",model:"KINGBOT-CORE-1",intent:kind,symbol:requested,
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
    const answer=kind==="MARKET_RESEARCH"
      ? "KINGBOT searched Google for current external information relevant to "+requested+" and returned "+search.results.length+" result(s). Market interpretation still requires live market data."
      : "KINGBOT searched Google for “"+search.query+"” and returned "+search.results.length+" result(s). The source metadata is preserved for the reasoning layer.";
    return {
      provider:"KINGBOT_NATIVE",model:"KINGBOT-CORE-1",intent:kind,symbol:requested,
      reply:{answer,facts,technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"No direct execution request.",invalidation:"Research is informational and is not execution authorization."},riskFlags:[],nextAction:kind==="MARKET_RESEARCH"?"Ask for a combined market and news analysis.":"Ask me to summarize, compare, or investigate the sources."},
      sources:search.results,
      verified:{google:true,freshnessDays:fresh}
    };
  }
    const search=await searchWeb(String(question||"").replace(/\b(google|search the web|search online|look up|find online|research online|on the internet)\b/gi,"").trim()||question,{limit:6});
    if(!search.ok) return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORE-1",intent:kind,symbol:requested,reply:{answer:"I can perform Google-backed research, but Google Search is not configured on the backend yet.",facts:[search.error||"GOOGLE_SEARCH_NOT_CONFIGURED",...(search.setup?[search.setup]:[])],technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Google Search credentials.",invalidation:"No web search available."},riskFlags:["WEB_SEARCH_UNAVAILABLE"],nextAction:"Configure GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX on the backend."},verified:{google:false}};
    const facts=search.results.map((r,i)=>(i+1)+". "+r.title+" — "+r.snippet+" — "+r.url);
    return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORE-1",intent:kind,symbol:requested,reply:{answer:"I searched Google for “"+search.query+"” and found "+search.results.length+" result(s).",facts,technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"No trading setup requested.",invalidation:"Not applicable."},riskFlags:[],nextAction:"Ask me to summarize, compare, or investigate the sources."},sources:search.results,verified:{google:true}};
  }
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

  if(["RISK_REVIEW","PLATFORM_SUPPORT"].includes(kind) && userId){
    const support=await databaseSupport(pool,userId,question);
    if(support) return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORE-1",intent:kind,symbol:requested,reply:{...support,technicalAnalysis:[],setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"Not a market setup request.",invalidation:"Not applicable."}}};
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

  if(kind==="PLATFORM_SUPPORT") return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORE-1",intent:kind,symbol:requested,reply:platformSupportReply(question),verified:{native:true}};\n\n  const snapshot=await latestSnapshot(pool,requested,"5m");
  const brain=snapshot?evaluateKingbotBrain(snapshot,{maxAgeMs:Number(process.env.KINGBOT_BRAIN_MAX_DATA_AGE_MS||5000)}):null;
  const reply=nativeMarketAnswer({question,symbol:requested,quote,snapshot,brain});
  return {provider:"KINGBOT_NATIVE",model:"KINGBOT-CORE-1",intent:kind,symbol:requested,reply,verified:{quote:Boolean(quote?.available),technicalSnapshot:Boolean(snapshot),brain:Boolean(brain)}};
}
