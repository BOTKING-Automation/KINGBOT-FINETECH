import { DEFAULTS } from "./risk-engine.js";
import { getGoldPriceFeed } from "./gold-price-feed.js";

const publicGoldPriceFeed = getGoldPriceFeed();

export function registerAiIntelligence(app, { requireUser, pool, broker } = {}) {
  app.get("/api/intelligence/context", async (req, res) => {
    const user = await requireUser(pool, req, res);
    if (!user) return;

    const symbol = String(req.query?.symbol || "XAUUSD").trim().toUpperCase();
    const generatedAt = new Date().toISOString();

    try {
      const status = await broker.getStatus(user.id);
      const connected = Boolean(status?.connected);

      let account = null;
      let positions = [];
      let marketQuote = null;

      try {
        if (symbol === "XAUUSD") {
          const gold = await publicGoldPriceFeed.getQuote();
          if (gold?.verified) {
            marketQuote = {
              symbol,
              price: gold.price,
              bid: gold.bid,
              ask: gold.ask,
              spread: gold.spread,
              time: gold.timestamp,
              verified: true,
              source: gold.source,
              freshnessMaxAgeMs: gold.freshnessMaxAgeMs
            };
          }
        }
      } catch {}

      if (connected) {
        try {
          const accountResult = await broker.getAccount(user.id);
          const raw = accountResult?.data || accountResult || {};
          account = {
            available: true,
            balance: Number.isFinite(Number(raw.balance)) ? Number(raw.balance) : null,
            equity: Number.isFinite(Number(raw.equity ?? raw.NAV ?? raw.netAssetValue)) ? Number(raw.equity ?? raw.NAV ?? raw.netAssetValue) : null,
            margin: Number.isFinite(Number(raw.margin)) ? Number(raw.margin) : null,
            freeMargin: Number.isFinite(Number(raw.freeMargin ?? raw.free_margin)) ? Number(raw.freeMargin ?? raw.free_margin) : null,
            currency: String(raw.currency || "").trim() || null,
            accountType: String(raw.accountType || raw.account_type || status.executionMode || "DEMO").toUpperCase(),
            tradingEnabled: raw.tradeAllowed !== false && raw.tradingEnabled !== false
          };
        } catch (error) {
          account = { available: false, error: String(error?.message || "ACCOUNT_TELEMETRY_UNAVAILABLE") };
        }

        try {
          const result = await broker.getPositions(user.id);
          positions = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
          positions = positions.slice(0, 20).map((p) => ({
            id: p.id ?? p.positionId ?? null,
            symbol: p.symbol ?? null,
            type: p.type ?? p.side ?? null,
            volume: Number.isFinite(Number(p.volume)) ? Number(p.volume) : null,
            openPrice: Number.isFinite(Number(p.openPrice ?? p.open_price)) ? Number(p.openPrice ?? p.open_price) : null,
            currentPrice: Number.isFinite(Number(p.currentPrice ?? p.current_price)) ? Number(p.currentPrice ?? p.current_price) : null,
            profit: Number.isFinite(Number(p.profit)) ? Number(p.profit) : null
          }));
        } catch {}

        try {
          const quote = await broker.getQuote(symbol, user.id);
          const raw = quote?.data || quote || {};
          const bid = Number(raw.bid);
          const ask = Number(raw.ask);
          if (Number.isFinite(bid) && Number.isFinite(ask)) {
            marketQuote = {
              symbol,
              bid,
              ask,
              spread: Number.isFinite(Number(raw.spread)) ? Number(raw.spread) : ask - bid,
              time: raw.time || raw.timestamp || generatedAt
            };
          }
        } catch (error) {
          marketQuote = { symbol, unavailable: true, reason: String(error?.message || "QUOTE_UNAVAILABLE") };
        }
      }

      const runtimeResult = pool
        ? await pool.query(
            "SELECT r.bot_id,r.state,COALESCE(rs.execution_mode,'DEMO') AS execution_mode,r.symbol,r.timeframe,r.last_signal,r.last_run_at,r.last_error,r.updated_at FROM kingbot_bot_runtime r LEFT JOIN kingbot_bot_risk_settings rs ON rs.user_id=r.user_id AND rs.bot_id=r.bot_id WHERE r.user_id=$1 ORDER BY r.bot_id",
            [user.id]
          )
        : { rows: [] };

      const runtime = runtimeResult.rows.map((row) => ({
        bot_id: row.bot_id,
        state: row.state || "STOPPED",
        executionMode: row.execution_mode || null,
        symbol: row.symbol || null,
        timeframe: row.timeframe || null,
        lastSignal: row.last_signal || null,
        lastRunAt: row.last_run_at || null,
        lastError: row.last_error || null,
        updatedAt: row.updated_at || null
      }));

      const risk = {
        policy: {
          dailyDrawdownPct: DEFAULTS.dailyDrawdownPct,
          totalDrawdownPct: DEFAULTS.totalDrawdownPct,
          maxRiskPerTradePct: DEFAULTS.maxRiskPerTradePct,
          maxPositions: DEFAULTS.maxPositions,
          maxSpreadAtrRatio: DEFAULTS.maxSpreadAtrRatio,
          staleDataMs: DEFAULTS.staleDataMs,
          maxConsecutiveLosses: DEFAULTS.maxConsecutiveLosses
        }
      };

      return res.json({
        ok: true,
        generatedAt,
        user: { id: user.id, email: user.email || null },
        broker: {
          connected,
          configured: Boolean(status?.configured),
          broker: status?.broker || null,
          accountId: status?.accountId || null,
          executionMode: status?.executionMode || "NOT_CONNECTED",
          accountType: status?.accountType || null
        },
        account,
        positions,
        marketQuote,
        runtime,
        risk
      });
    } catch (error) {
      console.error("[KINGBOT INTELLIGENCE CONTEXT]", error?.message || error);
      return res.status(503).json({
        ok: false,
        error: "INTELLIGENCE_CONTEXT_UNAVAILABLE",
        message: "Verified intelligence context is temporarily unavailable."
      });
    }
  });
}
