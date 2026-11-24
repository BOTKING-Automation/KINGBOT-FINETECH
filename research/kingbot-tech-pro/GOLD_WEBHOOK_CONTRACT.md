# KINGBOT TECH PRO — Gold Research Webhook Contract

**Status:** Research-only intake; not deployed or enabled by this change.  
**Endpoint:** `POST /api/research/gold/ingest/:token`  
**Purpose:** Store TradingView candidate events for replay, comparison and backtesting.

## Security and configuration

- Set `KINGBOT_GOLD_RESEARCH_WEBHOOK_SECRET` on the API service to a randomly generated value of at least 32 characters.
- Put the matching secret only in the TradingView alert's webhook URL path, for example:
  `https://<KINGBOT_API_HOST>/api/research/gold/ingest/<high-entropy-secret>`
- Do not place the secret in Pine source, indicator inputs, alert JSON, Git, or logs.
- The route uses a constant-time secret comparison, a per-minute rate limit, TLS-only deployment, and no-cache responses.
- Reverse-proxy/access logs must redact the final token path segment. Rotate the secret if it is exposed.
- This endpoint is not active until the API branch is deployed and the environment variable is configured.

## Event schema

The JSON request body must use:

```json
{
  "schema_version": "1.0",
  "event_type": "candidate_setup",
  "event_id": "XAUUSD:5:<bar-time-ms>:BUY:V3",
  "strategy": "KINGBOT_TECH_PRO",
  "strategy_version": "V3-baseline",
  "symbol": "XAUUSD",
  "source_symbol": "XAUUSDm",
  "timeframe": "5",
  "bar_time_utc": "2026-11-22T08:55:00.000Z",
  "event_time_utc": "2026-11-22T08:59:00.000Z",
  "side": "BUY",
  "bar_close": 4050.2,
  "atr": 4.3,
  "spread": 0.35,
  "entry": 4050.2,
  "stop_loss": 4046.0,
  "tp1": 4054.4,
  "tp2": 4058.6,
  "tp3": 4065.0,
  "score": 8,
  "setup_state": "TRIGGER_CONFIRMED",
  "reason_codes": ["HTF_BIAS_ALIGNED", "LIQUIDITY_SWEEP", "FVG_RETEST"],
  "source": "tradingview_alert"
}
```

Supported timeframes: `1`, `1m`, `5`, `5m`, `15`, `15m`, `60`, `1h`, `240`, `4h`, `D`, `1D`. Canonical symbol must be `XAUUSD`; keep the broker/provider alias separately in `source_symbol`. BUY and SELL price order is validated before storage. The event timestamp must be fresh (default 15 minutes) and cannot be more than two minutes in the future.

## Responses

- `201`: event stored for research.
- `200`: duplicate event ID; no second row inserted.
- `400`: malformed or inconsistent event.
- `404`: invalid URL token.
- `503`: secret, database or event store is not configured/available.

Every accepted response states `processing: RESEARCH_ONLY` and `executionAuthority: NONE`. The endpoint never creates, publishes or executes a customer trade. Events are retained in `kingbot_gold_research_events`.

## Current Pine boundary

The frozen V3 indicator emits a human-readable alert message, not this JSON contract. A separately versioned research Pine candidate must emit JSON before TradingView alerts can enter this endpoint. Keep V3 unchanged. Historical backtest imports should use a separate offline ingestion path, not bypass live-webhook freshness validation.
