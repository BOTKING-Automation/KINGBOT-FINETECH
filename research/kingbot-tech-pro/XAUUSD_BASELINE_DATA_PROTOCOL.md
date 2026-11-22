# XAUUSD historical data and baseline protocol

## Collector

The research branch contains `collect_xauusd_candles.mjs`, which reads public closed OHLC candles from KINGBOT's existing Deriv public historical-candle WebSocket mapping (`frxXAUUSD`) for the canonical research symbol XAUUSD.

Run with Node.js 22+:

```bash
node research/kingbot-tech-pro/collect_xauusd_candles.mjs \
  --timeframes 1m,5m,15m,1h,4h,1d \
  --count 1000 \
  --min-bars 200 \
  --output research/kingbot-tech-pro/data/xauusd-closed-candles.json
```

The collector:
- requests one XAUUSD series per timeframe, sequentially;
- keeps fully closed bars only;
- validates positive OHLC values and candle range consistency;
- rejects duplicate timestamps and retains gaps instead of interpolating;
- records provider, raw source symbol, UTC timestamp units, price unit and volume semantics;
- marks the package research-only with no execution authority;
- does not fabricate data or use an account token.

The initial per-timeframe request is capped at 1,000 bars. That is a smoke-test dataset only, not evidence that the required sample size or market-regime coverage has been achieved.

## Critical data-source boundary

Deriv's public `frxXAUUSD` history is not automatically identical to an execution broker's CFD contract. It may differ in quote construction, session availability, spreads, execution prices and candle highs/lows. If deployment is intended to execute on Exness XAUUSDm (or any other broker alias), collect the broker's own exported historical bars and cost schedule, then run a source-matched comparison. Keep both series labelled by provider; never silently splice or merge price feeds.

The public candle's `tick_count` is a count of ticks, not centralized traded volume. It must not be described as exchange volume.

## Before baseline testing

A complete baseline requires:
1. a sufficiently long, provenance-labelled XAUUSD dataset spanning multiple regimes and sessions;
2. exact timeframe and timezone metadata, with closed bars only;
3. a documented broker contract and symbol alias;
4. spread history or a conservative measured spread schedule, commissions, slippage and financing assumptions;
5. a Pine-to-strategy equivalent implementation that matches frozen V3 signal conditions and trade state, tested against TradingView bar replay;
6. chronological train/development/untouched-final or multiple walk-forward partitions, no leakage, and event-level reconciliation.

Do not infer costs from a current quote or substitute a fixed zero-cost assumption. Run at least base and stressed-cost cases only after broker-specific costs are supplied. The frozen indicator's in-chart performance panel is not a backtest.

## Acceptance and promotion

The V3 baseline is for measurement. New ICT/SMC sequential-entry signals remain candidate-only until a matched, cost-aware backtest demonstrates an improvement on untouched future periods, across relevant volatility/session regimes. The project release gate documented in the hybrid roadmap still applies. Passing CI confirms code correctness, not trading edge. Shadow evidence and explicit owner approval are mandatory before production promotion.

## Current status

The data contract and deterministic unit tests are being added. No real historical candles or transaction cost assumptions are included in this repository change. A manual workflow will create an artifact on demand; collection results are not committed to Git.
