/**
 * KINGBOT AGENT TOOL ORCHESTRATOR v1
 *
 * Safe tool layer for the native KINGBOT agent.
 * Tools are read/diagnostic only. Live execution remains outside chat.
 */

import { getBotDefinitions } from "./bot-engines.js";
import { runStandaloneMarketScan } from "./ai-market-scanner.js";
import { loadAdaptivePerformance } from "./adaptive-intelligence.js";
import { getGlobalRiskState } from "./global-risk.js";
import { loadUserMemory, summarizeUserMemory } from "./kingbot-user-memory.js";

const TOOL_DEFS = Object.freeze({
  broker_status: { risk: "private-read", intents: ["CONNECTION_INTELLIGENCE"] },
  account_telemetry: { risk: "private-read", intents: ["ACCOUNT_INTELLIGENCE", "RISK_REVIEW"] },
  bot_runtime: { risk: "private-read", intents: ["RUNTIME_INTELLIGENCE"] },
  risk_state: { risk: "private-read", intents: ["RISK_REVIEW", "RUNTIME_INTELLIGENCE", "MARKET_INTELLIGENCE"] },
  strategy_context: { risk: "public-read", intents: ["BOT_INTELLIGENCE", "MARKET_INTELLIGENCE"] },
  adaptive_history: { risk: "private-read", intents: ["BOT_INTELLIGENCE", "MARKET_INTELLIGENCE"] },
  market_snapshot: { risk: "market-read", intents: ["MARKET_INTELLIGENCE", "MARKET_RESEARCH"] },
  user_memory: { risk: "private-read", intents: ["PLATFORM_SUPPORT", "CONVERSATION"] },
  event_history: { risk: "private-read", intents: ["RUNTIME_INTELLIGENCE", "ACCOUNT_INTELLIGENCE", "PLATFORM_SUPPORT"] }
});

const INTENT_TO_TOOLS = Object.freeze({
  CONNECTION_INTELLIGENCE: ["broker_status"],
  ACCOUNT_INTELLIGENCE: ["broker_status", "account_telemetry"],
  RUNTIME_INTELLIGENCE: ["bot_runtime", "risk_state"],
  RISK_REVIEW: ["account_telemetry", "risk_state", "bot_runtime"],
  BOT_INTELLIGENCE: ["strategy_context", "adaptive_history"],
  MARKET_INTELLIGENCE: ["market_snapshot", "strategy_context", "adaptive_history", "risk_state"],
  MARKET_RESEARCH: ["market_snapshot"],
  PLATFORM_SUPPORT: ["user_memory", "event_history"],
  CONVERSATION: ["user_memory"],
  GENERAL_KNOWLEDGE: [],
  PROGRAMMING: [],
  STORE_INTELLIGENCE: []
});

function clean(value, max = 220) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safePosition(position = {}) {
  return {
    id: clean(position.id || position.positionId || position.ticket || "", 80) || null,
    symbol: clean(position.symbol || "", 40) || null,
    side: clean(position.side || position.type || "", 12).toUpperCase() || null,
    volume: finite(position.volume ?? position.lots ?? position.quantity),
    entry: finite(position.openPrice ?? position.entryPrice ?? position.entry),
    current: finite(position.currentPrice ?? position.current ?? position.marketPrice),
    pnl: finite(position.profit ?? position.pnl ?? position.unrealizedProfit)
  };
}

async function executeTool(tool, ctx = {}) {
  const { pool, broker, twelveData, userId, symbol = "XAUUSD", timeframe = "15m", eventBus } = ctx;

  if (tool === "broker_status") {
    if (!broker || !userId) return { ok: false, reason: "AUTHENTICATION_REQUIRED" };
    const status = await broker.getStatus(userId);
    return {
      ok: true,
      configured: Boolean(status?.configured),
      connected: Boolean(status?.connected),
      broker: status?.broker || null,
      accountId: status?.accountId || null,
      executionMode: status?.executionMode || null,
      accountType: status?.accountType || status?.accountSnapshot?.accountType || null,
      syncedAt: status?.accountSnapshot?.syncedAt || null
    };
  }

  if (tool === "account_telemetry") {
    if (!broker || !userId) return { ok: false, reason: "AUTHENTICATION_REQUIRED" };
    const [accountResult, positionsResult] = await Promise.all([
      broker.getAccount(userId),
      broker.getPositions(userId)
    ]);
    const raw = accountResult?.data || accountResult || {};
    const rawPositions = Array.isArray(positionsResult?.data) ? positionsResult.data : Array.isArray(positionsResult) ? positionsResult : [];
    return {
      ok: true,
      balance: finite(raw.balance),
      equity: finite(raw.equity),
      margin: finite(raw.margin),
      freeMargin: finite(raw.freeMargin),
      currency: clean(raw.currency || "", 12) || null,
      positionCount: rawPositions.length,
      positions: rawPositions.slice(0, 25).map(safePosition)
    };
  }

  if (tool === "bot_runtime") {
    if (!pool || !userId) return { ok: false, reason: "AUTHENTICATION_REQUIRED" };
    const q = await pool.query(
      "SELECT bot_id,state,symbol,timeframe,execution_mode,last_error,last_signal,last_run_at,updated_at FROM kingbot_bot_runtime WHERE user_id=$1 ORDER BY bot_id",
      [userId]
    );
    return {
      ok: true,
      bots: q.rows.map(row => ({
        botId: row.bot_id,
        state: row.state,
        symbol: row.symbol || null,
        timeframe: row.timeframe || null,
        executionMode: row.execution_mode || null,
        lastError: row.last_error || null,
        lastSignal: row.last_signal || null,
        lastRunAt: row.last_run_at || null,
        updatedAt: row.updated_at || null
      }))
    };
  }

  if (tool === "risk_state") {
    if (!pool) return { ok: false, reason: "DATABASE_UNAVAILABLE" };
    const global = await getGlobalRiskState(pool);
    let botRisk = [];
    if (userId) {
      const q = await pool.query(
        "SELECT bot_id,daily_drawdown_pct,total_drawdown_pct,max_risk_per_trade_pct,max_positions,max_spread_atr_ratio,stale_data_ms,max_consecutive_losses,auto_pause_on_loss_streak,execution_mode,kill_switch FROM kingbot_bot_risk_settings WHERE user_id=$1 ORDER BY bot_id",
        [userId]
      );
      botRisk = q.rows.map(row => ({
        botId: row.bot_id,
        dailyDrawdownPct: finite(row.daily_drawdown_pct),
        totalDrawdownPct: finite(row.total_drawdown_pct),
        maxRiskPerTradePct: finite(row.max_risk_per_trade_pct),
        maxPositions: finite(row.max_positions),
        maxSpreadAtrRatio: finite(row.max_spread_atr_ratio),
        staleDataMs: finite(row.stale_data_ms),
        maxConsecutiveLosses: finite(row.max_consecutive_losses),
        autoPauseOnLossStreak: Boolean(row.auto_pause_on_loss_streak),
        executionMode: row.execution_mode,
        killSwitch: Boolean(row.kill_switch)
      }));
    }
    return {
      ok: true,
      global: {
        tradingPaused: Boolean(global?.tradingPaused),
        globalKillSwitch: Boolean(global?.globalKillSwitch),
        reason: clean(global?.reason || "", 180) || null
      },
      botRisk
    };
  }

  if (tool === "strategy_context") {
    const defs = getBotDefinitions();
    return {
      ok: true,
      engines: Object.values(defs).map(d => ({
        id: d.id,
        name: d.name,
        mode: d.mode,
        strategies: Array.isArray(d.strategies) ? d.strategies.slice(0, 12) : [],
        timeframeProfile: d.timeframeProfile || null,
        signalThreshold: d.signalThreshold || null
      }))
    };
  }

  if (tool === "adaptive_history") {
    if (!pool) return { ok: false, reason: "DATABASE_UNAVAILABLE" };
    const performance = await loadAdaptivePerformance(pool, { userId, symbol });
    return {
      ok: true,
      symbol,
      engines: Object.entries(performance || {}).map(([engine, value]) => ({
        engine,
        sampleCount: finite(value?.sampleCount ?? value?.samples),
        winRate: finite(value?.smoothedWinRate ?? value?.winRate),
        avgR: finite(value?.avgRMultiple),
        fitAdjustment: finite(value?.fitAdjustment ?? value?.adjustment)
      }))
    };
  }

  if (tool === "market_snapshot") {
    const scan = await runStandaloneMarketScan({
      pool,
      twelveData,
      symbols: [symbol],
      timeframe
    });
    const item = (scan?.technical || []).find(x => String(x.symbol).toUpperCase() === String(symbol).toUpperCase()) || {};
    const quote = (scan?.quotes || []).find(x => String(x.symbol).toUpperCase() === String(symbol).toUpperCase()) || null;
    return {
      ok: Boolean(scan?.ok),
      symbol,
      timeframe,
      source: scan?.source || item?.source || "KINGBOT_MARKET_ENGINE",
      quote: quote ? {
        available: Boolean(quote.available),
        price: finite(quote.price),
        bid: finite(quote.bid),
        ask: finite(quote.ask),
        timestamp: quote.timestamp || quote.time || null
      } : null,
      technical: {
        trend: clean(item.trend || "NEUTRAL", 30).toUpperCase(),
        momentum: finite(item.momentum),
        volatility: finite(item.volatility),
        structure: clean(item.structure || item.bias || "unknown", 60).toLowerCase(),
        rsi: finite(item.rsi ?? item.rsi14),
        adx: finite(item.adx ?? item.adx14),
        signal: clean(item.signal || "WAIT", 40).toUpperCase(),
        score: finite(item.score)
      }
    };
  }

  if (tool === "user_memory") {
    if (!pool || !userId) return { ok: false, reason: "AUTHENTICATION_REQUIRED" };
    const memory = await loadUserMemory(pool, userId, { limit: 20 });
    return { ok: true, memory: summarizeUserMemory(memory) };
  }

  if (tool === "event_history") {
    if (!eventBus || !userId) return { ok: false, reason: "EVENT_CONTEXT_UNAVAILABLE" };
    const events = await eventBus.recent({ userId, limit: 20, sinceMinutes: 120 });
    return {
      ok: true,
      events: events.map(event => ({
        eventId: event.event_id,
        correlationId: event.correlation_id,
        eventType: event.event_type,
        aggregateType: event.aggregate_type,
        aggregateId: event.aggregate_id,
        source: event.source,
        severity: event.severity,
        createdAt: event.created_at,
        payload: event.payload || {}
      }))
    };
  }

  return { ok: false, reason: "TOOL_NOT_FOUND" };
}

export function agentToolPlan({ intent, goal } = {}) {
  const selected = [...new Set(INTENT_TO_TOOLS[intent] || [])];
  return {
    selected,
    count: selected.length,
    executionPolicy: "READ_ONLY_VERIFIED_TOOLS",
    prohibited: ["PLACE_ORDER", "MODIFY_ORDER", "CLOSE_ORDER", "AUTHORIZE_LIVE_EXECUTION", "CHANGE_RISK_CONTROLS"]
  };
}

export async function executeKingbotAgentTools({
  intent,
  goal,
  pool,
  broker,
  twelveData,
  userId,
  symbol,
  timeframe,
  eventBus
} = {}) {
  const plan = agentToolPlan({ intent, goal });
  const results = {};
  for (const tool of plan.selected) {
    try {
      results[tool] = await executeTool(tool, { pool, broker, twelveData, userId, symbol, timeframe, eventBus });
    } catch (error) {
      results[tool] = { ok: false, reason: clean(error?.message || "TOOL_EXECUTION_FAILED", 180) };
    }
  }
  return {
    plan,
    results,
    executedAt: new Date().toISOString()
  };
}

export function summarizeToolContext(toolRun = {}) {
  const results = toolRun?.results || {};
  return Object.fromEntries(Object.entries(results).map(([tool, value]) => [
    tool,
    { ok: Boolean(value?.ok), reason: value?.ok ? null : clean(value?.reason || "UNAVAILABLE", 180) }
  ]));
}

export function verifiedToolFacts(toolRun = {}) {
  const facts = [];
  const results = toolRun?.results || {};

  const broker = results.broker_status;
  if (broker?.ok) {
    facts.push("BROKER TOOL · " + (broker.connected ? "CONNECTED" : "NOT CONNECTED") + (broker.broker ? " · " + broker.broker : ""));
    if (broker.executionMode) facts.push("EXECUTION MODE · " + broker.executionMode);
  }

  const account = results.account_telemetry;
  if (account?.ok) {
    if (account.balance !== null) facts.push("ACCOUNT BALANCE · " + String(account.balance) + (account.currency ? " " + account.currency : ""));
    if (account.equity !== null) facts.push("ACCOUNT EQUITY · " + String(account.equity) + (account.currency ? " " + account.currency : ""));
    facts.push("OPEN POSITIONS · " + String(account.positionCount));
  }

  const runtime = results.bot_runtime;
  if (runtime?.ok) facts.push("BOT RUNTIME TOOL · " + String(runtime.bots.length) + " runtime record(s) verified");

  const risk = results.risk_state;
  if (risk?.ok) {
    facts.push("GLOBAL RISK · " + (risk.global.globalKillSwitch ? "KILL SWITCH" : risk.global.tradingPaused ? "ORDERS PAUSED" : "OPEN"));
  }

  const market = results.market_snapshot;
  if (market?.ok) {
    if (market.quote?.available && market.quote.price !== null) facts.push("MARKET TOOL · " + market.symbol + " verified price " + String(market.quote.price));
    facts.push("MARKET TOOL · " + market.symbol + " " + market.timeframe + " · " + market.technical.trend + " · " + market.technical.signal);
  }

  const memory = results.user_memory;
  if (memory?.ok) facts.push("USER MEMORY TOOL · " + String(memory.memory.length) + " persisted context item(s)");

  return facts;
}

export const KINGBOT_AGENT_TOOLS = TOOL_DEFS;
