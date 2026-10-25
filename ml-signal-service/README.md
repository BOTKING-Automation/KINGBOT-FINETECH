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


## Research-only rolling walk-forward and cost-aware backtest

The authenticated \`POST /backtest\` endpoint accepts one strategy, symbol, timeframe, timestamped OHLC history, a descriptive \`dataSource\` claim, 2–5 folds, and an explicit \`costs\` object. The service requires at least 260 bars, strictly increasing timestamps, and all the cost fields below. It trains a fresh Random Forest + PyTorch ensemble from only the history before each test fold. Training labels are cut off at the fold boundary by the configured forward horizon; each fold is evaluated only on later bars. The backtest uses the same 55% confidence / 12-point directional-score threshold as the production prediction function.

Required cost object fields:
- \`spread_price\`: full bid/ask spread in instrument price units (flat across the run).
- \`slippage_price_per_side\`: adverse price slippage per fill side.
- \`commission_per_lot_round_turn\`: full round-turn commission per lot in account currency.
- \`swap_long_per_lot_per_day\`, \`swap_short_per_lot_per_day\`: signed swap cash rate per lot per day; negative means a debit.
- \`units_per_lot\`, \`volume_lots\`: fixed position size; no compounding.
- \`quote_to_account_rate\`: conversion multiplier from instrument quote-currency P&L into account currency.
- \`starting_equity\`: starting account equity, used for reporting return and drawdown percentages only.
- \`account_currency\`, \`quote_currency\`: currency labels for auditability.

The ledger enters on the next bar's open and exits at the close after the configured forward horizon. The same flat spread and per-side slippage assumptions are applied adversely on entry and exit. Swap is pro-rated by elapsed calendar time; this deliberately does **not** model broker rollover cutoffs, holidays, financing-specific formulas, or triple-swap weekdays. Stop-loss/take-profit orders, market gaps within candles, broker margin, volume constraints and partial fills are not modeled by this research endpoint. The reported trade-level Sharpe is not annualized.

Every source is reported as caller-asserted and **not independently verified**; timestamp completeness and chronology are validated, but that does not authenticate the historical provider or prove bars are free from survivorship or vendor errors. One run does not change global model health or assert profitability. \`profitabilityValidated\` remains false. Use real historical bars from a named source and realistic broker cost settings; CI-generated fixtures only validate code paths and are not performance evidence.
