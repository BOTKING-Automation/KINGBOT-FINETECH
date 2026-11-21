import crypto from "node:crypto";
import express from "express";

const SCHEMA = "kingbot_private";
const TABLE = "ml_model_artifacts";
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const BOT_IDS = new Set(["strategic", "flipper", "breakout", "smc-pro", "ladder-flip"]);
const TIMEFRAMES = new Set(["1m", "5m", "15m", "1h", "4h"]);

function isAuthorized(req) {
  const expected = String(process.env.KINGBOT_ML_SIGNAL_SECRET || "");
  const provided = String(req.get("x-kingbot-ml-secret") || "");
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authFailure(res) {
  if (!String(process.env.KINGBOT_ML_SIGNAL_SECRET || "")) {
    return res.status(503).json({ ok: false, error: "ML_ARTIFACT_AUTH_NOT_CONFIGURED" });
  }
  return res.status(401).json({ ok: false, error: "ML_SERVICE_UNAUTHORIZED" });
}


const FEEDBACK_TIMEFRAMES = new Set(["1m", "5m", "15m", "1h", "4h"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeMlFeedbackPayload(body, now = Date.now()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("ML_FEEDBACK_PAYLOAD_INVALID");
  }
  const decisionId = String(body.decisionId || "").trim().toLowerCase();
  const strategy = String(body.strategy || body.botId || "").trim().toLowerCase();
  const symbol = String(body.symbol || "").trim().toUpperCase();
  const timeframe = String(body.timeframe || "5m").trim().toLowerCase();
  const direction = String(body.direction || "").trim().toUpperCase();
  const outcome = String(body.outcome || "").trim().toUpperCase();
  if (!UUID_RE.test(decisionId)) throw new Error("ML_FEEDBACK_DECISION_ID_INVALID");
  if (!BOT_IDS.has(strategy)) throw new Error("ML_FEEDBACK_STRATEGY_INVALID");
  if (!/^[A-Z0-9._-]{1,32}$/.test(symbol)) throw new Error("ML_FEEDBACK_SYMBOL_INVALID");
  if (!FEEDBACK_TIMEFRAMES.has(timeframe)) throw new Error("ML_FEEDBACK_TIMEFRAME_INVALID");
  if (!["BUY", "SELL"].includes(direction)) throw new Error("ML_FEEDBACK_DIRECTION_INVALID");
  if (!["WIN", "LOSS", "BREAKEVEN", "INVALIDATED"].includes(outcome)) {
    throw new Error("ML_FEEDBACK_OUTCOME_INVALID");
  }

  const features = body.features;
  if (!Array.isArray(features) || features.length !== 28 ||
      !features.every(value => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("ML_FEEDBACK_FEATURES_INVALID");
  }
  const marketAsOfSeconds = Number(body.marketAsOf);
  if (!Number.isFinite(marketAsOfSeconds) || marketAsOfSeconds <= 0) {
    throw new Error("ML_FEEDBACK_MARKET_TIMESTAMP_REQUIRED");
  }
  const marketAsOf = new Date(marketAsOfSeconds > 1e12 ? marketAsOfSeconds : marketAsOfSeconds * 1000);
  const settledAt = new Date(body.settledAt);
  if (!Number.isFinite(marketAsOf.getTime()) || !Number.isFinite(settledAt.getTime())) {
    throw new Error("ML_FEEDBACK_SETTLEMENT_TIMESTAMP_REQUIRED");
  }
  if (marketAsOf.getTime() > now + 60_000 || settledAt.getTime() > now + 60_000 ||
      settledAt.getTime() <= marketAsOf.getTime()) {
    throw new Error("ML_FEEDBACK_TIMESTAMP_ORDER_INVALID");
  }

  if (body.pnl == null || body.rMultiple == null) {
    throw new Error("ML_FEEDBACK_SETTLEMENT_METRICS_INVALID");
  }
  const pnl = Number(body.pnl);
  const rMultiple = Number(body.rMultiple);
  if (!Number.isFinite(pnl) || !Number.isFinite(rMultiple)) {
    throw new Error("ML_FEEDBACK_SETTLEMENT_METRICS_INVALID");
  }
  if ((outcome === "WIN" && pnl <= 0) ||
      ((outcome === "LOSS" || outcome === "INVALIDATED") && pnl >= 0) ||
      (outcome === "BREAKEVEN" && pnl !== 0)) {
    throw new Error("ML_FEEDBACK_OUTCOME_PNL_MISMATCH");
  }

  const label = outcome === "BREAKEVEN"
    ? 0
    : ((direction === "BUY") === (outcome === "WIN") ? 1 : -1);
  const normalized = {
    decisionId,
    strategy,
    symbol,
    timeframe,
    direction,
    outcome,
    label,
    features: features.map(value => Number(value)),
    marketAsOf: marketAsOf.toISOString(),
    settledAt: settledAt.toISOString(),
    pnl,
    rMultiple
  };
  const payloadHash = crypto.createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  return { ...normalized, payloadHash };
}

function toArtifactBuffer(value) {
  return Buffer.isBuffer(value) ? Buffer.from(value) : null;
}

export async function ensureMlArtifactsSchema(pool) {
  if (!pool) throw new Error("ML_ARTIFACT_DATABASE_UNAVAILABLE");
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS ${SCHEMA};
    REVOKE ALL ON SCHEMA ${SCHEMA} FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.${TABLE} (
      artifact_key text PRIMARY KEY,
      kind text NOT NULL CHECK (kind IN ('champion', 'challenger')),
      strategy text NOT NULL,
      timeframe text NOT NULL,
      artifact bytea NOT NULL,
      sha256 char(64) NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE ${SCHEMA}.${TABLE} ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE ${SCHEMA}.${TABLE} FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.ml_trade_feedback (
      decision_id uuid PRIMARY KEY,
      strategy text NOT NULL CHECK (strategy IN ('strategic','flipper','breakout','smc-pro','ladder-flip')),
      symbol text NOT NULL,
      timeframe text NOT NULL CHECK (timeframe IN ('1m','5m','15m','1h','4h')),
      direction text NOT NULL CHECK (direction IN ('BUY','SELL')),
      outcome text NOT NULL CHECK (outcome IN ('WIN','LOSS','BREAKEVEN','INVALIDATED')),
      label smallint NOT NULL CHECK (label IN (-1,0,1)),
      features jsonb NOT NULL CHECK (jsonb_typeof(features) = 'array'),
      market_as_of timestamptz NOT NULL,
      settled_at timestamptz NOT NULL,
      pnl numeric NOT NULL,
      r_multiple numeric NOT NULL,
      payload_hash char(64) NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      CHECK (settled_at > market_as_of),
      CHECK (
        (outcome = 'WIN' AND pnl > 0 AND label = CASE WHEN direction = 'BUY' THEN 1 ELSE -1 END) OR
        (outcome IN ('LOSS','INVALIDATED') AND pnl < 0 AND label = CASE WHEN direction = 'BUY' THEN -1 ELSE 1 END) OR
        (outcome = 'BREAKEVEN' AND pnl = 0 AND label = 0)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_kb_ml_feedback_training
      ON ${SCHEMA}.ml_trade_feedback(strategy,timeframe,market_as_of,settled_at);
    ALTER TABLE ${SCHEMA}.ml_trade_feedback ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE ${SCHEMA}.ml_trade_feedback FROM PUBLIC;

    CREATE TABLE IF NOT EXISTS ${SCHEMA}.ml_feedback_outbox (
      decision_id uuid PRIMARY KEY,
      payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','DELIVERED','FAILED')),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_kb_ml_feedback_outbox_due
      ON ${SCHEMA}.ml_feedback_outbox(status,next_attempt_at,created_at);
    ALTER TABLE ${SCHEMA}.ml_feedback_outbox ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE ${SCHEMA}.ml_feedback_outbox FROM PUBLIC;
  `);
}

export function registerMlArtifacts(app, { pool }) {
  const rawArtifactBody = express.raw({
    type: "application/octet-stream",
    limit: MAX_ARTIFACT_BYTES
  });


  app.get("/api/ml-artifacts/feedback", async (req, res) => {
    if (!isAuthorized(req)) return authFailure(res);
    if (!pool) return res.status(503).json({ ok: false, error: "ML_ARTIFACT_DATABASE_UNAVAILABLE" });
    try {
      const result = await pool.query(
        `SELECT decision_id,strategy,symbol,timeframe,direction,outcome,label,features,
                EXTRACT(EPOCH FROM market_as_of) AS market_as_of,
                EXTRACT(EPOCH FROM settled_at) AS settled_at,
                pnl,r_multiple,EXTRACT(EPOCH FROM received_at) AS received_at
           FROM ${SCHEMA}.ml_trade_feedback
          ORDER BY received_at DESC
          LIMIT 10000`
      );
      res.setHeader("Cache-Control", "no-store");
      return res.json({
        ok: true,
        count: result.rows.length,
        items: result.rows.map(row => ({
          decisionId: row.decision_id,
          strategy: row.strategy,
          symbol: row.symbol,
          timeframe: row.timeframe,
          direction: row.direction,
          outcome: row.outcome,
          label: Number(row.label),
          features: row.features,
          marketAsOf: Number(row.market_as_of),
          settledAt: Number(row.settled_at),
          pnl: Number(row.pnl),
          rMultiple: Number(row.r_multiple),
          receivedAt: Number(row.received_at)
        }))
      });
    } catch (error) {
      console.error("[KINGBOT ML FEEDBACK] read failed:", error?.message || error);
      return res.status(503).json({ ok: false, error: "ML_FEEDBACK_READ_FAILED" });
    }
  });

  app.post("/api/ml-artifacts/feedback", async (req, res) => {
    if (!isAuthorized(req)) return authFailure(res);
    if (!pool) return res.status(503).json({ ok: false, error: "ML_ARTIFACT_DATABASE_UNAVAILABLE" });
    let feedback;
    try {
      feedback = normalizeMlFeedbackPayload(req.body);
    } catch (error) {
      return res.status(422).json({ ok: false, error: String(error?.message || "ML_FEEDBACK_INVALID").slice(0, 100) });
    }
    try {
      const inserted = await pool.query(
        `INSERT INTO ${SCHEMA}.ml_trade_feedback
           (decision_id,strategy,symbol,timeframe,direction,outcome,label,features,
            market_as_of,settled_at,pnl,r_multiple,payload_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)
         ON CONFLICT(decision_id) DO NOTHING
         RETURNING decision_id`,
        [
          feedback.decisionId, feedback.strategy, feedback.symbol, feedback.timeframe,
          feedback.direction, feedback.outcome, feedback.label, JSON.stringify(feedback.features),
          feedback.marketAsOf, feedback.settledAt, feedback.pnl, feedback.rMultiple, feedback.payloadHash
        ]
      );
      if (inserted.rowCount) {
        const count = await pool.query(`SELECT COUNT(*)::int AS count FROM ${SCHEMA}.ml_trade_feedback`);
        return res.status(201).json({ ok: true, created: true, duplicate: false, feedbackRows: count.rows[0].count });
      }
      const existing = await pool.query(
        `SELECT payload_hash FROM ${SCHEMA}.ml_trade_feedback WHERE decision_id=$1`,
        [feedback.decisionId]
      );
      if (!existing.rowCount || String(existing.rows[0].payload_hash).trim() !== feedback.payloadHash) {
        return res.status(409).json({ ok: false, error: "ML_FEEDBACK_DECISION_CONFLICT" });
      }
      const count = await pool.query(`SELECT COUNT(*)::int AS count FROM ${SCHEMA}.ml_trade_feedback`);
      return res.status(200).json({ ok: true, created: false, duplicate: true, feedbackRows: count.rows[0].count });
    } catch (error) {
      console.error("[KINGBOT ML FEEDBACK] write failed:", error?.message || error);
      return res.status(503).json({ ok: false, error: "ML_FEEDBACK_WRITE_FAILED" });
    }
  });

  app.get("/api/ml-artifacts", async (req, res) => {
    if (!isAuthorized(req)) return authFailure(res);
    if (!pool) return res.status(503).json({ ok: false, error: "ML_ARTIFACT_DATABASE_UNAVAILABLE" });

    try {
      const result = await pool.query(
        `SELECT artifact_key, kind, strategy, timeframe,
                encode(artifact, 'base64') AS artifact_base64,
                sha256, updated_at
           FROM ${SCHEMA}.${TABLE}
          ORDER BY kind, strategy, timeframe
          LIMIT 100`
      );
      res.setHeader("Cache-Control", "no-store");
      return res.json({
        ok: true,
        count: result.rows.length,
        items: result.rows.map(row => ({
          modelKey: `${row.strategy}:${row.timeframe}`,
          kind: row.kind,
          strategy: row.strategy,
          timeframe: row.timeframe,
          artifactBase64: row.artifact_base64,
          sha256: String(row.sha256 || "").trim(),
          updatedAt: row.updated_at
        }))
      });
    } catch (error) {
      console.error("[KINGBOT ML ARTIFACTS] read failed:", error?.message || error);
      return res.status(503).json({ ok: false, error: "ML_ARTIFACT_READ_FAILED" });
    }
  });

  app.put("/api/ml-artifacts/:kind/:strategy/:timeframe", rawArtifactBody, async (req, res) => {
    if (!isAuthorized(req)) return authFailure(res);
    if (!pool) return res.status(503).json({ ok: false, error: "ML_ARTIFACT_DATABASE_UNAVAILABLE" });

    const kind = String(req.params?.kind || "").toLowerCase();
    const strategy = String(req.params?.strategy || "").toLowerCase();
    const timeframe = String(req.params?.timeframe || "").toLowerCase();
    const artifact = toArtifactBuffer(req.body);
    const artifactBytes = artifact ? artifact.byteLength : 0;
    const suppliedDigest = String(req.get("x-kingbot-artifact-sha256") || "").toLowerCase();

    if (!["champion", "challenger"].includes(kind) ||
        !BOT_IDS.has(strategy) ||
        !TIMEFRAMES.has(timeframe)) {
      return res.status(400).json({ ok: false, error: "ML_ARTIFACT_KEY_INVALID" });
    }
    if (!artifact || artifactBytes < 1 || artifactBytes > MAX_ARTIFACT_BYTES) {
      return res.status(413).json({ ok: false, error: "ML_ARTIFACT_SIZE_INVALID" });
    }
    if (!/^[a-f0-9]{64}$/.test(suppliedDigest)) {
      return res.status(400).json({ ok: false, error: "ML_ARTIFACT_DIGEST_REQUIRED" });
    }

    const actualDigest = crypto.createHash("sha256").update(artifact).digest("hex");
    const supplied = Buffer.from(suppliedDigest, "hex");
    const actual = Buffer.from(actualDigest, "hex");
    if (!crypto.timingSafeEqual(supplied, actual)) {
      return res.status(400).json({ ok: false, error: "ML_ARTIFACT_DIGEST_MISMATCH" });
    }

    const artifactKey = `${kind}:${strategy}:${timeframe}`;
    try {
      await pool.query(
        `INSERT INTO ${SCHEMA}.${TABLE}
           (artifact_key, kind, strategy, timeframe, artifact, sha256, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (artifact_key) DO UPDATE SET
           artifact = EXCLUDED.artifact,
           sha256 = EXCLUDED.sha256,
           updated_at = now()`,
        [artifactKey, kind, strategy, timeframe, artifact, actualDigest]
      );
      return res.status(200).json({
        ok: true,
        modelKey: artifactKey,
        bytes: artifactBytes,
        sha256: actualDigest
      });
    } catch (error) {
      console.error("[KINGBOT ML ARTIFACTS] write failed:", error?.message || error);
      return res.status(503).json({ ok: false, error: "ML_ARTIFACT_WRITE_FAILED" });
    }
  });
}
