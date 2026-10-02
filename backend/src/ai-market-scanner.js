import "dotenv/config";

const DEFAULT_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD"];
const DEFAULT_TF = "5m";

function cleanSymbols(value) {
  const input = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(input.map(s => String(s || "").trim().toUpperCase()).filter(s => /^[A-Z0-9._:-]{3,40}$/.test(s)))].slice(0, 12);
}
function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function cleanTimeframe(value) {
  const v = String(value || DEFAULT_TF).trim().toLowerCase();
  return /^(1m|3m|5m|15m|30m|1h|2h|4h|1d|1w)$/.test(v) ? v : DEFAULT_TF;
}
function bool(v) {
  if (typeof v === "boolean") return v;
  return ["true","1","yes","bullish","confirmed"].includes(String(v || "").toLowerCase());
}

function technicalEngine(snapshot) {
  if (!snapshot) return {
    signal: "DATA_INSUFFICIENT",
    bias: "DATA_INSUFFICIENT",
    score: 0,
    waitFor: "TradingView snapshot is not available yet.",
    reason: "KINGBOT requires a verified TradingView market snapshot before technical analysis.",
    technicalAnalysis: [],
    invalidation: "No valid market data.",
  };

  const price = finite(snapshot.close ?? snapshot.price);
  const ema20 = finite(snapshot.ema20);
  const ema50 = finite(snapshot.ema50);
  const rsi = finite(snapshot.rsi14 ?? snapshot.rsi);
  const macd = finite(snapshot.macd);
  const macdSignal = finite(snapshot.macdSignal ?? snapshot.macd_signal);
  const atr = finite(snapshot.atr14 ?? snapshot.atr);
  const support = finite(snapshot.support);
  const resistance = finite(snapshot.resistance);
  const trend = String(snapshot.trend || "").toUpperCase();
  const bos = String(snapshot.bos || "").toUpperCase();
  const choch = String(snapshot.choch || "").toUpperCase();
  const liquidity = String(snapshot.liquiditySweep || snapshot.liquidity_sweep || "").toUpperCase();
  const fvg = bool(snapshot.fvg);
  const longEvidence = [
    trend === "BULLISH", bos === "BULLISH", choch === "BULLISH", liquidity === "BULLISH",
    ema20 !== null && ema50 !== null && ema20 > ema50,
    rsi !== null && rsi >= 50 && rsi <= 70,
    macd !== null && macdSignal !== null && macd > macdSignal,
    fvg
  ];
  const shortEvidence = [
    trend === "BEARISH", bos === "BEARISH", choch === "BEARISH", liquidity === "BEARISH",
    ema20 !== null && ema50 !== null && ema20 < ema50,
    rsi !== null && rsi < 50 && rsi >= 30,
    macd !== null && macdSignal !== null && macd < macdSignal,
    fvg
  ];
  const longScore = longEvidence.filter(Boolean).length;
  const shortScore = shortEvidence.filter(Boolean).length;
  const bias = longScore === shortScore ? "NEUTRAL" : longScore > shortScore ? "BULLISH" : "BEARISH";
  const score = Math.round(Math.max(longScore, shortScore) / 8 * 100);

  const analysis = [];
  if (trend) analysis.push(`Trend: ${trend}`);
  if (bos) analysis.push(`BOS: ${bos}`);
  if (choch) analysis.push(`CHOCH: ${choch}`);
  if (liquidity) analysis.push(`Liquidity sweep: ${liquidity}`);
  if (ema20 !== null && ema50 !== null) analysis.push(`EMA20/EMA50: ${ema20 > ema50 ? "bullish alignment" : "bearish alignment"}`);
  if (rsi !== null) analysis.push(`RSI(14): ${rsi.toFixed(2)}`);
  if (macd !== null && macdSignal !== null) analysis.push(`MACD: ${macd > macdSignal ? "bullish" : "bearish"}`);
  if (fvg) analysis.push("FVG: detected");

  let signal = "WAIT";
  let waitFor = bias === "BULLISH"
    ? "Wait for bullish confirmation/close above the trigger level."
    : bias === "BEARISH"
      ? "Wait for bearish confirmation/close below the trigger level."
      : "Wait for structure and momentum to align.";
  if (score >= 75 && bias !== "NEUTRAL") signal = "ENTRY_CONFIRMING";
  if (score < 50) signal = "NO_TRADE";

  let entry = price;
  let sl = null;
  let tp1 = null;
  let tp2 = null;
  if (price !== null && atr !== null) {
    const risk = atr * 1.25;
    if (bias === "BULLISH") {
      sl = price - risk; tp1 = price + risk * 1.5; tp2 = price + risk * 2.5;
    } else if (bias === "BEARISH") {
      sl = price + risk; tp1 = price - risk * 1.5; tp2 = price - risk * 2.5;
    }
  }
  if (support !== null && resistance !== null && price !== null) {
    if (bias === "BULLISH" && price <= support) waitFor = "Wait for reclaim/confirmation above support.";
    if (bias === "BEARISH" && price >= resistance) waitFor = "Wait for rejection/confirmation below resistance.";
  }

  return {
    signal, bias, score, entry, sl, tp1, tp2, waitFor,
    reason: analysis.length ? analysis.join(" · ") : "Insufficient technical fields.",
    technicalAnalysis: analysis,
    invalidation: bias === "BULLISH"
      ? "Invalidate if price closes below the identified bullish structure/support."
      : bias === "BEARISH"
        ? "Invalidate if price closes above the identified bearish structure/resistance."
        : "Invalidate when a directional structure is established against the setup."
  };
}

async function ensureScannerSchema(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kingbot_tradingview_snapshots (
      id BIGSERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      bar_time TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(symbol, timeframe, bar_time)
    );
    CREATE INDEX IF NOT EXISTS idx_kingbot_tv_latest
      ON kingbot_tradingview_snapshots(symbol, timeframe, bar_time DESC);
  `);
}

async function saveTradingViewSnapshot(pool, body) {
  const symbol = String(body?.symbol || body?.ticker || "").trim().toUpperCase();
  const timeframe = cleanTimeframe(body?.timeframe || body?.interval);
  const barTime = new Date(body?.barTime || body?.time || Date.now());
  if (!symbol || !/^[A-Z0-9._:-]{3,40}$/.test(symbol) || Number.isNaN(barTime.getTime())) {
    throw new Error("TRADINGVIEW_PAYLOAD_INVALID");
  }
  await pool.query(
    `INSERT INTO kingbot_tradingview_snapshots(symbol,timeframe,bar_time,payload)
     VALUES($1,$2,$3,$4::jsonb)
     ON CONFLICT(symbol,timeframe,bar_time) DO UPDATE SET payload=EXCLUDED.payload,received_at=NOW()`,
    [symbol, timeframe, barTime.toISOString(), JSON.stringify(body)]
  );
  return { symbol, timeframe, barTime: barTime.toISOString() };
}

async function latestTradingView(pool, symbols, timeframe) {
  if (!pool) return [];
  const q = await pool.query(
    `SELECT DISTINCT ON (symbol) symbol,timeframe,bar_time,payload,received_at
       FROM kingbot_tradingview_snapshots
      WHERE symbol = ANY($1) AND timeframe=$2
      ORDER BY symbol,bar_time DESC`,
    [symbols, timeframe]
  );
  return q.rows.map(r => ({ ...r.payload, symbol: r.symbol, timeframe: r.timeframe, barTime: r.bar_time, receivedAt: r.received_at }));
}

async function askGrok({ technical, quotes, timeframe }) {
  const apiKey = String(process.env.XAI_API_KEY || "").trim();
  if (!apiKey) return { provider: "none", model: null, analysis: null };

  const model = String(process.env.XAI_MODEL || "grok-4.7").trim();
  const baseUrl = String(process.env.XAI_API_BASE_URL || "https://api.x.ai/v1").trim().replace(/\/$/, "");
  const prompt = [
    "You are KINGBOT AI, a trading-intelligence explanation layer.",
    "The deterministic KINGBOT technical engine calculated the supplied fields from a verified TradingView snapshot.",
    "Do not invent market data. Do not override the deterministic signal. Explain what is present, what is missing, the entry condition, what to wait for, and invalidation.",
    "Return VALID JSON only with keys: market_regime, ranked_symbols, risk_flags, summary.",
    "Each ranked_symbols item must contain: symbol,bias,signal,score,entry,sl,tp1,tp2,waitFor,reason,technicalAnalysis,invalidation.",
    "Never promise profit or certainty.",
    "TIMEFRAME: " + timeframe,
    "TECHNICAL ENGINE OUTPUT: " + JSON.stringify(technical),
    "VERIFIED QUOTES: " + JSON.stringify(quotes)
  ].join("\n");

  const response = await fetch(baseUrl + "/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: "KINGBOT AI market intelligence. Output JSON only." },
        { role: "user", content: prompt }
      ],
      max_output_tokens: 1600
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.message || "XAI_MARKET_SCAN_FAILED");
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
      const price = finite(raw.price ?? (bid !== null && ask !== null ? (bid + ask) / 2 : null));
      return { symbol, bid, ask, price, spread: bid !== null && ask !== null ? ask - bid : null, time: raw.time || raw.timestamp || null, available: price !== null || (bid !== null && ask !== null) };
    } catch (error) {
      return { symbol, available: false, error: String(error?.message || "QUOTE_UNAVAILABLE").slice(0, 120) };
    }
  }));
}

async function runMarketScan({ requireUser, pool, broker, req, res }) {
  const user = await requireUser(pool, req, res);
  if (!user) return null;
  const symbols = cleanSymbols(req.query?.symbols || req.body?.symbols).length ? cleanSymbols(req.query?.symbols || req.body?.symbols) : DEFAULT_SYMBOLS;
  const timeframe = cleanTimeframe(req.query?.timeframe || req.body?.timeframe);

  try {
    const mapping = await broker.getMapping(user.id);
    if (!mapping) return res.status(503).json({ ok:false, error:"BROKER_NOT_CONNECTED", code:"BROKER_NOT_CONNECTED", scanner:"KINGBOT AI MARKET SCANNER", message:"Connect a broker account before running the market scanner." });

    const [quotes, tv] = await Promise.all([collectQuotes(broker, user.id, symbols), latestTradingView(pool, symbols, timeframe)]);
    const technical = tv.map(snapshot => ({ symbol:snapshot.symbol, ...technicalEngine(snapshot), timeframe, source:"TradingView", barTime:snapshot.barTime }));
    const tvMap = Object.fromEntries(tv.map(x => [x.symbol, x]));
    for (const q of quotes) {
      if (!technical.some(x => x.symbol === q.symbol)) technical.push({ symbol:q.symbol, ...technicalEngine(null), timeframe, source:"TradingView", quote:q });
    }

    let ai = null;
    try { ai = await askGrok({ technical, quotes, timeframe }); }
    catch (error) { ai = { provider:"none", model:null, analysis:null, aiError:String(error?.message || "AI_FAILED").slice(0,200) }; }

    return res.json({
      ok:true, scanner:"KINGBOT AI MARKET SCANNER", provider:ai.provider, model:ai.model,
      executionAuthority:"NONE", source:"TradingView webhook + broker quote",
      symbols, timeframe, quotes, technical, tradingViewSnapshots:tvMap,
      analysis:ai.analysis || JSON.stringify({
        market_regime: technical.some(x=>x.bias==="BULLISH") ? "BULLISH" : technical.some(x=>x.bias==="BEARISH") ? "BEARISH" : "MIXED",
        ranked_symbols: technical.map(x=>({symbol:x.symbol,...x})),
        risk_flags:["AI explanation unavailable; deterministic KINGBOT technical engine shown."],
        summary:"KINGBOT technical engine analyzed the latest verified TradingView snapshots."
      }),
      aiError:ai.aiError || null, generatedAt:new Date().toISOString(), quoteCount:quotes.filter(q=>q.available).length,
      tradingViewCount:tv.length
    });
  } catch (error) {
    console.error("[KINGBOT MARKET SCANNER]", error?.message || error);
    return res.status(502).json({ ok:false, error:"AI_MARKET_SCANNER_UNAVAILABLE", code:"AI_MARKET_SCANNER_UNAVAILABLE", reason:String(error?.message || "AI_MARKET_SCANNER_UNAVAILABLE").slice(0,220) });
  }
}

export function registerAiMarketScanner(app, { requireUser, pool, broker, rateLimit }) {
  void ensureScannerSchema(pool).catch(e => console.error("[KINGBOT TV SCHEMA]", e?.message || e));

  const limiter = rateLimit({
    windowMs:60*1000, limit:Number(process.env.AI_SCANNER_MAX_REQUESTS_PER_MINUTE || 6),
    standardHeaders:"draft-8", legacyHeaders:false,
    message:{ok:false,error:"AI scanner rate limit reached. Wait a moment and retry."}
  });

  app.post("/api/webhooks/tradingview", async (req,res) => {
    try {
      const secret = String(process.env.TRADINGVIEW_WEBHOOK_SECRET || "").trim();
      if (!secret || String(req.headers["x-kingbot-webhook-secret"] || req.query?.secret || req.body?.secret || "") !== secret) {
        return res.status(401).json({ok:false,error:"TRADINGVIEW_WEBHOOK_UNAUTHORIZED"});
      }
      const saved = await saveTradingViewSnapshot(pool, req.body || {});
      return res.status(202).json({ok:true,source:"TradingView",...saved});
    } catch (error) {
      return res.status(400).json({ok:false,error:String(error?.message || "TRADINGVIEW_WEBHOOK_FAILED")});
    }
  });

  app.get("/api/ai/market-scanner/status", async (req,res) => {
    const user = await requireUser(pool, req, res); if (!user) return;
    const apiKey = String(process.env.XAI_API_KEY || "").trim();
    let brokerConnected=false, brokerName=null;
    try { const mapping=await broker.getMapping(user.id); brokerConnected=Boolean(mapping); brokerName=mapping?.provider || null; } catch {}
    let tvCount=0;
    try { const q=await pool.query("SELECT COUNT(*)::int AS count FROM kingbot_tradingview_snapshots WHERE received_at > NOW() - INTERVAL '10 minutes'"); tvCount=q.rows[0]?.count || 0; } catch {}
    return res.json({
      ok:true, scanner:"KINGBOT AI MARKET SCANNER", aiReady:Boolean(apiKey), provider:apiKey?"xai":"none",
      model:apiKey?String(process.env.XAI_MODEL || "grok-4.7"):null, brokerConnected, broker:brokerName,
      tradingViewConnected:tvCount>0, tradingViewSnapshotsLast10m:tvCount, webhookConfigured:Boolean(process.env.TRADINGVIEW_WEBHOOK_SECRET),
      defaultSymbols:DEFAULT_SYMBOLS
    });
  });

  const scanHandler=async(req,res)=>{ await runMarketScan({requireUser,pool,broker,req,res}); };
  app.get("/api/ai/market-scanner",limiter,scanHandler);
  app.post("/api/ai/market-scanner",limiter,scanHandler);
  app.get("/api/market-scanner",limiter,scanHandler);
  app.post("/api/market-scanner",limiter,scanHandler);
  app.get("/api/ai/scan",limiter,scanHandler);
  app.post("/api/ai/scan",limiter,scanHandler);
}
