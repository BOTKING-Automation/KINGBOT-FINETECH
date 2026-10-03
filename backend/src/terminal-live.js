/**
 * Terminal live SSE stream — REAL newlines required for EventSource parsing
 */
export function registerTerminalLive(app, { requireUser, pool, broker, firstFinite }) {
  app.get("/api/terminal/live", async (req, res) => {
    const user = await requireUser(pool, req, res);
    if (!user) return;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    let closed = false;
    const close = () => { closed = true; };
    req.on("close", close);
    req.on("aborted", close);

    const writeSse = (event, payload) => {
      if (closed) return;
      try {
        res.write("event: " + event + "\n");
        res.write("data: " + JSON.stringify(payload) + "\n\n");
      } catch {}
    };

    const writeHeartbeat = () => {
      if (closed) return;
      try { res.write(": kingbot-live\n\n"); } catch {}
    };

    const symbol = String(req.query?.symbol || "").trim();
    const streamStartedAt = Date.now();

    const send = async () => {
      if (closed) return;
      try {
        const mapping = await broker.getMapping(user.id);
        if (!mapping) {
          writeSse("error", { ok: false, error: "BROKER_NOT_CONNECTED" });
          return;
        }
        let entry;
        try {
          entry = await broker.connectionFor(user.id);
        } catch (e) {
          writeSse("error", {
            ok: false,
            error: "BROKER_CONNECTION_UNAVAILABLE",
            reason: String(e?.message || ""),
          });
          return;
        }

        const [accountResult, positionsResult, ordersResult, quoteResult] = await Promise.allSettled([
          entry?.api?.getAccount ? entry.api.getAccount() : Promise.resolve({ data: entry?.accountInfo || {} }),
          entry?.api?.getPositions ? entry.api.getPositions() : Promise.resolve({ data: [] }),
          entry?.api?.getOrders ? entry.api.getOrders() : Promise.resolve({ data: [] }),
          symbol && entry?.api?.getQuote ? entry.api.getQuote(symbol) : Promise.resolve(null),
        ]);

        if (accountResult.status !== "fulfilled") {
          writeSse("error", { ok:false, error:"BROKER_ACCOUNT_DATA_UNAVAILABLE", reason:String(accountResult.reason?.message||"ACCOUNT_DATA_UNAVAILABLE").slice(0,200) });
          return;
        }
        if (positionsResult.status !== "fulfilled") {
          writeSse("error", { ok:false, error:"BROKER_POSITIONS_UNAVAILABLE", reason:String(positionsResult.reason?.message||"POSITIONS_UNAVAILABLE").slice(0,200) });
          return;
        }
        if (ordersResult.status !== "fulfilled") {
          writeSse("error", { ok:false, error:"BROKER_ORDERS_UNAVAILABLE", reason:String(ordersResult.reason?.message||"ORDERS_UNAVAILABLE").slice(0,200) });
          return;
        }

        const raw = accountResult.value?.data || accountResult.value || {};


        const positionSource =
          positionsResult.status === "fulfilled"
            ? Array.isArray(positionsResult.value?.data)
              ? positionsResult.value.data
              : Array.isArray(positionsResult.value)
                ? positionsResult.value
                : []
            : [];

        const positions = positionSource.map((p) => ({
          id: p?.id || p?.positionId || p?.ticket || null,
          ticket: p?.ticket || p?.id || p?.positionId || null,
          symbol: p?.symbol || "—",
          side: p?.side || p?.type ? String(p?.side || p?.type).toUpperCase() : null,
          volume: firstFinite(p?.volume, p?.lots, p?.quantity),
          entry: firstFinite(p?.openPrice, p?.entryPrice, p?.entry),
          current: firstFinite(p?.currentPrice, p?.current, p?.marketPrice),
          pnl: firstFinite(p?.profit, p?.pnl, p?.unrealizedProfit),
          status: p?.state || p?.status ? String(p?.state || p?.status).toUpperCase() : null,
        }));

        const orderSource =
          ordersResult.status === "fulfilled"
            ? Array.isArray(ordersResult.value?.data)
              ? ordersResult.value.data
              : Array.isArray(ordersResult.value)
                ? ordersResult.value
                : []
            : [];
        const orders = orderSource.slice(0,100).map((o) => ({
          id:o?.id || o?.orderId || o?.ticket || null,
          time:o?.time || o?.createdAt || o?.created_at || o?.timestamp || null,
          symbol:o?.symbol || o?.instrument || "—",
          side:String(o?.side || o?.type || o?.order_type || "—").toUpperCase(),
          volume:firstFinite(o?.volume,o?.lots,o?.quantity,o?.stake,o?.units),
          price:firstFinite(o?.price,o?.openPrice,o?.entryPrice,o?.currentPrice),
          status:o?.status || o?.state ? String(o?.status || o?.state).toUpperCase() : null,
        }));

        const balance = firstFinite(raw.balance);
        const equity = firstFinite(raw.equity);

        let quote = null;
        if (quoteResult.status === "fulfilled" && quoteResult.value) {
          const q = quoteResult.value?.data || quoteResult.value;
          if (q) {
            quote = {
              symbol: q.symbol || symbol || null,
              bid: q.bid ?? q.buy ?? null,
              ask: q.ask ?? q.sell ?? null,
              price: q.price ?? null,
              time: q.time || q.timestamp || null,
            };
          }
        }

        writeSse("snapshot", {
          ok: true,
          account: {
            accountId: mapping.account_id || raw.accountId || raw.login || null,
            balance,
            equity,
            margin: firstFinite(raw.margin),
            freeMargin: firstFinite(raw.freeMargin),
            currency: raw.currency || null,
            broker: mapping.provider || null,
            executionMode: entry.executionMode || mapping.execution_mode || "DEMO",
            accountType: String(raw.accountType || raw.account_type || (entry.executionMode === "LIVE" ? "REAL" : "DEMO")).toUpperCase(),
            tradingEnabled: typeof raw.tradeAllowed === "boolean" ? raw.tradeAllowed : (typeof raw.tradingEnabled === "boolean" ? raw.tradingEnabled : null),
            accountStatus: raw.account_status || raw.status ? String(raw.account_status || raw.status).toUpperCase() : null,
          },
          positions,
          quote,
          at: new Date().toISOString(),
          generatedAt: new Date().toISOString(),
          latencyMs: Math.max(0, Date.now() - streamStartedAt),
        });
      } catch (error) {
        writeSse("error", {
          ok: false,
          error: String(error?.message || "STREAM_ERROR").slice(0, 200),
        });
      }
    };

    await send();
    const timer = setInterval(() => {
      if (closed) {
        clearInterval(timer);
        return;
      }
      writeHeartbeat();
      send().catch(() => {});
    }, 1500);

    req.on("close", () => {
      clearInterval(timer);
      closed = true;
    });
  });
}
