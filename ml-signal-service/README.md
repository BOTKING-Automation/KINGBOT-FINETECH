# KINGBOT ML Signal Service: readiness, recovery, and validation

## Readiness semantics

`GET /health` reports both liveness and readiness. `ok: true` means the process answered. `ready: true` requires the shared secret to be configured and at least one recent champion model to have passed the current predictive-quality gate. The default maximum accepted model age is seven days; configure `KINGBOT_ML_MAX_MODEL_AGE_SECONDS` to change it. A configured service with no recent, quality-gated model is reported as degraded rather than ready.

The trainer currently uses a **per-market temporal holdout (78% train / 22% holdout)**. It is not rolling walk-forward evaluation and does not establish profitability. Cost-aware backtesting that includes spread, commission, slippage, swap, latency, and realistic order outcomes remains **not established**. Metadata explicitly reports `profitabilityValidated: false` until that testing is implemented and run against suitable real-market data.

## Restart recovery using a persistent disk

Without a store path, models and feedback remain in memory. To enable checkpoint recovery, set `KINGBOT_ML_MODEL_STORE_DIR` to a path on a durable disk actually mounted to the ML service, and keep `KINGBOT_ML_SIGNAL_SECRET` stable and high-entropy across restarts.

Champion model artifacts and feedback state are written atomically. Model checkpoints are HMAC-signed and signatures are verified before deserialization. Invalid signatures, incompatible feature versions, invalid model schemas, and stale models are rejected. If a durable store is configured but a new champion cannot be saved, the candidate is not promoted. Health reports the persistence mode, restoration counts, and recent errors. Store files should only be writable by the ML service; never restore artifacts copied from untrusted sources.

An ephemeral filesystem is not durable across redeploys. Use the exact path configured by your hosting provider's persistent disk; this code change does not alter hosting settings or provision a disk.

## Scope limitations

- Checkpointing proves recoverability, not profitability.
- CI fixtures prove code paths execute, not live market performance.
- The ML service does not place broker orders.
- Foundation/financial language models are not in the trade-authority path in this change. Future macro/news FLM evidence must be source-cited, timestamped, freshness-bounded, and subordinate to deterministic risk gates; it must never independently authorize order execution.
