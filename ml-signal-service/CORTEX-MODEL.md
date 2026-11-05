# KINGBOT CORTEX temporal decision model

## Decision authority

The primary market-direction model is `ATTENTION_GRU_CANDLE_SEQUENCE`, a PyTorch attention-pooled GRU. It consumes the most recent 48 completed OHLCV bars and predicts a three-class distribution:

- `SELL`: future price falls beyond the training ATR barrier.
- `HOLD`: the forward move remains inside the neutral barrier.
- `BUY`: future price rises beyond the training ATR barrier.

The target is derived from the forward close relative to the current close and the causal 14-bar true-range average. Future bars are used only to create training labels; they are not part of the input window.

## Model inputs

Each candle is represented by eight causal, scale-normalized values: log return, body/ATR, upper wick/ATR, lower wick/ATR, range/ATR, close location, relative volume and realized volatility. No hand-coded EMA, RSI, ADX, ICT or SMC threshold chooses the model direction.

The model uses a two-layer GRU, temporal attention pooling and a small classification head. The scaler is fitted on training windows only. Class-weighted cross entropy, gradient clipping and chronological holdout validation are used during training.

## Multi-timeframe inference

Each engine has its configured regime, setup and execution timeframes. CORTEX requests a separately trained temporal model for each of those timeframes. The execution timeframe must be ready, and at least two timeframe models must return valid probabilities. Probabilities are weighted and aggregated; directional consensus is reported separately.

The learned model chooses BUY, SELL or HOLD. Model confidence (default 48%) and directional-edge (default 4 percentage points) thresholds allow it to abstain. The Node gate also requires at least 55% weighted directional agreement across at least two ready timeframes, including the execution timeframe. These are model-output acceptance thresholds, not indicator entry rules. The Node gate does not use a legacy indicator candidate as a directional veto. The old strategy analysis remains in the worker for compatibility and diagnostics only.

## Model promotion

Temporal models are evaluated on a chronological holdout separated by a forward-label embargo. The sequence model must achieve at least 0.36 balanced accuracy and 0.34 macro-F1 on at least 30 holdout samples before it can be promoted. Candidate promotion compares the sequence model's balanced-accuracy/macro-F1 score with the current champion.

These thresholds are minimum engineering quality gates, not evidence of profitability. Deployment should use out-of-sample, broker-realistic backtests and demo-forward validation before live trading.

## Trade feedback

When broker reconciliation verifies a closed trade and its outcome, the worker sends the stored market context to the ML service. If the context contains 48 or more bars, its final 48-bar sequence is retained as labelled feedback. The next model training run may use that sequence in the training partition. Feedback is never added to the chronological holdout.

## Execution safety boundary

The ML service only returns predictions and never places broker orders. The worker still enforces account authorization, DEMO/LIVE account matching, kill switches, global pauses, stale-quote checks, spread limits, broker symbol specifications, position limits, risk budgets, stop distances and execution journaling. A model prediction is not permission to bypass these controls.

If model weights are not trained or market history is incomplete, CORTEX returns HOLD and the worker does not fall back to a deterministic signal for entry direction.

## Current operational limitation

Model objects and feedback samples are currently held in the ML service process memory. A process restart loses the in-memory models and feedback, so the configured historical training workflow must rebuild them. This change does not provision persistent model-artifact storage or deploy the service. A persistent artifact store and a verified production training-data pipeline should be added before relying on restarts, rollbacks or multi-instance serving.

## Required verification

Run the Python sequence tests, the five-engine model-training CI, Node syntax checks and the end-to-end Node-to-ML multi-timeframe test. Before live trading, also validate realistic historical data, spread/slippage/fees, walk-forward performance, model calibration, drift handling, reconnect behavior and demo execution with every supported broker.
