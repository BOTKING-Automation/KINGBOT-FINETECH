import crypto from "node:crypto";
import pg from "pg";

/**
 * KINGBOT CENTRAL EVENT BUS v1
 *
 * Canonical cross-module event/state layer for KINGBOT FINTECH.
 * - PostgreSQL is the durable source of truth.
 * - LISTEN/NOTIFY fans events out across API/worker instances.
 * - correlationId links one business operation across subsystems.
 * - state snapshots give the UI/AI one canonical state surface.
 */

const EVENT_CHANNEL = "kingbot_events";
const MAX_SEEN = 5000;

function id() {
  return crypto.randomUUID();
}

function clean(value, fallback = "") {
  const text = String(value ?? fallback).trim();
  return text.slice(0, 180);
}

function json(value) {
  try { return JSON.stringify(value ?? {}); }
  catch { return "{}"; }
}

export class KingbotEventBus {
  constructor({ pool, name = "kingbot-api" } = {}) {
    this.pool = pool || null;
    this.name = clean(name, "kingbot");
    this.subscribers = new Map();
    this.seen = new Map();
    this.listenerClient = null;
    this.started = false;
    this.stopping = false;
    this.stats = { published: 0, delivered: 0, failures: 0, startedAt: null };
  }

  async ensureSchema() {
    if (!this.pool) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS kingbot_event_log (
        id BIGSERIAL PRIMARY KEY,
        event_id UUID NOT NULL UNIQUE,
        correlation_id UUID NOT NULL,
        causation_id UUID,
        user_id UUID REFERENCES kingbot_users(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT,
        source TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'INFO',
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_kb_event_user_created ON kingbot_event_log(user_id,created_at DESC)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_kb_event_type_created ON kingbot_event_log(event_type,created_at DESC)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_kb_event_correlation ON kingbot_event_log(correlation_id)");
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS kingbot_central_state (
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        state_type TEXT NOT NULL,
        version BIGINT NOT NULL DEFAULT 1,
        state JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(scope_type,scope_id,state_type)
      )
    `);
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_kb_state_updated ON kingbot_central_state(updated_at DESC)");
  }

  remember(eventId) {
    const key = String(eventId);
    this.seen.set(key, Date.now());
    while (this.seen.size > MAX_SEEN) {
      const first = this.seen.keys().next().value;
      if (!first) break;
      this.seen.delete(first);
    }
  }

  wasSeen(eventId) {
    return this.seen.has(String(eventId));
  }

  subscribe(eventType, handler) {
    const type = String(eventType || "*").toUpperCase();
    if (typeof handler !== "function") return () => {};
    if (!this.subscribers.has(type)) this.subscribers.set(type, new Set());
    const set = this.subscribers.get(type);
    set.add(handler);
    return () => set.delete(handler);
  }

  async dispatch(event) {
    if (!event || this.wasSeen(event.eventId)) return;
    this.remember(event.eventId);

    const handlers = [
      ...(this.subscribers.get(String(event.eventType).toUpperCase()) || []),
      ...(this.subscribers.get("*") || [])
    ];

    for (const handler of handlers) {
      try {
        await handler(event);
        this.stats.delivered += 1;
      } catch (error) {
        this.stats.failures += 1;
        console.warn("[KINGBOT EVENT BUS] subscriber failed:", error?.message || error);
      }
    }
  }

  async publish({
    eventType,
    aggregateType = "PLATFORM",
    aggregateId = null,
    userId = null,
    correlationId = null,
    causationId = null,
    source = this.name,
    severity = "INFO",
    payload = {}
  } = {}) {
    if (!this.pool) return null;
    const type = clean(eventType, "UNSPECIFIED").toUpperCase();
    const event = {
      eventId: id(),
      correlationId: correlationId || id(),
      causationId: causationId || null,
      userId: userId || null,
      eventType: type,
      aggregateType: clean(aggregateType, "PLATFORM").toUpperCase(),
      aggregateId: aggregateId == null ? null : clean(aggregateId),
      source: clean(source, this.name),
      severity: clean(severity, "INFO").toUpperCase(),
      payload: payload && typeof payload === "object" ? payload : {},
      createdAt: new Date().toISOString()
    };

    await this.pool.query(
      "INSERT INTO kingbot_event_log(event_id,correlation_id,causation_id,user_id,event_type,aggregate_type,aggregate_id,source,severity,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)",
      [
        event.eventId,
        event.correlationId,
        event.causationId,
        event.userId,
        event.eventType,
        event.aggregateType,
        event.aggregateId,
        event.source,
        event.severity,
        json(event.payload),
        event.createdAt
      ]
    );

    this.stats.published += 1;

    try {
      await this.pool.query("SELECT pg_notify($1,$2)", [
        EVENT_CHANNEL,
        JSON.stringify({ eventId: event.eventId, source: event.source })
      ]);
    } catch (error) {
      console.warn("[KINGBOT EVENT BUS] notify failed:", error?.message || error);
    }

    await this.dispatch(event);
    return event;
  }

  async upsertState({
    scopeType = "PLATFORM",
    scopeId = "global",
    stateType,
    state = {},
  } = {}) {
    if (!this.pool || !stateType) return null;
    const scope = clean(scopeType, "PLATFORM").toUpperCase();
    const sid = clean(scopeId, "global");
    const st = clean(stateType, "STATE").toUpperCase();
    const q = await this.pool.query(
      "INSERT INTO kingbot_central_state(scope_type,scope_id,state_type,version,state,updated_at) VALUES($1,$2,$3,1,$4::jsonb,NOW()) ON CONFLICT(scope_type,scope_id,state_type) DO UPDATE SET version=kingbot_central_state.version+1,state=EXCLUDED.state,updated_at=NOW() RETURNING scope_type,scope_id,state_type,version,state,updated_at",
      [scope, sid, st, json(state)]
    );
    return q.rows[0] || null;
  }

  async patchState({ scopeType = "PLATFORM", scopeId = "global", stateType, patch = {} } = {}) {
    if (!this.pool || !stateType) return null;
    const current = await this.getState({ scopeType, scopeId, stateType });
    return this.upsertState({
      scopeType,
      scopeId,
      stateType,
      state: { ...(current?.state || {}), ...(patch || {}) }
    });
  }

  async getState({ scopeType = "PLATFORM", scopeId = "global", stateType } = {}) {
    if (!this.pool || !stateType) return null;
    const q = await this.pool.query(
      "SELECT scope_type,scope_id,state_type,version,state,updated_at FROM kingbot_central_state WHERE scope_type=$1 AND scope_id=$2 AND state_type=$3",
      [clean(scopeType, "PLATFORM").toUpperCase(), clean(scopeId, "global"), clean(stateType, "STATE").toUpperCase()]
    );
    return q.rows[0] || null;
  }

  async recent({ userId = null, eventTypes = [], limit = 50, sinceMinutes = 60 } = {}) {
    if (!this.pool) return [];
    const types = Array.isArray(eventTypes) ? eventTypes.map(x => String(x).toUpperCase()).filter(Boolean) : [];
    const values = [];
    const where = [];

    if (userId) {
      values.push(userId);
      where.push("user_id=$" + values.length);
    }
    if (types.length) {
      values.push(types);
      where.push("event_type = ANY($" + values.length + "::text[])");
    }
    values.push(Math.max(1, Math.min(500, Number(limit) || 50)));
    const limitPos = values.length;
    values.push(Math.max(1, Math.min(10080, Number(sinceMinutes) || 60)));
    const minutesPos = values.length;

    const q = await this.pool.query(
      "SELECT event_id,correlation_id,causation_id,user_id,event_type,aggregate_type,aggregate_id,source,severity,payload,created_at FROM kingbot_event_log " +
      (where.length ? "WHERE " + where.join(" AND ") + " AND " : "WHERE ") +
      "created_at>=NOW()-(INTERVAL '1 minute'*$" + minutesPos + ") ORDER BY created_at DESC LIMIT $" + limitPos,
      values
    );
    return q.rows;
  }

  status() {
    return {
      ok: Boolean(this.pool) && this.started && !this.stopping,
      started: this.started,
      channel: EVENT_CHANNEL,
      subscribers: [...this.subscribers.entries()].reduce((n, [, set]) => n + set.size, 0),
      stats: { ...this.stats }
    };
  }

  async start() {
    if (!this.pool || this.started || this.stopping) return;
    this.listenerClient = await this.pool.connect();
    await this.listenerClient.query("LISTEN " + EVENT_CHANNEL);
    this.listenerClient.on("notification", async message => {
      try {
        const meta = JSON.parse(message.payload || "{}");
        if (!meta.eventId || this.wasSeen(meta.eventId)) return;
        const q = await this.pool.query(
          "SELECT event_id,correlation_id,causation_id,user_id,event_type,aggregate_type,aggregate_id,source,severity,payload,created_at FROM kingbot_event_log WHERE event_id=$1 LIMIT 1",
          [meta.eventId]
        );
        if (q.rowCount) {
          await this.dispatch({
            eventId: q.rows[0].event_id,
            correlationId: q.rows[0].correlation_id,
            causationId: q.rows[0].causation_id,
            userId: q.rows[0].user_id,
            eventType: q.rows[0].event_type,
            aggregateType: q.rows[0].aggregate_type,
            aggregateId: q.rows[0].aggregate_id,
            source: q.rows[0].source,
            severity: q.rows[0].severity,
            payload: q.rows[0].payload,
            createdAt: q.rows[0].created_at
          });
        }
      } catch (error) {
        this.stats.failures += 1;
        console.warn("[KINGBOT EVENT BUS] notification processing failed:", error?.message || error);
      }
    });
    this.listenerClient.on("error", error => {
      this.stats.failures += 1;
      console.warn("[KINGBOT EVENT BUS] listener error:", error?.message || error);
    });
    this.started = true;
    this.stats.startedAt = new Date().toISOString();
  }

  async stop() {
    this.stopping = true;
    if (this.listenerClient) {
      try { await this.listenerClient.query("UNLISTEN " + EVENT_CHANNEL); } catch {}
      try { this.listenerClient.release(); } catch {}
      this.listenerClient = null;
    }
    this.started = false;
  }
}

export function registerKingbotEventRoutes(app, { requireUser, pool, eventBus } = {}) {
  if (!app || !requireUser || !eventBus) return;

  app.get("/api/events/recent", async (req, res) => {
    const user = await requireUser(pool, req, res);
    if (!user) return;
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 50)));
      const minutes = Math.min(1440, Math.max(1, Number(req.query?.minutes || 60)));
      const events = await eventBus.recent({ userId: user.id, limit, sinceMinutes: minutes });
      res.json({ ok: true, events, generatedAt: new Date().toISOString() });
    } catch (error) {
      res.status(503).json({ ok: false, error: "EVENT_HISTORY_UNAVAILABLE", reason: String(error?.message || "").slice(0, 180) });
    }
  });

  app.get("/api/events/live", async (req, res) => {
    const user = await requireUser(pool, req, res);
    if (!user) return;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    let closed = false;
    const write = (event, payload) => {
      if (closed) return;
      try {
        res.write("event: " + event + "\n");
        res.write("data: " + JSON.stringify(payload) + "\n\n");
      } catch {}
    };

    const send = event => {
      if (!event || (event.userId && String(event.userId) !== String(user.id))) return;
      if (!event.userId && String(event.aggregateType).toUpperCase() !== "PLATFORM") return;
      write("kingbot", event);
    };

    const unsubscribe = eventBus.subscribe("*", send);
    const heartbeat = setInterval(() => { if (!closed) write("heartbeat", { at: new Date().toISOString() }); }, 15000);

    try {
      const recent = await eventBus.recent({ userId: user.id, limit: 25, sinceMinutes: 5 });
      recent.reverse().forEach(send);
      await write("ready", { at: new Date().toISOString(), bus: eventBus.status() });
    } catch {}

    const close = () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", close);
    req.on("aborted", close);
  });
}
