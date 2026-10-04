import crypto from "node:crypto";
import { evaluateBot, getBotDefinitions, getTradePlan } from "./bot-engines.js";
import { runStandaloneMarketScan } from "./ai-market-scanner.js";
import { loadAdaptivePerformance, applyAdaptivePerformance, classifySetup, recordAdaptiveDecision, settleAdaptiveDecision, ensureAdaptiveIntelligenceSchema, adaptiveDecisionState } from "./adaptive-intelligence.js";
import { identitySnapshot, buildCognitivePlan, capabilitySet, normalizeThinkingLevel, thinkingProfile } from "./kingbot-intelligence-core.js";
import { buildMarketEvidence, marketDecisionGate } from "./market-evidence-engine.js";
import { buildStrategyCouncil } from "./strategy-council.js";
import { evaluateStrategySpecialists } from "./strategy-specialists.js";
import { getGoldPriceFeed } from "./gold-price-feed.js";

const BOT_IDS = ["strategic", "flipper", "breakout", "smc-pro", "ladder-flip"];
const MODEL = "KINGBOT-CORTEX-1";
const ai = null;
const CACHE_MS = Math.max(2500, Number(process.env.KINGBOT_INTELLIGENCE_CACHE_MS || 7000));
const cache = new Map();
const publicGoldPriceFeed = getGoldPriceFeed();

const SYNTHESIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    regime: { type: "string" },
    bias: { type: "string" },
    confidence: { type: "number" },
    selectedEngine: { type: "string" },
    summary: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
    watch: { type: "array", items: { type: "string" } }
  },
  required: ["regime", "bias", "confidence", "selectedEngine", "summary", "risks", "watch"]
};

const num = (v, fallback = null) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const bool = v => Boolean(v);
const upper = v => String(v || "").trim().toUpperCase();
const lower = v => String(v || "").trim().toLowerCase();
const signed = (v, fallback = 0) => {
  const numeric = Number(v);
  if (Number.isFinite(numeric)) return clamp(numeric, -1, 1);
  const direction = upper(v);
  if (["BULLISH", "BUY", "LONG", "UP"].includes(direction)) return 1;
  if (["BEARISH", "SELL", "SHORT", "DOWN"].includes(direction)) return -1;
  return fallback;
};
const directionalFlag = v => {
  if (typeof v === "boolean") return v;
  const value = upper(v);
  return ["TRUE", "1", "YES", "CONFIRMED", "BULLISH", "BEARISH", "BUY", "SELL"].includes(value);
};

function freshness(value, maxAgeMs = 5000) {
  const t = value instanceof Date ? value.getTime() : Number.isFinite(Number(value)) && String(value).trim() !== ""
    ? (Number(value) > 2e10 ? Number(value) : Number(value) * 1000)
    : Date.parse(value || "");
  if (!Number.isFinite(t)) return { ok: false, ageMs: null, reason: "MARKET_TIMESTAMP_MISSING" };
  const ageMs = Math.max(0, Date.now() - t);
  return { ok: ageMs <= maxAgeMs, ageMs, reason: ageMs <= maxAgeMs ? null : "STALE_MARKET_DATA" };
}

function normalizeMarket(input = {}) {
  return {
    symbol: upper(input.symbol),
    timeframe: lower(input.timeframe || "15m"),
    price: num(input.price ?? input.close, 0),
    bid: num(input.bid),
    ask: num(input.ask),
    spread: num(input.spread, 0),
    atr: num(input.atr ?? input.atr14, 0),
    volatility: num(input.volatility, 0),
    trend: signed(input.trend ?? input.trendScore, 0),
    rawTrend: input.trend ?? input.trendScore ?? null,
    momentum: signed(input.momentum, 0),
    volume: clamp(num(input.volume ?? input.volumeScore, 0), 0, 1),
    structure: lower(input.structure || input.marketStructure?.direction || "unknown"),
    rawStructure: input.structure || input.marketStructure?.direction || null,
    rawBos: input.bos || null,
    rawChoch: input.choch || null,
    rawLiquiditySweep: input.liquiditySweep || input.liquidity_sweep || null,
    liquiditySweep: directionalFlag(input.liquiditySweep || input.liquidity_sweep),
    orderBlock: bool(input.orderBlock),
    fairValueGap: bool(input.fairValueGap ?? input.fvg),
    rawDisplacement: input.displacement || null,
    displacement: directionalFlag(input.displacement),
    breakout: bool(input.breakout),
    retest: bool(input.retest),
    adx: num(input.adx ?? input.adx14),
    rsi: num(input.rsi ?? input.rsi14),
    emaFast: num(input.emaFast ?? input.ema20),
    emaSlow: num(input.emaSlow ?? input.ema50),
    velocityPoints: num(input.velocityPoints, 0),
    timestamp: input.timestamp || input.time || input.receivedAt || null,
    quoteTimestamp: input.quoteTimestamp || input.timestamp || input.time || null,
    receivedAt: input.receivedAt || input.dataFreshness || null,
    freshnessMaxAgeMs: num(input.freshnessMaxAgeMs ?? input.quoteFreshnessMaxAgeMs),
    quoteFreshnessMaxAgeMs: num(input.quoteFreshnessMaxAgeMs ?? input.freshnessMaxAgeMs),
    barTime: input.barTime || input.time || null,
    multiTimeframe: input.multiTimeframe || null,
    crossMarket: input.crossMarket || null,
    technicalReady: Boolean(
      Number.isFinite(Number(input.atr ?? input.atr14)) &&
      Number.isFinite(Number(input.rsi ?? input.rsi14)) &&
      Number.isFinite(Number(input.emaFast ?? input.ema20)) &&
      Number.isFinite(Number(input.emaSlow ?? input.ema50))
    )
  };
}

async function buildMultiTimeframeContext({pool,twelveData,symbol,baseTimeframe="15m"}={}){
  const requestedLevels=[...new Set([String(baseTimeframe).toLowerCase(),"5m","15m","1h","4h"])];
  const fullMultiTimeframe=Boolean(twelveData?.enabled);
  const levels=fullMultiTimeframe ? requestedLevels : [String(baseTimeframe).toLowerCase()];
  const scans=await Promise.all(levels.map(async timeframe=>{
    try{
      const scan=await runStandaloneMarketScan({pool,twelveData,symbols:[symbol],timeframe});
      const item=(scan.technical||[]).find(x=>x.symbol===symbol)||{};
      const quote=(scan.quotes||[]).find(x=>x.symbol===symbol)||null;
      return {
        timeframe,ok:Boolean(scan.ok),price:num(item.price??quote?.price),
        trend:upper(item.trend||"NEUTRAL"),
        structure:lower(item.structure||"unknown"),
        bos:upper(item.bos||"NONE"),choch:upper(item.choch||"NONE"),
        liquiditySweep:upper(item.liquiditySweep||"NONE"),
        displacement:upper(item.displacement||"NONE"),
        fvg:Boolean(item.fvg),orderBlock:item.orderBlock||null,
        momentum:num(item.momentum,0),volatility:num(item.volatility,0),
        rsi:num(item.rsi??item.rsi14),atr:num(item.atr??item.atr14),
        timestamp:quote?.timestamp||item.receivedAt||item.barTime||null,
        source:scan.source||item.source||"KINGBOT market engine"
      };
    }catch(error){
      return {timeframe,ok:false,error:String(error?.message||"MTF_SCAN_FAILED").slice(0,140)};
    }
  }));
  const usable=scans.filter(x=>x.ok);
  const direction=x=>x.trend==="BULLISH"?"BULLISH":x.trend==="BEARISH"?"BEARISH":"NEUTRAL";
  const bull=usable.filter(x=>direction(x)==="BULLISH").length;
  const bear=usable.filter(x=>direction(x)==="BEARISH").length;
  const htf=usable.filter(x=>["1h","4h"].includes(x.timeframe));
  const ltf=usable.filter(x=>["5m","15m"].includes(x.timeframe));
  const hBull=htf.filter(x=>direction(x)==="BULLISH").length;
  const hBear=htf.filter(x=>direction(x)==="BEARISH").length;
  const lBull=ltf.filter(x=>direction(x)==="BULLISH").length;
  const lBear=ltf.filter(x=>direction(x)==="BEARISH").length;
  const htfBias=hBull>hBear?"BULLISH":hBear>hBull?"BEARISH":"MIXED";
  const ltfBias=lBull>lBear?"BULLISH":lBear>lBull?"BEARISH":"MIXED";
  const conflict=htfBias!=="MIXED"&&ltfBias!=="MIXED"&&htfBias!==ltfBias;
  const trigger=ltf.some(x=>direction(x)!=="NEUTRAL"&&x.bos===direction(x)&&(x.displacement===direction(x)||x.liquiditySweep===direction(x)||x.choch===direction(x)));
  const setupState=usable.length<levels.length?"DATA_INSUFFICIENT":conflict?"CONFLICTED":
    htfBias==="BULLISH"&&ltfBias==="BULLISH"&&trigger?"BUY_CANDIDATE":
    htfBias==="BEARISH"&&ltfBias==="BEARISH"&&trigger?"SELL_CANDIDATE":
    htfBias!=="MIXED"&&ltfBias===htfBias?"WAIT_CONFIRMATION":"WAIT";
  return {
    timeframes:scans,requiredTimeframes:levels,requestedTimeframes:requestedLevels,
    policy:fullMultiTimeframe?"FULL_MTF":"BASE_TIMEFRAME_ONLY",
    limitation:fullMultiTimeframe?null:"Higher-timeframe evidence is unavailable on the current free market-data path; the Council must not infer a directional execution route from the base timeframe alone.",
    alignment:{bullish:bull,bearish:bear,total:usable.length,required:levels.length,
      ratio:usable.length?Number((Math.max(bull,bear)/usable.length).toFixed(2)):0,
      direction:bull>bear?"BULLISH":bear>bull?"BEARISH":"MIXED",
      htfBias,ltfBias,conflict},
    higherTimeframeBias:htfBias,lowerTimeframeBias:ltfBias,triggerPresent:trigger,setupState,
    staleTimeframes:scans.filter(x=>!x.ok).map(x=>x.timeframe)
  };
}

function analyzeTechnical(m) {
  const technicalFields = [m.emaFast, m.emaSlow, m.rsi, m.atr].filter(v => Number.isFinite(Number(v))).length;
  const hasDirectionalFeature = Math.abs(Number(m.trend||0)) > 0 || Math.abs(Number(m.momentum||0)) > 0 || m.structure !== "unknown";
  const structureScore = m.structure === "bullish" ? 1 : m.structure === "bearish" ? -1 : 0;
  const smc = (m.liquiditySweep ? 0.25 : 0) + (m.displacement ? 0.2 : 0) + (m.orderBlock ? 0.1 : 0) + (m.fairValueGap ? 0.1 : 0);
  const breakout = m.breakout ? 0.25 : 0;
  const retest = m.retest ? 0.12 : 0;
  const score = clamp((m.trend * 0.35) + (m.momentum * 0.2) + (structureScore * 0.2) + smc + breakout + retest, -1, 1);
  return {
    id: "technical",
    name: "TECHNICAL ANALYST",
    score: Math.round(score * 100),
    bias: score > 0.18 ? "BULLISH" : score < -0.18 ? "BEARISH" : "NEUTRAL",
    evidence: [
      "trend=" + m.trend.toFixed(2),
      "momentum=" + m.momentum.toFixed(2),
      "structure=" + m.structure,
      "liquiditySweep=" + (m.liquiditySweep ? "yes" : "no"),
      "displacement=" + (m.displacement ? "yes" : "no"),
      "FVG=" + (m.fairValueGap ? "yes" : "no"),
      "breakout=" + (m.breakout ? "yes" : "no")
    ],
    status: technicalFields >= 3 || hasDirectionalFeature ? "VERIFIED_MARKET_FEATURES" : "MARKET_TECHNICAL_DATA_INCOMPLETE",
    dataCompleteness: { technicalFields, requiredForFullSetup: 4 }
  };
}

function analyzeRegime(m) {
  const hasRegimeInputs = Number.isFinite(Number(m.emaFast)) || Number.isFinite(Number(m.emaSlow)) || Math.abs(Number(m.trend||0)) > 0 || Math.abs(Number(m.momentum||0)) > 0 || Math.abs(Number(m.volatility||0)) > 0;
  if (!hasRegimeInputs) return {id:"regime",name:"REGIME ANALYST",score:0,regime:"DATA_INSUFFICIENT",bias:"NEUTRAL",evidence:["Live quote is present, but verified trend/volatility structure is not available yet."],status:"REGIME_WAITING_FOR_TECHNICAL_DATA"};
  const trendMagnitude = Math.abs(m.trend);
  const vol = m.volatility;
  const regime = trendMagnitude >= 0.55
    ? (vol >= 0.65 ? "TRENDING_VOLATILE" : "TRENDING")
    : (vol >= 0.65 ? "EXPANSION" : vol <= 0.12 ? "LOW_VOLATILITY" : "RANGE");
  const score = clamp((m.trend * 55) + (m.momentum * 25) + ((vol - 0.5) * 15), -100, 100);
  return {
    id: "regime",
    name: "REGIME ANALYST",
    score: Math.round(score),
    regime,
    bias: score > 15 ? "BULLISH" : score < -15 ? "BEARISH" : "NEUTRAL",
    evidence: ["trendMagnitude=" + trendMagnitude.toFixed(2), "volatility=" + vol.toFixed(2), "momentum=" + m.momentum.toFixed(2)],
    status: "REGIME_CLASSIFIED"
  };
}

function analyzeExecution(m) {
  const atr = Math.max(Math.abs(m.atr || 0), 1e-12);
  const spreadRatio = Math.abs(m.spread || 0) / atr;
  const stale = freshness(m.timestamp, Math.max(3000, Number(m.quoteFreshnessMaxAgeMs || m.freshnessMaxAgeMs || Number(process.env.KINGBOT_BRAIN_MAX_DATA_AGE_MS || 5000))));
  const quality = clamp(100 - spreadRatio * 100 - (stale.ok ? 0 : 45), 0, 100);
  const flags = [];
  if (!m.symbol) flags.push("SYMBOL_MISSING");
  if (!(m.price > 0)) flags.push("PRICE_MISSING");
  if (!(m.atr > 0)) flags.push("ATR_MISSING");
  if (!stale.ok) flags.push(stale.reason);
  if (spreadRatio > 0.25) flags.push("SPREAD_ELEVATED_VS_ATR");
  return {
    id: "execution",
    name: "EXECUTION CONDITIONS ANALYST",
    score: Math.round(quality),
    bias: "NEUTRAL",
    spreadRatio: Number(spreadRatio.toFixed(4)),
    stale: !stale.ok,
    dataAgeMs: stale.ageMs,
    flags,
    status: flags.length ? "CAUTION" : "EXECUTION_CONTEXT_READY"
  };
}

function analyzeCrossMarket(input) {
  const context = input?.crossMarket || input?.crossMarketSnapshot?.crossMarket || {};
  const breadth = context?.breadth || {};
  const live = Number(breadth.live || 0);
  const tracked = Number(breadth.tracked || 0);
  const up = Number(breadth.up || 0);
  const down = Number(breadth.down || 0);
  const avgChange = num(breadth.avgChange);
  if (!live) {
    return {
      id: "cross-market",
      name: "CROSS-MARKET ANALYST",
      score: 0,
      bias: "NEUTRAL",
      evidence: ["No shared Market page breadth snapshot available."],
      status: "WAITING_FOR_SHARED_MARKET_FEED"
    };
  }
  const bias = up === down ? "NEUTRAL" : up > down ? "BULLISH" : "BEARISH";
  const evidence = [
    "Shared Market page live instruments=" + live + "/" + Math.max(tracked, live),
    "Breadth up=" + up + " down=" + down + " flat=" + Number(breadth.flat || 0),
    ...(avgChange !== null ? ["Average 24h change-aware move=" + avgChange.toFixed(2) + "%"] : [])
  ];
  if (Array.isArray(context.strongest) && context.strongest.length) {
    evidence.push("Strongest live movers=" + context.strongest.slice(0, 3).map(x => x.symbol + " " + Number(x.change).toFixed(2) + "%").join(", "));
  }
  if (Array.isArray(context.weakest) && context.weakest.length) {
    evidence.push("Weakest live movers=" + context.weakest.slice(0, 3).map(x => x.symbol + " " + Number(x.change).toFixed(2) + "%").join(", "));
  }
  const score = up + down ? clamp(((up - down) / (up + down)) * 100, -100, 100) : 0;
  return {
    id: "cross-market",
    name: "CROSS-MARKET ANALYST",
    score: Math.round(score),
    bias,
    breadth: { live, tracked, up, down, flat: Number(breadth.flat || 0), avgChange },
    evidence,
    status: "SHARED_MARKET_FEED_VERIFIED"
  };
}

function analyzeMacroAndSentiment(input) {
  const macro = input.macro || input.macroContext || {};
  const sentiment = input.sentiment || input.sentimentContext || {};
  const news = input.news || input.newsContext || {};
  const available = [macro, sentiment, news].some(x => x && Object.keys(x).length);
  const biasValues = [macro?.bias, sentiment?.bias, news?.bias].filter(Boolean).map(upper);
  const bullish = biasValues.filter(v => v.includes("BULL")).length;
  const bearish = biasValues.filter(v => v.includes("BEAR")).length;
  const bias = bullish === bearish ? "NEUTRAL" : bullish > bearish ? "BULLISH" : "BEARISH";
  return {
    id: "context",
    name: "MACRO + SENTIMENT ANALYST",
    score: bias === "BULLISH" ? 50 : bias === "BEARISH" ? -50 : 0,
    bias,
    available,
    evidence: available ? { macro, sentiment, news } : null,
    status: available ? "CONTEXT_ATTACHED" : "WAITING_FOR_CONTEXT"
  };
}

function engineFit(botId, market, regime, performance = {}) {
  const result = evaluateBot(botId, market);
  let fit = clamp(Math.abs(Number(result.score || 0)), 0, 100);
  const mtf = market.multiTimeframe || {};
  if (mtf.setupState === "CONFLICTED") fit -= 18;
  if (mtf.higherTimeframeBias && mtf.higherTimeframeBias !== "MIXED") {
    const engineDirection = result.score > 0 ? "BULLISH" : result.score < 0 ? "BEARISH" : "NEUTRAL";
    if (engineDirection === mtf.higherTimeframeBias) fit += 10;
    else if (engineDirection !== "NEUTRAL") fit -= 10;
  }
  if (mtf.triggerPresent && (result.score > 0 || result.score < 0)) fit += 6;
  if (botId === "smc-pro") {
    if (market.liquiditySweep) fit += 8;
    if (market.displacement) fit += 7;
    if (market.orderBlock || market.fairValueGap) fit += 5;
  }
  if (botId === "breakout") {
    if (market.breakout) fit += 10;
    if (market.retest) fit += 7;
  }
  if (botId === "flipper") {
    if (Math.abs(market.momentum) >= 0.55) fit += 8;
    if (market.spread > 0 && market.atr > 0 && market.spread / market.atr < 0.15) fit += 8;
  }
  if (botId === "ladder-flip") {
    if (Number.isFinite(market.adx) && market.adx >= 18) fit += 7;
    if (Number.isFinite(market.rsi) && ((result.score > 0 && market.rsi >= 50) || (result.score < 0 && market.rsi <= 50))) fit += 6;
  }
  if (botId === "strategic" && String(regime.regime).startsWith("TRENDING")) fit += 6;
  const baseEngine = {
    botId,
    name: getBotDefinitions()[botId]?.name || botId,
    signal: result.signal || "NO_SIGNAL",
    score: Number(result.score || 0),
    fit: Math.round(clamp(fit, 0, 100)),
    strategyMatch: Math.abs(Number(result.score || 0)) >= Number(getBotDefinitions()[botId]?.signalThreshold || 75),
    reason: result.reason || "No reason supplied",
    timeframeProfile: getBotDefinitions()[botId]?.timeframeProfile || {}
  };
  return applyAdaptivePerformance(baseEngine, performance[botId], {
    regime: regime?.regime || "UNKNOWN",
    setupType: classifySetup(market)
  });
}

function buildDebate(analysts, engines, market) {
  const bullCase = [];
  const bearCase = [];
  for (const agent of analysts) {
    if (agent.bias === "BULLISH") bullCase.push(agent.name + ": " + agent.score);
    if (agent.bias === "BEARISH") bearCase.push(agent.name + ": " + agent.score);
  }
  for (const engine of engines) {
    if (engine.signal === "LONG_CANDIDATE") bullCase.push(engine.name + ": " + engine.score);
    if (engine.signal === "SHORT_CANDIDATE") bearCase.push(engine.name + ": " + engine.score);
  }
  if (market.liquiditySweep && market.displacement) bullCase.push("SMC sequence: sweep + displacement present");
  if (market.breakout && market.retest) bullCase.push("Breakout + retest confirmed");
  return {
    bullCase: bullCase.slice(0, 10),
    bearCase: bearCase.slice(0, 10),
    direction: bullCase.length > bearCase.length ? "BULLISH" : bearCase.length > bullCase.length ? "BEARISH" : "NEUTRAL",
    balance: { bullCount: bullCase.length, bearCount: bearCase.length, delta: bullCase.length - bearCase.length },
    status: "ADVERSARIAL_REVIEW_COMPLETE"
  };
}

function riskCouncil(market, engines, riskContext = {}) {
  const blocks = [];
  const flags = [];
  if (!(market.price > 0)) blocks.push("MARKET_DATA_INCOMPLETE");
  if (!(market.atr > 0)) flags.push("TECHNICAL_DATA_INCOMPLETE");
  if (Number(market.spread) > 0 && Number(market.atr) > 0 && Number(market.spread) / Number(market.atr) > Number(riskContext.maxSpreadAtrRatio ?? 0.25)) blocks.push("SPREAD_GATE");
  const liveTimestamp = market.quoteTimestamp || market.receivedAt || market.timestamp || null;
  const stale = freshness(liveTimestamp, Number(market.quoteFreshnessMaxAgeMs || market.freshnessMaxAgeMs || riskContext.staleDataMs || process.env.KINGBOT_BRAIN_MAX_DATA_AGE_MS || 5000));
  if (!stale.ok) blocks.push(stale.reason || "STALE_DATA");
  if (bool(riskContext.killSwitch)) blocks.push("BOT_KILL_SWITCH");
  if (bool(riskContext.globalKillSwitch)) blocks.push("GLOBAL_KILL_SWITCH");
  if (bool(riskContext.globalTradingPaused)) blocks.push("GLOBAL_TRADING_PAUSED");
  if (upper(riskContext.executionMode || "DEMO") === "LIVE" && !bool(riskContext.liveAuthorized)) blocks.push("LIVE_NOT_AUTHORIZED");
  if (market.multiTimeframe?.setupState === "CONFLICTED") blocks.push("MTF_CONFLICT");
  if (market.multiTimeframe?.setupState === "DATA_INSUFFICIENT") blocks.push("MTF_DATA_INSUFFICIENT");
  if (!engines.some(e => e.strategyMatch)) flags.push("NO_ENGINE_MEETS_SIGNAL_THRESHOLD");
  const bestFit = Math.max(...engines.map(e => e.fit), 0);
  const advisory = bestFit >= 82 ? "NORMAL" : "ELEVATED";
  return {
    status: blocks.length ? "BLOCKED" : advisory,
    blocks,
    flags,
    aggressiveCase: "Maximum engine fit " + Math.round(bestFit) + "/100",
    conservativeCase: flags.length ? flags.join(", ") : "No additional deterministic advisory risk flags.",
    neutralCase: blocks.length ? "Hard blockers present: " + blocks.join(", ") : "No hard blocker detected by this advisory council.",
    executionAuthority: "NONE"
  };
}

function chooseEngine(engines, debate) {
  const sorted = [...engines]
    .filter(engine => engine.strategyMatch)
    .sort((a, b) => b.fit - a.fit || Math.abs(b.score) - Math.abs(a.score));
  const top = sorted[0] || null;
  if (!top) return { selectedEngine: null, reason: "NO_ENGINE_MEETS_THRESHOLD" };
  const direction = top.score > 0 ? "BUY" : top.score < 0 ? "SELL" : "HOLD";
  if (debate.direction !== "NEUTRAL" && ((debate.direction === "BULLISH" && direction !== "BUY") || (debate.direction === "BEARISH" && direction !== "SELL"))) {
    return { selectedEngine: null, reason: "ENGINE_DEBATE_DIVERGENCE", candidate: top };
  }
  return { selectedEngine: top.botId, candidate: top, reason: "HIGHEST_STRATEGY_FIT" };
}

const safeParse = value => {
  try { return JSON.parse(String(value || "")); } catch { return null; }
};

async function synthesize(payload) {
  const summary = payload?.summary || {};
  const debate = payload?.debate || {};
  const risk = payload?.riskCouncil || {};
  const routing = payload?.routing || {};
  const engines = Array.isArray(payload?.engines) ? payload.engines : [];
  const analysts = Array.isArray(payload?.analysts) ? payload.analysts : [];
  const regimeAgent = analysts.find(agent => agent?.id === "regime") || {};
  const marketEvidence = payload?.market?.evidence || {};
  const councilState = String(payload?.strategyCouncil?.state || routing?.councilState || "").toUpperCase();
  const blockers = [...(risk.blocks || []), ...(risk.flags || [])];
  const selected = routing.selectedEngine || "";
  const synthesizedBias = councilState === "BUY"
    ? "BULLISH"
    : councilState === "SELL"
      ? "BEARISH"
      : String(marketEvidence.directionalBias || debate.direction || "NEUTRAL").toUpperCase();
  const synthesizedRegime = String(summary.regime || regimeAgent.regime || payload?.market?.regime || "UNKNOWN");
  const synthesizedConfidence = councilState === "WAIT" && blockers.length
    ? 0
    : Number(summary.confidence ?? payload?.market?.evidence?.confidence ?? 0);
  let statusSummary = "KINGBOT CORTEX completed the intelligence pass.";
  if (councilState === "BLOCKED" || blockers.length) {
    statusSummary = "KINGBOT CORTEX is blocked by deterministic controls or incomplete verified evidence.";
  } else if (councilState === "CONFLICTED") {
    statusSummary = "KINGBOT CORTEX found conflicting specialist and market evidence; no route is authorized.";
  } else if (councilState === "WAIT" || !selected) {
    statusSummary = payload?.market?.verifiedQuote && payload?.market?.technicalReady === false
      ? "KINGBOT CORTEX has a verified live XAU/USD quote, but technical/MTF evidence is incomplete; no directional route is inferred."
      : "KINGBOT CORTEX is waiting: no specialist currently satisfies a complete, verified setup.";
  } else if (selected) {
    statusSummary = "KINGBOT CORTEX routed the strongest verified specialist toward " + selected + ".";
  }
  return {
    provider: "KINGBOT_NATIVE",
    model: MODEL,
    result: {
      regime: synthesizedRegime,
      bias: synthesizedBias,
      confidence: synthesizedConfidence,
      selectedEngine: selected,
      summary: statusSummary,
      risks: blockers.slice(0, 8),
      watch: engines.filter(e => !e.strategyMatch).slice(0, 4).map(e => e.botId + ": strategy threshold not met")
    }
  };
}
function cacheKey(market, options = {}) {
  return JSON.stringify({
    symbol: market.symbol,
    timeframe: market.timeframe,
    price: market.price,
    atr: market.atr,
    spread: market.spread,
    trend: market.trend,
    momentum: market.momentum,
    structure: market.structure,
    quoteTimestamp: market.quoteTimestamp || null,
    barTime: market.barTime || null,
    crossMarket: market.crossMarket?.breadth ? {
      live: market.crossMarket.breadth.live,
      up: market.crossMarket.breadth.up,
      down: market.crossMarket.breadth.down,
      avgChange: market.crossMarket.breadth.avgChange
    } : null,
    liquiditySweep: market.liquiditySweep,
    displacement: market.displacement,
    breakout: market.breakout,
    retest: market.retest,
    botId: options.botId || null
  });
}

export async function orchestrateKingbotIntelligence({ market: inputMarket = {}, riskContext = {}, options = {}, memory = [], adaptivePerformance = {}, thinkingLevel = "EXPERT" } = {}) {
  const market = normalizeMarket(inputMarket);
  if (!market.multiTimeframe && market.symbol) market.multiTimeframe = await buildMultiTimeframeContext({ pool: options.pool, twelveData: options.twelveData, symbol: market.symbol, baseTimeframe: market.timeframe });
  const marketEvidence = buildMarketEvidence(market, { maxAgeMs: Number(process.env.KINGBOT_BRAIN_MAX_DATA_AGE_MS || 5000) });
  const level = normalizeThinkingLevel(thinkingLevel || options.thinkingLevel || "EXPERT");
  const cognitivePlan = buildCognitivePlan({ intent: "MARKET_INTELLIGENCE", symbol: market.symbol, conversation: [], thinkingLevel: level });
  const key = cacheKey(market, options);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at <= CACHE_MS) return { ...cached.result, cached: true };

  const technical = analyzeTechnical(market);
  technical.evidenceQuality = marketEvidence.evidenceQuality;
  technical.marketEvidence = marketEvidence.scores;
  const regime = analyzeRegime(market);
  const execution = analyzeExecution(market);
  const context = analyzeMacroAndSentiment(inputMarket);
  const crossMarket = analyzeCrossMarket(inputMarket);
  const analysts = [technical, regime, context, execution, crossMarket];
  const engines = BOT_IDS.map(id => engineFit(id, market, regime, adaptivePerformance));
  const specialistCards = evaluateStrategySpecialists({ market, multiTimeframe: market.multiTimeframe || {}, regime });
  const specialistByBot = new Map(specialistCards.map(card => [card.botId, card]));
  const enrichedEngines = engines.map(engine => ({ ...engine, specialist: specialistByBot.get(engine.botId) || null }));
  const debate = buildDebate(analysts, enrichedEngines, market);
  const risk = riskCouncil(market, engines, riskContext);
  const decisionGate = marketDecisionGate(marketEvidence, risk.blocks);
  const strategyCouncil = buildStrategyCouncil(enrichedEngines, {
    multiTimeframe: market.multiTimeframe,
    riskBlocks: risk.blocks,
    marketDecision: decisionGate.state,
    minAgreement: Number(process.env.KINGBOT_STRATEGY_COUNCIL_MIN_AGREEMENT || 0.6)
  });
  const routing = strategyCouncil.state === "BUY" || strategyCouncil.state === "SELL"
    ? chooseEngine(enrichedEngines, debate)
    : { selectedEngine: null, reason: "STRATEGY_COUNCIL_" + strategyCouncil.state, candidate: strategyCouncil.strongestEngine };
  if (strategyCouncil.strongestEngine && strategyCouncil.state !== "WAIT" && strategyCouncil.state !== "CONFLICTED") {
    routing.selectedEngine = strategyCouncil.strongestEngine.botId;
    routing.candidate = enrichedEngines.find(e => e.botId === strategyCouncil.strongestEngine.botId) || null;
    routing.reason = "STRATEGY_COUNCIL_CONSENSUS";
  }

  let tradePlan = null;
  if (routing.selectedEngine && routing.candidate && risk.blocks.length === 0) {
    const side = routing.candidate.score > 0 ? "BUY" : routing.candidate.score < 0 ? "SELL" : "HOLD";
    if (side !== "HOLD") tradePlan = getTradePlan(routing.selectedEngine, market, side);
  }

  const decisionId = crypto.randomUUID();
  const decisionState = adaptiveDecisionState({
    riskBlocks: risk.blocks,
    selectedEngine: routing.selectedEngine,
    directionalBias: debate.direction
  });
  const result = {
    ok: true,
    memoryContext: memory.slice(0, 5).map(row => ({
      selectedEngine: row.selected_engine || null,
      direction: row.direction || null,
      confidence: num(row.confidence),
      regime: row.regime || null,
      createdAt: row.created_at || null
    })),
    orchestrator: "KINGBOT INTELLIGENCE ORCHESTRATOR",
    version: "3.0.0",
    identity: identitySnapshot(),
    cognitive: {
      plan: cognitivePlan,
      capabilities: capabilitySet(cognitivePlan),
      executionAuthority: "NONE"
    },
    adaptive: {
      enabled: true,
      decisionId,
      decisionState,
      setupType: classifySetup(market),
      performanceWindowDays: Number(process.env.KINGBOT_ADAPTIVE_WINDOW_DAYS || 90),
      minSamples: Number(process.env.KINGBOT_ADAPTIVE_MIN_SAMPLES || 8)
    },
    generatedAt: new Date().toISOString(),
    market: {
      ...market,
      multiTimeframe: market.multiTimeframe,
      freshness: freshness(
        market.quoteTimestamp || market.receivedAt || market.timestamp,
        Number(market.quoteFreshnessMaxAgeMs || market.freshnessMaxAgeMs || process.env.KINGBOT_BRAIN_MAX_DATA_AGE_MS || 5000)
      ),
      freshnessMode: market.quoteTimestamp ? "LIVE_QUOTE" : (market.receivedAt ? "LIVE_DATA_INGESTION" : "BAR_CONTEXT"),
      evidence: marketEvidence
    },
    analysts,
    debate,
    engines,
    specialists: specialistCards,
    strategyCouncil,
    routing: { ...routing, direction: routing.candidate ? (routing.candidate.score > 0 ? "BUY" : routing.candidate.score < 0 ? "SELL" : "HOLD") : "HOLD" },
    tradePlan,
    riskCouncil: risk,
    decisionGate,
    decision: {
      state: decisionGate.state,
      confidence: marketEvidence.confidence,
      waitFor: marketEvidence.waitFor,
      invalidation: marketEvidence.invalidation,
      dataFlags: marketEvidence.dataFlags
    },
    execution: {
      authority: "NONE",
      authorized: false,
      nextStep: risk.blocks.length
        ? "Resolve deterministic risk blockers."
        : routing.selectedEngine
          ? "Pass TradePlan through the deterministic risk engine before execution."
          : "Wait for stronger aligned evidence."
    }
  };

  // The evidence gate is advisory only; deterministic risk/execution controls remain authoritative.
  if (decisionGate.state !== "BUY" && decisionGate.state !== "SELL" || strategyCouncil.state !== decisionGate.state) {
    result.routing = { ...result.routing, selectedEngine: null, reason: decisionGate.reason };
    result.tradePlan = null;
  }
  result.routing = {
    ...result.routing,
    councilState: strategyCouncil.state,
    councilConfidence: strategyCouncil.confidence,
    primarySpecialist: strategyCouncil.primarySpecialist?.botId || null
  };
  const synthesis = await synthesize(result);
  result.aiSynthesis = synthesis;
  result.summary = synthesis.result || {
    regime: regime.regime,
    bias: debate.direction,
    confidence: Math.round(clamp((Math.max(...engines.map(e => e.fit), 0) * 0.45) + (Math.abs(debate.balance.delta) * 5 * 0.25) + (execution.score * 0.30), 0, 100)),
    selectedEngine: routing.selectedEngine || "",
    summary: routing.selectedEngine
      ? "KINGBOT routed the current market state toward " + routing.selectedEngine + " from deterministic strategy fit and adversarial evidence."
      : "KINGBOT did not route a live candidate because the evidence is not sufficiently aligned.",
    risks: [...risk.blocks, ...risk.flags],
    watch: enrichedEngines.filter(e => !e.strategyMatch).slice(0, 3).map(e => e.botId + ": below legacy engine threshold")
  };

  cache.set(key, { at: Date.now(), result });
  return result;
}


export async function ensureIntelligenceOrchestratorSchema(pool) {
  if (!pool) return;
  await ensureAdaptiveIntelligenceSchema(pool);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kingbot_ai_intelligence_memory (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      selected_engine TEXT,
      direction TEXT,
      confidence NUMERIC(6,2),
      regime TEXT,
      result JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_kingbot_ai_intelligence_memory_user_symbol ON kingbot_ai_intelligence_memory(user_id, symbol, created_at DESC)");
}

async function loadIntelligenceMemory(pool, userId, symbol) {
  if (!pool || !userId || !symbol) return [];
  try {
    const q = await pool.query(
      "SELECT selected_engine,direction,confidence,regime,result,created_at FROM kingbot_ai_intelligence_memory WHERE user_id=$1 AND symbol=$2 ORDER BY created_at DESC LIMIT 5",
      [userId, symbol]
    );
    return q.rows;
  } catch (error) {
    console.warn("[KINGBOT ORCHESTRATOR MEMORY]", error?.message || error);
    return [];
  }
}

async function recordIntelligenceMemory(pool, userId, result) {
  if (!pool || !userId || !result?.market?.symbol) return;
  try {
    await pool.query(
      "INSERT INTO kingbot_ai_intelligence_memory(user_id,symbol,timeframe,selected_engine,direction,confidence,regime,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
      [
        userId,
        result.market.symbol,
        result.market.timeframe || "unknown",
        result.routing?.selectedEngine || null,
        result.routing?.direction || "HOLD",
        Number(result.summary?.confidence ?? 0),
        result.summary?.regime || result.market?.regime || null,
        JSON.stringify(result)
      ]
    );
  } catch (error) {
    console.warn("[KINGBOT ORCHESTRATOR MEMORY WRITE]", error?.message || error);
  }
}

export function registerIntelligenceOrchestrator(app, { requireUser, pool, twelveData } = {}) {
  app.post("/api/ai/intelligence/orchestrate", async (req, res) => {
    try {
      const user = await requireUser(pool, req, res);
      if (!user) return;
      let market = req.body?.market && typeof req.body.market === "object" ? req.body.market : null;
      const symbol = upper(req.body?.symbol || market?.symbol || "XAUUSD");
      const timeframe = lower(req.body?.timeframe || market?.timeframe || "15m");
      if (!market || !(Number(market.price) > 0)) {
        const scan = await runStandaloneMarketScan({ pool, twelveData, symbols: symbol, timeframe });
        const technical = Array.isArray(scan?.technical) ? scan.technical.find(x => x.symbol === symbol) || scan.technical[0] : null;
        const quote = Array.isArray(scan?.quotes) ? scan.quotes.find(x => x.symbol === symbol) || scan.quotes[0] : null;
        const quoteTimestamp = quote?.timestamp
          ? new Date(quote.timestamp).toISOString()
          : (quote?.receivedAt ? new Date(quote.receivedAt).toISOString() : null);
        const receivedAt = technical?.receivedAt || technical?.dataFreshness || quote?.receivedAt || null;
        market = {
          ...(technical || {}),
          ...(quote || {}),
          symbol,
          timeframe,
          timestamp: quoteTimestamp || receivedAt || technical?.barTime || null,
          quoteTimestamp,
          receivedAt
        };
        market.aiScanner = { provider: scan?.provider || "none", model: scan?.model || null, source: scan?.source || null, aiError: scan?.aiError || null };
      }
      if (symbol === "XAUUSD") {
        try {
          const goldQuote = await publicGoldPriceFeed.getQuote();
          if (goldQuote?.verified) {
            market = {
              ...market,
              symbol,
              price: goldQuote.price,
              bid: goldQuote.bid ?? market.bid ?? null,
              ask: goldQuote.ask ?? market.ask ?? null,
              spread: goldQuote.spread ?? market.spread ?? 0,
              quoteTimestamp: goldQuote.timestamp,
              receivedAt: goldQuote.receivedAt,
              timestamp: goldQuote.timestamp,
              freshnessMaxAgeMs: goldQuote.freshnessMaxAgeMs,
              quoteFreshnessMaxAgeMs: goldQuote.freshnessMaxAgeMs,
              verifiedQuote: true,
              source: goldQuote.source,
              directMarketFeed: goldQuote.provider
            };
          }
        } catch (error) {
          market = { ...market, directGoldFeedError: String(error?.message || "GOLD_API_DIRECT_FEED_UNAVAILABLE").slice(0,140) };
        }
      }
      const memory = await loadIntelligenceMemory(pool, user.id, symbol);
      const adaptivePerformance = await loadAdaptivePerformance(pool, {userId:user.id, symbol});
      const result = await orchestrateKingbotIntelligence({
        market,
        riskContext: req.body?.riskContext || {},
        options: { botId: req.body?.botId || null, pool, twelveData },
        memory,
        adaptivePerformance
      });
      await recordIntelligenceMemory(pool, user.id, result);
      await recordAdaptiveDecision(pool, user.id, result);
      res.json({
        ...result,
        brokerExecution: "NOT_AUTHORIZED_BY_ORCHESTRATOR",
        memory: { available: memory.length > 0, entries: memory.length }
      });
    } catch (error) {
      console.error("[KINGBOT ORCHESTRATOR]", error?.message || error);
      res.status(502).json({ ok: false, error: "KINGBOT_INTELLIGENCE_ORCHESTRATOR_FAILED", reason: String(error?.message || "ORCHESTRATOR_FAILED").slice(0, 220) });
    }
  });

  app.get("/api/ai/intelligence/status", async (req, res) => {
    const user = await requireUser(pool, req, res);
    if (!user) return;
    res.json({
      ok: true,
      orchestrator: "KINGBOT INTELLIGENCE ORCHESTRATOR",
      version: "3.0.0",
      identity: identitySnapshot(),
      cognitiveLoop: identitySnapshot().cognitiveLoop,
      agents: ["TECHNICAL ANALYST", "REGIME ANALYST", "MACRO + SENTIMENT ANALYST", "EXECUTION CONDITIONS ANALYST", "BULL RESEARCHER", "BEAR RESEARCHER", "RISK COUNCIL", "STRATEGY ROUTER"],
      engines: BOT_IDS,
      aiSynthesis: false,
      model: MODEL,
      deliberation: "PROPRIETARY_NATIVE",
      memoryPersistence: Boolean(pool),
      executionAuthority: "NONE",
      cacheMs: CACHE_MS,
      adaptiveMemory: true,
      adaptiveMinSamples: Number(process.env.KINGBOT_ADAPTIVE_MIN_SAMPLES || 8),
      adaptiveWindowDays: Number(process.env.KINGBOT_ADAPTIVE_WINDOW_DAYS || 90)
    });
  });

  app.get("/api/ai/intelligence/adaptive", async (req, res) => {
    try {
      const user = await requireUser(pool, req, res);
      if (!user) return;
      const symbol = upper(req.query?.symbol || "XAUUSD");
      const performance = await loadAdaptivePerformance(pool, {userId:user.id, symbol});
      res.json({
        ok:true,
        symbol,
        windowDays:Number(process.env.KINGBOT_ADAPTIVE_WINDOW_DAYS || 90),
        minSamples:Number(process.env.KINGBOT_ADAPTIVE_MIN_SAMPLES || 8),
        performance
      });
    } catch (error) {
      res.status(503).json({ok:false,error:"ADAPTIVE_INTELLIGENCE_UNAVAILABLE",reason:String(error?.message||"ADAPTIVE_INTELLIGENCE_UNAVAILABLE").slice(0,180)});
    }
  });

  app.post("/api/ai/intelligence/outcome", async (req, res) => {
    try {
      const user = await requireUser(pool, req, res);
      if (!user) return;
      const settled = await settleAdaptiveDecision(pool, user.id, req.body || {});
      res.json({ok:true, outcome:settled});
    } catch (error) {
      const message=String(error?.message||"ADAPTIVE_OUTCOME_FAILED");
      const status=/NOT_FOUND|REQUIRED|INVALID/.test(message)?400:503;
      res.status(status).json({ok:false,error:message});
    }
  });
}
