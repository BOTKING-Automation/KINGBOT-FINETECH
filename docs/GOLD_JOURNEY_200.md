# KINGBOT $200 XAUUSD Gold Journey

## Preset

- Reference starting capital: **$200 USD**; the connected broker account must report USD as its account currency before the profile can trade.
- Priority market: **XAUUSD** (broker suffixes such as XAUUSDm and the FRXXAUUSD ticker format are accepted).
- Sole execution engine: **KINGBOT SMC PRO**. The preset cannot be saved on Strategic, Flipper, Breakout or Ladder Flip.
- Maximum planned risk per trade: **12.5% of current verified USD account equity**, compounded before every new trade. Profits increase the next risk budget; losses reduce it. The $200 starting amount is a reference only, never the sizing base after the account begins trading.
- Minimum gross reward-to-risk: **1:4**.
- Daily drawdown stop: **12.5%** from the broker-account day-start equity.
- Peak-to-equity drawdown stop: **25%**.
- Maximum open account positions: **1**.
- Pause after **3 consecutive losses**; use the dashboard’s **RE-ARM AFTER LOSS REVIEW** action after manual review. It permits one successfully submitted order, then automatically clears. It does not bypass daily/total drawdown, symbol, position, spread, data-quality or 4R controls. The pre-trade projected drawdown check can stop the journey earlier.
- Auto-pause enabled, spread/ATR maximum 0.20, stale quote limit 5 seconds.
- The preset defaults to DEMO mode. Verified demo trading is allowed for the shadow/demo validation phase; LIVE mode remains unavailable until all validation gates pass and an operator enables the approval flag.
- SMC PRO uses its existing **4H regime → 15m setup → 5m execution** timeframe profile. A Gold Journey profile pauses other KINGBOT bot runtimes for this user to avoid overlapping strategy engines; those bots must be manually restarted after the Gold Journey profile is removed.

At exactly $200 of verified equity, 12.5% planned risk is $25 and a full 4R gross winner targets $100 before commission, spread, slippage, swaps and other execution costs. After that gross win, illustrative equity would be $300 and the next trade's 12.5% risk budget would compound to $37.50. After a full $25 loss, equity would be $175 and the next budget would reduce to $21.87 after rounding down to cents. These are arithmetic examples, not return forecasts; realised results are affected by costs, slippage and gaps. The worker recalculates from current broker-reported equity on each new trade; it does not keep sizing at $25.

## Execution safeguards

1. Use actual broker equity and broker symbol specifications for volume sizing. Never use the $200 reference as a substitute for account telemetry.
2. Compute volume from the final stop distance, tick size, tick value and volume step. Round volume down; reject a trade if minimum volume would exceed the risk budget.
3. Recompute the target from the final broker-valid stop distance and enforce at least 4R after stop-distance adjustments.
4. Block entries if the account has an open position, current or projected daily/total drawdown breaches its limit, the loss-streak is reached, the spread is too wide, the quote is stale, the broker data or symbol specification is missing, or the kill switch is active. Projected drawdown assumes a full planned stop loss at the configured risk percentage.
5. Require verified USD account currency and trade-history data for the loss-streak guard. Missing currency or a failed history request is a block, not an assumed value.
6. Only KINGBOT SMC PRO may execute this journey. The worker pauses every other bot runtime for this user while the Gold Journey profile is configured; they must be manually restarted after this preset is removed. SMC PRO keeps its native market-structure, liquidity-sweep, order-block, fair-value-gap and displacement analysis; the Gold Journey overrides its take-profit distance to at least 4R.
7. Deriv stake-based execution is excluded until its contract-specific monetary risk can be proven to equal the requested account-risk budget. The standard MT5/CFD volume path must pass broker sizing checks first.
8. AI signals are advisory. Deterministic SMC PRO strategy checks, broker verification, compounding risk authorization and order validation remain authoritative.

## Validation gate

The profile defaults to **DEMO**. Demo orders may be submitted on the connected, verified USD-denominated demo account so the required shadow/demo sample can be collected. **LIVE orders are blocked** until the environment flag KINGBOT_GOLD_JOURNEY_VALIDATED is set to true in both the API and worker environments after all gates below pass. Do not set this variable merely because CI is green.

Before enabling the gate, require:
- Preserve the existing KINGBOT V9/V10 model-acceptance gates without relaxation: ensemble balanced accuracy at least 0.36, macro-F1 at least 0.34, at least 30 untouched final test samples, and nonzero SELL, HOLD and BUY recall.
- Require a matched V9 benchmark on untouched forward data, robustness across market regimes/periods, and no automatic replacement of the currently accepted production model.
- A reproducible cost-aware XAUUSD backtest using spread, commission, slippage and swaps, with a chronological train/development/final split and untouched final data.
- At least 30 untouched final closed trades, positive net expectancy after costs, and profit factor of at least 1.20.
- Peak drawdown no greater than 25%; no sizing calculation may exceed 12.5% planned risk after broker volume rounding.
- At least 30 completed shadow/demo trades on the Gold Journey profile with no unexplained broker/order-journal reconciliation mismatch, stale-data execution, missing protective stop, or risk-limit bypass.
- A code review of the worker path and explicit operator approval.

Passing CI only proves the code/tests ran. It does not prove a trading edge or authorize live execution. The profile is saved per bot and per authenticated user. It is restricted to SMC PRO and only activates when that engine is configured for XAUUSD.
