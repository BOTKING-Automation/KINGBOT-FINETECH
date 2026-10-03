/**
 * Terminal snapshot REST endpoint
 * Loaded by server.js
 */
import { getGlobalRiskState } from "./global-risk.js";

export function registerTerminalSnapshot(app, { requireUser, pool, broker, firstFinite }) {
  app.get("/api/terminal/snapshot", async (req, res) => {
    const user = await requireUser(pool, req, res);
    if (!user) return;
    const mapping = await broker.getMapping(user.id);
    if (!mapping) return res.status(503).json({ ok: false, error: "BROKER_NOT_CONNECTED" });
    let entry;
    try {
      entry = await broker.connectionFor(user.id);
    } catch (error) {
      return res.status(503).json({
        ok: false,
        error: "BROKER_CONNECTION_UNAVAILABLE",
        reason: String(error?.message || ""),
      });
    }
    if (!entry?.api) return res.status(503).json({ ok: false, error: "BROKER_API_UNAVAILABLE" });
    const startedAt = Date.now();
    const provider = String(entry.provider || mapping.provider || "").toLowerCase();
    const symbol = String(req.query?.symbol || "").trim();
    const botId = String(req.query?.botId || "").trim().toLowerCase();
    const moneyNumber = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const mapPosition = (p) => ({
      id: p?.id || p?.positionId || p?.ticket || p?.contractId || null,
      ticket: p?.ticket || p?.id || p?.positionId || p?.contractId || null,
      time: p?.time || p?.openTime || p?.open_time || p?.date_start || p?.timestamp || null,
      symbol: p?.symbol || p?.underlying_symbol || "—",
      side: String(p?.side || p?.type || p?.positionSide || "—").toUpperCase(),
      volume: firstFinite(p?.volume, p?.lots, p?.quantity, p?.stake, p?.buy_price),
      entry: firstFinite(p?.openPrice, p?.entryPrice, p?.entry, p?.open_price),
      stopLoss: firstFinite(p?.stopLoss, p?.sl, p?.stop_loss),
      takeProfit: firstFinite(p?.takeProfit, p?.tp, p?.take_profit),
      current: firstFinite(p?.currentPrice, p?.current, p?.marketPrice, p?.current_spot, p?.current_tick, p?.bidPrice, p?.bid_price),
      swap: firstFinite(p?.swap, p?.swapAmount, p?.swap_amount),
      commission: firstFinite(p?.commission, p?.commissionAmount, p?.commission_amount),
      pnl: firstFinite(p?.profit, p?.pnl, p?.unrealizedProfit, p?.unrealizedPnl),
      status: String(p?.state || p?.status || "OPEN").toUpperCase(),
    });
    try {
      const [accountResult, positionsResult, ordersResult, quoteResult, riskResult, globalRiskResult] = await Promise.allSettled([
        entry.api.getAccount ? entry.api.getAccount() : Promise.resolve({ data: entry.accountInfo || {} }),
        entry.api.getPositions ? entry.api.getPositions() : Promise.resolve({ data: [] }),
        entry.api.getOrders ? entry.api.getOrders() : Promise.resolve({ data: [] }),
        symbol && entry.api.getQuote ? entry.api.getQuote(symbol) : Promise.resolve(null),
        botId ? pool.query("SELECT max_risk_per_trade_pct,daily_drawdown_pct,total_drawdown_pct,max_positions,max_spread_atr_ratio,stale_data_ms,max_consecutive_losses,auto_pause_on_loss_streak,execution_mode,kill_switch FROM kingbot_bot_risk_settings WHERE user_id=$1 AND bot_id=$2 LIMIT 1",[user.id,botId]) : Promise.resolve({rowCount:0,rows:[]}),
        getGlobalRiskState(pool),
      ]);
      const raw =
        accountResult.status === "fulfilled"
          ? accountResult.value?.data || accountResult.value || entry.accountInfo || {}
          : entry.accountInfo || {};
      const positionSource =
        positionsResult.status === "fulfilled"
          ? Array.isArray(positionsResult.value?.data)
            ? positionsResult.value.data
            : Array.isArray(positionsResult.value)
              ? positionsResult.value
              : []
          : [];
      const positionRows = positionSource.map(mapPosition);
      const orderSource = ordersResult.status === "fulfilled"
        ? Array.isArray(ordersResult.value?.data) ? ordersResult.value.data : Array.isArray(ordersResult.value) ? ordersResult.value : []
        : [];
      const orders = orderSource.slice(0,100).map(o => ({
        id:o?.id || o?.orderId || o?.ticket || null,
        time:o?.time || o?.createdAt || o?.created_at || o?.timestamp || null,
        symbol:o?.symbol || o?.instrument || "—",
        side:String(o?.side || o?.type || o?.order_type || "—").toUpperCase(),
        volume:firstFinite(o?.volume,o?.lots,o?.quantity,o?.stake,o?.units),
        price:firstFinite(o?.price,o?.openPrice,o?.entryPrice,o?.currentPrice),
        status:String(o?.status || o?.state || "OPEN").toUpperCase(),
      }));
      const balance = moneyNumber(raw.balance);
      const equity = moneyNumber(raw.equity);
      const floating = moneyNumber(raw.floatingPnl ?? raw.floating ?? raw.profit);
      let quote = null;
      if (quoteResult && quoteResult.status === "fulfilled" && quoteResult.value) {
        const q = quoteResult.value?.data || quoteResult.value;
        if (q)
          quote = {
            symbol: q.symbol || symbol || null,
            bid: q.bid ?? q.buy ?? q.bidPrice ?? null,
            ask: q.ask ?? q.sell ?? q.askPrice ?? null,
            price: q.price ?? null,
            time: q.time || q.timestamp || new Date().toISOString(),
            source: "broker-snapshot-quote",
          };
      }
      return res.json({
        ok: true,
        provider,
        account: {
          accountId: mapping.account_id || raw.accountId || raw.login || null,
          broker: provider,
          executionMode: entry.executionMode || mapping.execution_mode || "DEMO",
          accountType: String(
            raw.accountType || raw.account_type || (entry.executionMode === "LIVE" ? "REAL" : "DEMO")
          ).toUpperCase(),
          currency: raw.currency || null,
          balance,
          equity,
          floatingPnl: equity !== null && balance !== null ? equity - balance : floating,
          margin: moneyNumber(raw.margin),
          freeMargin: moneyNumber(raw.freeMargin),
          marginLevel: moneyNumber(raw.marginLevel),
          positionCount: positionRows.length,
          tradingEnabled: raw.tradeAllowed !== false && raw.tradingEnabled !== false,
          accountStatus: String(raw.account_status || raw.status || "ACTIVE").toUpperCase(),
        },
        risk: riskResult.status === "fulfilled" && riskResult.value?.rowCount ? riskResult.value.rows[0] : botId ? null : null,
        executionControl: globalRiskResult.status === "fulfilled" ? globalRiskResult.value : null,
        positions: positionRows,
        orders,
        quote,
        symbol: symbol || null,
        generatedAt: new Date().toISOString(),
        latencyMs: Math.max(0, Date.now() - startedAt),
        source: "authenticated-terminal-snapshot",
      });
    } catch (error) {
      return res.status(503).json({
        ok: false,
        error: "TERMINAL_SNAPSHOT_UNAVAILABLE",
        reason: String(error?.message || "TERMINAL_SNAPSHOT_UNAVAILABLE").slice(0, 300),
      });
    }
  });
}
