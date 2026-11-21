# KINGBOT Kronos Forecast Research Specialist

**Status: isolated research service; disabled by default; no trading execution.**

This component adapts the supplied Kronos source into a local-only research endpoint. It does not replace or modify the existing KINGBOT AI Strategies champion models, model-artifact store, Cortex analysis, risk governor, broker integration, or execution worker.

## Design

- Upstream implementation is vendored from `shiyu-coder/Kronos` commit `67b630e67f6a18c9e9be918d9b4337c960db1e9a` under the included MIT licence.
- Pretrained `NeoQuasar/Kronos-small` and `NeoQuasar/Kronos-Tokenizer-base` are loaded at immutable Hugging Face revisions recorded in `service.py`, matching the revisions used by the upstream CPU regression tests.
- CPU-only inference is the default. Model weights are downloaded lazily on the first forecast and cached under `/models`.
- The adapter runs independent single-sample forecasts and retains the paths. This avoids the upstream predictor's built-in averaging of multiple samples before downstream uncertainty analysis.
- Output includes median OHLC, close P10/P50/P90, close-path standard deviation, spread percentage, model revisions, input hash, and inference duration.
- The caller must supply explicit future timestamps. This avoids making the model guess FX weekend, market-session, or holiday calendars.
- The service accepts timezone-aware, strictly increasing OHLC bars only. It limits inference context to the most recent 512 bars and forecast length to 24 bars.
- The service returns forecast research only. It does not generate BUY/SELL/HOLD labels, position sizes, entries, stop-losses, or execution approvals.

## Run through KINGBOT local Compose

Set these in `.env.local`:

```text
KINGBOT_KRONOS_ENABLED=1
KINGBOT_KRONOS_SECRET=<a unique random secret of at least 32 characters>
KINGBOT_KRONOS_TORCH_THREADS=2
```

Do not reuse a production secret. Start only the research profile:

```powershell
docker compose --env-file .env.local -f compose.local.yaml --profile research up -d --build kronos-research
```

The endpoint is mapped to `127.0.0.1:10002` only:

- `GET http://localhost:10002/health`
- `POST http://localhost:10002/forecast`

The first actual forecast downloads model weights from Hugging Face and can take longer than subsequent requests. Keep the service disabled when not researching.

## Request contract

`POST /forecast`, header `Authorization: Bearer <KINGBOT_KRONOS_SECRET>`:

```json
{
  "symbol": "XAUUSD",
  "timeframe": "5m",
  "forecastSteps": 3,
  "samples": 5,
  "seed": 123,
  "bars": [
    {
      "timestamp": "2026-11-10T08:00:00Z",
      "open": 2500.0,
      "high": 2501.0,
      "low": 2499.5,
      "close": 2500.5,
      "volume": 120.0
    }
  ],
  "futureTimestamps": [
    "2026-11-10T08:05:00Z",
    "2026-11-10T08:10:00Z",
    "2026-11-10T08:15:00Z"
  ]
}
```

The example shows the shape only; a real request must contain at least 64 valid historical candles and exactly `forecastSteps` future timestamps. Timestamps must include a UTC offset or `Z`. Bars must be chronological and satisfy OHLC invariants. Session-aware future timestamps must be produced by the trusted KINGBOT market-data/calendar layer.

## Validation and promotion policy

Run unit tests:

```powershell
python -m unittest discover -s ml-signal-service/kronos_research -p "test_*.py" -v
```

The initial stage validates request integrity, service isolation, reproducible sampling, and output structure. It does **not** establish predictive quality. A separate research experiment must compare Kronos with the matched V9 baseline on the same symbols, timeframes, forecast horizon, fees/spread/slippage assumptions and untouched future test windows. Keep all existing acceptance gates unchanged:

- balanced accuracy >= 0.36;
- macro-F1 >= 0.34;
- at least 30 final test observations;
- nonzero SELL, HOLD and BUY recall;
- at least +0.005 matched V9 selection-score improvement;
- stability across periods/regimes and cost-aware simulation.

Forecast-only validation metrics (MAE, RMSE, directional accuracy, interval coverage and calibration) are additional diagnostics, not substitutes for the trading-model acceptance gates. Do not promote or connect forecasts to order execution until research passes and separate approval is given.

## Security and data boundaries

- Compose binds the port to loopback; do not publish this port to the internet.
- Authenticated POST requests require a unique local shared secret.
- The service has no DB connection, no broker keys, no persistence of customer or market data, and no execution client.
- Do not send live broker credentials or account identifiers in research payloads.
- Keep `.env.local` out of Git. Store Hugging Face cache and local data on a secured device.
- No production, Render, Supabase, V9/V10 champion, or broker configuration is changed by this component.

## Upstream attribution

The vendored model implementation is from [shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos), commit `67b630e67f6a18c9e9be918d9b4337c960db1e9a`, copyright ShiYu 2025, MIT License. Model weights remain hosted separately by the upstream Hugging Face model repositories and retain their own model-card terms.
