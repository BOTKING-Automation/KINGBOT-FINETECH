const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
const upper = v => String(v || "").trim().toUpperCase();

const DEFAULT_WEIGHTS = {
  rawScore: 0.42,
  strategyFit: 0.18,
  htfAlignment: 0.14,
  trigger: 0.08,
  structure: 0.08,
  adaptive: 0.05,
  contradiction: 0.05
};

function directionFromEngine(engine = {}) {
  const score = Number(engine.score || 0);
  if (upper(engine.signal) === "LONG_CANDIDATE" || score >= 60) return "BUY";
  if (upper(engine.signal) === "SHORT_CANDIDATE" || score <= -60) return "SELL";
  return "WAIT";
}

function weightedDirectionScore(engine, mtf = {}, weights = DEFAULT_WEIGHTS) {
  const raw = Number(engine.score || 0);
  const direction = directionFromEngine(engine);
  if (direction === "WAIT") return 0;

  let score = Math.abs(raw) * weights.rawScore;
  score += Number(engine.fit || 0) * weights.strategyFit;

  const htf = upper(mtf.higherTimeframeBias);
  if (htf && htf !== "MIXED") score += direction === htf ? 100 * weights.htfAlignment : -100 * weights.htfAlignment;
  if (mtf.triggerPresent) score += 100 * weights.trigger;

  const structure = upper(mtf.alignment?.direction);
  if (structure && structure !== "MIXED") score += direction === structure ? 100 * weights.structure : -100 * weights.structure;

  const adaptive = Number(engine.adaptiveAdjustment || 0);
  score += clamp(adaptive * 2, -12, 12) * weights.adaptive;

  if (mtf.setupState === "CONFLICTED") score -= 100 * weights.contradiction;
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
    const direction = directionFromEngine(engine);
    const councilScore = weightedDirectionScore(engine, multiTimeframe, weights);
    return {
      botId: engine.botId,
      name: engine.name,
      direction,
      rawScore: Number(engine.score || 0),
      fit: Number(engine.fit || 0),
      councilScore,
      strategyMatch: Boolean(engine.strategyMatch),
      adaptiveAdjustment: Number(engine.adaptiveAdjustment || 0),
      historicalSampleSize: Number(engine.historicalSampleSize || 0),
      reason: engine.reason || "No strategy reason supplied."
    };
  });

  const eligible = rows.filter(r => r.strategyMatch && r.direction !== "WAIT");
  const bullishVotes = eligible.filter(r => r.direction === "BUY").length;
  const bearishVotes = eligible.filter(r => r.direction === "SELL").length;
  const waitVotes = rows.length - bullishVotes - bearishVotes;
  const buyScore = rows.filter(r => r.direction === "BUY").reduce((s, r) => s + r.councilScore, 0);
  const sellScore = rows.filter(r => r.direction === "SELL").reduce((s, r) => s + r.councilScore, 0);
  const totalDirectional = buyScore + sellScore;
  const weightedDirection = buyScore === sellScore ? "WAIT" : buyScore > sellScore ? "BUY" : "SELL";
  const winningVotes = Math.max(bullishVotes, bearishVotes);
  const agreementRatio = rows.length ? winningVotes / rows.length : 0;
  const directionalAgreement = eligible.length ? winningVotes / eligible.length : 0;

  const sorted = [...eligible].sort((a, b) => b.councilScore - a.councilScore || Math.abs(b.rawScore) - Math.abs(a.rawScore));
  const strongest = sorted[0] || null;
  const runnerUp = sorted[1] || null;
  const divergence = rows.filter(r => r.direction !== "WAIT" && r.direction !== weightedDirection).map(r => ({
    botId: r.botId,
    direction: r.direction,
    councilScore: r.councilScore
  }));

  const blockers = Array.isArray(riskBlocks) ? riskBlocks : [];
  let state = weightedDirection;
  let reason = "Strategy Council consensus is aligned.";
  if (!rows.length || !eligible.length) {
    state = "WAIT";
    reason = "No strategy has reached its independent signal threshold.";
  } else if (blockers.length) {
    state = "WAIT";
    reason = "Risk controls override strategy consensus.";
  } else if (upper(multiTimeframe.setupState) === "CONFLICTED") {
    state = "CONFLICTED";
    reason = "Higher and lower timeframe evidence conflicts.";
  } else if (agreementRatio < Number(minAgreement) || directionalAgreement < Number(minAgreement)) {
    state = "CONFLICTED";
    reason = "Strategy agreement is below the council minimum.";
  } else if (marketDecision !== "BUY" && marketDecision !== "SELL") {
    state = "WAIT";
    reason = "Market evidence gate does not authorize a directional candidate.";
  } else if (weightedDirection !== marketDecision) {
    state = "CONFLICTED";
    reason = "Strategy Council direction conflicts with the independent market evidence gate.";
  }

  const rawConfidence = totalDirectional > 0
    ? (Math.max(buyScore, sellScore) / totalDirectional) * 100
    : 0;
  const agreementFactor = clamp(agreementRatio / 0.8, 0, 1);
  const confidenceCap = blockers.length || upper(multiTimeframe.setupState) === "DATA_INSUFFICIENT"
    ? 0
    : upper(multiTimeframe.setupState) === "CONFLICTED" || state === "CONFLICTED"
      ? 55
      : 92;
  const confidence = Number(clamp(rawConfidence * (0.65 + agreementFactor * 0.35), 0, confidenceCap).toFixed(2));

  const whatToWait = [];
  if (state === "WAIT" || state === "CONFLICTED") {
    if (blockers.length) whatToWait.push(...blockers.map(x => "Resolve " + x + "."));
    if (upper(multiTimeframe.setupState) === "DATA_INSUFFICIENT") whatToWait.push("Restore all required 5m/15m/1h/4h market data.");
    if (upper(multiTimeframe.setupState) === "CONFLICTED") whatToWait.push("Wait for higher/lower timeframe alignment.");
    if (agreementRatio < Number(minAgreement)) whatToWait.push("Wait for stronger strategy agreement.");
    if (marketDecision !== "BUY" && marketDecision !== "SELL") whatToWait.push("Wait for the independent evidence gate to confirm direction.");
  }

  return {
    state,
    reason,
    engines: rows,
    bullishVotes,
    bearishVotes,
    waitVotes,
    agreementRatio: Number(agreementRatio.toFixed(3)),
    directionalAgreement: Number(directionalAgreement.toFixed(3)),
    weightedScores: { buy: Number(buyScore.toFixed(2)), sell: Number(sellScore.toFixed(2)) },
    weightedDirection,
    strongestEngine: strongest,
    runnerUp,
    divergence,
    confidence,
    confidenceMethod: "weighted strategy evidence + agreement calibration + hard confidence caps",
    whatToWait: [...new Set(whatToWait)].slice(0, 8),
    invalidation: state === "BUY" ? "Invalidate if council loses BUY consensus or market evidence flips." :
      state === "SELL" ? "Invalidate if council loses SELL consensus or market evidence flips." :
      "No directional trade candidate until the council becomes aligned.",
    executionAuthorized: false,
    executionAuthority: "NONE"
  };
}
