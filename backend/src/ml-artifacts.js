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
  `);
}

export function registerMlArtifacts(app, { pool }) {
  const rawArtifactBody = express.raw({
    type: "application/octet-stream",
    limit: MAX_ARTIFACT_BYTES
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
          modelKey: row.artifact_key,
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
    const artifact = req.body;
    const suppliedDigest = String(req.get("x-kingbot-artifact-sha256") || "").toLowerCase();

    if (!["champion", "challenger"].includes(kind) ||
        !BOT_IDS.has(strategy) ||
        !TIMEFRAMES.has(timeframe)) {
      return res.status(400).json({ ok: false, error: "ML_ARTIFACT_KEY_INVALID" });
    }
    if (!Buffer.isBuffer(artifact) || artifact.length < 1 || artifact.length > MAX_ARTIFACT_BYTES) {
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
        bytes: artifact.length,
        sha256: actualDigest
      });
    } catch (error) {
      console.error("[KINGBOT ML ARTIFACTS] write failed:", error?.message || error);
      return res.status(503).json({ ok: false, error: "ML_ARTIFACT_WRITE_FAILED" });
    }
  });
}
