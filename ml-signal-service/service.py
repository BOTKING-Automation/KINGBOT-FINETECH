#!/usr/bin/env python3
"""
KINGBOT ML Signal Service
Purpose: supervised market-signal generation inside the AI STRATEGIES stage.

The service never places orders. It trains strategy-specific classifiers on
verified OHLC bars supplied by the KINGBOT market-data service and returns
BUY / SELL / HOLD probabilities from a scikit-learn + PyTorch ensemble.
"""
from __future__ import annotations

import hmac
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
from sklearn.metrics import accuracy_score, balanced_accuracy_score, f1_score
from sklearn.preprocessing import StandardScaler
from torch import nn


HOST = "0.0.0.0"
PORT = int(os.getenv("PORT", "10000"))
SECRET = os.getenv("KINGBOT_ML_SIGNAL_SECRET", "").strip()
MAX_BODY_BYTES = max(64_000, int(os.getenv("KINGBOT_ML_MAX_BODY_BYTES", "1500000")))
MIN_BARS = max(120, int(os.getenv("KINGBOT_ML_MIN_BARS", "150")))
FORWARD_HORIZON = max(1, int(os.getenv("KINGBOT_ML_FORWARD_BARS", "3")))
LABEL_ATR = float(os.getenv("KINGBOT_ML_LABEL_ATR", "0.35"))
MAX_MODELS = max(10, int(os.getenv("KINGBOT_ML_MAX_MODELS", "50")))
MAX_MARKETS = max(1, int(os.getenv("KINGBOT_ML_MAX_MARKETS", "12")))
MAX_BARS_PER_MARKET = max(MIN_BARS, min(1500, int(os.getenv("KINGBOT_ML_MAX_BARS_PER_MARKET", "1000"))))
MAX_RF_TREES = max(40, min(300, int(os.getenv("KINGBOT_ML_RF_TREES", "120"))))
TORCH_EPOCHS = max(10, min(150, int(os.getenv("KINGBOT_ML_TORCH_EPOCHS", "40"))))
TORCH_THREADS = max(1, min(8, int(os.getenv("KINGBOT_ML_TORCH_THREADS", "1"))))
MAX_PREDICTIONS = max(2, min(64, int(os.getenv("KINGBOT_ML_MAX_PREDICTIONS", "16"))))
MAX_CONCURRENT_TRAINING = max(1, min(2, int(os.getenv("KINGBOT_ML_MAX_CONCURRENT_TRAINING", "1"))))
TRAINING_KEYS: set[str] = set()
TRAINING_SEMAPHORE = threading.BoundedSemaphore(MAX_CONCURRENT_TRAINING)
PREDICTION_SEMAPHORE = threading.BoundedSemaphore(MAX_PREDICTIONS)
MAX_FEEDBACK_ROWS = max(200, min(10000, int(os.getenv("KINGBOT_ML_MAX_FEEDBACK_ROWS", "4000"))))
MIN_FEEDBACK_RETRAIN = max(20, min(500, int(os.getenv("KINGBOT_ML_MIN_FEEDBACK_RETRAIN", "60"))))
FEEDBACK_ROWS: list[dict[str, Any]] = []
FEEDBACK_VERSION = "online-feedback-v1"

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
CHALLENGERS: dict[str, dict[str, Any]] = {}
LOCK = threading.Lock()
torch.set_num_threads(TORCH_THREADS)
torch.set_num_interop_threads(max(1, min(4, TORCH_THREADS)))


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



def apply_strategy_focus(features: list[float], strategy: str) -> list[float]:
    focus = STRATEGY_FOCUS.get(strategy, set())
    # Each bot gets the same stable feature schema, but its own model is
    # explicitly weighted toward strategy-relevant evidence. Non-focus
    # features remain available at reduced strength so models can still learn
    # cross-factor interactions without becoming identical clones.
    return [
        float(value) if name in focus else float(value) * 0.25
        for name, value in zip(FEATURE_NAMES, features)
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
        features = apply_strategy_focus(features, strategy)
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


def train_torch(
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_test: np.ndarray,
    y_test: np.ndarray,
    scaler: StandardScaler,
    sample_weights: np.ndarray,
) -> tuple[MLP, dict[str, float]]:
    np.random.seed(42)
    torch.manual_seed(42)
    train_x = scaler.transform(X_train).astype(np.float32)
    test_x = scaler.transform(X_test).astype(np.float32)
    train_y = np.asarray([LABEL_TO_INDEX[int(value)] for value in y_train], dtype=np.int64)
    test_y = np.asarray([LABEL_TO_INDEX[int(value)] for value in y_test], dtype=np.int64)
    train_w = np.asarray(sample_weights, dtype=np.float32)

    model = MLP(train_x.shape[1], 3)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.008, weight_decay=0.001)

    counts = np.bincount(train_y, minlength=3).astype(np.float32)
    class_weights = np.where(counts > 0, len(train_y) / np.maximum(counts, 1.0), 0.0)
    class_weights = class_weights / max(class_weights[class_weights > 0].mean(), 1.0)
    loss_fn = nn.CrossEntropyLoss(weight=torch.tensor(class_weights, dtype=torch.float32), reduction="none")

    tx = torch.from_numpy(train_x)
    ty = torch.from_numpy(train_y)
    tw = torch.from_numpy(train_w)

    model.train()
    for _ in range(TORCH_EPOCHS):
        optimizer.zero_grad()
        logits = model(tx)
        losses = loss_fn(logits, ty)
        loss = (losses * tw).mean()
        loss.backward()
        optimizer.step()

    model.eval()
    with torch.no_grad():
        predictions = model(torch.from_numpy(test_x)).argmax(dim=1).numpy() if len(test_x) else np.empty((0,), dtype=np.int64)
    metrics = {
        "accuracy": float(accuracy_score(test_y, predictions)) if len(test_y) else 0.0,
        "balancedAccuracy": float(balanced_accuracy_score(test_y, predictions)) if len(test_y) else 0.0,
        "macroF1": float(f1_score(test_y, predictions, average="macro", zero_division=0)) if len(test_y) else 0.0,
    }
    return model, metrics


def ensemble_probabilities(
    rf: RandomForestClassifier,
    torch_model: MLP,
    scaler: StandardScaler,
    X: np.ndarray,
) -> np.ndarray:
    if len(X) == 0:
        return np.empty((0, 3), dtype=np.float32)
    scaled = scaler.transform(X).astype(np.float32)
    rf_raw = rf.predict_proba(scaled)
    rf_probs = np.zeros((len(X), 3), dtype=np.float32)
    for row_index, row in enumerate(rf_raw):
        row_map = {int(label): float(prob) for label, prob in zip(rf.classes_, row)}
        rf_probs[row_index] = [row_map.get(label, 0.0) for label in LABELS]
    torch_model.eval()
    with torch.no_grad():
        torch_probs = torch.softmax(
            torch_model(torch.from_numpy(scaled)), dim=1
        ).numpy().astype(np.float32)
    probs = rf_probs * 0.55 + torch_probs * 0.45
    return (probs / np.maximum(probs.sum(axis=1, keepdims=True), 1e-12)).astype(np.float32)


def fit_temperature(probs: np.ndarray, y_true: np.ndarray) -> tuple[float, float]:
    if len(probs) < 20:
        return 1.0, float("inf")
    targets = np.asarray([LABEL_TO_INDEX[int(value)] for value in y_true], dtype=np.int64)
    best_temperature = 1.0
    best_loss = float("inf")
    for temperature in np.linspace(0.50, 3.00, 51):
        logits = np.log(np.clip(probs, 1e-6, 1.0)) / float(temperature)
        logits -= logits.max(axis=1, keepdims=True)
        calibrated = np.exp(logits)
        calibrated /= np.maximum(calibrated.sum(axis=1, keepdims=True), 1e-12)
        loss = -float(np.mean(np.log(np.clip(
            calibrated[np.arange(len(targets)), targets], 1e-6, 1.0
        ))))
        if loss < best_loss:
            best_loss = loss
            best_temperature = float(temperature)
    return best_temperature, best_loss


def apply_temperature(probs: np.ndarray, temperature: float) -> np.ndarray:
    if len(probs) == 0:
        return probs
    temperature = max(float(temperature), 0.05)
    logits = np.log(np.clip(probs, 1e-6, 1.0)) / temperature
    logits -= logits.max(axis=1, keepdims=True)
    calibrated = np.exp(logits)
    calibrated /= np.maximum(calibrated.sum(axis=1, keepdims=True), 1e-12)
    return calibrated.astype(np.float32)


def probability_metrics(probs: np.ndarray, y_true: np.ndarray) -> dict[str, float]:
    if len(probs) == 0:
        return {"logLoss": 0.0, "brier": 0.0, "ece": 0.0}
    targets = np.asarray([LABEL_TO_INDEX[int(value)] for value in y_true], dtype=np.int64)
    clipped = np.clip(probs, 1e-6, 1.0)
    log_loss = -float(np.mean(np.log(clipped[np.arange(len(targets)), targets])))
    one_hot = np.eye(3, dtype=np.float32)[targets]
    brier = float(np.mean(np.sum((probs - one_hot) ** 2, axis=1)))
    confidence = probs.max(axis=1)
    predictions = probs.argmax(axis=1)
    ece = 0.0
    edges = np.linspace(0.0, 1.0, 11)
    for lower, upper in zip(edges[:-1], edges[1:]):
        mask = (confidence >= lower) & ((confidence < upper) if upper < 1.0 else (confidence <= upper))
        if not np.any(mask):
            continue
        accuracy = float(np.mean(predictions[mask] == targets[mask]))
        ece += float(np.mean(mask)) * abs(accuracy - float(np.mean(confidence[mask])))
    return {"logLoss": log_loss, "brier": brier, "ece": ece}


def normalize_market_bars(bars: Any) -> list[dict[str, float]]:
    if not isinstance(bars, list):
        raise ValueError("ML_MARKET_BARS_INVALID")
    rows: list[dict[str, float]] = []
    for bar in bars:
        if not isinstance(bar, dict):
            continue
        o = finite(bar.get("open"))
        h = finite(bar.get("high"))
        l = finite(bar.get("low"))
        close = finite(bar.get("close"))
        volume = finite(bar.get("volume"))
        if not all(math.isfinite(v) and v > 0 for v in (o, h, l, close)):
            continue
        if h < max(o, l, close) or l > min(o, h, close):
            continue
        rows.append({
            "open": o,
            "high": h,
            "low": l,
            "close": close,
            "volume": max(volume, 0.0),
        })
    if len(rows) > MAX_BARS_PER_MARKET:
        rows = rows[-MAX_BARS_PER_MARKET:]
    return rows


def train_model(strategy: str, timeframe: str, markets: list[dict[str, Any]]) -> dict[str, Any]:
    key = f"{strategy}:{timeframe.lower()}"
    if not TRAINING_SEMAPHORE.acquire(blocking=False):
        raise RuntimeError("ML_TRAINING_CAPACITY_BUSY")
    with LOCK:
        if key in TRAINING_KEYS:
            TRAINING_SEMAPHORE.release()
            raise RuntimeError("ML_TRAINING_IN_PROGRESS")
        TRAINING_KEYS.add(key)

    try:
        if not isinstance(markets, list) or not markets:
            raise ValueError("ML_TRAIN_PAYLOAD_REQUIRED")
        if len(markets) > MAX_MARKETS:
            raise ValueError(f"ML_TRAINING_MAX_MARKETS_{MAX_MARKETS}")

        train_x_parts: list[np.ndarray] = []
        train_y_parts: list[np.ndarray] = []
        train_w_parts: list[np.ndarray] = []
        test_x_parts: list[np.ndarray] = []
        test_y_parts: list[np.ndarray] = []
        calibration_x_parts: list[np.ndarray] = []
        calibration_y_parts: list[np.ndarray] = []
        validation_markets: list[dict[str, Any]] = []
        total_bar_count = 0
        accepted_markets = 0

        for market in markets:
            if not isinstance(market, dict):
                continue
            symbol = str(market.get("symbol") or "").strip().upper()
            if not symbol or not isinstance(market.get("bars"), list):
                continue

            normalized = normalize_market_bars(market["bars"])
            if len(normalized) < MIN_BARS:
                continue

            accepted_markets += 1
            total_bar_count += len(normalized)
            X_part, y_part, weights_part = bars_to_training_arrays(normalized, strategy)
            if len(X_part) < 90:
                validation_markets.append({
                    "symbol": symbol,
                    "accepted": False,
                    "reason": "ML_TRAINING_MARKET_SAMPLES_INSUFFICIENT"
                })
                continue

            train_end = max(45, int(len(X_part) * 0.70))
            calibration_end = max(train_end + 15, int(len(X_part) * 0.85))
            if calibration_end >= len(X_part):
                calibration_end = len(X_part) - 15
            X_train_part = X_part[:train_end]
            X_calibration_part = X_part[train_end:calibration_end]
            X_test_part = X_part[calibration_end:]
            y_train_part = y_part[:train_end]
            y_calibration_part = y_part[train_end:calibration_end]
            y_test_part = y_part[calibration_end:]
            w_train_part = weights_part[:train_end]

            if (
                len(X_calibration_part) < 15
                or len(X_test_part) < 15
                or len(set(int(v) for v in y_train_part)) < 3
            ):
                validation_markets.append({
                    "symbol": symbol,
                    "accepted": False,
                    "reason": "ML_TRAINING_WALK_FORWARD_SPLIT_INSUFFICIENT"
                })
                continue

            train_x_parts.append(X_train_part)
            train_y_parts.append(y_train_part)
            train_w_parts.append(w_train_part)
            calibration_x_parts.append(X_calibration_part)
            calibration_y_parts.append(y_calibration_part)
            test_x_parts.append(X_test_part)
            test_y_parts.append(y_test_part)
            validation_markets.append({
                "symbol": symbol,
                "accepted": True,
                "samples": int(len(X_part)),
                "trainSamples": int(len(X_train_part)),
                "calibrationSamples": int(len(X_calibration_part)),
                "testSamples": int(len(X_test_part))
            })

        if not train_x_parts or not test_x_parts:
            raise ValueError(f"ML_TRAINING_REQUIRES_{MIN_BARS}_BARS")

        X_train = np.concatenate(train_x_parts, axis=0)
        y_train = np.concatenate(train_y_parts, axis=0)
        weights_train = np.concatenate(train_w_parts, axis=0)
        X_test = np.concatenate(test_x_parts, axis=0)
        y_test = np.concatenate(test_y_parts, axis=0)
        X_calibration = np.concatenate(calibration_x_parts, axis=0)
        y_calibration = np.concatenate(calibration_y_parts, axis=0)

        # Fold settled live-trade feedback into the supervised dataset.
        # Feedback is only used on a subsequent training cycle, keeping live
        # execution read-only and making the learning loop auditable.
        with LOCK:
            feedback = [
                row for row in FEEDBACK_ROWS
                if str(row.get("strategy")) == strategy
                and str(row.get("timeframe")) == timeframe.lower()
                and isinstance(row.get("features"), list)
            ][-MAX_FEEDBACK_ROWS:]
        if feedback:
            feedback_x = np.asarray([row["features"] for row in feedback], dtype=np.float32)
            feedback_y = np.asarray([int(row["label"]) for row in feedback], dtype=np.int64)
            feedback_w = np.asarray([1.5 if row.get("outcome") in {"WIN","LOSS"} else 1.0 for row in feedback], dtype=np.float32)
            if feedback_x.ndim == 2 and feedback_x.shape[1] == len(FEATURE_NAMES):
                X_train = np.concatenate([X_train, feedback_x], axis=0)
                y_train = np.concatenate([y_train, feedback_y], axis=0)
                weights_train = np.concatenate([weights_train, feedback_w], axis=0)

        if len(X_train) < 70 or len(X_calibration) < 30 or len(X_test) < 30:
            raise ValueError("ML_TRAINING_FEATURES_INSUFFICIENT")

        train_classes = sorted(set(int(v) for v in y_train))
        test_classes = sorted(set(int(v) for v in y_test))
        if len(train_classes) < 3:
            raise ValueError("ML_TRAINING_REQUIRES_BUY_SELL_HOLD_TRAIN_CLASSES")
        if len(test_classes) < 2:
            raise ValueError("ML_TRAINING_REQUIRES_DIRECTIONAL_TEST_CLASSES")

        scaler = StandardScaler()
        scaler.fit(X_train)
        X_train_scaled = scaler.transform(X_train).astype(np.float32)
        X_test_scaled = scaler.transform(X_test).astype(np.float32)

        rf = RandomForestClassifier(
            n_estimators=MAX_RF_TREES,
            max_depth=7,
            min_samples_leaf=4,
            random_state=42,
            class_weight="balanced_subsample",
            n_jobs=1,
        )
        rf.fit(X_train_scaled, y_train, sample_weight=weights_train)

        rf_pred = rf.predict(X_test_scaled)
        rf_metrics = {
            "accuracy": float(accuracy_score(y_test, rf_pred)),
            "balancedAccuracy": float(balanced_accuracy_score(y_test, rf_pred)),
            "macroF1": float(f1_score(y_test, rf_pred, average="macro", zero_division=0)),
        }

        torch_model, torch_metrics = train_torch(
            X_train, y_train, X_test, y_test, scaler, weights_train
        )

        calibration_raw = ensemble_probabilities(rf, torch_model, scaler, X_calibration)
        test_raw = ensemble_probabilities(rf, torch_model, scaler, X_test)
        temperature, calibration_log_loss = fit_temperature(calibration_raw, y_calibration)
        test_probs = apply_temperature(test_raw, temperature)
        test_pred = np.asarray(
            [LABELS[int(index)] for index in test_probs.argmax(axis=1)],
            dtype=np.int64,
        )
        ensemble_metrics = {
            "accuracy": float(accuracy_score(y_test, test_pred)),
            "balancedAccuracy": float(balanced_accuracy_score(y_test, test_pred)),
            "macroF1": float(f1_score(y_test, test_pred, average="macro", zero_division=0)),
        }
        probability_metrics_result = probability_metrics(test_probs, y_test)
        calibration_metrics = probability_metrics(calibration_raw, y_calibration)

        quality_gate = (
            ensemble_metrics["balancedAccuracy"] >= 0.36
            and ensemble_metrics["macroF1"] >= 0.34
            and probability_metrics_result["brier"] <= 0.70
            and probability_metrics_result["ece"] <= 0.20
            and len(X_calibration) >= 30
            and len(X_test) >= 30
        )
        if not quality_gate:
            raise ValueError(
                "ML_MODEL_QUALITY_GATE_FAILED:"
                f"balanced={ensemble_metrics['balancedAccuracy']:.3f},"
                f"f1={ensemble_metrics['macroF1']:.3f},"
                f"test={len(X_test)}"
            )

        candidate_score = (
            ensemble_metrics["balancedAccuracy"] * 0.60
            + ensemble_metrics["macroF1"] * 0.40
        )
        with LOCK:
            incumbent = MODELS.get(key)
            incumbent_score = float(incumbent.get("selection_score", 0.0)) if incumbent else 0.0
        promote = incumbent is None or candidate_score >= incumbent_score - 0.0025
        trained_at = time.time()
        with LOCK:
            model_record = {
                "rf": rf,
                "torch": torch_model,
                "scaler": scaler,
                "temperature": float(temperature),
                "trained_at": trained_at,
                "strategy": strategy,
                "symbols": sorted(
                    {row["symbol"] for row in validation_markets if row.get("accepted")}
                ),
                "timeframe": timeframe.lower(),
                "samples": int(len(X_train) + len(X_test)),
                "train_samples": int(len(X_train)),
                "test_samples": int(len(X_test)),
                "rf_accuracy": rf_metrics["accuracy"],
                "rf_balanced_accuracy": rf_metrics["balancedAccuracy"],
                "rf_macro_f1": rf_metrics["macroF1"],
                "torch_accuracy": torch_metrics["accuracy"],
                "torch_balanced_accuracy": torch_metrics["balancedAccuracy"],
                "torch_macro_f1": torch_metrics["macroF1"],
                "ensemble_accuracy": ensemble_metrics["accuracy"],
                "ensemble_balanced_accuracy": ensemble_metrics["balancedAccuracy"],
                "ensemble_macro_f1": ensemble_metrics["macroF1"],
                "probability_log_loss": probability_metrics_result["logLoss"],
                "probability_brier": probability_metrics_result["brier"],
                "probability_ece": probability_metrics_result["ece"],
                "calibration_log_loss": calibration_log_loss,
                "calibration_ece": calibration_metrics["ece"],
                "temperature": float(temperature),
                "quality_gate": quality_gate,
                "bar_count": total_bar_count,
                "feature_version": "ai-strategies-v4-walk-forward",
                "validation": {
                    "type": "per-market-temporal-train-calibration-test",
                    "trainFraction": 0.70,
                    "calibrationFraction": 0.15,
                    "testFraction": 0.15,
                    "probabilityCalibration": "temperature-scaling",
                    "markets": validation_markets,
                },
                "selection_score": candidate_score,
                "promotion": "CHAMPION" if promote else "CHALLENGER",
                "promoted_at": trained_at if promote else None,
                "feedbackVersion": FEEDBACK_VERSION,
                "feedbackRowsUsed": len(feedback),
            }
            if promote:
                MODELS[key] = model_record
            else:
                CHALLENGERS[key] = model_record
            while len(MODELS) > MAX_MODELS:
                oldest = min(MODELS.items(), key=lambda item: item[1]["trained_at"])[0]
                MODELS.pop(oldest, None)

        return {
            **model_status(key),
            "candidate": {
                "selectionScore": candidate_score,
                "promotion": "CHAMPION" if promote else "CHALLENGER",
                "incumbentSelectionScore": incumbent_score,
            },
            "dataset": {
                "marketsAccepted": accepted_markets,
                "symbols": sorted(
                    {row["symbol"] for row in validation_markets if row.get("accepted")}
                ),
                "bars": total_bar_count,
                "trainSamples": int(len(X_train)),
                "testSamples": int(len(X_test)),
                "classesTrain": train_classes,
                "classesTest": test_classes,
                "forwardBars": FORWARD_HORIZON,
                "labelAtr": LABEL_ATR,
            },
            "validation": {
                "type": "per-market-temporal-holdout",
                "rf": rf_metrics,
                "pytorch": torch_metrics,
                "ensemble": ensemble_metrics,
                "qualityGate": quality_gate,
            },
        }
    finally:
        with LOCK:
            TRAINING_KEYS.discard(key)
        TRAINING_SEMAPHORE.release()

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
        "trainSamples": item.get("train_samples", 0),
        "testSamples": item.get("test_samples", 0),
        "barCount": item["bar_count"],
        "rfAccuracy": round(item["rf_accuracy"] * 100.0, 2),
        "rfBalancedAccuracy": round(item.get("rf_balanced_accuracy", 0.0) * 100.0, 2),
        "rfMacroF1": round(item.get("rf_macro_f1", 0.0) * 100.0, 2),
        "torchAccuracy": round(item["torch_accuracy"] * 100.0, 2),
        "torchBalancedAccuracy": round(item.get("torch_balanced_accuracy", 0.0) * 100.0, 2),
        "torchMacroF1": round(item.get("torch_macro_f1", 0.0) * 100.0, 2),
        "ensembleAccuracy": round(item.get("ensemble_accuracy", 0.0) * 100.0, 2),
        "ensembleBalancedAccuracy": round(item.get("ensemble_balanced_accuracy", 0.0) * 100.0, 2),
        "ensembleMacroF1": round(item.get("ensemble_macro_f1", 0.0) * 100.0, 2),
        "probabilityLogLoss": round(float(item.get("probability_log_loss", 0.0)), 4),
        "probabilityBrier": round(float(item.get("probability_brier", 0.0)), 4),
        "probabilityECE": round(float(item.get("probability_ece", 0.0)), 4),
        "calibrationMethod": "temperature-scaling",
        "temperature": round(float(item.get("temperature", 1.0)), 4),
        "qualityGate": bool(item.get("quality_gate", False)),
        "validationType": item.get("validation", {}).get("type", "unknown"),
        "selectionScore": round(float(item.get("selection_score", 0.0)), 4),
        "promotion": item.get("promotion", "CHAMPION"),
        "feedbackVersion": item.get("feedbackVersion"),
        "feedbackRowsUsed": item.get("feedbackRowsUsed", 0),
        "featureVersion": item["feature_version"],
        "libraries": ["scikit-learn", "PyTorch"],
    }

def current_market_features(market: dict[str, Any], strategy: str) -> np.ndarray:
    price = finite(market.get("price") or market.get("close"))
    atr_value = max(finite(market.get("atr") or market.get("atr14")), 1e-12)
    ema_fast = finite(market.get("emaFast") or market.get("ema20"))
    ema_slow = finite(market.get("emaSlow") or market.get("ema50"))
    rsi_value = finite(market.get("rsi") or market.get("rsi14"), 50.0)
    adx_value = finite(market.get("adx") or market.get("adx14"))
    spread_atr = finite(market.get("spreadAtr") or (finite(market.get("spread")) / atr_value if atr_value > 0 else 0.0))
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
        clamp(abs(spread_atr), 0.0, 2.0) / 2.0,
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
    values = apply_strategy_focus(values, strategy)
    array = np.asarray([values], dtype=np.float32)
    if not np.isfinite(array).all():
        raise ValueError("ML_PREDICT_FEATURES_INVALID")
    return array


def record_feedback(
    strategy: str,
    symbol: str,
    timeframe: str,
    direction: str,
    outcome: str,
    market: dict[str, Any],
    pnl: float | None = None,
    r_multiple: float | None = None,
) -> dict[str, Any]:
    normalized_direction = str(direction or "").strip().upper()
    normalized_outcome = str(outcome or "").strip().upper()
    if normalized_direction not in {"BUY", "SELL"}:
        raise ValueError("ML_FEEDBACK_DIRECTION_INVALID")
    if normalized_outcome not in {"WIN", "LOSS", "BREAKEVEN", "INVALIDATED"}:
        raise ValueError("ML_FEEDBACK_OUTCOME_INVALID")
    if not isinstance(market, dict):
        raise ValueError("ML_FEEDBACK_MARKET_REQUIRED")

    features = current_market_features(market, strategy)[0].astype(float).tolist()
    label = 1 if normalized_direction == "BUY" else -1
    if normalized_outcome in {"LOSS", "INVALIDATED"}:
        label *= -1
    if normalized_outcome == "BREAKEVEN":
        label = 0

    row = {
        "strategy": strategy,
        "symbol": str(symbol or "").upper(),
        "timeframe": str(timeframe or "5m").lower(),
        "direction": normalized_direction,
        "outcome": normalized_outcome,
        "label": int(label),
        "features": features,
        "pnl": None if pnl is None else finite(pnl, 0.0),
        "rMultiple": None if r_multiple is None else finite(r_multiple, 0.0),
        "receivedAt": time.time(),
    }
    with LOCK:
        FEEDBACK_ROWS.append(row)
        if len(FEEDBACK_ROWS) > MAX_FEEDBACK_ROWS:
            del FEEDBACK_ROWS[:len(FEEDBACK_ROWS) - MAX_FEEDBACK_ROWS]

    return {
        "ok": True,
        "status": "ML_FEEDBACK_RECORDED",
        "strategy": strategy,
        "symbol": row["symbol"],
        "timeframe": row["timeframe"],
        "outcome": normalized_outcome,
        "label": label,
        "feedbackRows": len(FEEDBACK_ROWS),
        "retrainRecommended": len(FEEDBACK_ROWS) >= MIN_FEEDBACK_RETRAIN,
        "feedbackVersion": FEEDBACK_VERSION,
    }


def predict_model(strategy: str, symbol: str, timeframe: str, market: dict[str, Any]) -> dict[str, Any]:
    key = f"{strategy}:{timeframe.lower()}"
    with LOCK:
        item = MODELS.get(key)
    if not item:
        return {"ok": True, "ready": False, "status": "MODEL_NOT_READY", "modelKey": key}

    price = finite(market.get("price") or market.get("close"))
    atr_value = finite(market.get("atr") or market.get("atr14"))
    if price <= 0 or atr_value <= 0:
        raise ValueError("ML_PREDICT_MARKET_DATA_INVALID")
    if not PREDICTION_SEMAPHORE.acquire(timeout=0.8):
        return {"ok": True, "ready": False, "status": "ML_PREDICTION_CAPACITY_BUSY", "modelKey": key}
    try:
        if not bool(item.get("quality_gate", False)):
            return {"ok": True, "ready": False, "status": "MODEL_QUALITY_GATE_BLOCKED", "modelKey": key}
        X = current_market_features(market, strategy)
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
        probs = apply_temperature(probs.reshape(1, -1), float(item.get("temperature", 1.0)))[0]
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
                    "balancedAccuracy": round(item.get("rf_balanced_accuracy", 0.0) * 100.0, 2),
                    "macroF1": round(item.get("rf_macro_f1", 0.0) * 100.0, 2),
                    "weight": 0.55,
                },
                "pytorch": {
                    "accuracy": round(item["torch_accuracy"] * 100.0, 2),
                    "balancedAccuracy": round(item.get("torch_balanced_accuracy", 0.0) * 100.0, 2),
                    "macroF1": round(item.get("torch_macro_f1", 0.0) * 100.0, 2),
                    "weight": 0.45,
                },
            },
            "focusFeatures": focus_note,
            "focusScale": "1.00 focus / 0.25 non-focus",
            "modelKey": key,
            "featureVersion": item["feature_version"],
            "trainedAt": item["trained_at"],
            "generatedAt": time.time(),
        }
    finally:
        PREDICTION_SEMAPHORE.release()

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
        return hmac.compare_digest(provided, SECRET)

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
                "ready": bool(SECRET),
                "training": len(TRAINING_KEYS),
                "feedbackRows": len(FEEDBACK_ROWS),
                "feedbackVersion": FEEDBACK_VERSION,
                "championModels": len(MODELS),
                "challengerModels": len(CHALLENGERS),
                "maxModels": MAX_MODELS,
                "maxPredictions": MAX_PREDICTIONS,
                "maxConcurrentTraining": MAX_CONCURRENT_TRAINING,
                "rfTrees": MAX_RF_TREES,
                "torchEpochs": TORCH_EPOCHS,
                "torchThreads": TORCH_THREADS,
            })
            return
        if self.path == "/models":
            if not self._authorized():
                self._json(401, {"ok": False, "error": "ML_SERVICE_UNAUTHORIZED"})
                return
            with LOCK:
                statuses = []
                for key in MODELS:
                    item = model_status(key)
                    challenger = CHALLENGERS.get(key)
                    if challenger:
                        item["challenger"] = {
                            "trainedAt": challenger.get("trained_at"),
                            "selectionScore": round(float(challenger.get("selection_score", 0.0)), 4),
                            "balancedAccuracy": round(float(challenger.get("ensemble_balanced_accuracy", 0.0)) * 100.0, 2),
                            "macroF1": round(float(challenger.get("ensemble_macro_f1", 0.0)) * 100.0, 2),
                            "samples": challenger.get("samples", 0)
                        }
                    statuses.append(item)
            self._json(200, {"ok": True, "stage": "AI_STRATEGIES", "models": statuses, "challengers": len(CHALLENGERS)})
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

            if path == "/feedback":
                strategy = str(body.get("botId") or "").strip().lower()
                symbol = str(body.get("symbol") or "").strip().upper()
                timeframe = str(body.get("timeframe") or "5m").strip().lower()
                direction = str(body.get("direction") or "").strip().upper()
                outcome = str(body.get("outcome") or "").strip().upper()
                market = body.get("market")
                if strategy not in STRATEGY_FOCUS or not symbol or not isinstance(market, dict):
                    self._json(400, {"ok": False, "error": "ML_FEEDBACK_PAYLOAD_REQUIRED"})
                    return
                result = record_feedback(
                    strategy, symbol, timeframe, direction, outcome, market,
                    body.get("pnl"), body.get("rMultiple")
                )
                self._json(200, {"stage": "AI_STRATEGIES", **result})
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
        except RuntimeError as error:
            self._json(409, {"ok": False, "error": str(error)[:180]})
        except ValueError as error:
            self._json(422, {"ok": False, "error": str(error)[:180]})
        except Exception as error:
            self._json(500, {"ok": False, "error": "ML_INTERNAL_ERROR", "reason": str(error)[:180]})

    def log_message(self, format: str, *args: Any) -> None:
        print("[KINGBOT ML]", format % args)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    server.allow_reuse_address = True
    print(f"KINGBOT ML signal service listening on {HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
