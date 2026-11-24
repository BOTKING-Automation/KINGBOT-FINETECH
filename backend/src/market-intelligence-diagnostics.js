const TF_WEIGHT = Object.freeze({
  "1m": 0.5, "3m": 0.75, "5m": 1, "15m": 2, "30m": 2.5,
  "1h": 3, "2h": 3.5, "4h": 4, "1d": 5, "1w": 6
});

const upper = value => String(value ?? "").trim().toUpperCase();

function directionOf(value) {
  const direction = upper(value);
  if (["BUY", "BULLISH", "LONG", "UP"].includes(direction)) return "BULLISH";
  if (["SELL", "BEARISH", "SHORT", "DOWN"].includes(direction)) return "BEARISH";
  return null;
}

function timeframeWeight(value) {
  return TF_WEIGHT[String(value || "").trim().toLowerCase()] || 0;
}

function featureRows(market = {}) {
  return [
    ["BOS", market.rawBos ?? market.bos],
    ["CHOCH", market.rawChoch ?? market.choch],
    ["LIQUIDITY_SWEEP", market.rawLiquiditySweep ?? market.liquiditySweepDirection ?? market.liquiditySweep],
    ["DISPLACEMENT", market.rawDisplacement ?? market.displacementDirection ?? market.displacement],
    ["ORDER_BLOCK", market.orderBlock?.direction ?? market.orderBlockDirection],
    ["FAIR_VALUE_GAP", market.fairValueGapDirection ?? market.rawFvgDirection],
    ["BREAKOUT", market.breakoutDirection],
    ["RETEST", market.retestDirection]
  ].map(([name, value]) => ({ name, direction: directionOf(value) })).filter(row => row.direction);
}

function timeframeTriggerRows(frame = {}) {
  return [
    ["BOS", frame.bosDirection ?? frame.bos],
    ["CHOCH", frame.chochDirection ?? frame.choch],
    ["LIQUIDITY_SWEEP", frame.liquiditySweepDirection ?? frame.liquiditySweep],
    ["DISPLACEMENT", frame.displacementDirection ?? frame.displacement],
    ["ORDER_BLOCK", frame.orderBlock?.direction],
    ["FAIR_VALUE_GAP", frame.fairValueGapDirection ?? frame.fvgDirection],
    ["RETEST", frame.retestDirection]
  ].map(([name, value]) => ({ name, direction: directionOf(value) })).filter(row => row.direction);
}

export function buildMarketIntelligenceDiagnostics({
  market = {},
  multiTimeframe = market.multiTimeframe || {},
  specialists = [],
  evidence = {}
} = {}) {
  const frames = Array.isArray(multiTimeframe.timeframes) ? multiTimeframe.timeframes : [];
  const requiredFrames = Array.isArray(multiTimeframe.requiredTimeframes)
    ? multiTimeframe.requiredTimeframes
    : ["5m", "15m", "1h", "4h"];
  const usable = frames.filter(frame => frame?.ok !== false && directionOf(frame?.trend));
  let bullishWeight = 0;
  let bearishWeight = 0;
  let totalWeight = 0;
  for (const frame of usable) {
    const weight = timeframeWeight(frame.timeframe) || 1;
    const direction = directionOf(frame.trend);
    totalWeight += weight;
    if (direction === "BULLISH") bullishWeight += weight;
    if (direction === "BEARISH") bearishWeight += weight;
  }
  const weightedDirection = bullishWeight > bearishWeight
    ? "BULLISH"
    : bearishWeight > bullishWeight
      ? "BEARISH"
      : "MIXED";
  const weightedAlignmentPct = totalWeight
    ? Math.round(Math.max(bullishWeight, bearishWeight) / totalWeight * 100)
    : null;

  const lowerFrames = usable.filter(frame => timeframeWeight(frame.timeframe) > 0 && timeframeWeight(frame.timeframe) < timeframeWeight("1h"));
  const triggerRows = lowerFrames.flatMap(frame => {
    const frameDirection = directionOf(frame.trend);
    return timeframeTriggerRows(frame).map(trigger => ({
      timeframe: frame.timeframe,
      name: trigger.name,
      direction: trigger.direction,
      aligned: trigger.direction === frameDirection
    }));
  });
  const alignedTriggers = triggerRows.filter(row => row.aligned).length;
  const opposedTriggers = triggerRows.length - alignedTriggers;
  const marketPatterns = featureRows(market);
  const alignedPatterns = marketPatterns.filter(row => row.direction === weightedDirection).length;
  const opposedPatterns = marketPatterns.filter(row => row.direction !== weightedDirection).length;

  const specialistReadiness = specialists.map(card => {
    const conditions = Array.isArray(card.conditions) ? card.conditions.length : 0;
    const missing = Array.isArray(card.missingConditions) ? card.missingConditions.length : 0;
    const contradictions = Array.isArray(card.contradictions) ? card.contradictions.length : 0;
    const total = conditions + missing;
    return {
      botId: card.botId,
      qualified: Boolean(card.strategyMatch),
      completionPct: total ? Math.round(conditions / total * 100) : 0,
      confirmedConditions: conditions,
      missingConditions: missing,
      contradictions
    };
  });

  const warnings = [];
  if (usable.length < requiredFrames.length) warnings.push("MTF_COVERAGE_INCOMPLETE");
  if (weightedDirection === "MIXED" && usable.length) warnings.push("MTF_WEIGHTED_DIRECTION_MIXED");
  if (opposedTriggers > 0) warnings.push("LOWER_TIMEFRAME_TRIGGER_DIVERGENCE");
  if (opposedPatterns > 0 && marketPatterns.length) warnings.push("PATTERN_EVIDENCE_CONFLICT");
  if (specialistReadiness.some(row => row.contradictions > 0)) warnings.push("SPECIALIST_CONTRADICTIONS_PRESENT");

  return {
    version: "1.0.0",
    diagnosticOnly: true,
    executionAuthority: "NONE",
    weightedMultiTimeframe: {
      direction: weightedDirection,
      bullishWeight: Number(bullishWeight.toFixed(2)),
      bearishWeight: Number(bearishWeight.toFixed(2)),
      totalWeight: Number(totalWeight.toFixed(2)),
      alignmentPct: weightedAlignmentPct,
      coveragePct: requiredFrames.length ? Math.round(usable.length / requiredFrames.length * 100) : null,
      usableTimeframes: usable.map(frame => frame.timeframe),
      missingTimeframes: requiredFrames.filter(timeframe => !usable.some(frame => frame.timeframe === timeframe))
    },
    lowerTimeframeTriggers: {
      frames: lowerFrames.map(frame => frame.timeframe),
      observedDirectionalTriggers: triggerRows.length,
      alignedTriggers,
      opposedTriggers,
      alignmentPct: triggerRows.length ? Math.round(alignedTriggers / triggerRows.length * 100) : null,
      details: triggerRows
    },
    patternConfluence: {
      observedDirectionalPatterns: marketPatterns.length,
      alignedWithWeightedBias: alignedPatterns,
      opposedToWeightedBias: opposedPatterns,
      details: marketPatterns
    },
    specialistReadiness,
    evidence: {
      verified: Boolean(evidence?.provenance?.verified),
      evidenceQuality: Number.isFinite(Number(evidence?.evidenceQuality)) ? Number(evidence.evidenceQuality) : null,
      dataFlags: Array.isArray(evidence?.dataFlags) ? [...evidence.dataFlags] : []
    },
    warnings
  };
}
