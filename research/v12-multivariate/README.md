# KINGBOT V12 — Cross-Market, Multi-Timeframe Transformer Research

This branch is a research-only challenger to the V9 RF/PyTorch benchmark. It does not alter the production ML signal service, Render, broker integrations, or order execution.

## Research hypothesis

A joint Transformer that reads a target instrument's recent 32-bar history together with as-of context tokens from other instruments and timeframes may learn cross-market dependencies that a single-series model cannot represent.

## Panel construction and leakage controls

- Reuse the same timestamped OHLC history and V9 causal strategy-masked feature/label generator.
- Build target sequences separately per symbol; windows never cross instruments.
- Context sources include all available symbols/timeframes: XAUUSD, EURUSD, GBPUSD, USDJPY, BTCUSD and 1m, 5m, 15m, 1h, 4h.
- A source candle becomes available only at its close (source timestamp plus timeframe duration). For each target candle, select the latest context row whose close is no later than the target candle close.
- Include log-compressed context staleness and mask unavailable or not-yet-closed context tokens.
- Use the existing V9 sample timestamps, forward-label end timestamps, global chronological splits and purge logic.
- Fit target and per-context-slot scalers on training-fold data only.
- Compare against V9 RF + PyTorch MLP 55/45 on the same target samples, terminal-row features and fold masks.
- Development window: 70%-85%; untouched final: 85%-100%, evaluated only if development quality and comparison guard pass.

## Acceptance

Preserve V9 gates: balanced accuracy >=0.36, macro-F1 >=0.34, at least 30 final samples, and nonzero recall for SELL, HOLD and BUY. The final candidate must also beat the matched V9 selection score by >=0.005.

## Scope

One representative timeframe per specialist is evaluated in the pilot, not all three production timeframes. A candidate still requires all-timeframe validation, regime-separated analysis, execution-aware cost backtesting and shadow evaluation. No model weights are persisted, registered, promoted or deployed.

Lightweight syntax/regression validation runs automatically. The compute-intensive five-pilot research workflow is separately gated by the run-v12-research pull-request label and is started only after the V11 report has been inspected.
