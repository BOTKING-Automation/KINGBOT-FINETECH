function candleTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return numeric > 1e12 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function sortChronologicalCandles(candles) {
  if (!Array.isArray(candles)) throw new TypeError("ML_CANDLES_ARRAY_REQUIRED");
  const parsed = candles.map((candle, index) => {
    const raw = candle?.time ?? candle?.datetime ?? candle?.timestamp ?? candle?.date ?? null;
    return { candle, index, timestamp: candleTimestamp(raw), hasTimestamp: raw !== null && raw !== undefined && raw !== "" };
  });
  const hasTimestamp = parsed.filter(item => item.hasTimestamp).length;
  const timestamped = parsed.filter(item => item.timestamp !== null).length;
  if (hasTimestamp === 0) return candles;
  if (hasTimestamp !== candles.length) {
    throw new Error("ML_CANDLE_TIMESTAMPS_INCONSISTENT");
  }
  if (timestamped !== candles.length) {
    throw new Error("ML_CANDLE_TIMESTAMP_INVALID");
  }

  parsed.sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);
  const unique = new Map();
  for (const item of parsed) unique.set(item.timestamp, item.candle);
  return [...unique.values()];
}
