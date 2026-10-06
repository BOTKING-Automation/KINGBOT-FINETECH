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
const TIMEOUT_MS = Math.max(2500, Number(process.env.KINGBOT_ML_SIGNAL_TIMEOUT_MS || 6500));
const TRAIN_TIMEOUT_MS = Math.max(8000, Number(process.env.KINGBOT_ML_TRAIN_TIMEOUT_MS || 30000));

function enabled() {
  return Boolean(URL && SECRET);
}

async function request(path, body, timeoutMs = TIMEOUT_MS) {
  if (!enabled()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || TIMEOUT_MS));
  try {
    const response = await fetch(URL + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        "x-kingbot-ml-secret": SECRET
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      const code = String(data?.error || data?.reason || `ML_SIGNAL_HTTP_${response.status}`);
      throw new Error(code.slice(0, 220));
    }
    if (!data || typeof data !== "object") throw new Error("ML_SIGNAL_RESPONSE_INVALID");
    return data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("ML_SIGNAL_REQUEST_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function health() {
  if (!enabled()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, TIMEOUT_MS));
  try {
    const response = await fetch(URL + "/health", {
      headers: { "accept": "application/json", "x-kingbot-ml-secret": SECRET },
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = String(data?.error || `ML_HEALTH_HTTP_${response.status}`);
      throw new Error(code.slice(0, 180));
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("ML_HEALTH_REQUEST_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timer);
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
    libraries: ["scikit-learn", "PyTorch"]
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
    return {
      ok: false,
      ready: false,
      status: "ML_SERVICE_UNAVAILABLE",
      error: normalizeError(error, "ML_SERVICE_UNAVAILABLE"),
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
      status: code === "ML_SIGNAL_REQUEST_TIMEOUT" ? "ML_SERVICE_TIMEOUT" :
        code === "ML_SERVICE_UNAUTHORIZED" ? "ML_SERVICE_UNAUTHORIZED" : "ML_SERVICE_UNAVAILABLE",
      error: code
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
      status:"ML_FEEDBACK_UNAVAILABLE",
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
    }, TRAIN_TIMEOUT_MS);
  } catch (error) {
    const code = normalizeError(error, "ML_TRAINING_SERVICE_UNAVAILABLE");
    return {
      ok: false,
      ready: false,
      status: code === "ML_TRAINING_IN_PROGRESS" ? "ML_TRAINING_IN_PROGRESS" :
        code === "ML_SIGNAL_REQUEST_TIMEOUT" ? "ML_TRAINING_TIMEOUT" :
        code === "ML_SERVICE_UNAUTHORIZED" ? "ML_SERVICE_UNAUTHORIZED" : "ML_TRAINING_SERVICE_UNAVAILABLE",
      error: code
    };
  }
}
