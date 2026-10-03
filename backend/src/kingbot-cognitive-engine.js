/*
 * KINGBOT CORTEX
 * Proprietary deterministic reasoning kernel.
 *
 * This is not an LLM and does not pretend to be conscious.
 * It provides KINGBOT with a repeatable "thinking mindset":
 * decomposition -> retrieval -> hypothesis -> evidence weighting ->
 * contradiction testing -> confidence calibration -> decision framing ->
 * self-critique -> explanation.
 */

const STOP_WORDS = new Set([
  "the","a","an","is","are","to","of","and","or","for","on","in","with","my","your",
  "what","how","why","can","does","do","i","we","it","this","that","about","me",
  "please","tell","show","give","get","now"
]);

const GOAL_PATTERNS = [
  ["DIAGNOSE", /\b(why|diagnos|error|broken|failed|not working|stopped|paused|issue|problem)\b/i],
  ["COMPARE", /\b(compare|versus|vs\.?|difference|better|which one)\b/i],
  ["DECIDE", /\b(should|recommend|choose|best|decision|buy|sell|long|short|enter)\b/i],
  ["EXPLAIN", /\b(explain|how does|what is|what are|teach|meaning|define)\b/i],
  ["VERIFY", /\b(verify|check|confirm|is it true|connected|status|actual|real|live)\b/i],
  ["RESEARCH", /\b(latest|current|news|research|search|look up|today)\b/i]
];

const ENTITY_PATTERNS = {
  XAUUSD: /\bxauusd\b|\bgold\b/i,
  EURUSD: /\beurusd\b|\beuro\b/i,
  GBPUSD: /\bgbpusd\b|\bpound\b/i,
  USDJPY: /\busdjpy\b|\byen\b/i,
  BTCUSD: /\bbtcusd\b|\bbitcoin\b/i,
  BROKER: /\bbroker|deriv|mt5|exness|oanda\b/i,
  RISK: /\brisk|drawdown|exposure|margin|stop loss|take profit|position size\b/i,
  STRATEGY: /\bstrateg|engine|smc|breakout|flipper|ladder|mean reversion|trend following\b/i,
  ACCOUNT: /\baccount|balance|equity|free margin|positions?\b/i,
  PLATFORM: /\bkingbot|platform|dashboard|subscription|payment|bot|terminal\b/i
};

const capitalize = s => String(s || "").replace(/^./, c => c.toUpperCase());
const normalize = s => String(s || "").replace(/\s+/g, " ").trim();
const tokens = s => normalize(s).toLowerCase().match(/[a-z0-9_+-]+/g) || [];
const unique = xs => [...new Set(xs)];

function lexicalTerms(text) {
  return unique(tokens(text).filter(t => t.length > 2 && !STOP_WORDS.has(t))).slice(0, 32);
}

function inferGoals(question) {
  const q = normalize(question);
  return GOAL_PATTERNS.filter(([,re]) => re.test(q)).map(([name]) => name);
}

function inferEntities(question) {
  const q = normalize(question);
  return Object.entries(ENTITY_PATTERNS).filter(([,re]) => re.test(q)).map(([name]) => name);
}

function intentProfile(intent, question) {
  const goals = inferGoals(question);
  const entities = inferEntities(question);
  const primaryGoal = goals[0] || (
    /CONNECTION|ACCOUNT|RUNTIME/.test(intent) ? "VERIFY" :
    /MARKET/.test(intent) ? "DECIDE" :
    /BOT|PLATFORM|BOOK|STORE/.test(intent) ? "EXPLAIN" : "EXPLAIN"
  );
  return { primaryGoal, goals: unique(goals), entities };
}

function flattenEvidence(reply = {}) {
  return {
    facts: Array.isArray(reply.facts) ? reply.facts.map(String).slice(0, 20) : [],
    technical: Array.isArray(reply.technicalAnalysis) ? reply.technicalAnalysis.map(String).slice(0, 24) : [],
    risks: Array.isArray(reply.riskFlags) ? reply.riskFlags.map(String).slice(0, 16) : [],
    nextAction: normalize(reply.nextAction),
    setup: reply.setup || {}
  };
}

function evidenceReliability(text) {
  const t = String(text).toLowerCase();
  if (/verified|broker|backend|live quote|technical snapshot|database|server/.test(t)) return 1.0;
  if (/adaptive|historical|settled|engine|strategy/.test(t)) return 0.92;
  if (/analysis|technical|structure|regime|momentum/.test(t)) return 0.82;
  if (/research|source|news/.test(t)) return 0.72;
  return 0.62;
}

function scoreEvidence(question, evidence) {
  const qTerms = new Set(lexicalTerms(question));
  return evidence.map((text, index) => {
    const eTerms = new Set(lexicalTerms(text));
    let overlap = 0;
    for (const t of eTerms) if (qTerms.has(t)) overlap++;
    const relevance = Math.min(1, 0.35 + overlap * 0.12);
    const reliability = evidenceReliability(text);
    const recency = /live|current|today|fresh|received|timestamp/.test(String(text).toLowerCase()) ? 1 : 0.8;
    const score = Number((relevance * 0.45 + reliability * 0.40 + recency * 0.15).toFixed(3));
    return { text, score, relevance, reliability, rank: index + 1 };
  }).sort((a,b) => b.score - a.score);
}

function buildHypotheses({ intent, question, reply, profile }) {
  const setup = reply?.setup || {};
  const signal = normalize(setup.signal).toUpperCase();
  const hypotheses = [];

  if (/MARKET/.test(intent)) {
    if (/BUY|BULL/.test(signal)) hypotheses.push({
      id: "H1",
      label: "BULLISH_CONTINUATION",
      claim: "The verified evidence supports a bullish market hypothesis.",
      direction: "BUY"
    });
    if (/SELL|BEAR/.test(signal)) hypotheses.push({
      id: "H1",
      label: "BEARISH_CONTINUATION",
      claim: "The verified evidence supports a bearish market hypothesis.",
      direction: "SELL"
    });
    hypotheses.push({
      id: "H2",
      label: "NO_EDGE",
      claim: "The apparent directional edge may be insufficient or vulnerable to invalidation.",
      direction: "HOLD"
    });
    hypotheses.push({
      id: "H3",
      label: "REGIME_CHANGE",
      claim: "The current structure could be transitioning and reduce the reliability of the current signal.",
      direction: "HOLD"
    });
  } else if (profile.primaryGoal === "DIAGNOSE") {
    hypotheses.push(
      { id:"H1", label:"PRIMARY_REPORTED_CAUSE", claim:"The backend/runtime evidence contains the most direct explanation." },
      { id:"H2", label:"SECONDARY_STATE_INTERACTION", claim:"A separate runtime, broker or risk state may be interacting with the reported condition." },
      { id:"H3", label:"DATA_OR_CONFIGURATION_GAP", claim:"The observed symptom may persist because required telemetry or configuration is missing." }
    );
  } else if (profile.primaryGoal === "COMPARE") {
    hypotheses.push(
      { id:"H1", label:"OBJECTIVE_MATCH", claim:"The strongest option is the one that best matches the stated objective and constraints." },
      { id:"H2", label:"TRADEOFF_DOMINATES", claim:"A hidden tradeoff may matter more than the headline difference." }
    );
  } else {
    hypotheses.push(
      { id:"H1", label:"DIRECT_INTERPRETATION", claim:"The verified platform evidence supports the most direct interpretation of the request." },
      { id:"H2", label:"CONTEXTUAL_INTERPRETATION", claim:"The previous conversation context changes what the user is actually asking." },
      { id:"H3", label:"INSUFFICIENT_EVIDENCE", claim:"The correct answer may require additional verified context rather than a confident assumption." }
    );
  }

  return hypotheses;
}

function contradictionPairs(evidence) {
  const pairs = [];
  for (let i = 0; i < evidence.length; i++) {
    for (let j = i + 1; j < evidence.length; j++) {
      const a = evidence[i].text.toLowerCase();
      const b = evidence[j].text.toLowerCase();
      const positive = /bullish|buy|connected|active|available|fresh|ready|allowed|running/.test(a);
      const negative = /bearish|sell|not connected|unavailable|stale|blocked|stopped|error|paused/.test(b);
      const reversePositive = /bullish|buy|connected|active|available|fresh|ready|allowed|running/.test(b);
      const reverseNegative = /bearish|sell|not connected|unavailable|stale|blocked|stopped|error|paused/.test(a);
      if ((positive && negative) || (reversePositive && reverseNegative)) {
        pairs.push({
          a: evidence[i].text,
          b: evidence[j].text,
          severity: "REVIEW"
        });
      }
    }
  }
  return pairs.slice(0, 5);
}

function confidenceScore({ evidence, contradictions, hypotheses, reply }) {
  const top = evidence.slice(0, 8);
  const avg = top.length ? top.reduce((s,e) => s + e.score, 0) / top.length : 0;
  const contradictionPenalty = Math.min(0.30, contradictions.length * 0.07);
  const setup = reply?.setup || {};
  const signalBonus = /ENTRY_CONFIRMING|BUY|SELL/.test(normalize(setup.signal).toUpperCase()) ? 0.08 : 0;
  const evidenceBonus = Math.min(0.12, evidence.length * 0.015);
  const raw = Math.max(0, Math.min(1, avg + signalBonus + evidenceBonus - contradictionPenalty));
  return Math.round(raw * 100);
}

function challengeHypotheses(hypotheses, scoredEvidence, contradictions) {
  return hypotheses.map(h => {
    const supporting = scoredEvidence.filter(e =>
      h.label === "NO_EDGE"
        ? /wait|insufficient|unavailable|stale|neutral|no route|blocked/i.test(e.text)
        : /buy|bull|sell|bear|trend|structure|signal|connected|running|verified/i.test(e.text)
    ).slice(0, 4);
    const challenged = h.label === "NO_EDGE"
      ? scoredEvidence.filter(e => /buy|bull|sell|bear|entry/i.test(e.text)).slice(0, 3)
      : scoredEvidence.filter(e => /wait|insufficient|unavailable|stale|blocked|error|neutral/i.test(e.text)).slice(0, 3);
    const conflict = contradictions.length > 0 && challenged.length > 0;
    return {
      ...h,
      supporting: supporting.map(x => x.text),
      counterEvidence: challenged.map(x => x.text),
      challenged: conflict || challenged.length > 0,
      status: supporting.length && !conflict ? "SUPPORTED" : challenged.length ? "CONTESTED" : "WEAK"
    };
  });
}

function critique({ question, intent, profile, evidence, hypotheses, contradictions, confidence }) {
  const issues = [];
  if (!evidence.length) issues.push("NO_EVIDENCE");
  if (contradictions.length) issues.push("EVIDENCE_CONFLICT");
  if (confidence < 55) issues.push("LOW_CONFIDENCE");
  if (profile.primaryGoal === "DECIDE" && confidence < 70) issues.push("DECISION_REQUIRES_MORE_EVIDENCE");
  if (/MARKET/.test(intent) && !evidence.some(e => /live|quote|snapshot|price|technical/i.test(e.text))) issues.push("MARKET_DATA_NOT_EXPLICIT");
  if (hypotheses.filter(h => h.status === "SUPPORTED").length === 0) issues.push("NO_HYPOTHESIS_DOMINATES");
  return {
    passed: issues.length === 0,
    issues,
    statement: issues.length
      ? "KINGBOT challenged its own first interpretation and found: " + issues.join(", ") + "."
      : "KINGBOT's evidence and alternative-hypothesis checks are internally consistent."
  };
}

function synthesize({ intent, question, reply, profile, scoredEvidence, challenged, contradictions, confidence, critiqueState, conversation }) {
  const direct = normalize(reply.answer) || "KINGBOT has no validated answer yet.";
  const dominant = challenged.find(h => h.status === "SUPPORTED") || challenged[0];
  const evidenceFor = (dominant?.supporting || scoredEvidence.slice(0, 3).map(x => x.text)).slice(0, 5);
  const evidenceAgainst = unique([
    ...(dominant?.counterEvidence || []),
    ...contradictions.flatMap(x => [x.a, x.b])
  ]).slice(0, 5);
  const uncertainties = [];
  if (confidence < 70) uncertainties.push("Confidence is below KINGBOT's high-conviction threshold.");
  if (contradictions.length) uncertainties.push("Some evidence conflicts and requires verification.");
  if (!evidenceFor.length) uncertainties.push("No strong supporting evidence was available.");
  if (/DATA_INSUFFICIENT|UNAVAILABLE|STALE|NO_ROUTE/i.test(normalize(reply?.setup?.signal))) {
    uncertainties.push("The current evidence does not justify a strong conclusion.");
  }

  const alternatives = challenged
    .filter(h => h.id !== dominant?.id)
    .map(h => h.label + ": " + h.claim)
    .slice(0, 3);

  const validation = [];
  if (reply?.setup?.waitFor) validation.push("Verify: " + normalize(reply.setup.waitFor));
  if (reply?.setup?.invalidation) validation.push("Invalidation: " + normalize(reply.setup.invalidation));
  if (critiqueState.issues.includes("EVIDENCE_CONFLICT")) validation.push("Resolve conflicting evidence before increasing confidence.");
  if (critiqueState.issues.includes("MARKET_DATA_NOT_EXPLICIT")) validation.push("Obtain fresh verified market data before a market conclusion.");
  if (!validation.length) validation.push("Re-check the authoritative backend state before acting.");

  const reasoningSummary = [
    "Intent: " + intent + " · objective: " + profile.primaryGoal,
    "Relevant entities: " + (profile.entities.join(", ") || "GENERAL"),
    "Evidence set: " + scoredEvidence.length + " items scored for relevance and reliability.",
    "Leading hypothesis: " + (dominant?.label || "NONE"),
    "Self-critique: " + critiqueState.statement
  ];

  return {
    answer: direct,
    reasoningSummary,
    evidenceFor,
    evidenceAgainst,
    uncertainties,
    alternativeHypotheses: alternatives,
    validationSteps: validation,
    confidence,
    cognitiveState: {
      objective: profile.primaryGoal,
      entities: profile.entities,
      evidenceCount: scoredEvidence.length,
      contradictions: contradictions.length,
      leadingHypothesis: dominant?.id || null,
      confidence,
      critique: critiqueState.issues,
      conversationConsidered: Array.isArray(conversation) ? Math.min(6, conversation.length) : 0
    }
  };
}

export function think({ question="", intent="PLATFORM_SUPPORT", reply={}, conversation=[], thinkingLevel="EXPERT" } = {}) {
  const level = String(thinkingLevel || "EXPERT").toUpperCase();
  const profiles = {
    FAST:{passes:2,evidenceLimit:8,hypothesisLimit:2},
    STANDARD:{passes:4,evidenceLimit:14,hypothesisLimit:3},
    DEEP:{passes:6,evidenceLimit:20,hypothesisLimit:4},
    EXPERT:{passes:8,evidenceLimit:30,hypothesisLimit:6}
  };
  const cfg=profiles[level]||profiles.EXPERT;

  const profile = intentProfile(intent, question);
  const flat = flattenEvidence(reply);
  const evidence = [...flat.facts, ...flat.technical, ...flat.risks].filter(Boolean);
  const scoredEvidence = scoreEvidence(question, evidence).slice(0,cfg.evidenceLimit);
  const hypotheses = buildHypotheses({ intent, question, reply, profile }).slice(0,cfg.hypothesisLimit);
  const contradictions = contradictionPairs(scoredEvidence.slice(0, 14));
  const challenged = challengeHypotheses(hypotheses, scoredEvidence, contradictions);
  let confidence = confidenceScore({ evidence: scoredEvidence, contradictions, hypotheses, reply });
  for(let pass=1; pass<cfg.passes; pass++){
    const adjustment = (scoredEvidence.length>8?1:0) - Math.min(2, contradictions.length);
    confidence = Math.max(0, Math.min(100, confidence + adjustment));
  }
  const critiqueState = critique({ question, intent, profile, evidence: scoredEvidence, hypotheses, contradictions, confidence });
  const synthesis = synthesize({ intent, question, reply, profile, scoredEvidence, challenged, contradictions, confidence, critiqueState, conversation });

  return {
    engine: "KINGBOT_CORTEX",
    version: "1.0.0",
    mode: "PROPRIETARY_REASONING",
    thinkingLevel: level,
    passes: cfg.passes,
    evidenceLimit: cfg.evidenceLimit,
    hypothesisLimit: cfg.hypothesisLimit,
    stages: ["DECOMPOSE","RETRIEVE","HYPOTHESIZE","WEIGH","CHALLENGE","CALIBRATE","SELF_CRITIQUE","SYNTHESIZE"],
    ...synthesis
  };
}
