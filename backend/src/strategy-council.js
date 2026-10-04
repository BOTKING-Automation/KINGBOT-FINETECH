const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
const upper = v => String(v || "").trim().toUpperCase();

const DEFAULT_WEIGHTS = {
  specialistScore: 0.42,
  specialistConfidence: 0.18,
  htfAlignment: 0.14,
  trigger: 0.08,
  structure: 0.06,
  adaptive: 0.04,
  contradiction: 0.08
};

function directionFromSpecialist(card = {}) {
  const d = upper(card.direction);
  if (d === "BUY" || d === "SELL") return d;
  return "WAIT";
}

function specialistCouncilScore(engine, specialist, mtf = {}, weights = DEFAULT_WEIGHTS) {
  if (!specialist) {
    const raw = Number(engine?.score || 0);
    return Number(clamp(Math.abs(raw), 0, 100).toFixed(2));
  }
  const direction = directionFromSpecialist(specialist);
  if (direction === "WAIT" || !specialist.strategyMatch) return 0;
  const raw = Math.abs(Number(specialist.rawScore || 0));
  let score = raw * weights.specialistScore;
  score += Number(specialist.confidence || 0) * weights.specialistConfidence;
  const htf = upper(mtf.higherTimeframeBias);
  if (htf && htf !== "MIXED") {
    const expected = direction === "BUY" ? "BULLISH" : "BEARISH";
    score += direction === expected ? 100 * weights.htfAlignment : -100 * weights.htfAlignment;
  }
  if (mtf.triggerPresent) score += 100 * weights.trigger;
  const structure = upper(mtf.alignment?.direction);
  if (structure && structure !== "MIXED") {
    const expected = direction === "BUY" ? "BULLISH" : "BEARISH";
    score += structure === expected ? 100 * weights.structure : -100 * weights.structure;
  }
  const adaptive = Number(engine?.adaptiveAdjustment || 0);
  score += clamp(adaptive * 2, -12, 12) * weights.adaptive;
  score -= Math.min(100, (specialist.contradictions?.length || 0) * 12) * weights.contradiction;
  return Number(clamp(score, 0, 100).toFixed(2));
}

export function buildStrategyCouncil(engines = [], {
  multiTimeframe = {},
  riskBlocks = [],
  marketDecision = "WAIT",
  weights = DEFAULT_WEIGHTS,
  minAgreement = 0.6
} = {}) {
  const rows = engines.map(engine => {
    const specialist = engine.specialist || null;
    const direction = directionFromSpecialist(specialist) || (
      upper(engine.signal) === "LONG_CANDIDATE" ? "BUY" :
      upper(engine.signal) === "SHORT_CANDIDATE" ? "SELL" : "WAIT"
    );
    const councilScore = specialistCouncilScore(engine, specialist, multiTimeframe, weights);
    return {
      botId: engine.botId,
      name: engine.name,
      strategyIdentity: specialist?.strategyIdentity || "Legacy bot strategy evaluator",
      direction,
      rawScore: Number(specialist?.rawScore ?? engine.score ?? 0),
      confidence: Number(specialist?.confidence ?? 0),
      councilScore,
      strategyMatch: Boolean(specialist?.strategyMatch ?? engine.strategyMatch),
      conditions: specialist?.conditions || [],
      missingConditions: specialist?.missingConditions || [],
      entryConditions: specialist?.entryConditions || [],
      waitConditions: specialist?.waitConditions || [],
      invalidation: specialist?.invalidation || "No directional candidate.",
      timeframeRequirements: specialist?.timeframeRequirements || engine.timeframeProfile || {},
      marketRegimes: specialist?.marketRegimes || [],
      evidenceUsed: specialist?.evidenceUsed || [],
      contradictions: specialist?.contradictions || [],
      adaptiveAdjustment: Number(engine.adaptiveAdjustment || 0),
      historicalSampleSize: Number(engine.historicalSampleSize || 0),
      reason: specialist?.entryConditions?.[0] || specialist?.waitConditions?.[0] || engine.reason || "No strategy reason supplied."
    };
  });

  const eligible = rows.filter(r => r.strategyMatch && r.direction !== "WAIT");
  const bullish = eligible.filter(r => r.direction === "BUY");
  const bearish = eligible.filter(r => r.direction === "SELL");
  const waitVotes = rows.length - eligible.length;
  const buyScore = bullish.reduce((s, r) => s + r.councilScore, 0);
  const sellScore = bearish.reduce((s, r) => s + r.councilScore, 0);
  const sorted = [...eligible].sort((a,b) => b.councilScore - a.councilScore || b.confidence - a.confidence);
  const strongest = sorted[0] || null;
  const runnerUp = sorted[1] || null;
  const weightedDirection = buyScore === sellScore ? "WAIT" : buyScore > sellScore ? "BUY" : "SELL";
  const directionalAgreement = eligible.length
    ? Math.max(bullish.length, bearish.length) / eligible.length
    : 0;
  const agreementRatio = rows.length
    ? Math.max(bullish.length, bearish.length) / rows.length
    : 0;

  const opposing = strongest
    ? eligible.filter(r => r.direction !== strongest.direction)
    : [];
  const strongOpposition = opposing.filter(r => r.confidence >= 70 && r.councilScore >= 55);
  const blockers = Array.isArray(riskBlocks) ? riskBlocks : [];

  let state = "WAIT";
  let reason = "No specialist has a valid setup.";
  if (blockers.length) {
    state = "WAIT";
    reason = "Deterministic risk controls override all AI specialist candidates.";
  } else if (!strongest) {
    state = "WAIT";
    reason = "All five AI specialists are waiting for their own strategy conditions.";
  } else if (upper(multiTimeframe.setupState) === "DATA_INSUFFICIENT") {
    state = "WAIT";
    reason = "Required multi-timeframe market evidence is incomplete.";
  } else if (upper(multiTimeframe.setupState) === "CONFLICTED") {
    state = "CONFLICTED";
    reason = "Higher and lower timeframe evidence conflicts.";
  } else if (marketDecision !== "BUY" && marketDecision !== "SELL") {
    state = "WAIT";
    reason = "Independent market evidence gate is not directional.";
  } else if (strongest.direction !== marketDecision) {
    state = "CONFLICTED";
    reason = "The strongest specialist conflicts with the independent market evidence gate.";
  } else if (strongOpposition.length >= 2) {
    state = "CONFLICTED";
    reason = "Multiple independent specialists strongly contradict the primary setup.";
  } else {
    // A specialist may lead without majority voting. WAITING specialists are not treated as dissent.
    state = strongest.direction;
    reason = strongOpposition.length
      ? strongest.name + " has a valid specialist setup; opposing specialists are recorded as dissent."
      : strongest.name + " has the strongest valid specialist setup.";
  }

  const totalDirectional = buyScore + sellScore;
  const primaryShare = strongest && totalDirectional > 0
    ? strongest.councilScore / (strongest.direction === "BUY" ? buyScore : sellScore)
    : 0;
  let confidence = strongest
    ? (strongest.confidence * 0.55) + (Math.min(100, strongest.councilScore) * 0.35) + (Math.min(100, directionalAgreement * 100) * 0.10)
    : 0;
  if (strongOpposition.length) confidence -= 10;
  if (state === "CONFLICTED") confidence = Math.min(confidence, 55);
  if (state === "WAIT" && blockers.length) confidence = 0;
  confidence = Number(clamp(confidence, 0, state === "BUY" || state === "SELL" ? 92 : 55).toFixed(2));

  const dissent = eligible.filter(r => strongest && r.botId !== strongest.botId && r.direction !== strongest.direction).map(r => ({
    botId:r.botId, name:r.name, direction:r.direction, confidence:r.confidence, councilScore:r.councilScore,
    reason:r.reason, contradictions:r.contradictions
  }));
  const supporters = eligible.filter(r => strongest && r.botId !== strongest.botId && r.direction === strongest.direction).map(r => ({
    botId:r.botId, name:r.name, confidence:r.confidence, councilScore:r.councilScore
  }));

  const whatToWait = [];
  if (blockers.length) whatToWait.push(...blockers.map(x => "Resolve " + x + "."));
  if (state === "WAIT" || state === "CONFLICTED") {
    if (upper(multiTimeframe.setupState) === "DATA_INSUFFICIENT") whatToWait.push("Restore all required 5m/15m/1h/4h market data.");
    if (upper(multiTimeframe.setupState) === "CONFLICTED") whatToWait.push("Wait for higher/lower timeframe alignment.");
    if (marketDecision !== "BUY" && marketDecision !== "SELL") whatToWait.push("Wait for the independent evidence gate to confirm direction.");
  }
  if (strongest) {
    for (const item of strongest.missingConditions || []) whatToWait.push(item);
    for (const item of strongest.waitConditions || []) whatToWait.push(item);
  }

  return {
    state,
    reason,
    engines: rows,
    primarySpecialist: strongest,
    supportingSpecialists: supporters,
    dissentingSpecialists: dissent,
    bullishVotes: bullish.length,
    bearishVotes: bearish.length,
    waitVotes,
    agreementRatio:Number(agreementRatio.toFixed(3)),
    directionalAgreement:Number(directionalAgreement.toFixed(3)),
    weightedScores:{buy:Number(buyScore.toFixed(2)),sell:Number(sellScore.toFixed(2))},
    weightedDirection,
    strongestEngine:strongest,
    runnerUp,
    divergence:dissent.map(x=>({botId:x.botId,direction:x.direction,councilScore:x.councilScore})),
    confidence,
    confidenceMethod:"specialist strategy completion + specialist confidence + independent evidence alignment; no majority-vote requirement",
    whatToWait:[...new Set(whatToWait)].slice(0,10),
    invalidation:strongest?.invalidation || "No directional trade candidate until a specialist setup is valid.",
    executionAuthorized:false,
    executionAuthority:"NONE",
    primaryShare:Number(primaryShare.toFixed(3)),
    minAgreement:Number(minAgreement)
  };
}
