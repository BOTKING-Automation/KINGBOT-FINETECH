# KINGBOT $200 XAUUSD Gold Journey

## Preset

- Reference starting capital: **$200 USD**; the connected broker account must report USD as its account currency before the profile can trade.
- Priority market: **XAUUSD** (broker suffixes such as XAUUSDm and the FRXXAUUSD ticker format are accepted).
- Maximum planned risk per trade: **12.5% of current verified account equity**.
- Minimum gross reward-to-risk: **1:4**.
- Daily drawdown stop: **12.5%** from the broker-account day-start equity.
- Peak-to-equity drawdown stop: **25%**.
- Maximum open account positions: **1**.
- Pause after **3 consecutive losses**; use the dashboard’s **RE-ARM AFTER LOSS REVIEW** action after manual review. It permits one successfully submitted order, then automatically clears. It does not bypass daily/total drawdown, symbol, position, spread, data-quality or 4R controls. The pre-trade projected drawdown check can stop the journey earlier.
- Auto-pause enabled, spread/ATR maximum 0.20, stale quote limit 5 seconds.
- The preset saves DEMO mode. It does not activate a live account.

At exactly $200 of verified equity, 12.5% planned risk is $25 and a full 4R gross winner targets $100 before commission, spread, slippage, swaps and other execution costs. A full loss would leave $175. At a different account equity, the risk budget is recalculated from the broker's current verified equity; the $200 starting figure is a journey reference, not a fabricated or forced broker balance.

## Execution safeguards

1. Use actual broker equity and broker symbol specifications for volume sizing. Never use the $200 reference as a substitute for account telemetry.
2. Compute volume from the final stop distance, tick size, tick value and volume step. Round volume down; reject a trade if minimum volume would exceed the risk budget.
3. Recompute the target from the final broker-valid stop distance and enforce at least 4R after stop-distance adjustments.
4. Block entries if the account has an open position, current or projected daily/total drawdown breaches its limit, the loss-streak is reached, the spread is too wide, the quote is stale, the broker data or symbol specification is missing, or the kill switch is active. Projected drawdown assumes a full planned stop loss at the configured risk percentage.
5. Require verified USD account currency and trade-history data for the loss-streak guard. Missing currency or a failed history request is a block, not an assumed value.
6. Ladder Flip V8 is excluded because its multi-rung/pyramiding management does not implement a single-position fixed 1:4 journey. Existing Ladder positions must remain under their existing stop-management path; the Gold Journey does not open new Ladder cycles or add rungs.
7. Deriv stake-based execution is excluded until its contract-specific monetary risk can be proven to equal the requested account-risk budget. The standard MT5/CFD volume path must pass broker sizing checks first.
8. AI signals are advisory. Deterministic strategy, broker verification, risk authorization and order validation remain authoritative.

## Validation gate

The profile is **shadow-only by default**. New orders are blocked until the environment flag KINGBOT_GOLD_JOURNEY_VALIDATED is set to true in the backend/worker environment after all gates below pass. Do not set this variable merely because CI is green.

Before enabling the gate, require:
- A reproducible cost-aware XAUUSD backtest using spread, commission, slippage and swaps, with a chronological train/development/final split and untouched final data.
- At least 30 untouched final closed trades, positive net expectancy after costs, and profit factor of at least 1.20.
- Peak drawdown no greater than 25%; no sizing calculation may exceed 12.5% planned risk after broker volume rounding.
- At least 30 completed shadow/demo trades with no unexplained broker/order-journal reconciliation mismatch, stale-data execution, missing protective stop, or risk-limit bypass.
- A code review of the worker path and explicit operator approval.

Passing CI only proves the code/tests ran. It does not prove a trading edge or authorize live execution. The profile is saved per bot and per authenticated user; it only activates when that bot is configured for XAUUSD.
