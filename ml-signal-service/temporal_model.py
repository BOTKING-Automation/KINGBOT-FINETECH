"""Sequence-learning model for KINGBOT CORTEX.

The model consumes chronological OHLCV windows.  It does not use indicator
thresholds to choose a direction; BUY/SELL/HOLD probabilities are learned
from forward price outcomes on past windows.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
import torch
from sklearn.metrics import accuracy_score, balanced_accuracy_score, f1_score
from sklearn.preprocessing import StandardScaler
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

SEQUENCE_LENGTH = 48
SEQUENCE_FEATURE_NAMES = [
    "log_return",
    "body_atr",
    "upper_wick_atr",
    "lower_wick_atr",
    "range_atr",
    "close_location",
    "relative_volume",
    "realized_volatility",
]


def _finite(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else fallback
    except (TypeError, ValueError):
        return fallback


def extract_bar_sequence_features(
    bars: list[dict[str, Any]],
) -> tuple[np.ndarray, np.ndarray]:
    """Create causal, scale-normalized features for every completed candle."""
    if not isinstance(bars, list) or not bars:
        return np.empty((0, len(SEQUENCE_FEATURE_NAMES)), dtype=np.float32), np.empty((0,), dtype=np.float32)

    rows: list[list[float]] = []
    atr_values: list[float] = []
    true_ranges: list[float] = []
    returns: list[float] = []
    volumes: list[float] = []

    for index, bar in enumerate(bars):
        open_price = _finite(bar.get("open"))
        high = _finite(bar.get("high"))
        low = _finite(bar.get("low"))
        close = _finite(bar.get("close"))
        volume = max(0.0, _finite(bar.get("volume")))
        previous_close = _finite(bars[index - 1].get("close"), open_price) if index else open_price

        if min(open_price, high, low, close) <= 0 or high < max(open_price, low, close) or low > min(open_price, high, close):
            # normalize_market_bars normally removes these; keep this module defensive.
            rows.append([0.0] * len(SEQUENCE_FEATURE_NAMES))
            atr_values.append(0.0)
            true_ranges.append(0.0)
            returns.append(0.0)
            volumes.append(volume)
            continue

        true_range = max(high - low, abs(high - previous_close), abs(low - previous_close))
        true_ranges.append(true_range)
        atr_value = max(float(np.mean(true_ranges[-14:])), 1e-12)
        atr_values.append(atr_value)

        log_return = math.log(close / max(previous_close, 1e-12)) if previous_close > 0 else 0.0
        returns.append(log_return)
        candle_range = max(high - low, 1e-12)
        body = close - open_price
        upper_wick = high - max(open_price, close)
        lower_wick = min(open_price, close) - low
        close_location = ((close - low) / candle_range) * 2.0 - 1.0

        prior_volumes = volumes[max(0, index - 20):index]
        mean_volume = float(np.mean(prior_volumes)) if prior_volumes else volume
        relative_volume = math.log((volume + 1.0) / (mean_volume + 1.0))
        realized_volatility = float(np.std(returns[max(0, index - 11):index + 1])) * 100.0

        rows.append([
            float(np.clip(log_return * 100.0, -5.0, 5.0)),
            float(np.clip(body / atr_value, -3.0, 3.0)),
            float(np.clip(upper_wick / atr_value, 0.0, 3.0)),
            float(np.clip(lower_wick / atr_value, 0.0, 3.0)),
            float(np.clip(candle_range / atr_value, 0.0, 5.0)),
            float(np.clip(close_location, -1.0, 1.0)),
            float(np.clip(relative_volume, -3.0, 3.0)),
            float(np.clip(realized_volatility, 0.0, 5.0)),
        ])

        volumes.append(volume)

    features = np.asarray(rows, dtype=np.float32)
    atr_array = np.asarray(atr_values, dtype=np.float32)
    return np.nan_to_num(features, nan=0.0, posinf=0.0, neginf=0.0), atr_array


def bars_to_sequence_arrays(
    bars: list[dict[str, Any]],
    *,
    horizon: int = 3,
    atr_barrier: float = 0.35,
    sequence_length: int = SEQUENCE_LENGTH,
) -> tuple[np.ndarray, np.ndarray]:
    """Build samples where each input ends at t and labels only use t+horizon."""
    features, atr_values = extract_bar_sequence_features(bars)
    if len(features) <= sequence_length + horizon:
        return (
            np.empty((0, sequence_length, len(SEQUENCE_FEATURE_NAMES)), dtype=np.float32),
            np.empty((0,), dtype=np.int64),
        )

    windows: list[np.ndarray] = []
    labels: list[int] = []
    for index in range(sequence_length - 1, len(bars) - horizon):
        current = _finite(bars[index].get("close"))
        future = _finite(bars[index + horizon].get("close"))
        current_atr = float(atr_values[index])
        if current <= 0 or future <= 0 or current_atr <= 1e-12:
            continue

        move_in_atr = (future - current) / current_atr
        label = 1 if move_in_atr >= atr_barrier else -1 if move_in_atr <= -atr_barrier else 0
        windows.append(features[index - sequence_length + 1:index + 1])
        labels.append(label)

    if not windows:
        return (
            np.empty((0, sequence_length, len(SEQUENCE_FEATURE_NAMES)), dtype=np.float32),
            np.empty((0,), dtype=np.int64),
        )
    return np.asarray(windows, dtype=np.float32), np.asarray(labels, dtype=np.int64)


class TemporalGRU(nn.Module):
    """Attention-pooled GRU that learns patterns across candle sequences."""

    def __init__(self, input_size: int = len(SEQUENCE_FEATURE_NAMES), hidden_size: int = 48, classes: int = 3):
        super().__init__()
        self.encoder = nn.GRU(
            input_size=input_size,
            hidden_size=hidden_size,
            num_layers=2,
            batch_first=True,
            dropout=0.12,
        )
        self.attention = nn.Sequential(nn.Linear(hidden_size, 24), nn.Tanh(), nn.Linear(24, 1))
        self.head = nn.Sequential(
            nn.LayerNorm(hidden_size),
            nn.Linear(hidden_size, 32),
            nn.GELU(),
            nn.Dropout(0.15),
            nn.Linear(32, classes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        encoded, _ = self.encoder(x)
        weights = torch.softmax(self.attention(encoded).squeeze(-1), dim=1)
        pooled = torch.sum(encoded * weights.unsqueeze(-1), dim=1)
        return self.head(pooled)


def _class_index(label: int) -> int:
    return 0 if int(label) < 0 else 2 if int(label) > 0 else 1


def train_temporal_model(
    x_train: np.ndarray,
    y_train: np.ndarray,
    x_test: np.ndarray,
    y_test: np.ndarray,
    *,
    epochs: int = 24,
    batch_size: int = 64,
) -> tuple[TemporalGRU, StandardScaler, dict[str, float]]:
    if x_train.ndim != 3 or x_test.ndim != 3 or len(x_train) < 40 or len(x_test) < 20:
        raise ValueError("ML_TEMPORAL_TRAINING_DATA_INSUFFICIENT")
    if len(set(int(value) for value in y_train)) < 3 or len(set(int(value) for value in y_test)) < 2:
        raise ValueError("ML_TEMPORAL_CLASSES_INSUFFICIENT")

    scaler = StandardScaler()
    train_flat = x_train.reshape(-1, x_train.shape[-1])
    test_flat = x_test.reshape(-1, x_test.shape[-1])
    scaler.fit(train_flat)
    scaled_train = scaler.transform(train_flat).reshape(x_train.shape).astype(np.float32)
    scaled_test = scaler.transform(test_flat).reshape(x_test.shape).astype(np.float32)

    train_labels = np.asarray([_class_index(value) for value in y_train], dtype=np.int64)
    test_labels = np.asarray([_class_index(value) for value in y_test], dtype=np.int64)
    counts = np.bincount(train_labels, minlength=3).astype(np.float32)
    class_weights = np.where(counts > 0, len(train_labels) / np.maximum(counts, 1.0), 0.0)
    present = class_weights[class_weights > 0]
    class_weights = class_weights / max(float(present.mean()) if len(present) else 1.0, 1e-6)

    torch.manual_seed(73)
    np.random.seed(73)
    model = TemporalGRU(input_size=x_train.shape[-1])
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.0025, weight_decay=0.001)
    loss_fn = nn.CrossEntropyLoss(weight=torch.tensor(class_weights, dtype=torch.float32))
    dataset = TensorDataset(
        torch.from_numpy(scaled_train),
        torch.from_numpy(train_labels),
    )
    loader = DataLoader(dataset, batch_size=max(8, min(batch_size, len(dataset))), shuffle=True, drop_last=False)

    model.train()
    for _ in range(max(8, min(int(epochs), 80))):
        for batch_x, batch_y in loader:
            optimizer.zero_grad(set_to_none=True)
            logits = model(batch_x)
            loss = loss_fn(logits, batch_y)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()

    model.eval()
    with torch.no_grad():
        logits = model(torch.from_numpy(scaled_test))
        probabilities = torch.softmax(logits, dim=1).cpu().numpy()

    predicted = np.argmax(probabilities, axis=1)
    metrics = {
        "accuracy": float(accuracy_score(test_labels, predicted)),
        "balancedAccuracy": float(balanced_accuracy_score(test_labels, predicted)),
        "macroF1": float(f1_score(test_labels, predicted, average="macro", zero_division=0)),
    }
    return model, scaler, metrics


def predict_temporal_probabilities(
    model: TemporalGRU,
    scaler: StandardScaler,
    bars: list[dict[str, Any]],
) -> np.ndarray | None:
    features, _ = extract_bar_sequence_features(bars)
    if len(features) < SEQUENCE_LENGTH:
        return None
    window = features[-SEQUENCE_LENGTH:]
    scaled = scaler.transform(window).astype(np.float32)[None, :, :]
    model.eval()
    with torch.no_grad():
        logits = model(torch.from_numpy(scaled))
        probabilities = torch.softmax(logits, dim=1).cpu().numpy()[0]
    if not np.isfinite(probabilities).all():
        raise ValueError("ML_TEMPORAL_PREDICTION_INVALID")
    return probabilities
