const DEFAULT_MIN_INTERVAL_MS = 1800;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 4000;

let lastRequestStartedAt = 0;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function isDerivHistoryRateLimitError(error) {
  const message = String(error?.message || error || "");
  return /rate[\\s_-]*limit|too many requests/i.test(message);
}

/**
 * Request one Deriv candle page with pacing and bounded retry for the
 * ticks_history_expensive rate limit. Other errors fail immediately.
 */
export async function getDerivHistoryChunkWithRetry(
  feed,
  symbol,
  requestOptions,
  {
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
    sleepFn = sleep,
    now = Date.now,
    logger = console
  } = {}
) {
  if (!feed || typeof feed.getHistoricalCandles !== "function") {
    throw new TypeError("DERIV_HISTORY_FEED_INVALID");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 ||
      !Number.isFinite(minIntervalMs) || minIntervalMs < 0 ||
      !Number.isFinite(backoffBaseMs) || backoffBaseMs < 0) {
    throw new RangeError("DERIV_HISTORY_RETRY_CONFIGURATION_INVALID");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const waitMs = minIntervalMs > 0
      ? Math.max(0, minIntervalMs - (now() - lastRequestStartedAt))
      : 0;
    if (waitMs > 0) await sleepFn(waitMs);
    lastRequestStartedAt = now();

    try {
      return await feed.getHistoricalCandles(symbol, requestOptions);
    } catch (error) {
      if (!isDerivHistoryRateLimitError(error) || attempt === maxAttempts) {
        throw error;
      }

      const delayMs = backoffBaseMs * (2 ** (attempt - 1));
      logger.warn?.(
        "[KINGBOT V12.4 DATA] DERIV_HISTORY_RATE_LIMIT_RETRY",
        JSON.stringify({
          symbol,
          timeframe: requestOptions?.timeframe || null,
          end: requestOptions?.end ?? null,
          attempt,
          maxAttempts,
          delayMs,
          error: String(error?.message || error).slice(0, 180)
        })
      );
      await sleepFn(delayMs);
    }
  }

  throw new Error("DERIV_HISTORY_RETRY_EXHAUSTED");
}
