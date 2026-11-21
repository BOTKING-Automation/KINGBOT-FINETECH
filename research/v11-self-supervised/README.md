# KINGBOT V11 — Self-Supervised Market Representation Research

This is an isolated research challenger. It does not modify the ML signal service, production V10, Render services, broker connections, or order execution.

## Research hypothesis

A Transformer encoder pretrained to reconstruct masked market time steps may learn reusable temporal representations that improve downstream SELL/HOLD/BUY classification compared with the matched V9 RF + PyTorch MLP ensemble.

## Method

- Build timestamped 32-bar sequences independently within each market; windows never cross symbol boundaries.
- Use existing V9 causal OHLC-derived strategy feature masks and labels.
- Apply global timestamp-aligned splits with forward-label purging.
- Pretrain using masked time-step reconstruction (20% masked) on training-fold windows only. Labels are not used in the self-supervised loss.
- Fine-tune the encoder for SELL/HOLD/BUY using only training-fold labels.
- Compare with V9 RF + PyTorch MLP 55/45 using the same samples, terminal-row features and fold masks.
- Development window: 70%-85%. Untouched final window: 85%-100%, evaluated only when development passes.
- Preserve existing gates: balanced accuracy >= 0.36, macro-F1 >= 0.34, >=30 test samples, and nonzero recall for SELL, HOLD and BUY.
- Additional final gate: selection score must exceed the matched V9 baseline by >=0.005.

## Scope and limitations

The pilot uses one representative timeframe per specialist, not all three timeframes. The first iteration uses OHLC-derived features, not tick/order-book data. Classification metrics do not establish profitability. A passing result still requires all-timeframe validation, regime-separated evaluation, spread/commission/slippage-aware backtesting and shadow evaluation.

No weights are saved, registered, promoted or deployed. No live trading is possible from this research package.
