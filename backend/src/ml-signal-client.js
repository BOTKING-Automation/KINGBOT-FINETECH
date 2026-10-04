const EXPLICIT_URL = String(process.env.KINGBOT_ML_SIGNAL_URL || "").trim().replace(/\/$/, "");
const HOST = String(process.env.KINGBOT_ML_SIGNAL_HOST || "").trim();
const PORT = String(process.env.KINGBOT_ML_SIGNAL_PORT || "").trim();
const URL = EXPLICIT_URL || (HOST ? "http://" + HOST + (PORT ? ":" + PORT : "") : "");
const SECRET = String(process.env.KINGBOT_ML_SIGNAL_SECRET || "").trim();
const TIMEOUT_MS = Math.max(800, Number(process.env.KINGBOT_ML_SIGNAL_TIMEOUT_MS || 2200));

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
      throw new Error(String(data?.error || data?.reason || "ML_SIGNAL_SERVICE_UNAVAILABLE").slice(0, 220));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export function mlSignalServiceStatus() {
  return {
    configured: enabled(),
    urlConfigured: Boolean(URL),
    secretConfigured: Boolean(SECRET),
    stage: "AI_STRATEGIES",
    purpose: "ML_SIGNAL_GENERATION",
    endpoint: enabled() ? URL : null,
    libraries: ["scikit-learn", "PyTorch"]
  };
}

export async function predictMlStrategySignal({ botId, market } = {}) {
  if (!enabled() || !botId || !market?.symbol) return null;
  try {
    return await request("/predict", {
      botId: String(botId).trim().toLowerCase(),
      symbol: String(market.symbol).trim().toUpperCase(),
      timeframe: String(market.timeframe || "5m").trim().toLowerCase(),
      market
    });
  } catch (error) {
    return {
      ok: false,
      ready: false,
      status: "ML_SERVICE_UNAVAILABLE",
      error: String(error?.message || "ML_SERVICE_UNAVAILABLE").slice(0, 180)
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
    }, Math.max(8000, TIMEOUT_MS * 12));
  } catch (error) {
    return {
      ok: false,
      ready: false,
      status: "ML_TRAINING_SERVICE_UNAVAILABLE",
      error: String(error?.message || "ML_TRAINING_SERVICE_UNAVAILABLE").slice(0, 180)
    };
  }
}
