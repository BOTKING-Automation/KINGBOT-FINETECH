const toCount = value => Math.max(0, Math.trunc(Number(value) || 0));
const toNumberOrNull = value => {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const toIsoOrNull = value => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export async function loadAiLearningSnapshot(pool, {
  mlService = null,
  modelRegistry = null,
  now = new Date()
} = {}) {
  if (!pool) throw new Error("LEARNING_MONITOR_DATABASE_UNAVAILABLE");

  const [summaryResult, strategyResult, outboxResult, recentResult] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE outcome='WIN')::int AS wins,
        COUNT(*) FILTER (WHERE outcome='LOSS')::int AS losses,
        COUNT(*) FILTER (WHERE outcome='INVALIDATED')::int AS invalidated,
        COUNT(*) FILTER (WHERE outcome='BREAKEVEN')::int AS breakeven,
        COUNT(*) FILTER (WHERE received_at >= NOW()-INTERVAL '24 hours')::int AS last_24h,
        AVG(r_multiple) AS average_r,
        MAX(received_at) AS last_received_at,
        MAX(settled_at) AS last_settled_at
      FROM kingbot_private.ml_trade_feedback
    `),
    pool.query(`
      SELECT strategy,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE outcome='WIN')::int AS wins,
             COUNT(*) FILTER (WHERE outcome='LOSS')::int AS losses,
             COUNT(*) FILTER (WHERE outcome='INVALIDATED')::int AS invalidated,
             COUNT(*) FILTER (WHERE outcome='BREAKEVEN')::int AS breakeven,
             AVG(r_multiple) AS average_r,
             MAX(settled_at) AS last_settled_at
        FROM kingbot_private.ml_trade_feedback
       GROUP BY strategy
       ORDER BY COUNT(*) DESC, strategy ASC
    `),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='PENDING')::int AS pending,
        COUNT(*) FILTER (WHERE status='PROCESSING')::int AS processing,
        COUNT(*) FILTER (WHERE status='DELIVERED')::int AS delivered,
        COUNT(*) FILTER (WHERE status='FAILED')::int AS failed,
        MIN(created_at) FILTER (WHERE status='PENDING') AS oldest_pending_at
      FROM kingbot_private.ml_feedback_outbox
    `),
    pool.query(`
      SELECT strategy,symbol,direction,outcome,pnl,r_multiple,settled_at,received_at
        FROM kingbot_private.ml_trade_feedback
       ORDER BY received_at DESC
       LIMIT 12
    `)
  ]);

  const summary = summaryResult.rows?.[0] || {};
  const wins = toCount(summary.wins);
  const losses = toCount(summary.losses);
  const invalidated = toCount(summary.invalidated);
  const breakeven = toCount(summary.breakeven);
  const decisive = wins + losses + invalidated;
  const outbox = outboxResult.rows?.[0] || {};

  const models = Array.isArray(modelRegistry?.models)
    ? modelRegistry.models.slice(0, 50).map(item => ({
        key: String(item?.key || ""),
        strategy: String(item?.strategy || ""),
        timeframe: String(item?.timeframe || ""),
        symbols: Array.isArray(item?.symbols) ? item.symbols.map(String).slice(0, 20) : [],
        trainedAt: toIsoOrNull(item?.trainedAt),
        samples: toCount(item?.samples),
        trainSamples: toCount(item?.trainSamples),
        testSamples: toCount(item?.testSamples),
        ensembleAccuracy: toNumberOrNull(item?.ensembleAccuracy),
        ensembleBalancedAccuracy: toNumberOrNull(item?.ensembleBalancedAccuracy),
        ensembleMacroF1: toNumberOrNull(item?.ensembleMacroF1),
        qualityGate: item?.qualityGate === true,
        validationType: String(item?.validationType || "UNKNOWN"),
        promotion: String(item?.promotion || "UNKNOWN"),
        feedbackRowsUsed: toCount(item?.feedbackRowsUsed),
        featureVersion: String(item?.featureVersion || ""),
        challenger: item?.challenger && typeof item.challenger === "object" ? {
          trainedAt: toIsoOrNull(item.challenger.trainedAt),
          selectionScore: toNumberOrNull(item.challenger.selectionScore),
          balancedAccuracy: toNumberOrNull(item.challenger.balancedAccuracy),
          macroF1: toNumberOrNull(item.challenger.macroF1),
          samples: toCount(item.challenger.samples)
        } : null
      }))
    : [];

  const remote = mlService?.remote && typeof mlService.remote === "object" ? mlService.remote : {};
  return {
    ok: true,
    generatedAt: toIsoOrNull(now) || new Date().toISOString(),
    dataSource: "POSTGRESQL_SETTLED_TRADE_FEEDBACK",
    outcomes: {
      total: toCount(summary.total),
      wins,
      losses,
      invalidated,
      breakeven,
      last24h: toCount(summary.last_24h),
      decisiveTrades: decisive,
      winRate: decisive ? Number(((wins / decisive) * 100).toFixed(2)) : null,
      averageR: toNumberOrNull(summary.average_r),
      lastReceivedAt: toIsoOrNull(summary.last_received_at),
      lastSettledAt: toIsoOrNull(summary.last_settled_at)
    },
    outbox: {
      pending: toCount(outbox.pending),
      processing: toCount(outbox.processing),
      delivered: toCount(outbox.delivered),
      failed: toCount(outbox.failed),
      oldestPendingAt: toIsoOrNull(outbox.oldest_pending_at)
    },
    strategies: (strategyResult.rows || []).map(row => {
      const strategyWins = toCount(row.wins);
      const strategyLosses = toCount(row.losses);
      const strategyInvalidated = toCount(row.invalidated);
      const strategyDecisive = strategyWins + strategyLosses + strategyInvalidated;
      return {
        strategy: String(row.strategy || ""),
        total: toCount(row.total),
        wins: strategyWins,
        losses: strategyLosses,
        invalidated: strategyInvalidated,
        breakeven: toCount(row.breakeven),
        decisiveTrades: strategyDecisive,
        winRate: strategyDecisive ? Number(((strategyWins / strategyDecisive) * 100).toFixed(2)) : null,
        averageR: toNumberOrNull(row.average_r),
        lastSettledAt: toIsoOrNull(row.last_settled_at)
      };
    }),
    recent: (recentResult.rows || []).map(row => ({
      strategy: String(row.strategy || ""),
      symbol: String(row.symbol || ""),
      direction: String(row.direction || ""),
      outcome: String(row.outcome || ""),
      pnl: toNumberOrNull(row.pnl),
      rMultiple: toNumberOrNull(row.r_multiple),
      settledAt: toIsoOrNull(row.settled_at),
      receivedAt: toIsoOrNull(row.received_at)
    })),
    mlService: {
      configured: mlService?.configured === true,
      reachable: mlService?.ok === true,
      ready: remote.ready === true,
      status: String(mlService?.status || "ML_SERVICE_STATUS_UNKNOWN"),
      modelRestoreStatus: String(remote.modelRestoreStatus || "UNKNOWN"),
      feedbackRestoreStatus: String(remote.feedbackRestoreStatus || "UNKNOWN"),
      feedbackRowsInMemory: toCount(remote.feedbackRows),
      persistedFeedbackRowsReported: toCount(remote.persistedFeedbackRows),
      feedbackPersistenceConfigured: remote.feedbackPersistenceConfigured === true,
      modelsLoaded: toCount(remote.modelsLoaded),
      training: toCount(remote.training)
    },
    modelRegistry: {
      available: modelRegistry?.ok === true,
      status: String(modelRegistry?.status || (modelRegistry?.ok ? "AVAILABLE" : "UNAVAILABLE")),
      count: models.length,
      models
    }
  };
}

export function registerAiLearningMonitor(app, {
  pool,
  requireUser,
  isAdminEmail,
  probeMlSignalService,
  listMlSignalModels
} = {}) {
  app.get("/api/admin/ai-learning-monitor", async (req, res) => {
    const user = await requireUser(pool, req, res);
    if (!user) return;
    if (!isAdminEmail(user.email)) {
      return res.status(403).json({ ok: false, error: "Administrator access required." });
    }
    if (!pool) {
      return res.status(503).json({ ok: false, error: "Learning monitor database unavailable." });
    }

    try {
      const [mlService, modelRegistry] = await Promise.all([
        Promise.resolve().then(() => probeMlSignalService?.()).catch(() => null),
        Promise.resolve().then(() => listMlSignalModels?.()).catch(() => null)
      ]);
      const snapshot = await loadAiLearningSnapshot(pool, { mlService, modelRegistry });
      res.setHeader("Cache-Control", "no-store");
      return res.json(snapshot);
    } catch (error) {
      console.error("[KINGBOT LEARNING MONITOR]", error?.message || error);
      return res.status(503).json({
        ok: false,
        error: "AI_LEARNING_MONITOR_UNAVAILABLE"
      });
    }
  });
}
