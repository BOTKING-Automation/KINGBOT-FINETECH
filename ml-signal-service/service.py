#!/usr/bin/env python3
"""
KINGBOT ML Signal Service
Purpose: supervised market-signal generation inside the AI STRATEGIES stage.

The service never places orders. It trains strategy-specific classifiers on
verified OHLC bars supplied by the KINGBOT market-data service and returns
BUY / SELL / HOLD probabilities from a scikit-learn + PyTorch ensemble.
"""
from __future__ import annotations

import json
import math
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import numpy as np
import torch
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score
from sklearn.preprocessing import StandardScaler
from torch import nn


HOST = "0.0.0.0"
PORT = int(os.getenv("PORT", "10000"))
SECRET = os.getenv("KINGBOT_ML_SIGNAL_SECRET", "").strip()
MAX_BODY_BYTES = 1_500_000
MIN_BARS = max(120, int(os.getenv("KINGBOT_ML_MIN_BARS", "150")))
FORWARD_HORIZON = max(1, int(os.getenv("KINGBOT_ML_FORWARD_BARS", "3")))
LABEL_ATR = float(os.getenv("KINGBOT_ML_LABEL_ATR", "0.35"))
MAX_MODELS = max(10, int(os.getenv("KINGBOT_ML_MAX_MODELS", "50")))

LABELS = [-1, 0, 1]
LABEL_TO_INDEX = {-1: 0, 0: 1, 1: 2}
INDEX_TO_LABEL = {0: -1, 1: 0, 2: 1}
FEATURE_NAMES = [
    "trend",
    "momentum",
    "volatility",
    "atr_pct",
    "rsi_norm",
    "adx_norm",
    "ema_gap",
    "spread_atr",
    "structure_bull",
    "structure_bear",
    "liquidity_sweep",
    "order_block",
    "fair_value_gap",
    "displacement",
    "breakout",
    "retest",
    "velocity",
]

STRATEGY_FOCUS = {
    "strategic": {"trend", "momentum", "volatility"},
    "flipper": {"momentum", "velocity", "spread_atr"},
    "breakout": {"breakout", "retest", "volatility", "momentum"},
    "smc-pro": {"structure_bull", "structure_bear", "liquidity_sweep", "order_block", "fair_value_gap", "displacement"},
    "ladder-flip": {"ema_gap", "adx_norm", "rsi_norm", "velocity", "spread_atr"},
}

MODELS: dict[str, dict[str, Any]] = {}
LOCK = threading.Lock()


def finite(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else fallback
    except (TypeError, ValueError):
        return fallback


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def ema(values: list[float], period: int) -> float | None:
    if len(values) < period:
        return None
    alpha = 2.0 / (period + 1.0)
    result = sum(values[:period]) / period
    for value in values[period:]:
        result = value * alpha + result * (1.0 - alpha)
    return result


def rsi(values: list[float], period: int = 14) -> float | None:
    if len(values) <= period:
        return None
    gain = 0.0
    loss = 0.0
    for index in range(1, period + 1):
        delta = values[index] - values[index - 1]
        gain += max(delta, 0.0)
        loss += max(-delta, 0.0)
    avg_gain = gain / period
    avg_loss = loss / period
    for index in range(period + 1, len(values)):
        delta = values[index] - values[index - 1]
        avg_gain = (avg_gain * (period - 1) + max(delta, 0.0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-delta, 0.0)) / period
    if avg_loss <= 1e-12:
        return 100.0
    return 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)


def atr(bars: list[dict[str, float]], period: int = 14) -> float | None:
    if len(bars) <= period:
        return None
    ranges: list[float] = []
    for index in range(1, len(bars)):
        high = bars[index]["high"]
        low = bars[index]["low"]
        previous_close = bars[index - 1]["close"]
        ranges.append(max(
            high - low,
            abs(high - previous_close),
            abs(low - previous_close),
        ))
    if len(ranges) < period:
        return None
    return float(sum(ranges[-period:]) / period)


def adx(bars: list[dict[str, float]], period: int = 14) -> float | None:
    if len(bars) < period * 3:
        return None
    trs: list[float] = []
    plus_dm: list[float] = []
    minus_dm: list[float] = []
    for index in range(1, len(bars)):
        high = bars[index]["high"]
        low = bars[index]["low"]
        prev_high = bars[index - 1]["high"]
        prev_low = bars[index - 1]["low"]
        prev_close = bars[index - 1]["close"]
        up = high - prev_high
        down = prev_low - low
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
        plus_dm.append(up if up > down and up > 0 else 0.0)
        minus_dm.append(down if down > up and down > 0 else 0.0)
    if len(trs) < period * 2:
        return None
    dx_values: list[float] = []
    for i in range(period, len(trs)):
        tr_sum = max(sum(trs[i - period + 1:i + 1]), 1e-12)
        plus = 100.0 * sum(plus_dm[i - period + 1:i + 1]) / tr_sum
        minus = 100.0 * sum(minus_dm[i - period + 1:i + 1]) / tr_sum
        total = plus + minus
        dx_values.append(100.0 * abs(plus - minus) / total if total else 0.0)
    return float(sum(dx_values[-period:]) / max(1, min(period, len(dx_values)))) if dx_values else None


def sma(values: list[float], period: int) -> float | None:
    if len(values) < period:
        return None
    return float(sum(values[-period:]) / period)


def bool_feature(value: Any) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    return 1.0 if str(value).strip().lower() in {"1", "true", "yes", "bullish", "bearish", "confirmed"} else 0.0


def extract_features_from_bars(bars: list[dict[str, float]], index: int) -> list[float] | None:
    window = bars[: index + 1]
    if len(window) < 60:
        return None
    closes = [b["close"] for b in window]
    highs = [b["high"] for b in window]
    lows = [b["low"] for b in window]
    opens = [b["open"] for b in window]

    price = closes[-1]
    ema20 = ema(closes, 20)
    ema50 = ema(closes, 50)
    rsi14 = rsi(closes, 14)
    atr14 = atr(window, 14)
    atr60 = atr(window, min(60, max(14, len(window) // 3)))
    adx14 = adx(window, 14)

    if not all(math.isfinite(x) and x > 0 for x in [price, ema20 or 0, ema50 or 0, atr14 or 0]):
        return None

    previous_close = closes[-2]
    roc5 = (price - closes[-6]) / max(abs(closes[-6]), 1e-12) if len(closes) >= 6 else 0.0
    momentum = clamp(
        ((rsi14 or 50.0) - 50.0) / 20.0 * 0.65
        + clamp(roc5 / 0.003, -1.0, 1.0) * 0.35,
        -1.0, 1.0,
    )
    volatility = clamp(((atr14 / max(atr60 or atr14, 1e-12)) / 1.8), 0.0, 1.0)
    trend = 1.0 if ema20 > ema50 and price > ema20 else -1.0 if ema20 < ema50 and price < ema20 else 0.0
    recent_high = max(highs[-20:-1])
    recent_low = min(lows[-20:-1])
    prior_high = max(highs[-40:-20])
    prior_low = min(lows[-40:-20])
    structure_bull = 1.0 if price > ema50 else 0.0
    structure_bear = 1.0 if price < ema50 else 0.0
    liquidity = 1.0 if (lows[-1] < recent_low and price > recent_low) or (highs[-1] > recent_high and price < recent_high) else 0.0
    fvg = 1.0 if len(bars) >= 4 and (lows[-1] > highs[-3] or highs[-1] < lows[-3]) else 0.0
    displacement = 1.0 if abs(price - opens[-1]) >= 1.25 * atr14 else 0.0
    breakout = 1.0 if price > recent_high or price < recent_low else 0.0
    retest = 1.0 if (price > recent_high and lows[-1] <= recent_high) or (price < recent_low and highs[-1] >= recent_low) else 0.0
    velocity = clamp((price - previous_close) / max(atr14, 1e-12), -2.0, 2.0) / 2.0
    ema_gap = clamp((ema20 - ema50) / max(price, 1e-12), -0.05, 0.05) / 0.01

    return [
        trend,
        momentum,
        volatility,
        clamp(atr14 / max(price, 1e-12) * 100.0, 0.0, 10.0) / 10.0,
        clamp(((rsi14 or 50.0) - 50.0) / 50.0, -1.0, 1.0),
        clamp((adx14 or 0.0) / 50.0, 0.0, 2.0),
        clamp(ema_gap, -5.0, 5.0) / 5.0,
        0.0,
        structure_bull,
        structure_bear,
        liquidity,
        0.0,
        fvg,
        displacement,
        breakout,
        retest,
        velocity,
    ]


def bars_to_training_arrays(bars: list[dict[str, float]], strategy: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rows: list[list[float]] = []
    labels: list[int] = []
    weights: list[float] = []
    focus = STRATEGY_FOCUS.get(strategy, set())

    for index in range(60, len(bars) - FORWARD_HORIZON):
        features = extract_features_from_bars(bars, index)
        if features is None:
            continue
        current = bars[index]["close"]
        current_atr = atr(bars[: index + 1], 14)
        future = bars[index + FORWARD_HORIZON]["close"]
        if current <= 0 or not current_atr or current_atr <= 0:
            continue
        move_in_atr = (future - current) / current_atr
        label = 1 if move_in_atr >= LABEL_ATR else -1 if move_in_atr <= -LABEL_ATR else 0

        # Slightly emphasize rows containing evidence relevant to the strategy.
        focus_strength = 0.0
        names = FEATURE_NAMES
        for name, value in zip(names, features):
            if name in focus and abs(value) > 0.15:
                focus_strength += 0.12
        rows.append(features)
        labels.append(label)
        weights.append(1.0 + min(0.6, focus_strength))

    if not rows:
        return np.empty((0, len(FEATURE_NAMES))), np.empty((0,), dtype=np.int64), np.empty((0,), dtype=np.float32)
    return np.asarray(rows, dtype=np.float32), np.asarray(labels, dtype=np.int64), np.asarray(weights, dtype=np.float32)


class MLP(nn.Module):
    def __init__(self, input_size: int, classes: int = 3):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_size, 32),
            nn.ReLU(),
            nn.LayerNorm(32),
            nn.Linear(32, 16),
            nn.ReLU(),
            nn.Linear(16, classes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


def train_torch(X: np.ndarray, y: np.ndarray, scaler: StandardScaler, sample_weights: np.ndarray) -> tuple[MLP, float]:
    np.random.seed(42)
    torch.manual_seed(42)
    Xs = scaler.transform(X).astype(np.float32)
    target = np.asarray([LABEL_TO_INDEX[int(value)] for value in y], dtype=np.int64)

    cutoff = max(20, int(len(Xs) * 0.78))
    train_x, test_x = Xs[:cutoff], Xs[cutoff:]
    train_y, test_y = target[:cutoff], target[cutoff:]
    train_w = sample_weights[:cutoff]

    model = MLP(Xs.shape[1], 3)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.008, weight_decay=0.001)

    counts = np.bincount(train_y, minlength=3).astype(np.float32)
    class_weights = np.where(counts > 0, len(train_y) / np.maximum(counts, 1.0), 0.0)
    class_weights = class_weights / max(class_weights[class_weights > 0].mean(), 1.0)
    loss_fn = nn.CrossEntropyLoss(weight=torch.tensor(class_weights, dtype=torch.float32), reduction="none")

    tx = torch.from_numpy(train_x)
    ty = torch.from_numpy(train_y)
    tw = torch.from_numpy(train_w)

    model.train()
    for _ in range(70):
        optimizer.zero_grad()
        logits = model(tx)
        losses = loss_fn(logits, ty)
        loss = (losses * tw).mean()
        loss.backward()
        optimizer.step()

    model.eval()
    with torch.no_grad():
        predictions = model(torch.from_numpy(test_x)).argmax(dim=1).numpy() if len(test_x) else np.empty((0,), dtype=np.int64)
    accuracy = float(accuracy_score(test_y, predictions)) if len(test_y) else 0.0
    return model, accuracy


def train_model(strategy: str, timeframe: str, markets: list[dict[str, Any]]) -> dict[str, Any]:
    combined_x: list[np.ndarray] = []
    combined_y: list[np.ndarray] = []
    combined_weights: list[np.ndarray] = []
    symbols: list[str] = []
    total_bar_count = 0

    for market in markets:
        symbol = str(market.get("symbol") or "").strip().upper()
        bars = market.get("bars")
        if not symbol or not isinstance(bars, list):
            continue
        normalized: list[dict[str, float]] = []
        for bar in bars[-320:]:
            try:
                row = {
                    "open": finite(bar.get("open")),
                    "high": finite(bar.get("high")),
                    "low": finite(bar.get("low")),
                    "close": finite(bar.get("close")),
                    "volume": finite(bar.get("volume")),
                }
                if row["high"] >= row["low"] > 0 and row["close"] > 0:
                    normalized.append(row)
            except AttributeError:
                continue

        if len(normalized) < MIN_BARS:
            continue
        total_bar_count += len(normalized)
        X_part, y_part, weights_part = bars_to_training_arrays(normalized, strategy)
        if len(X_part):
            combined_x.append(X_part)
            combined_y.append(y_part)
            combined_weights.append(weights_part)
            symbols.append(symbol)

    if not combined_x:
        raise ValueError(f"ML_TRAINING_REQUIRES_{MIN_BARS}_BARS")

    X = np.concatenate(combined_x, axis=0)
    y = np.concatenate(combined_y, axis=0)
    weights = np.concatenate(combined_weights, axis=0)
    if len(X) < 70:
        raise ValueError("ML_TRAINING_FEATURES_INSUFFICIENT")

    present = sorted(set(int(v) for v in y))
    if len(present) < 3:
        raise ValueError("ML_TRAINING_REQUIRES_BUY_SELL_HOLD_CLASSES")

    cutoff = max(20, int(len(X) * 0.78))
    scaler = StandardScaler()
    scaler.fit(X[:cutoff])

    rf = RandomForestClassifier(
        n_estimators=180,
        max_depth=7,
        min_samples_leaf=4,
        random_state=42,
        class_weight="balanced_subsample",
        n_jobs=1,
    )
    rf.fit(X[:cutoff], y[:cutoff], sample_weight=weights[:cutoff])

    rf_pred = rf.predict(X[cutoff:]) if cutoff < len(X) else np.empty((0,), dtype=np.int64)
    rf_accuracy = float(accuracy_score(y[cutoff:], rf_pred)) if len(rf_pred) else 0.0
    torch_model, torch_accuracy = train_torch(X, y, scaler, weights)

    key = f"{strategy}:{timeframe.lower()}"
    with LOCK:
        MODELS[key] = {
            "rf": rf,
            "torch": torch_model,
            "scaler": scaler,
            "trained_at": time.time(),
            "strategy": strategy,
            "symbols": sorted(set(symbols)),
            "timeframe": timeframe.lower(),
            "samples": int(len(X)),
            "rf_accuracy": rf_accuracy,
            "torch_accuracy": torch_accuracy,
            "bar_count": total_bar_count,
            "feature_version": "ai-strategies-v1",
        }
        while len(MODELS) > MAX_MODELS:
            oldest = min(MODELS.items(), key=lambda item: item[1]["trained_at"])[0]
            MODELS.pop(oldest, None)

    return model_status(key)


def model_status(key: str) -> dict[str, Any]:
    item = MODELS.get(key)
    if not item:
        return {"ready": False, "status": "MODEL_NOT_READY", "key": key}
    return {
        "ready": True,
        "status": "TRAINED",
        "key": key,
        "strategy": item["strategy"],
        "symbols": item["symbols"],
        "timeframe": item["timeframe"],
        "trainedAt": item["trained_at"],
        "samples": item["samples"],
        "barCount": item["bar_count"],
        "rfAccuracy": round(item["rf_accuracy"] * 100.0, 2),
        "torchAccuracy": round(item["torch_accuracy"] * 100.0, 2),
        "featureVersion": item["feature_version"],
        "libraries": ["scikit-learn", "PyTorch"],
    }


def current_market_features(market: dict[str, Any]) -> np.ndarray:
    price = finite(market.get("price") or market.get("close"))
    atr_value = max(finite(market.get("atr") or market.get("atr14")), 1e-12)
    ema_fast = finite(market.get("emaFast") or market.get("ema20"))
    ema_slow = finite(market.get("emaSlow") or market.get("ema50"))
    rsi_value = finite(market.get("rsi") or market.get("rsi14"), 50.0)
    adx_value = finite(market.get("adx") or market.get("adx14"))
    spread = finite(market.get("spread"))
    trend = clamp(finite(market.get("trend")), -1.0, 1.0)
    momentum = clamp(finite(market.get("momentum")), -1.0, 1.0)
    volatility = clamp(finite(market.get("volatility")), 0.0, 1.0)
    ema_gap = clamp((ema_fast - ema_slow) / max(price, 1e-12) if price > 0 else 0.0, -0.05, 0.05) / 0.01

    structure = str(market.get("structure") or "").lower()
    direction = 1.0 if ema_fast > ema_slow else -1.0 if ema_fast < ema_slow else 0.0
    velocity = clamp(finite(market.get("velocityPoints")) / max(atr_value, 1e-12), -2.0, 2.0) / 2.0

    values = [
        trend,
        momentum,
        volatility,
        clamp(atr_value / max(price, 1e-12) * 100.0, 0.0, 10.0) / 10.0,
        clamp((rsi_value - 50.0) / 50.0, -1.0, 1.0),
        clamp(adx_value / 50.0, 0.0, 2.0),
        clamp(ema_gap, -5.0, 5.0) / 5.0,
        clamp(abs(spread) / atr_value, 0.0, 2.0) / 2.0,
        1.0 if structure == "bullish" else 0.0,
        1.0 if structure == "bearish" else 0.0,
        bool_feature(market.get("liquiditySweep")),
        bool_feature(market.get("orderBlock")),
        bool_feature(market.get("fairValueGap") or market.get("fvg")),
        bool_feature(market.get("displacement")),
        bool_feature(market.get("breakout")),
        bool_feature(market.get("retest")),
        velocity if abs(velocity) > 0 else direction * momentum * 0.25,
    ]
    return np.asarray([values], dtype=np.float32)


def predict_model(strategy: str, symbol: str, timeframe: str, market: dict[str, Any]) -> dict[str, Any]:
    key = f"{strategy}:{timeframe.lower()}"
    with LOCK:
        item = MODELS.get(key)
    if not item:
        return {"ok": True, "ready": False, "status": "MODEL_NOT_READY", "modelKey": key}

    X = current_market_features(market)
    scaled = item["scaler"].transform(X).astype(np.float32)

    rf_prob = item["rf"].predict_proba(scaled)[0]
    rf_map = {int(label): float(prob) for label, prob in zip(item["rf"].classes_, rf_prob)}
    rf_probs = np.asarray([rf_map.get(label, 0.0) for label in LABELS], dtype=np.float32)

    item["torch"].eval()
    with torch.no_grad():
        torch_prob_raw = torch.softmax(item["torch"](torch.from_numpy(scaled)), dim=1).numpy()[0]
    torch_probs = np.asarray(torch_prob_raw, dtype=np.float32)

    probs = (rf_probs * 0.55 + torch_probs * 0.45)
    probs = probs / max(float(probs.sum()), 1e-12)
    best_index = int(np.argmax(probs))
    direction = int(INDEX_TO_LABEL[best_index])
    confidence = float(probs[best_index])
    signed_score = float((probs[2] - probs[0]) * 100.0)

    if confidence < 0.55 or abs(signed_score) < 12.0:
        direction = 0

    focus = STRATEGY_FOCUS.get(strategy, set())
    focus_note = ",".join(sorted(focus))

    return {
        "ok": True,
        "ready": True,
        "status": "LIVE_ML_SIGNAL",
        "strategy": strategy,
        "symbol": symbol.upper(),
        "timeframe": timeframe.lower(),
        "direction": "BUY" if direction > 0 else "SELL" if direction < 0 else "HOLD",
        "confidence": round(confidence * 100.0, 2),
        "score": round(signed_score, 2),
        "probabilities": {
            "sell": round(float(probs[0]) * 100.0, 2),
            "hold": round(float(probs[1]) * 100.0, 2),
            "buy": round(float(probs[2]) * 100.0, 2),
        },
        "models": {
            "scikitLearn": {
                "accuracy": round(item["rf_accuracy"] * 100.0, 2),
                "weight": 0.55,
            },
            "pytorch": {
                "accuracy": round(item["torch_accuracy"] * 100.0, 2),
                "weight": 0.45,
            },
        },
        "focusFeatures": focus_note,
        "modelKey": key,
        "featureVersion": item["feature_version"],
        "trainedAt": item["trained_at"],
        "generatedAt": time.time(),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "KINGBOT-ML/1.0"

    def _json(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _authorized(self) -> bool:
        if not SECRET:
            return False
        provided = self.headers.get("x-kingbot-ml-secret", "")
        return provided == SECRET

    def _body(self) -> dict[str, Any] | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {
                "ok": True,
                "service": "KINGBOT ML Signal Service",
                "stage": "AI_STRATEGIES",
                "purpose": "ML_SIGNAL_GENERATION",
                "libraries": ["scikit-learn", "PyTorch"],
                "modelsLoaded": len(MODELS),
                "configured": bool(SECRET),
            })
            return
        if self.path == "/models":
            if not self._authorized():
                self._json(401, {"ok": False, "error": "ML_SERVICE_UNAUTHORIZED"})
                return
            with LOCK:
                statuses = [model_status(key) for key in MODELS]
            self._json(200, {"ok": True, "stage": "AI_STRATEGIES", "models": statuses})
            return
        self._json(404, {"ok": False, "error": "NOT_FOUND"})

    def do_POST(self) -> None:
        if not self._authorized():
            self._json(401, {"ok": False, "error": "ML_SERVICE_UNAUTHORIZED"})
            return
        body = self._body()
        if body is None:
            self._json(400, {"ok": False, "error": "ML_PAYLOAD_INVALID"})
            return

        try:
            path = self.path.split("?", 1)[0]
            if path == "/train":
                strategy = str(body.get("botId") or "").strip().lower()
                timeframe = str(body.get("timeframe") or "5m").strip().lower()
                markets = body.get("markets")
                if not isinstance(markets, list):
                    symbol = str(body.get("symbol") or "").strip().upper()
                    bars = body.get("bars")
                    markets = [{"symbol": symbol, "bars": bars}] if symbol and isinstance(bars, list) else []
                if strategy not in STRATEGY_FOCUS:
                    self._json(400, {"ok": False, "error": "ML_STRATEGY_INVALID"})
                    return
                if not markets:
                    self._json(400, {"ok": False, "error": "ML_TRAIN_PAYLOAD_REQUIRED"})
                    return
                result = train_model(strategy, timeframe, markets)
                self._json(200, {"ok": True, "stage": "AI_STRATEGIES", **result})
                return

            if path == "/predict":
                strategy = str(body.get("botId") or "").strip().lower()
                symbol = str(body.get("symbol") or "").strip().upper()
                timeframe = str(body.get("timeframe") or "5m").strip().lower()
                market = body.get("market")
                if strategy not in STRATEGY_FOCUS or not symbol or not isinstance(market, dict):
                    self._json(400, {"ok": False, "error": "ML_PREDICT_PAYLOAD_REQUIRED"})
                    return
                result = predict_model(strategy, symbol, timeframe, market)
                self._json(200, {"stage": "AI_STRATEGIES", **result})
                return

            self._json(404, {"ok": False, "error": "NOT_FOUND"})
        except ValueError as error:
            self._json(422, {"ok": False, "error": str(error)[:180]})
        except Exception as error:
            self._json(500, {"ok": False, "error": "ML_INTERNAL_ERROR", "reason": str(error)[:180]})

    def log_message(self, format: str, *args: Any) -> None:
        print("[KINGBOT ML]", format % args)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"KINGBOT ML signal service listening on {HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
