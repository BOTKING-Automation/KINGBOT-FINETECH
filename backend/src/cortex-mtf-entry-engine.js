const REQUIRED_TIMEFRAMES = ["1d", "4h", "1h", "15m", "5m"];
const DIRECTIONAL = new Set(["BULLISH", "BEARISH"]);

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function sameDirection(value, direction) {
  return String(value || "").trim().toUpperCase() === direction;
}
function opposite(direction) {
  return direction === "BULLISH" ? "BEARISH" : "BULLISH";
}
function frameDirection(frame) {
  const direction = String(frame?.technical?.trend || frame?.direction || "").toUpperCase();
  return DIRECTIONAL.has(direction) ? direction : "NEUTRAL";
}
const TIMEFRAME_SECONDS = { "1d":86400, "4h":14400, "1h":3600, "15m":900, "5m":300 };

function frameFresh(frame, expectedTimeframe) {
  if (!frame || frame.ok !== true || frame.fresh !== true) return false;
  if (String(frame.timeframe || "").toLowerCase() !== expectedTimeframe) return false;
  const age = number(frame.ageSinceCloseMs), limit = number(frame.freshnessLimitMs);
  const openedAt = Date.parse(String(frame.lastClosedBarTime || ""));
  const closedAt = Date.parse(String(frame.lastBarCloseTime || ""));
  const intervalMs = (TIMEFRAME_SECONDS[expectedTimeframe] || 0) * 1000;
  if (!intervalMs || !Number.isFinite(openedAt) || !Number.isFinite(closedAt)) return false;
  if (Math.abs((closedAt - openedAt) - intervalMs) > 1000) return false;
  return age !== null && limit !== null && limit > 0 && age >= 0 && age <= limit && Number(frame.barCount || 0) >= 80;
}
function closedCandleDirection(frame, direction) {
  const bar = frame?.lastClosedBar;
  const open = number(bar?.open), close = number(bar?.close);
  const high = number(bar?.high), low = number(bar?.low);
  if ([open, close, high, low].some(value => value === null) || high < low ||
      high < Math.max(open, close) || low > Math.min(open, close)) return false;
  const range = Math.max(high - low, 1e-12);
  const bodyRatio = Math.abs(close - open) / range;
  if (direction === "BULLISH") return close > open && bodyRatio >= 0.45 && close >= low + range * 0.68;
  return close < open && bodyRatio >= 0.45 && close <= high - range * 0.68;
}
function getMarketStructure(technical) {
  const structure = technical?.marketStructure || {};
  return {
    swingHigh: number(structure.lastSwingHigh ?? technical?.resistance),
    swingLow: number(structure.lastSwingLow ?? technical?.support)
  };
}
function baseResult(signal, bias, reason, frames, gates = {}, blockedReasons = []) {
  const passed = Object.values(gates).filter(Boolean).length;
  const total = Object.keys(gates).length;
  return {
    signal,bias,side:null,entryEligible:false,entry:null,sl:null,tp1:null,tp2:null,
    riskReward:null,spreadAtrRatio:null,
    confluenceScore:total?Math.round(passed/total*100):0,
    confluenceScoreMeaning:"Share of technical gates passed; not a probability or expected win rate.",
    executionTimeframe:"5m",timeframeStack:REQUIRED_TIMEFRAMES,
    reason,waitFor:reason,gates,blockedReasons,frameSummary:frames
  };
}

/**
 * Strict top-down entry qualification.
 * A qualified setup requires aligned trend and structure, a completed 5m
 * trigger, a fresh two-sided quote, acceptable spread, bounded structural
 * risk and at least 1.8R to a measured/structural target. Analysis only.
 */
export function evaluateCortexMultiTimeframeEntry({ frames = {}, quote = null } = {}) {
  const frameRows = Object.fromEntries(REQUIRED_TIMEFRAMES.map(timeframe => [timeframe, frames[timeframe] || null]));
  const missing = REQUIRED_TIMEFRAMES.filter(timeframe => !frameRows[timeframe]);
  const stale = REQUIRED_TIMEFRAMES.filter(timeframe => frameRows[timeframe] && !frameFresh(frameRows[timeframe], timeframe));
  const summary = REQUIRED_TIMEFRAMES.map(timeframe => {
    const frame = frameRows[timeframe], technical = frame?.technical || {};
    return {
      timeframe,direction:frameDirection(frame),
      structure:String(technical.structure||"unknown").toUpperCase(),
      adx:number(technical.adx),rsi:number(technical.rsi14??technical.rsi),
      momentum:number(technical.momentum),
      lastClosedBarTime:frame?.lastClosedBarTime||null,
      ageSinceCloseMs:number(frame?.ageSinceCloseMs),
      fresh:frameFresh(frame, timeframe),barCount:Number(frame?.barCount||0),error:frame?.reason||null
    };
  });
  const allFramesFresh = missing.length === 0 && stale.length === 0;
  if (!allFramesFresh) {
    const blocked=[
      ...missing.map(timeframe=>timeframe+" timeframe data missing"),
      ...stale.map(timeframe=>timeframe+" timeframe data stale or insufficient")
    ];
    return {
      ...baseResult("WAIT","NEUTRAL","CORTEX requires fresh, verified completed candles across the full timeframe stack.",summary,{
        completeTimeframeStack:false,completedCandleFreshness:false
      },blocked),
      dataStatus:"INCOMPLETE",missingTimeframes:missing,staleTimeframes:stale
    };
  }
  const directionalFrames=["1d","4h","1h","15m"];
  const directions=directionalFrames.map(timeframe=>frameDirection(frameRows[timeframe]));
  const uniqueDirections=[...new Set(directions)];
  if(uniqueDirections.length!==1||!DIRECTIONAL.has(uniqueDirections[0])){
    return {
      ...baseResult("NO_TRADE","NEUTRAL","Higher-timeframe trend is mixed or neutral; do not force a directional entry.",summary,{
        completeTimeframeStack:true,completedCandleFreshness:true,higherTimeframeAgreement:false
      },directionalFrames.map((timeframe,index)=>timeframe+": "+directions[index])),
      dataStatus:"VERIFIED",
      conflictingTimeframes:directionalFrames.filter((timeframe,index)=>directions[index]!==directions[0])
    };
  }

  const direction=uniqueDirections[0];
  const trend=frameRows["4h"].technical||{};
  const structure=frameRows["1h"].technical||{};
  const setup=frameRows["15m"].technical||{};
  const execution=frameRows["5m"];
  const trigger=execution.technical||{};
  const atr=number(trigger.atr14??trigger.atr);
  const adx4h=number(trend.adx14??trend.adx),adx1h=number(structure.adx14??structure.adx);
  const adx15m=number(setup.adx14??setup.adx),adx5m=number(trigger.adx14??trigger.adx);
  const rsi5m=number(trigger.rsi14??trigger.rsi);
  const momentum15m=number(setup.momentum),momentum5m=number(trigger.momentum);
  const structure1h=String(structure.structure||"").toUpperCase();
  const structure15m=String(setup.structure||"").toUpperCase();

  const trendStrength=adx4h!==null&&adx4h>=16&&adx1h!==null&&adx1h>=16;
  const setupStrength=adx15m!==null&&adx15m>=18&&
    (direction==="BULLISH"?momentum15m!==null&&momentum15m>0:momentum15m!==null&&momentum15m<0);
  const structureAlignment=sameDirection(structure1h,direction)&&sameDirection(structure15m,direction);
  const momentumAlignment=momentum5m!==null&&(direction==="BULLISH"?momentum5m>0:momentum5m<0);
  const executionStrength=adx5m!==null&&adx5m>=14;
  const rsiInTradeableBand=rsi5m!==null&&
    (direction==="BULLISH"?rsi5m>=48&&rsi5m<=74:rsi5m>=26&&rsi5m<=52);
  const candleConfirmed=closedCandleDirection(execution,direction);

  const breakoutDirection=String(trigger.breakoutDirection||"NONE").toUpperCase();
  const bosDirection=String(trigger.bosDirection||trigger.bos||"NONE").toUpperCase();
  const retestDirection=String(trigger.retestDirection||"NONE").toUpperCase();
  const sweepDirection=String(trigger.liquiditySweepDirection||trigger.liquiditySweep||"NONE").toUpperCase();
  const displacementDirection=String(trigger.displacementDirection||"NONE").toUpperCase();
  const fvgDirection=String(trigger.fairValueGapDirection||"NONE").toUpperCase();
  const orderBlockDirection=String(trigger.orderBlock?.direction||"NONE").toUpperCase();

  const breakAndDisplace=(sameDirection(breakoutDirection,direction)||sameDirection(bosDirection,direction))&&
    sameDirection(displacementDirection,direction)&&candleConfirmed;
  const retestAndHold=sameDirection(retestDirection,direction)&&candleConfirmed&&
    (sameDirection(orderBlockDirection,direction)||sameDirection(fvgDirection,direction)||sameDirection(displacementDirection,direction));
  const sweepReversal=sameDirection(sweepDirection,direction)&&
    sameDirection(displacementDirection,direction)&&sameDirection(fvgDirection,direction)&&candleConfirmed;
  const executionTrigger=Boolean(atr&&atr>0&&(breakAndDisplace||retestAndHold||sweepReversal));

  const quotePrice=number(quote?.price),bid=number(quote?.bid),ask=number(quote?.ask);
  const quoteAge=number(quote?.ageMs??quote?.quoteAgeMs);
  const quoteFresh=quote?.available===true&&quotePrice!==null&&quotePrice>0&&
    bid!==null&&ask!==null&&bid>0&&ask>=bid&&quoteAge!==null&&quoteAge>=0&&quoteAge<=2500;
  const spread=bid!==null&&ask!==null?ask-bid:null;
  const entry=direction==="BULLISH"?ask:bid;
  const spreadAtrRatio=spread!==null&&atr!==null&&atr>0?spread/atr:null;
  const spreadAcceptable=spread!==null&&spread>0&&spreadAtrRatio!==null&&spreadAtrRatio<=0.12;
  const noChase=quotePrice!==null&&number(trigger.close)!==null&&atr!==null&&
    Math.abs(quotePrice-number(trigger.close))<=atr*0.35;

  const executionStructure=getMarketStructure(trigger);
  const stop=direction==="BULLISH"
    ?executionStructure.swingLow!==null&&atr!==null?executionStructure.swingLow-atr*0.15:null
    :executionStructure.swingHigh!==null&&atr!==null?executionStructure.swingHigh+atr*0.15:null;
  const riskDistance=entry!==null&&stop!==null?Math.abs(entry-stop):null;
  const riskAtr=riskDistance!==null&&atr!==null&&atr>0?riskDistance/atr:null;
  const stopOnCorrectSide=entry!==null&&stop!==null&&(direction==="BULLISH"?stop<entry:stop>entry);
  const riskBounded=stopOnCorrectSide&&riskAtr!==null&&riskAtr>=0.45&&riskAtr<=2.25;

  const opposingLevels=["15m","1h","4h","1d"].map(timeframe=>{
    const levels=getMarketStructure(frameRows[timeframe]?.technical||{});
    return direction==="BULLISH"?levels.swingHigh:levels.swingLow;
  }).filter(value=>value!==null);
  const validTargets=opposingLevels.filter(value=>direction==="BULLISH"?value>entry:value<entry);
  const nearestStructureTarget=validTargets.length
    ?(direction==="BULLISH"?Math.min(...validTargets):Math.max(...validTargets)):null;
  const targetTwoR=entry!==null&&riskDistance!==null?entry+(direction==="BULLISH"?2:-2)*riskDistance:null;
  const targetTwoPointFiveR=entry!==null&&riskDistance!==null?entry+(direction==="BULLISH"?2.5:-2.5)*riskDistance:null;
  let tp2=null,targetBasis=null;
  if(nearestStructureTarget!==null&&targetTwoPointFiveR!==null){
    tp2=direction==="BULLISH"?Math.min(nearestStructureTarget,targetTwoPointFiveR):Math.max(nearestStructureTarget,targetTwoPointFiveR);
    targetBasis="Nearest opposing structure, capped at 2.5R";
  }else if(targetTwoR!==null){
    tp2=targetTwoR;targetBasis="2R measured risk projection; no nearer validated opposing swing found";
  }
  const rewardDistance=entry!==null&&tp2!==null?Math.abs(tp2-entry):null;
  const rewardToRisk=rewardDistance!==null&&riskDistance!==null&&riskDistance>0?rewardDistance/riskDistance:null;
  const rewardToRiskAcceptable=rewardToRisk!==null&&rewardToRisk>=1.8;
  const tp1=entry!==null&&riskDistance!==null?entry+(direction==="BULLISH"?1:-1)*riskDistance:null;

  const gates={
    completeTimeframeStack:true,completedCandleFreshness:true,higherTimeframeAgreement:true,
    higherTimeframeTrendStrength:trendStrength,marketStructureAlignment:structureAlignment,
    setupMomentum:setupStrength,executionStrength,executionMomentum:momentumAlignment,
    rsiDiscipline:rsiInTradeableBand,confirmedExecutionTrigger:executionTrigger,
    freshTwoSidedQuote:quoteFresh,spreadCost:spreadAcceptable,noChasing:noChase,
    structuralStop:riskBounded,rewardToRisk:rewardToRiskAcceptable
  };
  const blockedReasons=Object.entries(gates).filter(([,passed])=>!passed).map(([key])=>{
    const messages={
      higherTimeframeTrendStrength:"4h/1h ADX strength is below the required threshold.",
      marketStructureAlignment:"1h and 15m swing structure do not both align with the directional bias.",
      setupMomentum:"15m setup momentum or ADX is not sufficiently aligned.",
      executionStrength:"5m ADX is below the execution-strength threshold.",
      executionMomentum:"5m momentum does not confirm the directional setup.",
      rsiDiscipline:"5m RSI is outside the allowed entry band.",
      confirmedExecutionTrigger:"No completed 5m breakout/displacement, retest or sweep-reversal trigger.",
      freshTwoSidedQuote:"A fresh bid/ask quote is unavailable or too old.",
      spreadCost:"Spread is unknown, invalid or too expensive relative to 5m ATR.",
      noChasing:"Live price has moved too far from the completed 5m candle.",
      structuralStop:"A valid structural stop is missing or outside the allowed ATR risk range.",
      rewardToRisk:"The available target does not provide at least 1.8R."
    };
    return messages[key]||key;
  });
  const ready=Object.values(gates).every(Boolean);
  const confluenceScore=Math.round(Object.values(gates).filter(Boolean).length/Object.keys(gates).length*100);
  if(!ready){
    const triggerPending=gates.higherTimeframeAgreement&&gates.completeTimeframeStack&&
      gates.completedCandleFreshness&&!gates.confirmedExecutionTrigger&&
      gates.higherTimeframeTrendStrength&&gates.marketStructureAlignment;
    return {
      signal:triggerPending?"WAIT":"NO_TRADE",bias:direction,side:null,entryEligible:false,
      entry:null,sl:null,tp1:null,tp2:null,riskReward:rewardToRisk,spreadAtrRatio,
      confluenceScore,confluenceScoreMeaning:"Share of technical gates passed; not a probability or expected win rate.",
      executionTimeframe:"5m",timeframeStack:REQUIRED_TIMEFRAMES,
      reason:triggerPending
        ?"Top-down trend and structure are aligned. Wait for a completed 5m trigger and all execution gates."
        :"CORTEX rejected this setup because one or more professional entry gates failed.",
      waitFor:blockedReasons.join(" "),gates,blockedReasons,frameSummary:summary,targetBasis
    };
  }
  return {
    signal:"ENTRY_CONFIRMING",bias:direction,side:direction==="BULLISH"?"BUY":"SELL",
    entryEligible:true,entry,sl:stop,tp1,tp2,riskReward:rewardToRisk,spreadAtrRatio,
    confluenceScore,confluenceScoreMeaning:"All mandatory technical and execution gates passed; this is not a win probability.",
    executionTimeframe:"5m",timeframeStack:REQUIRED_TIMEFRAMES,
    reason:direction+" setup qualified by 1d/4h/1h/15m alignment and a completed 5m trigger.",
    waitFor:"No order is placed. A separate risk and execution authorisation gate is still required.",
    gates,blockedReasons:[],frameSummary:summary,targetBasis
  };
}

export const CORTEX_MTF_TIMEFRAMES = REQUIRED_TIMEFRAMES;


/**
 * Convert the strict five-frame analysis into the existing specialist-engine
 * timeframe contract. Missing/stale frames remain unavailable, never inferred.
 */
export function toCouncilMultiTimeframe(frames = {}, entryDecision = {}) {
  const timeframes = REQUIRED_TIMEFRAMES.map(timeframe => {
    const frame = frames[timeframe] || {};
    const technical = frame.technical || {};
    const available = frame.ok === true && frame.fresh === true &&
      Number(frame.barCount || 0) >= 80 && number(technical.atr14 ?? technical.atr) > 0;
    return {
      timeframe,
      ok: available,
      available,
      trend: technical.trend || "NEUTRAL",
      structure: technical.structure || "unknown",
      atr: number(technical.atr14 ?? technical.atr),
      rsi: number(technical.rsi14 ?? technical.rsi),
      adx: number(technical.adx14 ?? technical.adx),
      momentum: number(technical.momentum),
      emaFast: number(technical.ema20 ?? technical.emaFast),
      emaSlow: number(technical.ema50 ?? technical.emaSlow),
      bos: technical.bos || "NONE",
      choch: technical.choch || "NONE",
      liquiditySweep: technical.liquiditySweepDirection || "NONE",
      displacement: technical.displacementDirection || "NONE",
      breakout: Boolean(technical.breakout),
      breakoutDirection: technical.breakoutDirection || "NONE",
      retest: Boolean(technical.retest),
      retestDirection: technical.retestDirection || "NONE",
      orderBlock: technical.orderBlock || null,
      fairValueGap: Boolean(technical.fairValueGap),
      fairValueGapDirection: technical.fairValueGapDirection || "NONE",
      lastClosedBarTime: frame.lastClosedBarTime || null,
      ageSinceCloseMs: number(frame.ageSinceCloseMs),
      barCount: Number(frame.barCount || 0),
      source: technical.source || "KINGBOT verified OHLC"
    };
  });
  const byTimeframe = Object.fromEntries(timeframes.map(frame => [frame.timeframe, frame]));
  const side = String(entryDecision.side || "").toUpperCase();
  const complete = timeframes.every(frame => frame.ok);
  const directions = ["1d", "4h", "1h", "15m"].map(timeframe =>
    String(byTimeframe[timeframe]?.trend || "NEUTRAL").toUpperCase()
  );
  const unique = [...new Set(directions)];
  const higherTimeframeBias = unique.length === 1 && ["BULLISH", "BEARISH"].includes(unique[0]) ? unique[0] : "MIXED";
  const lowerDirections = ["15m", "5m"].map(timeframe =>
    String(byTimeframe[timeframe]?.trend || "NEUTRAL").toUpperCase()
  ).filter(direction => DIRECTIONAL.has(direction));
  const lowerTimeframesConflict = higherTimeframeBias !== "MIXED" &&
    lowerDirections.some(direction => direction !== higherTimeframeBias);
  const lowerTimeframeBias = lowerDirections.length &&
    lowerDirections.every(direction => direction === lowerDirections[0])
      ? lowerDirections[0] : "MIXED";
  const lowerTimeframesAgree = lowerTimeframeBias === higherTimeframeBias;
  const setupState = !complete ? "DATA_INSUFFICIENT"
    : higherTimeframeBias === "MIXED" || lowerTimeframesConflict ? "CONFLICTED"
    : entryDecision.entryEligible === true
      ? (side === "BUY" ? "BUY_CANDIDATE" : side === "SELL" ? "SELL_CANDIDATE" : "WAIT_CONFIRMATION")
      : entryDecision.signal === "NO_TRADE" ? "CONFLICTED" : "WAIT_CONFIRMATION";
  return {
    timeframes,
    requiredTimeframes: REQUIRED_TIMEFRAMES,
    higherTimeframeBias,
    lowerTimeframeBias,
    triggerPresent: Boolean(entryDecision.gates?.confirmedExecutionTrigger),
    setupState,
    policy: "CORTEX_STRICT_TOP_DOWN_MTF",
    alignment: {
      complete,
      direction: higherTimeframeBias,
      htfBias: higherTimeframeBias,
      ltfBias: lowerTimeframesAgree ? higherTimeframeBias : "MIXED",
      conflict: higherTimeframeBias === "MIXED" || lowerTimeframesConflict,
      lowerTimeframesConflict,
      total: timeframes.filter(frame => frame.ok).length,
      required: timeframes.length
    }
  };
}

/**
 * A technical candidate is only eligible when the independent Strategy
 * Council selects the same side, a specialist is routed, and hard-risk
 * blockers are empty. It does not authorise or place orders.
 */
export function applyCortexCouncilApproval(entryDecision = {}, council = null) {
  if (entryDecision.entryEligible !== true) return entryDecision;
  const expected = entryDecision.side === "BUY" ? "BUY" : entryDecision.side === "SELL" ? "SELL" : null;
  const councilState = String(council?.strategyCouncil?.state || "").toUpperCase();
  const routedSide = String(council?.routing?.direction || "").toUpperCase();
  const selectedEngine = String(council?.routing?.selectedEngine || "").trim();
  const tradePlanReady = council?.tradePlan?.ok === true;
  const riskBlocks = Array.isArray(council?.riskCouncil?.blocks) ? council.riskCouncil.blocks : [];
  const approved = Boolean(expected && councilState === expected && routedSide === expected &&
    selectedEngine && tradePlanReady && riskBlocks.length === 0);
  if (approved) {
    return {
      ...entryDecision,
      councilApproval: {
        approved: true,
        state: councilState,
        selectedEngine,
        riskBlocks: []
      }
    };
  }
  const blockers = [];
  if (!council) blockers.push("CORTEX Strategy Council did not return a decision.");
  if (councilState !== expected) blockers.push("Strategy Council state does not match the technical setup.");
  if (routedSide !== expected) blockers.push("Strategy routing direction does not match the technical setup.");
  if (!selectedEngine) blockers.push("No specialist engine was selected.");
  if (!tradePlanReady) blockers.push("CORTEX trade-plan validation is unavailable.");
  if (riskBlocks.length) blockers.push(...riskBlocks.map(value => "Risk Council: " + String(value)));
  return {
    ...entryDecision,
    signal: "WAIT",
    side: null,
    entryEligible: false,
    entry: null,
    sl: null,
    tp1: null,
    tp2: null,
    reason: "Technical confluence passed, but the independent CORTEX Strategy Council did not approve the same direction.",
    waitFor: blockers.join(" "),
    blockedReasons: [...(entryDecision.blockedReasons || []), ...blockers],
    councilApproval: {
      approved: false,
      state: councilState || "UNAVAILABLE",
      selectedEngine: selectedEngine || null,
      riskBlocks
    }
  };
}
