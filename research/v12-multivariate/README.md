# KINGBOT V12.1 — Overlap Repair and Context Ablation Research

This branch is a research-only follow-on to V12. It preserves the V9 baseline and the original V12 branch. It does not alter production inference, Render, broker integrations, customer accounts, or order execution.

## Research questions

1. Does deeper, paginated BTC history materially improve timestamp overlap with FX/gold data?
2. Does cross-market context help when restricted to source slots with sufficient coverage?
3. Is a target-only Transformer more reliable than feeding a sparse, heterogeneous 25-slot context panel?

## Data acquisition change

The research fetcher pages Binance BTCUSDT klines backwards in batches of up to 1,000 instead of accepting only one most-recent batch. It filters out any still-open candle and deduplicates timestamps before applying the shared history limit. Kraken remains a fallback and may still return a shorter history; the report records the source and actual date range for every series. BTCUSDT is a USDT-quoted proxy for the BTCUSD target label and is explicitly identified as such in source metadata.

The fetcher does not fabricate missing data or forward-fill absent markets. The model report includes each series' first/last feature and availability timestamps, so overlapping history and stale context can be inspected.

## Controlled ablations

All ablations use the same target rows, chronological fold masks, label purging, Transformer architecture, training budget, and one shared matched V9 prediction set:

- `target_only`: all cross-market context slots are masked.
- `high_coverage`: retain only context slots with at least 60% availability in the current training fold.
- `full_context`: retain every context slot that has any observations in the current training fold.

The high-coverage decision and full-context availability test use training rows only. Evaluation-window coverage cannot cause a slot to be selected. The high-coverage threshold is fixed at 0.60 before running the experiment.

The best eligible development ablation is selected using only the 70%-85% development window. That mode is frozen before the 85%-100% final window is evaluated. No final window is evaluated unless the chosen development candidate first passes the unchanged quality gates and the development comparison guard.

## Acceptance gates — unchanged

Balanced accuracy >=0.36, macro-F1 >=0.34, at least 30 final samples, and nonzero SELL/HOLD/BUY recall. Final selection additionally requires a selection-score improvement of at least 0.005 over the matched V9 baseline. No gate is weakened to force a pass.

## Scope and interpretation

The pilot remains one representative timeframe per specialist. Any candidate still requires all-timeframe validation, regime-separated analysis, execution-aware spread/slippage/commission backtesting, robust walk-forward validation, and shadow evaluation before any deployment discussion. No model weights are persisted, registered, promoted, or deployed.
