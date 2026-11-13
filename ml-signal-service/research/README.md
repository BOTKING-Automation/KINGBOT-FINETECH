# KINGBOT V13 Advanced Intelligence Research

## Objective

Test whether a compact multivariate sequence Transformer improves the intelligence of KINGBOT's five existing specialist bots:

- Strategic
- Flipper
- Breakout
- SMC-Pro
- Ladder Flip

This is a research challenger, not a production model. It does not change live inference, model artifacts, broker connections, execution gates, Render configuration, or the current champion models.

## What is being compared

The challenger consumes 16 consecutive closed-candle feature rows and uses a two-layer Transformer encoder to classify SELL / HOLD / BUY. It reuses the incumbent feature extractor, strategy feature masks, and triple-barrier labels so the comparison remains tied to the current feature and target definitions.

The matched baseline is the current Random Forest + PyTorch MLP probability blend. Both approaches receive the same markets, timestamps, labels, training samples, development samples, and final samples.

## Validation design

A single shared UTC market window is used across the supplied symbols. Samples are partitioned chronologically into:

- 60% training period.
- 20% development period for early stopping and temperature calibration.
- 20% untouched future final period for the matched comparison.

Forward labels are purged at both split boundaries. The scaler is fitted only on training sequences. Final-period predictions are not used for model selection, early stopping, calibration, or threshold tuning.

The report includes balanced accuracy, macro-F1, per-class recall and support, NLL, multiclass Brier score, ECE, and final-period metrics by market regime.

The initial research gate retains KINGBOT's minimum balanced accuracy (0.36), macro-F1 (0.34), at least 30 final samples, and nonzero SELL/HOLD/BUY support and recall. The challenger must also beat the matched baseline selection score by at least 0.005 on the untouched final period.

A green CI run validates code and tests only. It does not demonstrate trading edge or approve a model. Passing this first experiment is not sufficient for shadow or production use: multiple non-overlapping walk-forward periods, regime robustness, cost-aware simulation, shadow deployment, and explicit approval remain mandatory.

## Input data

Supply a JSON file containing at least three synchronized market histories, each with timestamped, closed OHLC candles. Timestamps must be epoch seconds/milliseconds or ISO-8601 values. Keep each candle chronological and include positive open, high, low, and close values. Volume may be zero if the feed does not provide it.

Example shape:

~~~json
{
  "markets": [
    {
      "symbol": "XAUUSD",
      "bars": [
        {
          "time": 1790000000,
          "open": 2000.0,
          "high": 2001.0,
          "low": 1999.5,
          "close": 2000.5,
          "volume": 120
        }
      ]
    }
  ]
}
~~~

The example is only a schema illustration; one candle is not a trainable dataset. Do not commit broker credentials, client data, or private trading histories to the repository.

## Run the experiment

From the repository root, after installing the existing ML dependencies:

~~~bash
python ml-signal-service/research/v13_sequence_transformer.py --input /path/to/closed-candle-markets.json --strategy all --timeframe 5m --sequence-length 16 --epochs 18 --report /path/to/v13-sequence-transformer-report.json
~~~

Use --strategy strategic, flipper, breakout, smc-pro, or ladder-flip to run one specialist. Repeat with other available timeframe histories and record each data file's SHA-256 report value. Each invocation requires a sufficient common historical window across at least three markets.

## Status

PROMOTION_ALLOWED is always false in this package. No model artifact is saved, and no live signal path imports this module. A promising report authorizes only the next research stage.
