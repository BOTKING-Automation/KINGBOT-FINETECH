import {
  ema as calculateEma,
  rsi as calculateRsi,
  atr as calculateAtr,
  adx as calculateAdx,
  calculateLadderV8Indicators,
  LADDER_V8_DEFAULTS
} from "./ladder-v8.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = null) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;
const maxOf = values => values.length ? Math.max(...values) : null;
const minOf = values => values.length ? Math.min(...values) : null;

function directionalClose(candle, direction) {
  const range = Math.max(candle.high - candle.low, 1e-12);
  const location = (candle.close - candle.low) / range;
  return direction === "BULLISH"
    ? candle.close > candle.open && location >= 0.72
    : direction === "BEARISH"
      ? candle.close < candle.open && location <= 0.28
      : false;
}

function breakoutRetest(rows, atrValue) {
  const lastIndex = rows.length - 1;
  const last = rows[lastIndex];
  const buffer = atrValue * 0.05;
  const touchTolerance = atrValue * 0.20;
  let retestDirection = "NONE";
  let retestLevel = null;

  // A retest must follow a prior closed breakout candle. A first touch
  // through a range boundary is not counted as a retest.
  for (let i = Math.max(20, lastIndex - 5); i < lastIndex; i++) {
    const prior = rows.slice(i - 20, i);
    if (prior.length < 20) continue;
    const rangeHigh = maxOf(prior.map(x => x.high));
    const rangeLow = minOf(prior.map(x => x.low));
    const breakoutBar = rows[i];

    if (breakoutBar.close > rangeHigh + buffer) {
      const heldOutside = rows.slice(i + 1, lastIndex).every(x => x.close > rangeHigh);
      const retested = last.low <= rangeHigh + touchTolerance &&
        last.close > rangeHigh + buffer &&
        directionalClose(last, "BULLISH");
      if (heldOutside && retested) {
        retestDirection = "BULLISH";
        retestLevel = rangeHigh;
        break;
      }
    }

    if (breakoutBar.close < rangeLow - buffer) {
      const heldOutside = rows.slice(i + 1, lastIndex).every(x => x.close < rangeLow);
      const retested = last.high >= rangeLow - touchTolerance &&
        last.close < rangeLow - buffer &&
        directionalClose(last, "BEARISH");
      if (heldOutside && retested) {
        retestDirection = "BEARISH";
        retestLevel = rangeLow;
        break;
      }
    }
  }

  const recent = rows.slice(-21, -1);
  const recentHigh = maxOf(recent.map(x => x.high));
  const recentLow = minOf(recent.map(x => x.low));
  const immediateDirection = last.close > recentHigh + buffer
    ? "BULLISH"
    : last.close < recentLow - buffer
      ? "BEARISH"
      : "NONE";

  return {
    breakoutDirection: retestDirection !== "NONE" ? retestDirection : immediateDirection,
    retestDirection,
    retestLevel,
    breakout: retestDirection !== "NONE" || immediateDirection !== "NONE",
    retest: retestDirection !== "NONE"
  };
}

export function calculateMarketIndicators(candles = []) {
  const rows = (Array.isArray(candles) ? candles : [])
    .map(c => ({
      time: c?.time || c?.datetime || c?.timestamp || null,
      open: finite(c?.open),
      high: finite(c?.high),
      low: finite(c?.low),
      close: finite(c?.close),
      volume: finite(c?.volume, finite(c?.tickVolume, 0))
    }))
    .filter(c =>
      [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
      c.open > 0 && c.low > 0 && c.high >= c.low &&
      c.high >= Math.max(c.open, c.close) &&
      c.low <= Math.min(c.open, c.close)
    )
    .slice(-100);

  // EMA50 and the longer volatility baseline need a real history window.
  if (rows.length < 60) throw new Error("INSUFFICIENT_HISTORICAL_CANDLES");

  const closes = rows.map(x => x.close);
  const highs = rows.map(x => x.high);
  const lows = rows.map(x => x.low);
  const last = rows.at(-1);
  const previous = rows.at(-2);
  const price = last.close;

  const emaFast = calculateEma(closes, 20);
  const emaSlow = calculateEma(closes, 50);
  const rsiValue = calculateRsi(closes, 14);
  const atrValue = calculateAtr(rows, 14);
  const atrBaseline = calculateAtr(rows, 50);
  const adxValue = calculateAdx(rows, 14);

  if (![emaFast, emaSlow, rsiValue, atrValue, adxValue].every(Number.isFinite) || atrValue <= 0) {
    throw new Error("TECHNICAL_INDICATORS_UNAVAILABLE");
  }

  const emaGap = (emaFast - emaSlow) / atrValue;
  const priceSide = price > emaFast ? 1 : price < emaFast ? -1 : 0;
  const emaSide = Math.sign(emaFast - emaSlow);
  let trend = clamp(emaGap / 1.8, -1, 1);
  if (priceSide !== 0 && emaSide !== 0 && priceSide !== emaSide) trend *= 0.45;
  if (priceSide === 0) trend *= 0.65;

  const roc5 = (price - closes.at(-6)) / Math.max(atrValue, 1e-12);
  const rsiMomentum = clamp((rsiValue - 50) / 25, -1, 1);
  const priceMomentum = clamp(roc5 / 2.5, -1, 1);
  const momentum = clamp(rsiMomentum * 0.55 + priceMomentum * 0.45, -1, 1);

  const volatilityRatio = atrBaseline > 0 ? atrValue / atrBaseline : 1;
  const volatility = clamp(volatilityRatio / 1.8, 0, 1);

  const recentHighs = highs.slice(-21, -1);
  const recentLows = lows.slice(-21, -1);
  const recentHigh = maxOf(recentHighs);
  const recentLow = minOf(recentLows);

  const previousHighs = highs.slice(-41, -21);
  const previousLows = lows.slice(-41, -21);
  const oldHigh = maxOf(previousHighs);
  const oldLow = minOf(previousLows);
  const structureBuffer = atrValue * 0.05;
  const higherHigh = recentHigh > oldHigh + structureBuffer;
  const higherLow = recentLow > oldLow + structureBuffer;
  const lowerHigh = recentHigh < oldHigh - structureBuffer;
  const lowerLow = recentLow < oldLow - structureBuffer;
  const structure = higherHigh && higherLow
    ? "bullish"
    : lowerHigh && lowerLow
      ? "bearish"
      : "range";

  const breakoutState = breakoutRetest(rows, atrValue);
  const breakoutDirection = breakoutState.breakoutDirection;
  const retestDirection = breakoutState.retestDirection;

  const range = Math.max(last.high - last.low, 1e-12);
  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / range;
  const displacementDirection =
    body >= atrValue * 1.15 && bodyRatio >= 0.65 && directionalClose(last, "BULLISH")
      ? "BULLISH"
      : body >= atrValue * 1.15 && bodyRatio >= 0.65 && directionalClose(last, "BEARISH")
        ? "BEARISH"
        : "NONE";

  const liquiditySweepDirection =
    last.low < recentLow - structureBuffer &&
    last.close > recentLow &&
    directionalClose(last, "BULLISH")
      ? "BULLISH"
      : last.high > recentHigh + structureBuffer &&
        last.close < recentHigh &&
        directionalClose(last, "BEARISH")
        ? "BEARISH"
        : "NONE";

  const bosDirection = last.close > recentHigh + structureBuffer
    ? "BULLISH"
    : last.close < recentLow - structureBuffer
      ? "BEARISH"
      : "NONE";

  const bullishFvg = rows.length >= 3 && last.low > rows.at(-3).high;
  const bearishFvg = rows.length >= 3 && last.high < rows.at(-3).low;
  const fairValueGapDirection = bullishFvg ? "BULLISH" : bearishFvg ? "BEARISH" : "NONE";

  let orderBlock = null;
  if (displacementDirection !== "NONE") {
    for (let i = rows.length - 2; i >= Math.max(0, rows.length - 12); i--) {
      const candidate = rows[i];
      const impulse = rows[i + 1];
      if (
        displacementDirection === "BULLISH" &&
        candidate.close < candidate.open &&
        impulse.close > candidate.high &&
        impulse.close - candidate.high >= atrValue * 0.15
      ) {
        orderBlock = { direction: "BULLISH", high: candidate.high, low: candidate.low, index: i };
        break;
      }
      if (
        displacementDirection === "BEARISH" &&
        candidate.close > candidate.open &&
        impulse.close < candidate.low &&
        candidate.low - impulse.close >= atrValue * 0.15
      ) {
        orderBlock = { direction: "BEARISH", high: candidate.high, low: candidate.low, index: i };
        break;
      }
    }
  }

  const meanVolume = rows.slice(-21, -1).reduce((sum, x) => sum + x.volume, 0) / 20;
  const volumeRatio = meanVolume > 0 ? last.volume / meanVolume : 0;
  const volume = clamp(volumeRatio / 2, 0, 1);

  let v8 = null;
  if (rows.length >= 78) {
    try { v8 = calculateLadderV8Indicators(rows, LADDER_V8_DEFAULTS); }
    catch { v8 = null; }
  }

  return {
    price,
    atr: atrValue,
    v8Atr: v8?.atr ?? atrValue,
    trend,
    momentum,
    volatility,
    structure,
    breakout: breakoutState.breakout,
    breakoutDirection,
    retest: breakoutState.retest,
    retestDirection,
    retestLevel: breakoutState.retestLevel,
    displacement: displacementDirection !== "NONE",
    displacementDirection,
    liquiditySweep: liquiditySweepDirection !== "NONE",
    liquiditySweepDirection,
    bosDirection,
    orderBlock,
    fairValueGap: fairValueGapDirection !== "NONE",
    fairValueGapDirection,
    volume,
    emaFast,
    emaSlow,
    adx: adxValue,
    rsi: rsiValue,
    velocityPoints: 0,
    v8Price: v8?.price ?? price,
    v8EntryQualified: Boolean(v8?.entryQualified),
    v8Direction: Number(v8?.direction || 0),
    candleCount: rows.length,
    lastBarTime: last.time || null
  };
}
