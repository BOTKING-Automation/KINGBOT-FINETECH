function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  let candidate = value;
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    candidate = Number.isFinite(numeric) ? numeric : Date.parse(trimmed);
  }
  const n = finite(candidate);
  if (n === null || n <= 0) return null;
  if (n > 1e17) return n / 1e6;
  if (n > 1e14) return n / 1e3;
  if (n < 1e11) return n * 1000;
  return n;
}

/**
 * Validate and standardize candle history returned by a connected broker adapter.
 * Invalid chronology, malformed OHLC, and insufficient history are rejected.
 */
export function normalizeBrokerHistoricalBars(result, { minBars = 260, maxBars = 1000 } = {}) {
  const rows = Array.isArray(result)
    ? result
    : Array.isArray(result?.data)
      ? result.data
      : Array.isArray(result?.candles)
        ? result.candles
        : null;

  if (!rows) throw new Error("BROKER_HISTORICAL_BARS_REQUIRED");
  const minimum = Math.max(1, Math.floor(Number(minBars) || 260));
  const maximum = Math.max(minimum, Math.floor(Number(maxBars) || 1000));
  if (rows.length < minimum) {
    throw new Error("BROKER_HISTORICAL_BARS_INSUFFICIENT:" + rows.length + "/" + minimum);
  }

  const normalized = rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("BROKER_HISTORICAL_BAR_INVALID");
    }
    const timestamp = parseTimestamp(
      row.datetime ?? row.time ?? row.timestamp ?? row.date ?? row.epoch ?? null
    );
    const open = finite(row.open ?? row.o);
    const high = finite(row.high ?? row.h);
    const low = finite(row.low ?? row.l);
    const close = finite(row.close ?? row.c);
    const volume = finite(row.volume ?? row.tickVolume ?? row.tick_volume ?? row.v);

    if (timestamp === null) throw new Error("BROKER_HISTORICAL_TIMESTAMP_INVALID");
    if (timestamp > Date.now() + 60_000) {
      throw new Error("BROKER_HISTORICAL_TIMESTAMP_IN_FUTURE");
    }
    if (![open, high, low, close].every(value => value !== null && value > 0)) {
      throw new Error("BROKER_HISTORICAL_OHLC_INVALID");
    }
    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
      throw new Error("BROKER_HISTORICAL_OHLC_INCONSISTENT");
    }

    return {
      datetime: new Date(timestamp).toISOString(),
      open,
      high,
      low,
      close,
      volume: volume !== null && volume >= 0 ? volume : 0
    };
  });

  for (let index = 1; index < normalized.length; index += 1) {
    if (Date.parse(normalized[index].datetime) <= Date.parse(normalized[index - 1].datetime)) {
      throw new Error("BROKER_HISTORICAL_TIMESTAMPS_NOT_INCREASING");
    }
  }

  const bars = normalized.slice(-maximum);
  if (bars.length < minimum) {
    throw new Error("BROKER_HISTORICAL_BARS_INSUFFICIENT:" + bars.length + "/" + minimum);
  }
  return bars;
}
