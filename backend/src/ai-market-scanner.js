import "dotenv/config";

const DEFAULT_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD"];

function cleanSymbols(value) {
  const input = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(
    input
      .map(symbol => String(symbol || "").trim().toUpperCase())
      .filter(symbol => /^[A-Z0-9._-]{3,30}$/.test(symbol))
  )].slice(0, 12);
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function askGrok({ quotes, timeframe }) {
  const apiKey = String(process.env.XAI_API_KEY || "").trim();
  if (!apiKey) {
    return {
      provider: "none",
      model: null,
      analysis: "Grok market scanning is not configured on the server yet.",
    };
  }

  const model = String(process.env.XAI_MODEL || "grok-4.7").trim();
  const baseUrl = String(process.env.XAI_API_BASE_URL || "https://api.x.ai/v1")
    .trim()
    .replace(/\/$/, "");

  const prompt = [
    "You are the KINGBOT Market Scanner.",
    "Analyze only the verified broker quote snapshot supplied below.",
    "Do not invent candles, news, indicators, order flow, sentiment, or market data that is not present.",
    "Return concise JSON with keys: market_regime, ranked_symbols, risk_flags, summary.",
    "ranked_symbols must be an array of objects with symbol, bias, rationale.",
    "Use BULLISH, BEARISH, NEUTRAL, or DATA_INSUFFICIENT for bias.",
    "",
    "Timeframe hint: " + (timeframe || "NOT_SPECIFIED"),
    "Verified broker quotes:",
    JSON.stringify(quotes, null, 2),
  ].join("\n");

  const response = await fetch(baseUrl + "/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: "KINGBOT market-scanner intelligence." },
        { role: "user", content: prompt },
      ],
      max_output_tokens: 700,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      data?.message ||
      "XAI_MARKET_SCAN_FAILED"
    );
  }

  const analysis = String(data?.output_text || "").trim();
  if (!analysis) throw new Error("XAI_MARKET_SCAN_EMPTY");
  return { provider: "xai", model, analysis };
}

async function collectQuotes(broker, userId, symbols) {
  return Promise.all(symbols.map(async symbol => {
    try {
      const result = await broker.getQuote(symbol, userId);
      const raw = result?.data || result || {};
      const bid = finite(raw.bid ?? raw.buy ?? raw.bidPrice);
      const ask = finite(raw.ask ?? raw.sell ?? raw.askPrice);
      const price = finite(
        raw.price ?? (bid !== null && ask !== null ? (bid + ask) / 2 : null)
      );
      return {
        symbol,
        bid,
        ask,
        price,
        spread: bid !== null && ask !== null ? ask - bid : null,
        time: raw.time || raw.timestamp || null,
        available: price !== null || (bid !== null && ask !== null),
      };
    } catch (error) {
      return {
        symbol,
        available: false,
        error: String(error?.message || "QUOTE_UNAVAILABLE").slice(0, 120),
      };
    }
  }));
}

async function runMarketScan({ requireUser, pool, broker, req, res }) {
  const user = await requireUser(pool, req, res);
  if (!user) return null;

  const requestedSymbols = cleanSymbols(req.query?.symbols || req.body?.symbols);
  const symbols = requestedSymbols.length ? requestedSymbols : DEFAULT_SYMBOLS;
  const timeframe = String(req.query?.timeframe || req.body?.timeframe || "").trim().slice(0, 12);

  try {
    const mapping = await broker.getMapping(user.id);
    if (!mapping) {
      res.status(503).json({
        ok: false,
        error: "BROKER_NOT_CONNECTED",
        code: "BROKER_NOT_CONNECTED",
        scanner: "KINGBOT AI MARKET SCANNER",
        message: "Connect a broker account before running the market scanner.",
      });
      return null;
    }

    const quotes = await collectQuotes(broker, user.id, symbols);
    const available = quotes.filter(q => q.available).length;

    let ai;
    try {
      ai = await askGrok({ quotes, timeframe });
    } catch (error) {
      return res.json({
        ok: true,
        scanner: "KINGBOT AI MARKET SCANNER",
        provider: "none",
        model: null,
        executionAuthority: "NONE",
        symbols,
        quotes,
        analysis: "AI analysis temporarily unavailable: " + String(error?.message || "AI_FAILED").slice(0, 160),
        aiError: String(error?.message || "AI_FAILED").slice(0, 200),
        generatedAt: new Date().toISOString(),
        quoteCount: available,
      });
    }

    return res.json({
      ok: true,
      scanner: "KINGBOT AI MARKET SCANNER",
      provider: ai.provider,
      model: ai.model,
      executionAuthority: "NONE",
      symbols,
      quotes,
      analysis: ai.analysis,
      generatedAt: new Date().toISOString(),
      quoteCount: available,
    });
  } catch (error) {
    console.error("[KINGBOT MARKET SCANNER] failed:", error?.message || error);
    return res.status(502).json({
      ok: false,
      error: "AI_MARKET_SCANNER_UNAVAILABLE",
      code: "AI_MARKET_SCANNER_UNAVAILABLE",
      reason: String(error?.message || "AI_MARKET_SCANNER_UNAVAILABLE").slice(0, 220),
    });
  }
}

export function registerAiMarketScanner(app, { requireUser, pool, broker, rateLimit }) {
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.AI_SCANNER_MAX_REQUESTS_PER_MINUTE || 6),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { ok: false, error: "AI scanner rate limit reached. Wait a moment and retry." },
  });

  app.get("/api/ai/market-scanner/status", async (req, res) => {
    const user = await requireUser(pool, req, res);
    if (!user) return;
    const apiKey = String(process.env.XAI_API_KEY || "").trim();
    let brokerConnected = false;
    let brokerName = null;
    try {
      const mapping = await broker.getMapping(user.id);
      brokerConnected = Boolean(mapping);
      brokerName = mapping?.provider || null;
    } catch {}
    return res.json({
      ok: true,
      scanner: "KINGBOT AI MARKET SCANNER",
      aiReady: Boolean(apiKey),
      provider: apiKey ? "xai" : "none",
      model: apiKey ? String(process.env.XAI_MODEL || "grok-4.7") : null,
      brokerConnected,
      broker: brokerName,
      defaultSymbols: DEFAULT_SYMBOLS,
    });
  });

  const scanHandler = async (req, res) => {
    await runMarketScan({ requireUser, pool, broker, req, res });
  };

  app.get("/api/ai/market-scanner", limiter, scanHandler);
  app.post("/api/ai/market-scanner", limiter, scanHandler);
  app.get("/api/market-scanner", limiter, scanHandler);
  app.post("/api/market-scanner", limiter, scanHandler);
  app.get("/api/ai/scan", limiter, scanHandler);
  app.post("/api/ai/scan", limiter, scanHandler);
}
