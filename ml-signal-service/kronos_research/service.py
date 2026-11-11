#!/usr/bin/env python3
"""Isolated KINGBOT Kronos forecast research service. Never places orders."""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import statistics
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

SERVICE_NAME = "KINGBOT KRONOS RESEARCH"
MODEL_ID = "NeoQuasar/Kronos-small"
TOKENIZER_ID = "NeoQuasar/Kronos-Tokenizer-base"
MODEL_REVISION = "901c26c1332695a2a8f243eb2f37243a37bea320"
TOKENIZER_REVISION = "0e0117387f39004a9016484a186a908917e22426"
UPSTREAM_COMMIT = "67b630e67f6a18c9e9be918d9b4337c960db1e9a"
MAX_CONTEXT = 512
MIN_CONTEXT = 64
MAX_INPUT_BARS = 2000
MAX_FORECAST_STEPS = 24
MIN_SAMPLES = 3
MAX_SAMPLES = 9
MAX_BODY_BYTES = 2_000_000
TIMEFRAME_MINUTES = {"5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440}

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "10002"))
ENABLED = os.getenv("KINGBOT_KRONOS_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}
SECRET = os.getenv("KINGBOT_KRONOS_SECRET", "").strip()
TORCH_THREADS = max(1, min(8, int(os.getenv("KINGBOT_KRONOS_TORCH_THREADS", "2"))))
MODEL_STATUS = "DISABLED" if not ENABLED else "NOT_LOADED"
MODEL_ERROR = ""
ENGINE: "KronosEngine | None" = None
ENGINE_LOCK = threading.Lock()
INFERENCE_LOCK = threading.Lock()


def _parse_timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"KRONOS_{field.upper()}_INVALID")
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"KRONOS_{field.upper()}_INVALID") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"KRONOS_{field.upper()}_TIMEZONE_REQUIRED")
    return parsed.astimezone(timezone.utc)


def _finite_number(value: Any, field: str, *, minimum: float | None = None) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"KRONOS_{field.upper()}_INVALID") from exc
    if not math.isfinite(number) or (minimum is not None and number < minimum):
        raise ValueError(f"KRONOS_{field.upper()}_INVALID")
    return number


def validate_request(payload: Any) -> dict[str, Any]:
    """Validate a research request without importing/loading ML dependencies."""
    if not isinstance(payload, dict):
        raise ValueError("KRONOS_PAYLOAD_INVALID")
    symbol = str(payload.get("symbol") or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9._/-]{2,24}", symbol):
        raise ValueError("KRONOS_SYMBOL_INVALID")
    timeframe = str(payload.get("timeframe") or "").strip().lower()
    if timeframe not in TIMEFRAME_MINUTES:
        raise ValueError("KRONOS_TIMEFRAME_UNSUPPORTED")

    raw_bars = payload.get("bars")
    if not isinstance(raw_bars, list) or not MIN_CONTEXT <= len(raw_bars) <= MAX_INPUT_BARS:
        raise ValueError("KRONOS_CONTEXT_BARS_OUT_OF_RANGE")

    bars: list[dict[str, float]] = []
    timestamps: list[datetime] = []
    for raw in raw_bars:
        if not isinstance(raw, dict):
            raise ValueError("KRONOS_BAR_INVALID")
        timestamp = _parse_timestamp(raw.get("timestamp"), "bar_timestamp")
        if timestamps and timestamp <= timestamps[-1]:
            raise ValueError("KRONOS_BAR_TIMESTAMPS_NOT_STRICTLY_INCREASING")
        timestamps.append(timestamp)
        candle = {
            "open": _finite_number(raw.get("open"), "open", minimum=1e-12),
            "high": _finite_number(raw.get("high"), "high", minimum=1e-12),
            "low": _finite_number(raw.get("low"), "low", minimum=1e-12),
            "close": _finite_number(raw.get("close"), "close", minimum=1e-12),
            "volume": _finite_number(raw.get("volume", 0.0), "volume", minimum=0.0),
        }
        if candle["high"] < max(candle["open"], candle["close"], candle["low"]):
            raise ValueError("KRONOS_OHLC_HIGH_INVARIANT_FAILED")
        if candle["low"] > min(candle["open"], candle["close"], candle["high"]):
            raise ValueError("KRONOS_OHLC_LOW_INVARIANT_FAILED")
        bars.append(candle)

    used_bars = bars[-MAX_CONTEXT:]
    used_timestamps = timestamps[-MAX_CONTEXT:]
    future_raw = payload.get("futureTimestamps")
    try:
        forecast_steps = int(payload.get("forecastSteps", len(future_raw) if isinstance(future_raw, list) else 12))
    except (TypeError, ValueError) as exc:
        raise ValueError("KRONOS_FORECAST_STEPS_INVALID") from exc
    if not 1 <= forecast_steps <= MAX_FORECAST_STEPS:
        raise ValueError("KRONOS_FORECAST_STEPS_OUT_OF_RANGE")
    if not isinstance(future_raw, list) or len(future_raw) != forecast_steps:
        raise ValueError("KRONOS_FUTURE_TIMESTAMPS_REQUIRED")

    future_timestamps = [_parse_timestamp(value, "future_timestamp") for value in future_raw]
    previous = used_timestamps[-1]
    for timestamp in future_timestamps:
        if timestamp <= previous:
            raise ValueError("KRONOS_FUTURE_TIMESTAMPS_NOT_STRICTLY_INCREASING")
        previous = timestamp

    try:
        sample_count = int(payload.get("samples", 5))
        seed = int(payload.get("seed", 20261111))
    except (TypeError, ValueError) as exc:
        raise ValueError("KRONOS_SAMPLE_OR_SEED_INVALID") from exc
    if not MIN_SAMPLES <= sample_count <= MAX_SAMPLES:
        raise ValueError("KRONOS_SAMPLE_COUNT_OUT_OF_RANGE")
    if not 0 <= seed <= 2**31 - 1:
        raise ValueError("KRONOS_SEED_INVALID")

    return {
        "symbol": symbol, "timeframe": timeframe, "bars": used_bars,
        "timestamps": used_timestamps, "inputBars": len(bars),
        "contextBars": len(used_bars), "futureTimestamps": future_timestamps,
        "forecastSteps": forecast_steps, "samples": sample_count, "seed": seed,
    }


def _quantile(values: list[float], q: float) -> float:
    ordered = sorted(float(value) for value in values)
    position = (len(ordered) - 1) * q
    lower, upper = math.floor(position), math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def aggregate_forecasts(
    paths: list[list[dict[str, float]]], future_timestamps: list[datetime]
) -> list[dict[str, Any]]:
    """Retain sample-path dispersion rather than averaging samples first."""
    if len(paths) < MIN_SAMPLES:
        raise ValueError("KRONOS_INSUFFICIENT_FORECAST_PATHS")
    if any(len(path) != len(future_timestamps) for path in paths):
        raise ValueError("KRONOS_FORECAST_PATH_LENGTH_MISMATCH")
    result: list[dict[str, Any]] = []
    for index, timestamp in enumerate(future_timestamps):
        candles = [path[index] for path in paths]
        closes = [float(candle["close"]) for candle in candles]
        median_open = statistics.median(float(c["open"]) for c in candles)
        median_close = statistics.median(closes)
        median_high = max(median_open, median_close, statistics.median(float(c["high"]) for c in candles))
        median_low = min(median_open, median_close, statistics.median(float(c["low"]) for c in candles))
        close_std = statistics.pstdev(closes)
        result.append({
            "timestamp": timestamp.isoformat().replace("+00:00", "Z"),
            "open": median_open, "high": median_high, "low": median_low,
            "close": median_close,
            "volume": max(0.0, statistics.median(float(c.get("volume", 0.0)) for c in candles)),
            "closeP10": _quantile(closes, 0.10),
            "closeP50": _quantile(closes, 0.50),
            "closeP90": _quantile(closes, 0.90),
            "closeStdDev": close_std,
            "closeSpreadPct": 100.0 * close_std / abs(median_close) if median_close else 0.0,
        })
    return result


class KronosEngine:
    def __init__(self, *, torch: Any, pandas: Any, predictor: Any):
        self.torch, self.pandas, self.predictor = torch, pandas, predictor

    def forecast(self, request: dict[str, Any]) -> list[dict[str, Any]]:
        columns = ["open", "high", "low", "close", "volume"]
        frame = self.pandas.DataFrame(request["bars"], columns=columns)
        frame["amount"] = 0.0
        x_timestamps = self.pandas.Series(request["timestamps"])
        y_timestamps = self.pandas.Series(request["futureTimestamps"])
        paths: list[list[dict[str, float]]] = []

        # Serialize inference and fork RNG state so research sampling is reproducible
        # without leaking seeded random state into other ML tasks in this process.
        with INFERENCE_LOCK:
            for sample_index in range(request["samples"]):
                with self.torch.random.fork_rng(devices=[]):
                    self.torch.manual_seed(request["seed"] + sample_index)
                    with self.torch.inference_mode():
                        frame_out = self.predictor.predict(
                            df=frame, x_timestamp=x_timestamps, y_timestamp=y_timestamps,
                            pred_len=request["forecastSteps"], T=1.0, top_k=0,
                            top_p=0.9, sample_count=1, verbose=False,
                        )
                path: list[dict[str, float]] = []
                for row in frame_out[columns].to_dict("records"):
                    candle = {
                        name: _finite_number(row.get(name), f"forecast_{name}", minimum=0.0)
                        for name in columns
                    }
                    if min(candle[name] for name in ("open", "high", "low", "close")) <= 0:
                        raise ValueError("KRONOS_FORECAST_PRICE_NON_POSITIVE")
                    candle["high"] = max(candle["high"], candle["open"], candle["close"], candle["low"])
                    candle["low"] = min(candle["low"], candle["open"], candle["close"])
                    path.append(candle)
                paths.append(path)
        return aggregate_forecasts(paths, request["futureTimestamps"])


def _load_engine() -> KronosEngine:
    global ENGINE, MODEL_STATUS, MODEL_ERROR
    if not ENABLED:
        raise RuntimeError("KRONOS_RESEARCH_DISABLED")
    if len(SECRET) < 32:
        raise RuntimeError("KRONOS_RESEARCH_SECRET_NOT_CONFIGURED")
    with ENGINE_LOCK:
        if ENGINE is not None:
            return ENGINE
        MODEL_STATUS = "LOADING"
        try:
            import torch
            import pandas as pd

            vendor_root = str(Path(__file__).resolve().parent / "vendor")
            if vendor_root not in sys.path:
                sys.path.insert(0, vendor_root)
            from model import Kronos, KronosPredictor, KronosTokenizer  # type: ignore[import-not-found]

            torch.set_num_threads(TORCH_THREADS)
            tokenizer = KronosTokenizer.from_pretrained(TOKENIZER_ID, revision=TOKENIZER_REVISION)
            model = Kronos.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
            tokenizer.eval()
            model.eval()
            predictor = KronosPredictor(model, tokenizer, device="cpu", max_context=MAX_CONTEXT)
            ENGINE = KronosEngine(torch=torch, pandas=pd, predictor=predictor)
            MODEL_STATUS, MODEL_ERROR = "READY", ""
            return ENGINE
        except Exception as exc:
            MODEL_STATUS = "ERROR"
            MODEL_ERROR = f"{type(exc).__name__}: {str(exc)[:160]}"
            raise RuntimeError("KRONOS_MODEL_LOAD_FAILED") from exc


class Handler(BaseHTTPRequestHandler):
    server_version = "KINGBOT-Kronos-Research/0.1"

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {SECRET}" if SECRET else ""
        return bool(expected) and hmac.compare_digest(supplied, expected)

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send(404, {"ok": False, "error": "NOT_FOUND"})
            return
        self._send(200, {
            "ok": True, "service": SERVICE_NAME, "enabled": ENABLED,
            "modelStatus": MODEL_STATUS, "model": MODEL_ID, "modelRevision": MODEL_REVISION,
            "tokenizer": TOKENIZER_ID, "tokenizerRevision": TOKENIZER_REVISION,
            "upstreamCommit": UPSTREAM_COMMIT, "device": "cpu",
            "researchOnly": True, "executionEligible": False,
        })

    def do_POST(self) -> None:
        if self.path != "/forecast":
            self._send(404, {"ok": False, "error": "NOT_FOUND"})
            return
        if not self._authorized():
            self._send(401, {"ok": False, "error": "KRONOS_UNAUTHORIZED"})
            return
        if not ENABLED:
            self._send(503, {"ok": False, "error": "KRONOS_RESEARCH_DISABLED"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY_BYTES:
                self._send(413, {"ok": False, "error": "KRONOS_PAYLOAD_SIZE_INVALID"})
                return
            raw = self.rfile.read(length)
            if len(raw) != length:
                self._send(400, {"ok": False, "error": "KRONOS_PAYLOAD_TRUNCATED"})
                return
            payload = json.loads(raw.decode("utf-8"))
            request = validate_request(payload)
            started = time.perf_counter()
            forecasts = _load_engine().forecast(request)
            inference_ms = round((time.perf_counter() - started) * 1000.0, 2)
            input_hash = hashlib.sha256(
                json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest()
            last_close, projected_close = request["bars"][-1]["close"], forecasts[-1]["close"]
            self._send(200, {
                "ok": True, "service": SERVICE_NAME, "stage": "KRONOS_FORECAST_RESEARCH",
                "researchOnly": True, "executionEligible": False,
                "symbol": request["symbol"], "timeframe": request["timeframe"],
                "inputBars": request["inputBars"], "contextBars": request["contextBars"],
                "forecastSteps": request["forecastSteps"], "samplePaths": request["samples"],
                "inputHash": input_hash, "lastObservedClose": last_close,
                "projectedCloseChangePct": round((projected_close / last_close - 1.0) * 100.0, 6),
                "inferenceMs": inference_ms, "forecast": forecasts,
                "model": {
                    "id": MODEL_ID, "revision": MODEL_REVISION,
                    "tokenizerId": TOKENIZER_ID, "tokenizerRevision": TOKENIZER_REVISION,
                    "upstreamCommit": UPSTREAM_COMMIT, "device": "cpu",
                },
                "disclaimer": "Forecast research only. Not a BUY/SELL signal, not execution approval, and not a guarantee of future prices.",
            })
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send(400, {"ok": False, "error": "KRONOS_JSON_INVALID"})
        except ValueError as exc:
            self._send(422, {"ok": False, "error": str(exc)[:180]})
        except RuntimeError as exc:
            self._send(503, {"ok": False, "error": str(exc)[:180]})
        except Exception as exc:
            self._send(500, {"ok": False, "error": "KRONOS_INTERNAL_ERROR", "reason": str(exc)[:160]})

    def log_message(self, fmt: str, *args: Any) -> None:
        print("[KINGBOT KRONOS]", fmt % args)


def main() -> None:
    global MODEL_STATUS
    if ENABLED and len(SECRET) < 32:
        MODEL_STATUS = "SECRET_NOT_CONFIGURED"
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    server.allow_reuse_address = True
    print(f"{SERVICE_NAME} listening on {HOST}:{PORT}; enabled={ENABLED}; executionEligible=false")
    server.serve_forever()


if __name__ == "__main__":
    main()
