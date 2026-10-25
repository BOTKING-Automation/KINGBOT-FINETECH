function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timestampMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    const n = value.getTime();
    return Number.isFinite(n) && n > 0 ? n : null;
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
  if (n > 1e17) return n / 1e6; // nanoseconds to milliseconds
  if (n > 1e14) return n / 1e3; // microseconds to milliseconds
  if (n < 1e11) return n * 1000; // Unix seconds to milliseconds
  return n; // milliseconds
}

function unwrapQuote(result) {
  let raw = result;
  if (raw && typeof raw === "object" && raw.data && typeof raw.data === "object") {
    raw = raw.data;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("BROKER_EXECUTION_QUOTE_REQUIRED");
  }
  if (result?.connected === false || raw.connected === false || raw.ok === false) {
    throw new Error("BROKER_EXECUTION_QUOTE_UNAVAILABLE");
  }
  return raw;
}

/**
 * Normalize only executable broker quotes. Mid-price-only feeds are useful for
 * analysis but cannot silently become a zero-spread execution quote.
 */
export function normalizeExecutionQuote(result, {
  requestedSymbol,
  provider,
  nowMs = Date.now(),
  freshnessMaxAgeMs = 30000,
  futureToleranceMs = 2000
} = {}) {
  const raw = unwrapQuote(result);
  const bid = finite(raw.bid ?? raw.bidPrice ?? raw.bid_price ?? raw.bestBid ?? raw.best_bid);
  const ask = finite(raw.ask ?? raw.askPrice ?? raw.ask_price ?? raw.bestAsk ?? raw.best_ask);
  if (!(bid > 0) || !(ask > 0)) {
    throw new Error("BROKER_EXECUTION_BID_ASK_REQUIRED");
  }
  if (ask < bid) throw new Error("BROKER_EXECUTION_QUOTE_CROSSED");
  if (raw.tradeable === false || raw.tradeable === 0 || raw.tradeable === "false") {
    throw new Error("BROKER_INSTRUMENT_NOT_TRADEABLE");
  }

  const rawTimestamp = raw.time ?? raw.timestamp ?? raw.updatedAt ?? raw.updated_at
    ?? raw.datetime ?? raw.epoch ?? raw.quoteTime ?? null;
  const timestamp = timestampMs(rawTimestamp);
  if (timestamp === null) throw new Error("BROKER_QUOTE_TIMESTAMP_REQUIRED");
  if (timestamp > nowMs + Math.max(0, Number(futureToleranceMs) || 0)) {
    throw new Error("BROKER_QUOTE_TIMESTAMP_IN_FUTURE");
  }

  const ageMs = Math.max(0, nowMs - timestamp);
  const symbol = String(requestedSymbol || raw.symbol || raw.instrument || "").trim().toUpperCase();
  if (!symbol) throw new Error("BROKER_SYMBOL_REQUIRED");

  const brokerSymbol = String(
    raw.brokerSymbol || raw.instrument || raw.symbol || requestedSymbol
  ).trim().toUpperCase();
  const sourcePrice = finite(raw.price ?? raw.mid ?? raw.midPrice);
  const price = sourcePrice !== null && sourcePrice > 0
    ? sourcePrice
    : Number(((bid + ask) / 2).toPrecision(14));

  return {
    ...raw,
    symbol,
    brokerSymbol,
    bid,
    ask,
    price,
    spread: ask - bid,
    time: new Date(timestamp).toISOString(),
    timestamp: new Date(timestamp).toISOString(),
    ageMs,
    freshnessMaxAgeMs: Math.max(1000, Number(freshnessMaxAgeMs) || 30000),
    fresh: ageMs <= Math.max(1000, Number(freshnessMaxAgeMs) || 30000),
    quoteQuality: "BROKER_NATIVE_BID_ASK",
    provider: String(provider || raw.provider || "unknown"),
    timestampSource: String(
      raw.time !== undefined ? "time"
      : raw.timestamp !== undefined ? "timestamp"
      : raw.updatedAt !== undefined ? "updatedAt"
      : raw.updated_at !== undefined ? "updated_at"
      : raw.datetime !== undefined ? "datetime"
      : raw.epoch !== undefined ? "epoch"
      : "quoteTime"
    )
  };
}
