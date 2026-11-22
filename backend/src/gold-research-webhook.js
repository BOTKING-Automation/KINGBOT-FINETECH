import crypto from "node:crypto";
import { Router } from "express";

const ALLOWED_TIMEFRAMES = new Set([
  "1", "1m", "5", "5m", "15", "15m", "60", "1h", "240", "4h", "D", "1D"
]);
const EVENT_ID_RE = /^[A-Za-z0-9_.:-]{8,160}$/;
const SOURCE_SYMBOL_RE = /^[A-Z0-9._:-]{3,40}$/;

function cleanText(value, max = 120) {
  return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

function parsePositive(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "INVALID_" + field.toUpperCase() };
  return { ok: true, value: n };
}

function parseOptionalSpread(value) {
  if (value === null || value === undefined || value === "") return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: "INVALID_SPREAD" };
  return { ok: true, value: n };
}

function parseUtc(value, field) {
  const raw = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    return { ok: false, error: "INVALID_" + field.toUpperCase() };
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { ok: false, error: "INVALID_" + field.toUpperCase() };
  return { ok: true, ms, value: new Date(ms).toISOString() };
}

export function normalizeGoldResearchEvent(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "JSON_OBJECT_REQUIRED" };
  }

  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const configuredMaxAge = Number(options.maxAgeMs ?? process.env.KINGBOT_GOLD_RESEARCH_MAX_EVENT_AGE_MS ?? 900000);
  const maxAgeMs = Number.isFinite(configuredMaxAge) && configuredMaxAge >= 60000 ? configuredMaxAge : 900000;

  const schemaVersion = cleanText(input.schema_version, 12);
  const eventType = cleanText(input.event_type, 40);
  const eventId = cleanText(input.event_id, 160);
  const strategy = cleanText(input.strategy, 60);
  const strategyVersion = cleanText(input.strategy_version, 80);
  const symbol = cleanText(input.symbol, 20).toUpperCase();
  const sourceSymbol = cleanText(input.source_symbol, 40).toUpperCase();
  const timeframe = cleanText(input.timeframe, 12);
  const side = cleanText(input.side, 12).toUpperCase();
  const setupState = cleanText(input.setup_state, 48);
  const source = cleanText(input.source || "tradingview_alert", 40);

  if (schemaVersion !== "1.0") return { ok: false, error: "UNSUPPORTED_SCHEMA_VERSION" };
  if (eventType !== "candidate_setup") return { ok: false, error: "UNSUPPORTED_EVENT_TYPE" };
  if (!EVENT_ID_RE.test(eventId)) return { ok: false, error: "INVALID_EVENT_ID" };
  if (strategy !== "KINGBOT_TECH_PRO") return { ok: false, error: "INVALID_STRATEGY" };
  if (!strategyVersion) return { ok: false, error: "STRATEGY_VERSION_REQUIRED" };
  if (symbol !== "XAUUSD") return { ok: false, error: "CANONICAL_SYMBOL_MUST_BE_XAUUSD" };
  if (!SOURCE_SYMBOL_RE.test(sourceSymbol)) return { ok: false, error: "INVALID_SOURCE_SYMBOL" };
  if (!ALLOWED_TIMEFRAMES.has(timeframe)) return { ok: false, error: "UNSUPPORTED_TIMEFRAME" };
  if (!["BUY", "SELL"].includes(side)) return { ok: false, error: "INVALID_SIDE" };
  if (!setupState) return { ok: false, error: "SETUP_STATE_REQUIRED" };
  if (source !== "tradingview_alert") return { ok: false, error: "INVALID_EVENT_SOURCE" };

  const barTime = parseUtc(input.bar_time_utc, "bar_time_utc");
  if (!barTime.ok) return barTime;
  const eventTime = parseUtc(input.event_time_utc, "event_time_utc");
  if (!eventTime.ok) return eventTime;
  if (eventTime.ms > nowMs + 120000) return { ok: false, error: "EVENT_TIME_IN_FUTURE" };
  if (nowMs - eventTime.ms > maxAgeMs) return { ok: false, error: "STALE_EVENT" };

  const numeric = {};
  for (const field of ["bar_close", "atr", "entry", "stop_loss", "tp1", "tp2", "tp3"]) {
    const parsed = parsePositive(input[field], field);
    if (!parsed.ok) return parsed;
    numeric[field] = parsed.value;
  }

  const spread = parseOptionalSpread(input.spread);
  if (!spread.ok) return spread;

  if (side === "BUY") {
    if (!(numeric.stop_loss < numeric.entry && numeric.entry < numeric.tp1 && numeric.tp1 < numeric.tp2 && numeric.tp2 < numeric.tp3)) {
      return { ok: false, error: "BUY_LEVEL_ORDER_INVALID" };
    }
  } else if (!(numeric.tp3 < numeric.tp2 && numeric.tp2 < numeric.tp1 && numeric.tp1 < numeric.entry && numeric.entry < numeric.stop_loss)) {
    return { ok: false, error: "SELL_LEVEL_ORDER_INVALID" };
  }

  let score = null;
  if (input.score !== null && input.score !== undefined && input.score !== "") {
    score = Number(input.score);
    if (!Number.isInteger(score) || score < 0 || score > 11) return { ok: false, error: "INVALID_SCORE" };
  }

  const rawReasons = input.reason_codes === undefined ? [] : input.reason_codes;
  if (!Array.isArray(rawReasons) || rawReasons.length > 20) return { ok: false, error: "INVALID_REASON_CODES" };
  const reasonCodes = rawReasons.map(x => cleanText(x, 64)).filter(Boolean);

  return {
    ok: true,
    event: {
      schema_version: schemaVersion,
      event_type: eventType,
      event_id: eventId,
      strategy,
      strategy_version: strategyVersion,
      symbol,
      source_symbol: sourceSymbol,
      timeframe,
      bar_time_utc: barTime.value,
      event_time_utc: eventTime.value,
      side,
      bar_close: numeric.bar_close,
      atr: numeric.atr,
      spread: spread.value,
      entry: numeric.entry,
      stop_loss: numeric.stop_loss,
      tp1: numeric.tp1,
      tp2: numeric.tp2,
      tp3: numeric.tp3,
      score,
      setup_state: setupState,
      reason_codes: reasonCodes,
      source
    }
  };
}

export function constantTimeTokenMatch(received, expected) {
  const a = Buffer.from(String(received ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function ensureGoldResearchSchema(pool) {
  if (!pool) return false;
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_gold_research_events (
    event_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    event_type TEXT NOT NULL,
    strategy TEXT NOT NULL,
    strategy_version TEXT NOT NULL,
    symbol TEXT NOT NULL CHECK (symbol = 'XAUUSD'),
    source_symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    bar_time_utc TIMESTAMPTZ NOT NULL,
    event_time_utc TIMESTAMPTZ NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
    bar_close NUMERIC(20,8) NOT NULL,
    atr NUMERIC(20,8) NOT NULL,
    spread NUMERIC(20,8),
    entry NUMERIC(20,8) NOT NULL,
    stop_loss NUMERIC(20,8) NOT NULL,
    tp1 NUMERIC(20,8) NOT NULL,
    tp2 NUMERIC(20,8) NOT NULL,
    tp3 NUMERIC(20,8) NOT NULL,
    score INTEGER,
    setup_state TEXT NOT NULL,
    reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
    source TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_gold_research_events_bar_idx ON kingbot_gold_research_events(symbol,timeframe,bar_time_utc DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_gold_research_events_strategy_idx ON kingbot_gold_research_events(strategy_version,event_time_utc DESC)");
  return true;
}

export function registerGoldResearchWebhook(app, { pool, rateLimit } = {}) {
  if (!app || typeof app.post !== "function") throw new TypeError("EXPRESS_APP_REQUIRED");
  if (typeof rateLimit !== "function") throw new TypeError("RATE_LIMIT_FACTORY_REQUIRED");

  const limiter = rateLimit({
    windowMs: 60000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false
  });

  void ensureGoldResearchSchema(pool).catch(error => {
    console.error("[KINGBOT GOLD RESEARCH SCHEMA]", error?.message || "SCHEMA_INIT_FAILED");
  });

  app.post("/api/research/gold/ingest/:token", limiter, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const expected = String(process.env.KINGBOT_GOLD_RESEARCH_WEBHOOK_SECRET || "").trim();
    const received = String(req.params?.token || "");
    if (expected.length < 32 || !constantTimeTokenMatch(received, expected)) {
      return res.status(expected ? 404 : 503).json({
        ok: false,
        error: expected ? "NOT_FOUND" : "GOLD_RESEARCH_WEBHOOK_NOT_CONFIGURED"
      });
    }
    if (!pool) return res.status(503).json({ ok: false, error: "GOLD_RESEARCH_DATABASE_UNAVAILABLE" });

    const normalized = normalizeGoldResearchEvent(req.body);
    if (!normalized.ok) return res.status(400).json({ ok: false, error: normalized.error });

    const event = normalized.event;
    try {
      const result = await pool.query(
        `INSERT INTO kingbot_gold_research_events(
          event_id,schema_version,event_type,strategy,strategy_version,symbol,source_symbol,timeframe,
          bar_time_utc,event_time_utc,side,bar_close,atr,spread,entry,stop_loss,tp1,tp2,tp3,score,
          setup_state,reason_codes,source,payload
        ) VALUES(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,$24::jsonb
        ) ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
        [
          event.event_id,event.schema_version,event.event_type,event.strategy,event.strategy_version,
          event.symbol,event.source_symbol,event.timeframe,event.bar_time_utc,event.event_time_utc,
          event.side,event.bar_close,event.atr,event.spread,event.entry,event.stop_loss,event.tp1,
          event.tp2,event.tp3,event.score,event.setup_state,JSON.stringify(event.reason_codes),
          event.source,JSON.stringify(event)
        ]
      );
      const duplicate = result.rowCount === 0;
      return res.status(duplicate ? 200 : 201).json({
        ok: true,
        accepted: !duplicate,
        duplicate,
        eventId: event.event_id,
        processing: "RESEARCH_ONLY",
        executionAuthority: "NONE"
      });
    } catch (error) {
      console.error("[KINGBOT GOLD RESEARCH INGEST]", error?.code || error?.name || "DATABASE_WRITE_FAILED");
      return res.status(503).json({ ok: false, error: "GOLD_RESEARCH_EVENT_STORE_UNAVAILABLE" });
    }
  });
}
