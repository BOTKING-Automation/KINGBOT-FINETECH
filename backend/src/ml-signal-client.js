const EXPLICIT_URL = String(process.env.KINGBOT_ML_SIGNAL_URL || "").trim().replace(/\/$/, "");
const HOST = String(process.env.KINGBOT_ML_SIGNAL_HOST || "").trim();
const PORT = String(process.env.KINGBOT_ML_SIGNAL_PORT || "").trim();
function normalizeServiceUrl() {
  if (EXPLICIT_URL) return EXPLICIT_URL;
  if (!HOST) return "";
  const host = HOST.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  // Render exposes public web services over HTTPS and maps the internal PORT
  // automatically. Never append the internal port to a public *.onrender.com URL.
  if (/\.onrender\.com$/i.test(host)) return "https://" + host;
  return "http://" + host + (PORT ? ":" + PORT : "");
}
const URL = normalizeServiceUrl();
const SECRET = String(process.env.KINGBOT_ML_SIGNAL_SECRET || "").trim();
// Allow enough time for Render free-tier wake-up + model inference, while
// keeping the worker bounded and preserving the mandatory AI execution gate.
const TIMEOUT_MS = Math.max(5000, Number(process.env.KINGBOT_ML_SIGNAL_TIMEOUT_MS || 10000));
const TRAIN_TIMEOUT_MS = Math.max(30000, Number(process.env.KINGBOT_ML_TRAIN_TIMEOUT_MS || 180000));
const RATE_LIMIT_COOLDOWN_MS = Math.min(30 * 60 * 1000,
  Math.max(60 * 1000, Number(process.env.KINGBOT_ML_429_COOLDOWN_MS || 10 * 60 * 1000)));
const HEALTH_CACHE_MS = Math.max(5000, Number(process.env.KINGBOT_ML_HEALTH_CACHE_MS || 15000));
let rateLimitUntil = 0;
let healthCache = null;
let healthCacheUntil = 0;
let healthInflight = null;

function enabled() {
  return Boolean(URL && SECRET);
}

function parseRetryAfterMs(header) {
  const value = String(header || "").trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(30 * 60 * 1000, Math.max(1000, seconds * 1000));
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.min(30 * 60 * 1000, Math.max(1000, date - Date.now()));
  }
  return null;
}

function remainingRateLimitMs() {
  return Math.max(0, rateLimitUntil - Date.now());
}

function rateLimitedError() {
  const error = new Error("ML_SIGNAL_HTTP_429");
  error.retryAfterMs = remainingRateLimitMs();
  return error;
}

function recordRateLimit(response) {
  const advertised = parseRetryAfterMs(response?.headers?.get?.("retry-after"));
  const cooldown = advertised ?? RATE_LIMIT_COOLDOWN_MS;
  rateLimitUntil = Math.max(rateLimitUntil, Date.now() + cooldown);
  healthCache = null;
  healthCacheUntil = 0;
  return remainingRateLimitMs();
}

function retryDelay(response, fallbackMs, minimumMs, maximumMs = 30000) {
  const advertised = parseRetryAfterMs(response?.headers?.get?.("retry-after"));
  return Math.max(minimumMs, Math.min(maximumMs, advertised ?? fallbackMs));
}

async function request(
  path,
  body,
  timeoutMs = TIMEOUT_MS,
  { maxBusyRetries = 0, maxUnavailableRetries = 0 } = {}
) {
  if (!enabled()) return null;
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || TIMEOUT_MS);
  let retry429Count = 0;
  let retryBusyCount = 0;
  let retryUnavailableCount = 0;

  while (true) {
    if (remainingRateLimitMs() > 0) throw rateLimitedError();
    const remaining = deadline - Date.now();
    if (remaining < 1000) throw new Error("ML_SIGNAL_REQUEST_TIMEOUT");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(500, remaining));
    let response;
    try {
      response = await fetch(URL + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "x-kingbot-ml-secret": SECRET
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("ML_SIGNAL_REQUEST_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      const retryAfterMs = recordRateLimit(response);
      const error = new Error("ML_SIGNAL_HTTP_429");
      error.retryAfterMs = retryAfterMs;
      throw error;
    }

    const data = await response.json().catch(() => ({}));
    const errorCode = String(data?.error || data?.reason || `ML_SIGNAL_HTTP_${response.status}`);

    // The Python trainer is intentionally single-capacity on the Free tier.
    // Wait for the active model fit instead of treating an ordinary 409 busy
    // response as a failed strategy model.
    const gatewayUnavailable = [502, 503, 504].includes(response.status) &&
      errorCode === `ML_SIGNAL_HTTP_${response.status}`;
    if (gatewayUnavailable && retryUnavailableCount < maxUnavailableRetries) {
      retryUnavailableCount += 1;
      const delayMs = retryDelay(
        response, Math.min(30000, 1500 * (2 ** (retryUnavailableCount - 1))), 1000
      );
      if (Date.now() + delayMs + 1000 >= deadline) {
        throw new Error(errorCode);
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
      continue;
    }

    const trainerBusy = response.status === 409 &&
      ["ML_TRAINING_CAPACITY_BUSY", "ML_TRAINING_IN_PROGRESS"].includes(errorCode);
    if (trainerBusy && retryBusyCount < maxBusyRetries) {
      retryBusyCount += 1;
      const delayMs = retryDelay(
        response, Math.min(30000, 3000 * (2 ** (retryBusyCount - 1))), 2000
      );
      if (Date.now() + delayMs + 1000 >= deadline) {
        throw new Error(errorCode);
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
      continue;
    }

    if (!response.ok || data?.ok === false) {
      throw new Error(errorCode.slice(0, 220));
    }
    if (!data || typeof data !== "object") throw new Error("ML_SIGNAL_RESPONSE_INVALID");
    return data;
  }
}

async function health() {
  if (!enabled()) return null;
  if (remainingRateLimitMs() > 0) throw rateLimitedError();
  if (healthCache && Date.now() < healthCacheUntil) return healthCache;
  if (healthInflight) return healthInflight;

  const pending = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(500, TIMEOUT_MS));
    try {
      const response = await fetch(URL + "/health", {
        headers: { "accept": "application/json", "x-kingbot-ml-secret": SECRET },
        signal: controller.signal
      });
      if (response.status === 429) {
        const retryAfterMs = recordRateLimit(response);
        const error = new Error("ML_SIGNAL_HTTP_429");
        error.retryAfterMs = retryAfterMs;
        throw error;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const code = String(data?.error || `ML_HEALTH_HTTP_${response.status}`);
        throw new Error(code.slice(0, 180));
      }
      healthCache = data;
      healthCacheUntil = Date.now() + HEALTH_CACHE_MS;
      return data;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("ML_HEALTH_REQUEST_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();

  healthInflight = pending;
  try {
    return await pending;
  } finally {
    if (healthInflight === pending) healthInflight = null;
  }
}

function normalizeError(error, fallback) {
  return String(error?.message || fallback).slice(0, 180);
}

export function mlSignalServiceStatus() {
  return {
    configured: enabled(),
    urlConfigured: Boolean(URL),
    secretConfigured: Boolean(SECRET),
    stage: "AI_STRATEGIES",
    purpose: "ML_SIGNAL_GENERATION",
    endpoint: enabled() ? URL : null,
    healthEndpoint: enabled() ? URL + "/health" : null,
    timeoutMs: TIMEOUT_MS,
    trainTimeoutMs: TRAIN_TIMEOUT_MS,
    libraries: ["scikit-learn", "PyTorch"],
    rateLimited: remainingRateLimitMs() > 0,
    retryAfterMs: remainingRateLimitMs()
  };
}

export async function probeMlSignalService() {
  if (!enabled()) {
    return {
      ok: false,
      ready: false,
      status: "ML_SERVICE_NOT_CONFIGURED",
      ...mlSignalServiceStatus()
    };
  }
  if (remainingRateLimitMs() > 0) {
    return {
      ok: false,
      ready: false,
      status: "ML_SERVICE_RATE_LIMITED",
      error: "ML_SIGNAL_HTTP_429",
      ...mlSignalServiceStatus()
    };
  }
  try {
    const remote = await health();
    return {
      ok: true,
      ready: Boolean(remote?.ready || remote?.configured),
      status: remote?.ready ? "ML_SERVICE_READY" : "ML_SERVICE_DEGRADED",
      ...mlSignalServiceStatus(),
      remote
    };
  } catch (error) {
    const code = normalizeError(error, "ML_SERVICE_UNAVAILABLE");
    if (/HTTP_429|RATE_LIMITED/i.test(code) || remainingRateLimitMs() > 0) {
      return {
        ok: false,
        ready: false,
        status: "ML_SERVICE_RATE_LIMITED",
        error: "ML_SIGNAL_HTTP_429",
        ...mlSignalServiceStatus()
      };
    }
    return {
      ok: false,
      ready: false,
      status: "ML_SERVICE_UNAVAILABLE",
      error: code,
      ...mlSignalServiceStatus()
    };
  }
}

export async function predictMlStrategySignal({ botId, market } = {}) {
  if (!enabled() || !botId || !market?.symbol) return null;
  try {
    const result = await request("/predict", {
      botId: String(botId).trim().toLowerCase(),
      symbol: String(market.symbol).trim().toUpperCase(),
      timeframe: String(market.timeframe || "5m").trim().toLowerCase(),
      market
    });
    if (result?.ready && !["BUY", "SELL", "HOLD"].includes(String(result.direction || "").toUpperCase())) {
      throw new Error("ML_PREDICTION_DIRECTION_INVALID");
    }
    return result;
  } catch (error) {
    const code = normalizeError(error, "ML_SERVICE_UNAVAILABLE");
    return {
      ok: false,
      ready: false,
      status: /HTTP_429|RATE_LIMITED/i.test(code) ? "ML_SERVICE_RATE_LIMITED" :
        code === "ML_SIGNAL_REQUEST_TIMEOUT" ? "ML_SERVICE_TIMEOUT" :
        code === "ML_SERVICE_UNAUTHORIZED" ? "ML_SERVICE_UNAUTHORIZED" : "ML_SERVICE_UNAVAILABLE",
      error: code,
      retryAfterMs: Number(error?.retryAfterMs || remainingRateLimitMs()) || undefined
    };
  }
}

export async function recordMlFeedback({ botId, symbol, timeframe, direction, outcome, market, pnl, rMultiple } = {}) {
  if(!enabled() || !botId || !symbol || !market) return null;
  try{
    return await request("/feedback", {
      botId: String(botId).trim().toLowerCase(),
      symbol: String(symbol).trim().toUpperCase(),
      timeframe: String(timeframe || "5m").trim().toLowerCase(),
      direction: String(direction || "").trim().toUpperCase(),
      outcome: String(outcome || "").trim().toUpperCase(),
      market,
      pnl,
      rMultiple
    });
  }catch(error){
    return {
      ok:false,
      status:/HTTP_429|RATE_LIMITED/i.test(String(error?.message||"")) ? "ML_FEEDBACK_RATE_LIMITED" : "ML_FEEDBACK_UNAVAILABLE",
      error:normalizeError(error,"ML_FEEDBACK_UNAVAILABLE")
    };
  }
}

export async function trainMlStrategyModel({ botId, symbol, timeframe, bars, markets } = {}) {
  if (!enabled() || !botId) return null;
  const datasets = Array.isArray(markets)
    ? markets
        .filter(item => item && item.symbol && Array.isArray(item.bars))
        .map(item => ({
          symbol: String(item.symbol).trim().toUpperCase(),
          bars: item.bars
        }))
    : (symbol && Array.isArray(bars) ? [{
        symbol: String(symbol).trim().toUpperCase(),
        bars
      }] : []);
  if (!datasets.length) return null;
  try {
    return await request("/train", {
      botId: String(botId).trim().toLowerCase(),
      timeframe: String(timeframe || "5m").trim().toLowerCase(),
      markets: datasets
    }, TRAIN_TIMEOUT_MS, { maxBusyRetries: 6, maxUnavailableRetries: 4 });
  } catch (error) {
    const code = normalizeError(error, "ML_TRAINING_SERVICE_UNAVAILABLE");
    return {
      ok: false,
      ready: false,
      status: /HTTP_429|RATE_LIMITED/i.test(code) ? "ML_TRAINING_RATE_LIMITED" :
        code === "ML_TRAINING_IN_PROGRESS" ? "ML_TRAINING_IN_PROGRESS" :
        code === "ML_SIGNAL_REQUEST_TIMEOUT" ? "ML_TRAINING_TIMEOUT" :
        code === "ML_SERVICE_UNAUTHORIZED" ? "ML_SERVICE_UNAUTHORIZED" : "ML_TRAINING_SERVICE_UNAVAILABLE",
      error: code,
      retryAfterMs: Number(error?.retryAfterMs || remainingRateLimitMs()) || undefined
    };
  }
}
