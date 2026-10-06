import { agentToolPlan } from "./kingbot-agent-tools.js";

/*
 * KINGBOT AGENT CORE v2
 * Native agent controller for KINGBOT FINTECH.
 *
 * This is the orchestration layer that makes the platform behave like one
 * coherent assistant instead of a collection of unrelated route handlers.
 * It does not expose hidden reasoning and does not claim consciousness.
 */

const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
const upper = value => normalize(value).toUpperCase();

const GOAL_TO_RESPONSE = Object.freeze({
  UNDERSTAND: "EXPLANATORY",
  SOLVE: "ACTIONABLE",
  DIAGNOSE: "DIAGNOSTIC",
  COMPARE: "COMPARATIVE",
  DECIDE: "DECISION_SUPPORT",
  VERIFY: "EVIDENCE_FIRST",
  RESEARCH: "RESEARCH"
});

const INTENT_TO_KNOWLEDGE = Object.freeze({
  CONVERSATION: ["CONVERSATION_CONTEXT"],
  KINGBOT_KNOWLEDGE: ["KINGBOT_ARCHITECTURE", "ENGINE_DEFINITIONS"],
  CONNECTION_INTELLIGENCE: ["BROKER_STATUS"],
  ACCOUNT_INTELLIGENCE: ["ACCOUNT_TELEMETRY", "POSITIONS"],
  RUNTIME_INTELLIGENCE: ["RUNTIME_STATE", "RISK_STATE"],
  RISK_REVIEW: ["RISK_STATE", "ACCOUNT_TELEMETRY", "POSITIONS"],
  BOT_INTELLIGENCE: ["ENGINE_DEFINITIONS", "ADAPTIVE_HISTORY"],
  MARKET_INTELLIGENCE: ["LIVE_QUOTE", "TECHNICAL_SNAPSHOT", "MULTI_TIMEFRAME", "ENGINE_CONSENSUS", "RISK_STATE"],
  MARKET_RESEARCH: ["LIVE_QUOTE", "WEB_RESEARCH", "MARKET_CONTEXT"],
  WEB_RESEARCH: ["WEB_RESEARCH"],
  TECHNICAL_ANALYSIS_BOOK: ["TECHNICAL_REFERENCE"],
  STORE_INTELLIGENCE: ["SUBSCRIPTION_STATE", "PAYMENT_STATE"],
  PROGRAMMING: ["PROJECT_CONTEXT", "ERROR_CONTEXT"],
  PLATFORM_SUPPORT: ["PLATFORM_STATE", "CONVERSATION_CONTEXT"],
  GENERAL_KNOWLEDGE: ["VERIFIED_KNOWLEDGE"]
});

function chooseGoals(frame = {}) {
  const goals = Array.isArray(frame.userGoals) ? frame.userGoals : [];
  return goals.length ? [...new Set(goals)] : ["UNDERSTAND"];
}

function chooseResponseMode(frame = {}) {
  if (frame.responseMode) return upper(frame.responseMode);
  const goal = chooseGoals(frame)[0];
  return GOAL_TO_RESPONSE[goal] || "DIRECT";
}

function chooseKnowledge(intent, frame = {}) {
  const base = INTENT_TO_KNOWLEDGE[intent] || INTENT_TO_KNOWLEDGE.PLATFORM_SUPPORT;
  const needsFreshness = chooseGoals(frame).includes("RESEARCH") || /latest|current|today|now|live/i.test(frame.resolvedUtterance || "");
  return needsFreshness && !base.includes("WEB_RESEARCH")
    ? [...base, "FRESHNESS_CHECK"]
    : [...base];
}

export function buildKingbotAgentPlan({
  question = "",
  intent = "PLATFORM_SUPPORT",
  symbol = null,
  conversation = [],
  frame = {},
  thinkingLevel = "EXPERT",
  memory = [],
  memorySummary = [],
  originalQuestion = ""
} = {}) {
  const goals = chooseGoals(frame);
  const responseMode = chooseResponseMode(frame);
  const knowledge = chooseKnowledge(intent, frame);
  const hasContext = Number(frame?.historyDepth || conversation.length || 0) > 0;
  const memoryAvailable = Array.isArray(memory) && memory.length > 0;
  const referenceResolved = Boolean(frame?.contextResolved);

  return {
    agent: "KINGBOT_AGENT_CORE",
    version: "2.0.0",
    userGoal: goals[0],
    userGoals: goals,
    responseMode,
    intent,
    symbol: symbol ? upper(symbol) : null,
    thinkingLevel: upper(thinkingLevel),
    context: {
      available: hasContext,
      referenceResolved,
      topic: frame?.topic || null,
      historyDepth: Number(frame?.historyDepth || conversation.length || 0),
      memoryAvailable,
      memoryCount: Array.isArray(memory) ? memory.length : 0,
      memorySummary: Array.isArray(memorySummary) ? memorySummary : [],
      effectiveQuestion: normalize(question),
      originalQuestion: normalize(originalQuestion)
    },
    knowledgeRoute: knowledge,
    toolPlan: agentToolPlan({ intent, goal: goals[0] }),
    loop: [
      "UNDERSTAND_USER",
      "RECALL_CONTEXT",
      "SELECT_KNOWLEDGE",
      "VERIFY",
      "REASON",
      "RESPOND",
      "ADAPT"
    ],
    executionBoundary: "NONE"
  };
}

function cleanAgentLanguage(answer) {
  return normalize(answer)
    .replace(/^KINGBOT (?:AI|INTELLIGENCE|CORTEX)\s*(?:is|:)?\s*/i, "")
    .replace(/^Request failed \(HTTP \d+\)\.?\s*/i, "")
    .trim();
}

function contextLead(frame = {}) {
  if (!frame?.contextResolved) return "";
  const topic = normalize(frame.topic);
  if (!topic) return "";
  return "";
}

function conversationContinuity(frame = {}) {
  const depth = Number(frame?.historyDepth || 0);
  return depth > 0;
}

function composeAgentAnswer(answer, frame = {}) {
  const text = adaptResponseStyle(answer, frame);
  if (!conversationContinuity(frame)) return text;

  // Context is used to preserve continuity, not to invent missing facts.
  // The upstream dialogue/knowledge layer remains authoritative for content.
  return text;
}

function adaptResponseStyle(answer, frame = {}) {
  const raw = normalize(answer);
  if (!raw) return "I’m here. Tell me what you want to work through.";

  const text = cleanAgentLanguage(raw);
  if (!text) return "I’m here. Tell me what you want to work through.";

  const mode = chooseResponseMode(frame);
  const lead = contextLead(frame);

  // The core never invents facts or live values. It only improves presentation
  // of an already-produced, verified-or-explicitly-qualified answer.
  if (lead) return \`\${lead}\${text}\`;

  if (mode === "DIAGNOSTIC" && !/[.!?]$/.test(text)) return \`\${text}.\`;
  return text;
}

function buildAgentSnapshot({ plan, verified = {}, learning = null } = {}) {
  return {
    agent: "KINGBOT_AGENT_CORE",
    state: "READY",
    goal: plan?.userGoal || "UNDERSTAND",
    intent: plan?.intent || "PLATFORM_SUPPORT",
    responseMode: plan?.responseMode || "DIRECT",
    knowledgeRoute: Array.isArray(plan?.knowledgeRoute) ? plan.knowledgeRoute : [],
    contextAware: Boolean(plan?.context?.available),
    memoryAware: Boolean(plan?.context?.memoryAvailable),
    memoryCount: Number(plan?.context?.memoryCount || 0),
    verified: Object.keys(verified || {}).length > 0,
    adaptiveLearning: Boolean(learning),
    executionAuthority: "NONE"
  };
}

export function createKingbotAgent({
  question = "",
  intent = "PLATFORM_SUPPORT",
  symbol = null,
  conversation = [],
  frame = {},
  thinkingLevel = "EXPERT",
  verified = {},
  learning = null,
  memory = [],
  memorySummary = [],
  originalQuestion = ""
} = {}) {
  const plan = buildKingbotAgentPlan({ question, originalQuestion, intent, symbol, conversation, frame, thinkingLevel, memory, memorySummary });
  return {
    plan,
    snapshot: buildAgentSnapshot({ plan, verified, learning }),
    responseStyle: {
      naturalLanguage: true,
      memoryAware: plan.context.memoryAvailable,
      contextAware: plan.context.available,
      userGoalFirst: true,
      hiddenReasoning: false,
      adaptive: Boolean(learning)
    }
  };
}

export function agentAnswer(answer, frame = {}) {
  return composeAgentAnswer(answer, frame);
}

export function agentCapabilitySnapshot({ intent = "PLATFORM_SUPPORT", frame = {}, memory = [], verified = {} } = {}) {
  const plan = buildKingbotAgentPlan({ intent, frame, memory });
  return {
    agent: "KINGBOT_AGENT_CORE",
    version: "2.0.0",
    intent: plan.intent,
    responseMode: plan.responseMode,
    context: plan.context,
    knowledgeRoute: plan.knowledgeRoute,
    verifiedFactsAvailable: Object.keys(verified || {}).length > 0,
    executionAuthority: "NONE",
    liveDataPolicy: "REQUIRE_VERIFIED_SOURCE"
  };
}
