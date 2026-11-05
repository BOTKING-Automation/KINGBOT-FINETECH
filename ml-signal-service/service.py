#!/usr/bin/env python3
"""
KINGBOT ML Signal Service
Purpose: learned temporal market-direction inference inside KINGBOT CORTEX.

The service never places orders. Its primary decision model is a PyTorch
attention-GRU trained on causal OHLCV sequences and forward market outcomes.
Scikit-learn and the tabular PyTorch model remain auxiliary benchmarks.
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

from temporal_model import (
    SEQUENCE_LENGTH,
    TemporalGRU,
    bars_to_sequence_arrays,
    extract_bar_sequence_features,
    predict_temporal_probabilities,
    train_temporal_model,
)


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
RF_ENSEMBLE_WEIGHT = 0.55
TORCH_ENSEMBLE_WEIGHT = 0.45
MAX_PREDICTIONS = max(2, min(64, int(os.getenv("KINGBOT_ML_MAX_PREDICTIONS", "16"))))
MAX_CONCURRENT_TRAINING = max(1, min(2, int(os.getenv("KINGBOT_ML_MAX_CONCURRENT_TRAINING", "1"))))
TEMPORAL_MIN_CONFIDENCE = max(0.40, min(0.90, float(os.getenv("KINGBOT_ML_TEMPORAL_MIN_CONFIDENCE", "0.48"))))
TEMPORAL_MIN_EDGE = max(0.0, min(0.50, float(os.getenv("KINGBOT_ML_TEMPORAL_MIN_EDGE", "0.04"))))
TEMPORAL_EPOCHS = max(8, min(80, int(os.getenv("KINGBOT_ML_TEMPORAL_EPOCHS", "24"))))
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
    "relative_volume",
]

STRATEGY_FOCUS = {
    "strategic": {"trend", "momentum", "volatility"},
    # OHLC-only training has no historical bid/ask spread. Spread remains a
    # deterministic risk input rather than a live-only ML feature.
    "flipper": {"momentum", "velocity"},
    "breakout": {"breakout", "retest", "volatility", "momentum", "relative_volume"},
    "smc-pro": {"structure_bull", "structure_bear", "liquidity_sweep", "order_block", "fair_value_gap", "displacement"},
    "ladder-flip": {"ema_gap", "adx_norm", "rsi_norm", "velocity"},
}

REGIME_ORDER = ["trend", "range", "breakout", "reversal", "volatile"]
REGIME_RISK_MODE = {
    "trend": "aggressive",
    "breakout": "aggressive",
    "range": "neutral",
    "reversal": "cautious",
    "volatile": "defensive",
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


def detect_order_block_feature(bars: list[dict[str, float]], atr_value: float) -> float:
    """Reconstruct an observable OHLC order-block proxy from closed candles."""
    if len(bars) < 3 or not math.isfinite(atr_value) or atr_value <= 0:
        return 0.0

    last = bars[-1]
    candle_range = max(last["high"] - last["low"], 1e-12)
    body = abs(last["close"] - last["open"])
    close_location = (last["close"] - last["low"]) / candle_range
    direction = (
        1 if last["close"] > last["open"] and close_location >= 0.72
        else -1 if last["close"] < last["open"] and close_location <= 0.28
        else 0
    )
    if direction == 0 or body < atr_value * 1.15 or body / candle_range < 0.65:
        return 0.0

    start = max(0, len(bars) - 12)
    for index in range(len(bars) - 2, start - 1, -1):
        candidate = bars[index]
        impulse = bars[index + 1]
        if (
            direction > 0
            and candidate["close"] < candidate["open"]
            and impulse["close"] > candidate["high"]
            and impulse["close"] - candidate["high"] >= atr_value * 0.15
        ):
            return 1.0
        if (
            direction < 0
            and candidate["close"] > candidate["open"]
            and impulse["close"] < candidate["low"]
            and candidate["low"] - impulse["close"] >= atr_value * 0.15
        ):
            return 1.0
    return 0.0


def extract_features_from_bars(bars: list[dict[str, float]], index: int) -> list[float] | None:
    window = bars[: index + 1]
    if len(window) < 60:
        return None
    closes = [b["close"] for b in window]
    highs = [b["high"] for b in window]
    lows = [b["low"] for b in window]
    opens = [b["open"] for b in window]
    volumes = [b["volume"] for b in window]

    price = closes[-1]
    ema20 = ema(closes, 20)
    ema50 = ema(closes, 50)
    rsi14 = rsi(closes, 14)
    atr14 = atr(window, 14)
    atr60 = atr(window, min(60, max(14, len(window) // 3)))
    adx14 = adx(window, 14)

    if not all(math.isfinite(x) and x > 0 for x in [price, ema20 or 0, ema50 or 0, atr14 or 0]):
        return None

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
    structure_bull = 1.0 if price > ema50 else 0.0
    structure_bear = 1.0 if price < ema50 else 0.0
    liquidity = 1.0 if (lows[-1] < recent_low and price > recent_low) or (highs[-1] > recent_high and price < recent_high) else 0.0
    fvg = 1.0 if len(bars) >= 4 and (lows[-1] > highs[-3] or highs[-1] < lows[-3]) else 0.0
    displacement = 1.0 if abs(price - opens[-1]) >= 1.25 * atr14 else 0.0
    breakout = 1.0 if price > recent_high or price < recent_low else 0.0
    retest = 1.0 if (price > recent_high and lows[-1] <= recent_high) or (price < recent_low and highs[-1] >= recent_low) else 0.0
    velocity_move = (price - closes[-4]) / max(atr14, 1e-12) if len(closes) >= 4 else 0.0
    velocity = clamp(velocity_move, -2.0, 2.0) / 2.0
    order_block = detect_order_block_feature(window, atr14)
    # No historical bid/ask spread is included in OHLC datasets.
    spread_atr = 0.0
    mean_volume = sum(volumes[-21:-1]) / max(1, len(volumes[-21:-1]))
    relative_volume = clamp((volumes[-1] / mean_volume) / 2.0, 0.0, 1.0) if mean_volume > 0 else 0.0
    ema_gap = clamp((ema20 - ema50) / max(price, 1e-12), -0.05, 0.05) / 0.01

    return [
        trend,
        momentum,
        volatility,
        clamp(atr14 / max(price, 1e-12) * 100.0, 0.0, 10.0) / 10.0,
        clamp(((rsi14 or 50.0) - 50.0) / 50.0, -1.0, 1.0),
        clamp((adx14 or 0.0) / 50.0, 0.0, 2.0),
        clamp(ema_gap, -5.0, 5.0) / 5.0,
        spread_atr,
        structure_bull,
        structure_bear,
        liquidity,
        order_block,
        fvg,
        displacement,
        breakout,
        retest,
        velocity,
        relative_volume,
    ]


def apply_strategy_focus(features: list[float], strategy: str) -> list[float]:
    focus = STRATEGY_FOCUS.get(strategy, set())
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

        focus_strength = 0.0
        for name, value in zip(FEATURE_NAMES, features):
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


def detect_market_regime(market: dict[str, Any], strategy: str) -> str:
    if not isinstance(market, dict):
        return "range"

    explicit = str(market.get("regime") or "").strip().lower()
    if explicit in REGIME_ORDER:
        return explicit

    price = finite(market.get("price") or market.get("close"))
    atr_value = max(finite(market.get("atr") or market.get("atr14")), 1e-12)
    ema_fast = finite(market.get("emaFast") or market.get("ema20"))
    ema_slow = finite(market.get("emaSlow") or market.get("ema50"))
    momentum = clamp(finite(market.get("momentum")), -1.0, 1.0)
    volatility = clamp(finite(market.get("volatility")), 0.0, 1.0)
    adx_value = finite(market.get("adx") or market.get("adx14"), 0.0)
    velocity = clamp(finite(market.get("velocityPoints")) / max(atr_value / max(price, 1e-12), 1e-12), -2.0, 2.0)
    trend_bias = 1.0 if ema_fast > ema_slow else -1.0 if ema_fast < ema_slow else 0.0
    breakout_signal = bool_feature(market.get("breakout")) or bool_feature(market.get("breakoutScan"))
    range_signal = bool_feature(market.get("range")) or bool_feature(market.get("isRange"))
    structure = str(market.get("structure") or "").lower()

    if volatility > 0.8 and abs(momentum) < 0.35:
        return "volatile"
    if range_signal and adx_value < 22.5:
        return "range"
    if breakout_signal and abs(velocity) > 0.6:
        return "breakout"
    if adx_value >= 25.0 and abs(trend_bias) > 0.0:
        return "trend" if trend_bias > 0 else "reversal"
    if abs(momentum) < 0.22 and adx_value < 25.0:
        return "range"
    if momentum < -0.35:
        return "reversal"
    if structure in {"bullish", "bearish"} and abs(momentum) > 0.4:
        return "trend"
    return "trend" if trend_bias > 0 else "reversal" if trend_bias < 0 else "range"


def decide_action(probabilities: np.ndarray, regime: str, direction: int, confidence: float) -> tuple[str, str]:
    sell = float(probabilities[0])
    hold = float(probabilities[1])
    buy = float(probabilities[2])
    signed = buy - sell

    if confidence < 0.58:
        return "ABSTAIN", "low confidence"
    if regime == "volatile" and abs(signed) < 0.18:
        return "ABSTAIN", "volatile regime too unstable"
    if regime == "range" and abs(signed) < 0.16:
        return "HOLD", "range compression without conviction"
    if regime == "reversal" and abs(signed) < 0.14:
        return "HOLD", "reversal not confirmed"
    if regime == "breakout" and abs(signed) < 0.12:
        return "REDUCE", "breakout lacks follow-through"

    if direction > 0 and buy >= max(sell, hold) and buy > 0.36:
        return "BUY", "directional conviction in active regime"
    if direction < 0 and sell >= max(buy, hold) and sell > 0.36:
        return "SELL", "negative conviction in active regime"
    return "HOLD", "probability spread is not strong enough"


def temporal_split_bounds(sample_count: int, train_fraction: float = 0.78) -> tuple[int, int]:
    """Split chronologically and embargo overlapping forward labels."""
    split = max(40, min(sample_count - 20, int(sample_count * train_fraction)))
    train_end = split - FORWARD_HORIZON
    return train_end, split


def ensemble_probabilities(rf: Any, torch_model: nn.Module, scaled_features: np.ndarray) -> np.ndarray:
    """Return the RF/PyTorch probability blend used during live inference."""
    rf_raw = rf.predict_proba(scaled_features)
    rf_aligned = np.zeros((len(scaled_features), len(LABELS)), dtype=np.float32)
    for column, label in enumerate(rf.classes_):
        label_index = LABEL_TO_INDEX.get(int(label))
        if label_index is not None:
            rf_aligned[:, label_index] = rf_raw[:, column]

    torch_model.eval()
    with torch.no_grad():
        torch_raw = torch.softmax(
            torch_model(torch.from_numpy(np.asarray(scaled_features, dtype=np.float32))),
            dim=1,
        ).cpu().numpy().astype(np.float32)

    blended = rf_aligned * RF_ENSEMBLE_WEIGHT + torch_raw * TORCH_ENSEMBLE_WEIGHT
    return blended / np.maximum(blended.sum(axis=1, keepdims=True), 1e-12)


def ensemble_class_metrics(y_true: np.ndarray, probabilities: np.ndarray) -> dict[str, float]:
    predicted_indices = np.argmax(probabilities, axis=1)
    predicted = np.asarray([INDEX_TO_LABEL[int(value)] for value in predicted_indices], dtype=np.int64)
    return {
        "accuracy": float(accuracy_score(y_true, predicted)),
        "balancedAccuracy": float(balanced_accuracy_score(y_true, predicted)),
        "macroF1": float(f1_score(y_true, predicted, average="macro", zero_division=0)),
    }


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
        temporal_train_parts: list[np.ndarray] = []
        temporal_train_labels: list[np.ndarray] = []
        temporal_test_parts: list[np.ndarray] = []
        temporal_test_labels: list[np.ndarray] = []
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

            train_end, test_start = temporal_split_bounds(len(X_part))
            X_train_part, X_test_part = X_part[:train_end], X_part[test_start:]
            y_train_part, y_test_part = y_part[:train_end], y_part[test_start:]
            w_train_part = weights_part[:train_end]

            sequence_x, sequence_y = bars_to_sequence_arrays(
                normalized,
                horizon=FORWARD_HORIZON,
                atr_barrier=LABEL_ATR,
                sequence_length=SEQUENCE_LENGTH,
            )
            sequence_train_end, sequence_test_start = temporal_split_bounds(len(sequence_x))
            sequence_x_train = sequence_x[:sequence_train_end]
            sequence_x_test = sequence_x[sequence_test_start:]
            sequence_y_train = sequence_y[:sequence_train_end]
            sequence_y_test = sequence_y[sequence_test_start:]

            if (
                train_end < 40
                or len(X_test_part) < 20
                or len(set(int(v) for v in y_train_part)) < 3
                or sequence_train_end < 40
                or len(sequence_x_test) < 20
                or len(set(int(v) for v in sequence_y_train)) < 3
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
            test_x_parts.append(X_test_part)
            test_y_parts.append(y_test_part)
            temporal_train_parts.append(sequence_x_train)
            temporal_train_labels.append(sequence_y_train)
            temporal_test_parts.append(sequence_x_test)
            temporal_test_labels.append(sequence_y_test)
            validation_markets.append({
                "symbol": symbol,
                "accepted": True,
                "samples": int(len(X_part)),
                "trainSamples": int(len(X_train_part)),
                "testSamples": int(len(X_test_part)),
                "sequenceTrainSamples": int(len(sequence_x_train)),
                "sequenceTestSamples": int(len(sequence_x_test)),
                "embargoBars": int(test_start - train_end),
                "sequenceEmbargoBars": int(sequence_test_start - sequence_train_end)
            })

        if not train_x_parts or not test_x_parts or not temporal_train_parts or not temporal_test_parts:
            raise ValueError(f"ML_TRAINING_REQUIRES_{MIN_BARS}_BARS_AND_TEMPORAL_SAMPLES")

        X_temporal_train = np.concatenate(temporal_train_parts, axis=0)
        y_temporal_train = np.concatenate(temporal_train_labels, axis=0)
        X_temporal_test = np.concatenate(temporal_test_parts, axis=0)
        y_temporal_test = np.concatenate(temporal_test_labels, axis=0)

        X_train = np.concatenate(train_x_parts, axis=0)
        y_train = np.concatenate(train_y_parts, axis=0)
        weights_train = np.concatenate(train_w_parts, axis=0)
        X_test = np.concatenate(test_x_parts, axis=0)
        y_test = np.concatenate(test_y_parts, axis=0)

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
            feedback_w = np.asarray([1.5 if row.get("outcome") in {"WIN", "LOSS"} else 1.0 for row in feedback], dtype=np.float32)
            if feedback_x.ndim == 2 and feedback_x.shape[1] == len(FEATURE_NAMES):
                X_train = np.concatenate([X_train, feedback_x], axis=0)
                y_train = np.concatenate([y_train, feedback_y], axis=0)
                weights_train = np.concatenate([weights_train, feedback_w], axis=0)

            sequence_feedback = [
                row for row in feedback
                if isinstance(row.get("sequence"), list)
                and len(row["sequence"]) == SEQUENCE_LENGTH
            ]
            if sequence_feedback:
                feedback_sequence_x = np.asarray([row["sequence"] for row in sequence_feedback], dtype=np.float32)
                feedback_sequence_y = np.asarray([int(row["label"]) for row in sequence_feedback], dtype=np.int64)
                if feedback_sequence_x.ndim == 3 and feedback_sequence_x.shape[1:] == X_temporal_train.shape[1:]:
                    X_temporal_train = np.concatenate([X_temporal_train, feedback_sequence_x], axis=0)
                    y_temporal_train = np.concatenate([y_temporal_train, feedback_sequence_y], axis=0)

        if len(X_train) < 70 or len(X_test) < 30:
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

        ensemble_test_probabilities = ensemble_probabilities(rf, torch_model, X_test_scaled)
        ensemble_metrics = ensemble_class_metrics(y_test, ensemble_test_probabilities)

        temporal_model, temporal_scaler, temporal_metrics = train_temporal_model(
            X_temporal_train,
            y_temporal_train,
            X_temporal_test,
            y_temporal_test,
            epochs=TEMPORAL_EPOCHS,
        )

        # The temporal network, not indicator gates or the legacy shallow ensemble,
        # is the decision authority. A weak candidate is rejected and cannot be promoted.
        quality_gate = (
            temporal_metrics["balancedAccuracy"] >= 0.36
            and temporal_metrics["macroF1"] >= 0.34
            and len(X_temporal_test) >= 30
        )
        if not quality_gate:
            raise ValueError(
                "ML_TEMPORAL_MODEL_QUALITY_GATE_FAILED:"
                f"balanced={temporal_metrics['balancedAccuracy']:.3f},"
                f"f1={temporal_metrics['macroF1']:.3f},"
                f"test={len(X_temporal_test)}"
            )

        candidate_score = (
            temporal_metrics["balancedAccuracy"] * 0.60
            + temporal_metrics["macroF1"] * 0.40
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
                "temporal_model": temporal_model,
                "temporal_scaler": temporal_scaler,
                "temporal_balanced_accuracy": temporal_metrics["balancedAccuracy"],
                "temporal_macro_f1": temporal_metrics["macroF1"],
                "temporal_accuracy": temporal_metrics["accuracy"],
                "sequence_length": SEQUENCE_LENGTH,
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
                "temporal_balanced_accuracy": temporal_metrics["balancedAccuracy"],
                "temporal_macro_f1": temporal_metrics["macroF1"],
                "temporal_accuracy": temporal_metrics["accuracy"],
                "quality_gate": quality_gate,
                "bar_count": total_bar_count,
                "feature_version": "ai-strategies-v6-temporal-gru-primary",
                "decision_model": "ATTENTION_GRU_CANDLE_SEQUENCE",
                "validation": {
                    "type": "per-market-temporal-holdout-with-label-embargo",
                    "trainFraction": 0.78,
                    "embargoBars": FORWARD_HORIZON,
                    "markets": validation_markets,
                },
                "selection_score": candidate_score,
                "promotion": "CHAMPION" if promote else "CHALLENGER",
                "promoted_at": trained_at if promote else None,
                "feedbackVersion": FEEDBACK_VERSION,
                "feedbackRowsUsed": len(feedback),
                "regimeAware": False,
                "supportedRegimes": REGIME_ORDER,
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
                "temporalSequenceModel": temporal_metrics,
                "sequenceLength": SEQUENCE_LENGTH,
                "decisionAuthority": "ATTENTION_GRU_CANDLE_SEQUENCE",
                "qualityGate": quality_gate,
            },
            "regimeAware": False,
            "supportedRegimes": REGIME_ORDER,
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
        "temporalAccuracy": round(item.get("temporal_accuracy", 0.0) * 100.0, 2),
        "temporalBalancedAccuracy": round(item.get("temporal_balanced_accuracy", 0.0) * 100.0, 2),
        "temporalMacroF1": round(item.get("temporal_macro_f1", 0.0) * 100.0, 2),
        "sequenceLength": int(item.get("sequence_length", SEQUENCE_LENGTH)),
        "decisionModel": item.get("decision_model", "ATTENTION_GRU_CANDLE_SEQUENCE"),
        "qualityGate": bool(item.get("quality_gate", False)),
        "validationType": item.get("validation", {}).get("type", "unknown"),
        "selectionScore": round(float(item.get("selection_score", 0.0)), 4),
        "promotion": item.get("promotion", "CHAMPION"),
        "feedbackVersion": item.get("feedbackVersion"),
        "feedbackRowsUsed": item.get("feedbackRowsUsed", 0),
        "featureVersion": item["feature_version"],
        "libraries": ["scikit-learn", "PyTorch"],
        "regimeAware": bool(item.get("regimeAware", False)),
        "supportedRegimes": item.get("supportedRegimes", REGIME_ORDER),
    }


def current_market_features(market: dict[str, Any], strategy: str) -> np.ndarray:
    price = finite(market.get("price") or market.get("close"))
    atr_value = max(finite(market.get("atr") or market.get("atr14")), 1e-12)
    ema_fast = finite(market.get("emaFast") or market.get("ema20"))
    ema_slow = finite(market.get("emaSlow") or market.get("ema50"))
    rsi_value = finite(market.get("rsi") or market.get("rsi14"), 50.0)
    adx_value = finite(market.get("adx") or market.get("adx14"))
    # Historical OHLC training has no bid/ask spread; do not inject a
    # live-only spread value into the model's feature distribution.
    spread_atr = 0.0
    trend = clamp(finite(market.get("trend")), -1.0, 1.0)
    momentum = clamp(finite(market.get("momentum")), -1.0, 1.0)
    volatility = clamp(finite(market.get("volatility")), 0.0, 1.0)
    ema_gap = clamp((ema_fast - ema_slow) / max(price, 1e-12) if price > 0 else 0.0, -0.05, 0.05) / 0.01

    structure = str(market.get("structure") or "").lower()
    order_block_raw = market.get("orderBlock")
    order_block_present = bool(order_block_raw) if isinstance(order_block_raw, dict) else bool_feature(order_block_raw)
    velocity_atr = finite(market.get("velocityAtr"), finite(market.get("velocityPoints"), 0.0))
    velocity = clamp(velocity_atr, -2.0, 2.0) / 2.0
    relative_volume = clamp(finite(market.get("volume"), 0.0), 0.0, 1.0)

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
        1.0 if order_block_present else 0.0,
        bool_feature(market.get("fairValueGap") or market.get("fvg")),
        bool_feature(market.get("displacement")),
        bool_feature(market.get("breakout")),
        bool_feature(market.get("retest")),
        velocity,
        relative_volume,
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
    sequence = None
    raw_bars = market.get("bars")
    if isinstance(raw_bars, list):
        normalized_bars = normalize_market_bars(raw_bars)
        sequence_features, _ = extract_bar_sequence_features(normalized_bars)
        if len(sequence_features) >= SEQUENCE_LENGTH:
            sequence = sequence_features[-SEQUENCE_LENGTH:].astype(float).tolist()
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
        "sequence": sequence,
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

    bars = normalize_market_bars(market.get("bars"))
    if len(bars) < SEQUENCE_LENGTH:
        return {
            "ok": True,
            "ready": False,
            "status": "SEQUENCE_DATA_REQUIRED",
            "requiredBars": SEQUENCE_LENGTH,
            "receivedBars": len(bars),
            "modelKey": key,
        }
    if not PREDICTION_SEMAPHORE.acquire(timeout=0.8):
        return {"ok": True, "ready": False, "status": "ML_PREDICTION_CAPACITY_BUSY", "modelKey": key}
    try:
        if not bool(item.get("quality_gate", False)):
            return {"ok": True, "ready": False, "status": "MODEL_QUALITY_GATE_BLOCKED", "modelKey": key}
        if not item.get("temporal_model") or not item.get("temporal_scaler"):
            return {"ok": True, "ready": False, "status": "TEMPORAL_MODEL_NOT_READY", "modelKey": key}

        probs = predict_temporal_probabilities(item["temporal_model"], item["temporal_scaler"], bars)
        if probs is None:
            return {"ok": True, "ready": False, "status": "SEQUENCE_DATA_REQUIRED", "requiredBars": SEQUENCE_LENGTH, "receivedBars": len(bars), "modelKey": key}

        best_index = int(np.argmax(probs))
        best_confidence = float(probs[best_index])
        signed_score = float((probs[2] - probs[0]) * 100.0)
        directional_confidence = float(max(probs[0], probs[2]))
        directional_edge = directional_confidence - float(probs[1])

        # This is model-probability abstention, not an indicator/regime rule.
        # The model alone chooses BUY/SELL/HOLD; the backend risk governor
        # separately decides whether any proposed order is permitted.
        action = "HOLD"
        direction = 0
        action_reason = "learned sequence probabilities do not support a directional trade"
        if best_index in (0, 2) and best_confidence >= TEMPORAL_MIN_CONFIDENCE and directional_edge >= TEMPORAL_MIN_EDGE:
            direction = -1 if best_index == 0 else 1
            action = "SELL" if direction < 0 else "BUY"
            action_reason = "attention-GRU sequence prediction cleared the model confidence and directional-edge thresholds"

        return {
            "ok": True,
            "ready": True,
            "status": "LIVE_TEMPORAL_ML_SIGNAL",
            "strategy": strategy,
            "symbol": symbol.upper(),
            "timeframe": timeframe.lower(),
            "direction": "BUY" if direction > 0 else "SELL" if direction < 0 else "HOLD",
            "confidence": round(best_confidence * 100.0, 2),
            "directionalConfidence": round(directional_confidence * 100.0, 2),
            "directionalEdge": round(directional_edge * 100.0, 2),
            "score": round(signed_score, 2),
            "regime": "MODEL_INFERENCE",
            "riskMode": "DETERMINISTIC_RISK_GOVERNOR",
            "decision": action,
            "decisionReason": action_reason,
            "probabilities": {
                "sell": round(float(probs[0]) * 100.0, 2),
                "hold": round(float(probs[1]) * 100.0, 2),
                "buy": round(float(probs[2]) * 100.0, 2),
            },
            "models": {
                "primary": {
                    "name": "Attention GRU candle-sequence network",
                    "type": "DEEP_TEMPORAL_LEARNING",
                    "accuracy": round(item.get("temporal_accuracy", 0.0) * 100.0, 2),
                    "balancedAccuracy": round(item.get("temporal_balanced_accuracy", 0.0) * 100.0, 2),
                    "macroF1": round(item.get("temporal_macro_f1", 0.0) * 100.0, 2),
                    "sequenceLength": int(item.get("sequence_length", SEQUENCE_LENGTH)),
                    "decisionAuthority": True,
                },
                "auxiliaryBenchmarks": {
                    "randomForestBalancedAccuracy": round(item.get("rf_balanced_accuracy", 0.0) * 100.0, 2),
                    "tabularPytorchBalancedAccuracy": round(item.get("torch_balanced_accuracy", 0.0) * 100.0, 2),
                    "usedForDirection": False,
                },
            },
            "modelKey": key,
            "featureVersion": item["feature_version"],
            "decisionModel": item.get("decision_model", "ATTENTION_GRU_CANDLE_SEQUENCE"),
            "trainedAt": item["trained_at"],
            "generatedAt": time.time(),
            "decisionAuthority": "TEMPORAL_GRU_SEQUENCE_MODEL",
            "rulesBasedDirection": False,
            "regimeAware": False,
        }
    finally:
        PREDICTION_SEMAPHORE.release()

