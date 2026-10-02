function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function precisionFor(price) {
  const p = Math.abs(Number(price));
  if (!Number.isFinite(p)) return 5;
  if (p >= 1000) return 2;
  if (p >= 100) return 3;
  return 5;
}

function roundPrice(value, priceRef) {
  const p = precisionFor(priceRef);
  const factor = 10 ** p;
  return Math.round(Number(value) * factor) / factor;
}

function directionalConfidence({
  side,
  trend,
  bos,
  choch,
  liquidity,
  fvg,
  nearLevel
}) {
  const wanted = side === "BUY" ? "BULLISH" : "BEARISH";
  let score = 35;
  if (trend === wanted) score += 15;
  if (bos === wanted) score += 12;
  if (choch === wanted) score += 10;
  if (liquidity === wanted) score += 15;
  if (fvg) score += 8;
  if (nearLevel) score += 5;
  return clamp(score);
}

function buildLimitZone({
  side,
  price,
  anchor,
  atr,
  confidence,
  timeframe,
  invalidation,
  confluence
}) {
  const halfWidth = Math.max(atr * 0.12, Math.abs(anchor) * 0.00008);
  const lower = side === "BUY" ? anchor - halfWidth : anchor + halfWidth;
  const upper = side === "BUY" ? anchor + halfWidth : anchor - halfWidth;
  return {
    side,
    orderType: side === "BUY" ? "BUY_LIMIT" : "SELL_LIMIT",
    zone: [
      roundPrice(Math.min(lower, upper), price),
      roundPrice(Math.max(lower, upper), price)
    ],
    midpoint: roundPrice(anchor, price),
    confidence,
    confidenceType: "structural_confluence",
    timeframe,
    confluence,
    invalidation,
    source: "KINGBOT structural inference",
    actualBrokerOrdersVisible: false
  };
}

function buildStopTrigger({
  side,
  price,
  trigger,
  atr,
  confidence,
  timeframe,
  invalidation,
  confluence
}) {
  const buffer = Math.max(atr * 0.08, Math.abs(price) * 0.00004);
  const level = side === "BUY" ? trigger + buffer : trigger - buffer;
  return {
    side,
    orderType: side === "BUY" ? "BUY_STOP" : "SELL_STOP",
    trigger: roundPrice(level, price),
    confidence,
    confidenceType: "breakout_confluence",
    timeframe,
    confluence,
    invalidation,
    source: "KINGBOT structural inference",
    actualBrokerOrdersVisible: false
  };
}

export function predictPendingOrderZones(snapshot = {}) {
  const price = finite(snapshot.price ?? snapshot.close);
  const atr = finite(snapshot.atr14 ?? snapshot.atr);
  const support = finite(snapshot.support);
  const resistance = finite(snapshot.resistance);
  const trend = String(snapshot.trend || "").toUpperCase();
  const bos = String(snapshot.bos || "").toUpperCase();
  const choch = String(snapshot.choch || "").toUpperCase();
  const liquidity = String(snapshot.liquiditySweep || snapshot.liquidity_sweep || "").toUpperCase();
  const fvg = Boolean(snapshot.fvg);
  const timeframe = String(snapshot.timeframe || "5m");

  if (price === null || atr === null || atr <= 0) {
    return {
      mode: "PREDICTED_ZONES",
      status: "DATA_INSUFFICIENT",
      source: "KINGBOT structural inference",
      actualMarketOrdersVisible: false,
      message: "Price and ATR are required before pending-order zones can be inferred.",
      buyLimitZones: [],
      sellLimitZones: [],
      buyStopTriggers: [],
      sellStopTriggers: []
    };
  }

  const safeSupport = support !== null && support < price ? support : price - atr * 0.75;
  const safeResistance = resistance !== null && resistance > price ? resistance : price + atr * 0.75;
  const nearSupport = support !== null && Math.abs(price - support) <= atr * 0.75;
  const nearResistance = resistance !== null && Math.abs(resistance - price) <= atr * 0.75;

  const buyConfidence = directionalConfidence({
    side: "BUY",
    trend,
    bos,
    choch,
    liquidity,
    fvg,
    nearLevel: nearSupport
  });
  const sellConfidence = directionalConfidence({
    side: "SELL",
    trend,
    bos,
    choch,
    liquidity,
    fvg,
    nearLevel: nearResistance
  });

  const buyConfluence = [
    support !== null ? "support" : "ATR fallback level",
    liquidity === "BULLISH" ? "bullish liquidity sweep" : null,
    bos === "BULLISH" ? "bullish BOS" : null,
    choch === "BULLISH" ? "bullish CHOCH" : null,
    fvg ? "FVG present" : null,
    trend === "BULLISH" ? "bullish trend" : null
  ].filter(Boolean);

  const sellConfluence = [
    resistance !== null ? "resistance" : "ATR fallback level",
    liquidity === "BEARISH" ? "bearish liquidity sweep" : null,
    bos === "BEARISH" ? "bearish BOS" : null,
    choch === "BEARISH" ? "bearish CHOCH" : null,
    fvg ? "FVG present" : null,
    trend === "BEARISH" ? "bearish trend" : null
  ].filter(Boolean);

  const buyLimitInvalidation = roundPrice(
    safeSupport - Math.max(atr * 0.35, Math.abs(price) * 0.00012),
    price
  );
  const sellLimitInvalidation = roundPrice(
    safeResistance + Math.max(atr * 0.35, Math.abs(price) * 0.00012),
    price
  );

  const buyStopInvalidation = roundPrice(
    safeResistance - Math.max(atr * 0.45, Math.abs(price) * 0.00015),
    price
  );
  const sellStopInvalidation = roundPrice(
    safeSupport + Math.max(atr * 0.45, Math.abs(price) * 0.00015),
    price
  );

  const buyLimit = buildLimitZone({
    side: "BUY",
    price,
    anchor: safeSupport,
    atr,
    confidence: buyConfidence,
    timeframe,
    invalidation: `Invalidate below ${buyLimitInvalidation} on a confirmed close.`,
    confluence: buyConfluence
  });

  const sellLimit = buildLimitZone({
    side: "SELL",
    price,
    anchor: safeResistance,
    atr,
    confidence: sellConfidence,
    timeframe,
    invalidation: `Invalidate above ${sellLimitInvalidation} on a confirmed close.`,
    confluence: sellConfluence
  });

  const buyStop = buildStopTrigger({
    side: "BUY",
    price,
    trigger: safeResistance,
    atr,
    confidence: clamp(40 + (bos === "BULLISH" ? 20 : 0) + (trend === "BULLISH" ? 15 : 0) + (choch === "BULLISH" ? 10 : 0) + (fvg ? 5 : 0)),
    timeframe,
    invalidation: `Invalidate if the breakout fails back below ${buyStopInvalidation}.`,
    confluence: [resistance !== null ? "resistance break" : "ATR breakout level", bos === "BULLISH" ? "bullish BOS" : null, trend === "BULLISH" ? "bullish trend" : null].filter(Boolean)
  });

  const sellStop = buildStopTrigger({
    side: "SELL",
    price,
    trigger: safeSupport,
    atr,
    confidence: clamp(40 + (bos === "BEARISH" ? 20 : 0) + (trend === "BEARISH" ? 15 : 0) + (choch === "BEARISH" ? 10 : 0) + (fvg ? 5 : 0)),
    timeframe,
    invalidation: `Invalidate if the breakdown fails back above ${sellStopInvalidation}.`,
    confluence: [support !== null ? "support break" : "ATR breakdown level", bos === "BEARISH" ? "bearish BOS" : null, trend === "BEARISH" ? "bearish trend" : null].filter(Boolean)
  });

  return {
    mode: "PREDICTED_ZONES",
    status: "READY_TO_MONITOR",
    source: "KINGBOT structural inference",
    actualMarketOrdersVisible: false,
    note: "These are inferred liquidity/entry zones from observable price structure, not broker-confirmed pending orders.",
    currentPrice: roundPrice(price, price),
    atr: roundPrice(atr, price),
    buyLimitZones: [buyLimit],
    sellLimitZones: [sellLimit],
    buyStopTriggers: [buyStop],
    sellStopTriggers: [sellStop]
  };
}
