# KINGBOT V10 Intelligence Research

This directory contains an isolated research challenger. It is not part of live
signal inference and does not write to the model artifact store.

## First pilot

Five representative specialist/timeframe combinations are tested:

- Strategic / 1h
- Flipper / 5m
- Breakout / 15m
- SMC-Pro / 15m
- Ladder-Flip / 15m

Each candidate uses 32-bar sequences of the existing causal, strategy-masked V9
OHLC features and a small three-block causal temporal convolutional network.

## Validation

The 70%-85% purged development window is used only for advancement screening.
The final 85%-100% window is kept untouched. The existing V9 RF/PyTorch MLP
ensemble is evaluated on the same terminal rows, labels, sample set and fold
masks so the comparison is paired.

Acceptance keeps the existing gates unchanged: balanced accuracy >= 0.36,
macro-F1 >= 0.34, at least 30 final test samples, and nonzero recall for SELL,
HOLD and BUY. A research candidate must also beat the matched V9 baseline
selection score by at least 0.005 on the untouched final window.

This is classification research, not a trading-profit claim. It does not include
spread/commission/slippage-aware order simulation, walk-forward live paper
trading, deployment, model persistence or promotion. A pass on one timeframe
does not establish that a complete specialist bot is ready across its three
required timeframes.
