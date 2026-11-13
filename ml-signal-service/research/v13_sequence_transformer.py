#!/usr/bin/env python3
"""Research-only V13 sequence Transformer challenger for KINGBOT's five specialists.

This module is deliberately isolated from service.py inference, artifact storage,
HTTP routes and broker execution. It consumes closed OHLC candles supplied by the
existing market-data pipeline and compares a sequence model with the current
RandomForest + PyTorch MLP blend on identical chronological data windows.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np
import torch
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, balanced_accuracy_score, f1_score, recall_score
from sklearn.preprocessing import StandardScaler
from torch import nn

_SERVICE_DIR = Path(__file__).resolve().parents[1]
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))
import service as engine  # noqa: E402


STRATEGIES = tuple(engine.STRATEGY_FOCUS.keys())
CLASS_LABELS = (-1, 0, 1)
CLASS_NAMES = ("SELL", "HOLD", "BUY")
SEQUENCE_LENGTH = 16
MODEL_WIDTH = 32
ATTENTION_HEADS = 4
ENCODER_LAYERS = 2
MIN_TRAIN_PER_MARKET = 40
MIN_DEV_PER_MARKET = 20
MIN_FINAL_PER_MARKET = 20
MIN_FINAL_SAMPLES = 30
MIN_MATCHED_SCORE_DELTA = 0.005
QUALITY_BALANCED_ACCURACY = 0.36
QUALITY_MACRO_F1 = 0.34


class MarketSequenceTransformer(nn.Module):
    """Small CPU-friendly encoder; each sequence ends at the decision candle."""

    def __init__(
        self,
        input_size: int,
        sequence_length: int = SEQUENCE_LENGTH,
        model_width: int = MODEL_WIDTH,
        attention_heads: int = ATTENTION_HEADS,
        encoder_layers: int = ENCODER_LAYERS,
        dropout: float = 0.10,
    ) -> None:
        super().__init__()
        if model_width % attention_heads:
            raise ValueError("V13_TRANSFORMER_WIDTH_MUST_DIVIDE_HEADS")
        self.sequence_length = int(sequence_length)
        self.input_projection = nn.Linear(input_size, model_width)
        self.position_embedding = nn.Parameter(
            torch.zeros(1, self.sequence_length, model_width)
        )
        layer = nn.TransformerEncoderLayer(
            d_model=model_width,
            nhead=attention_heads,
            dim_feedforward=model_width * 2,
            dropout=dropout,
            activation="gelu",
            batch_first=True,
            norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(
            layer,
            num_layers=encoder_layers,
            enable_nested_tensor=False,
        )
        self.output_norm = nn.LayerNorm(model_width)
        self.classifier = nn.Sequential(
            nn.Linear(model_width, model_width // 2),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(model_width // 2, 3),
        )
        nn.init.normal_(self.position_embedding, mean=0.0, std=0.02)

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        if features.ndim != 3 or features.shape[1] > self.sequence_length:
            raise ValueError("V13_TRANSFORMER_SEQUENCE_SHAPE_INVALID")
        if features.shape[1] != self.sequence_length:
            raise ValueError("V13_TRANSFORMER_SEQUENCE_LENGTH_INVALID")
        encoded = self.input_projection(features) + self.position_embedding
        encoded = self.encoder(encoded)
        return self.classifier(self.output_norm(encoded[:, -1, :]))


def _regime_from_features(
    raw_features: list[float],
    bar: dict[str, float],
) -> str:
    """Apply the incumbent regime taxonomy using only information at candle close."""
    trend = float(raw_features[0])
    price = float(bar["close"])
    atr_estimate = max(price * float(raw_features[3]) / 10.0, 1e-9)
    market = {
        "price": price,
        "atr": atr_estimate,
        "emaFast": 2.0 if trend > 0 else 0.0 if trend < 0 else 1.0,
        "emaSlow": 1.0,
        "momentum": float(raw_features[1]),
        "volatility": float(raw_features[2]),
        "adx": float(raw_features[5]) * 50.0,
        "breakout": float(raw_features[14]) >= 0.5,
        "structure": (
            "bullish" if raw_features[8] > raw_features[9]
            else "bearish" if raw_features[9] > raw_features[8]
            else ""
        ),
    }
    return engine.detect_market_regime(market, "strategic")


def build_market_samples(
    market: dict[str, Any],
    strategy: str,
    sequence_length: int = SEQUENCE_LENGTH,
) -> dict[str, Any]:
    """Build causal feature sequences and existing triple-barrier labels for one market."""
    symbol = str(market.get("symbol") or "").strip().upper()
    if not symbol or not isinstance(market.get("bars"), list):
        raise ValueError("V13_MARKET_SYMBOL_AND_BARS_REQUIRED")
    if strategy not in STRATEGIES:
        raise ValueError("V13_STRATEGY_NOT_SUPPORTED")
    if sequence_length < 2 or sequence_length > 64:
        raise ValueError("V13_SEQUENCE_LENGTH_OUT_OF_RANGE")

    bars = engine.normalize_market_bars(market["bars"])
    if len(bars) < max(engine.MIN_BARS, 60 + sequence_length + engine.FORWARD_HORIZON):
        raise ValueError(f"V13_MARKET_HISTORY_INSUFFICIENT:{symbol}")
    if not bars or any("_timestamp" not in row for row in bars):
        raise ValueError(f"V13_TIMESTAMPED_CLOSED_CANDLES_REQUIRED:{symbol}")

    features_by_index: dict[int, list[float]] = {}
    labels: list[int] = []
    sequences: list[np.ndarray] = []
    sample_times: list[float] = []
    label_end_times: list[float] = []
    regimes: list[str] = []
    forward = engine.FORWARD_HORIZON

    # Feature generation only sees bars through the current index. Labels inspect
    # the following barrier horizon, matching the incumbent label definition.
    for index in range(60, len(bars) - forward):
        raw_features = engine.extract_features_from_bars(bars, index)
        if raw_features is None:
            continue
        focused = engine.apply_strategy_focus(raw_features, strategy)
        features_by_index[index] = focused

        first_index = index - sequence_length + 1
        if first_index < 60 or any(
            feature_index not in features_by_index
            for feature_index in range(first_index, index + 1)
        ):
            continue

        atr_value = engine.atr(bars[: index + 1], 14)
        if atr_value is None or atr_value <= 0:
            continue
        label = engine.triple_barrier_label(bars, index, atr_value)
        sequence = np.asarray(
            [features_by_index[feature_index] for feature_index in range(first_index, index + 1)],
            dtype=np.float32,
        )
        if sequence.shape != (sequence_length, len(engine.FEATURE_NAMES)):
            raise ValueError("V13_SEQUENCE_FEATURE_WIDTH_INVALID")
        if not np.isfinite(sequence).all():
            raise ValueError("V13_NONFINITE_FEATURE_SEQUENCE")

        sequences.append(sequence)
        labels.append(int(label))
        sample_times.append(float(bars[index]["_timestamp"]))
        label_end_times.append(float(bars[index + forward]["_timestamp"]))
        regimes.append(_regime_from_features(raw_features, bars[index]))

    if not sequences:
        raise ValueError(f"V13_NO_VALID_SEQUENCES:{symbol}")

    return {
        "symbol": symbol,
        "X": np.asarray(sequences, dtype=np.float32),
        "y": np.asarray(labels, dtype=np.int64),
        "times": np.asarray(sample_times, dtype=np.float64),
        "label_end_times": np.asarray(label_end_times, dtype=np.float64),
        "regimes": np.asarray(regimes, dtype=object),
        "bars": len(bars),
    }


def temporal_split_masks(
    sample_times: np.ndarray,
    label_end_times: np.ndarray,
    train_cutoff: float,
    final_cutoff: float,
    common_end: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Create train/dev/final masks and purge labels crossing either boundary."""
    times = np.asarray(sample_times, dtype=np.float64)
    ends = np.asarray(label_end_times, dtype=np.float64)
    if times.ndim != 1 or ends.shape != times.shape or not len(times):
        raise ValueError("V13_TEMPORAL_SPLIT_INPUT_INVALID")
    if not np.isfinite(times).all() or not np.isfinite(ends).all():
        raise ValueError("V13_TEMPORAL_SPLIT_TIMESTAMPS_INVALID")
    if not train_cutoff < final_cutoff <= common_end:
        raise ValueError("V13_TEMPORAL_SPLIT_BOUNDARIES_INVALID")

    train = (times < train_cutoff) & (ends < train_cutoff)
    dev = (
        (times >= train_cutoff)
        & (times < final_cutoff)
        & (ends < final_cutoff)
    )
    final = (times >= final_cutoff) & (times <= common_end)
    if np.any(train & dev) or np.any(train & final) or np.any(dev & final):
        raise ValueError("V13_TEMPORAL_SPLIT_OVERLAP")
    return train, dev, final


def assemble_three_way_split(
    market_parts: list[dict[str, Any]],
) -> dict[str, Any]:
    """Use one common UTC window and shared cutoffs across every market."""
    if len(market_parts) < engine.MIN_VALIDATION_MARKETS:
        raise ValueError(
            "V13_MARKET_COVERAGE_INSUFFICIENT:"
            f"received={len(market_parts)},required={engine.MIN_VALIDATION_MARKETS}"
        )

    common_start = max(float(np.min(part["times"])) for part in market_parts)
    common_end = min(float(np.max(part["times"])) for part in market_parts)
    if common_start >= common_end:
        raise ValueError("V13_NO_COMMON_MARKET_TIME_WINDOW")

    all_times = np.concatenate([
        part["times"][
            (part["times"] >= common_start) & (part["times"] <= common_end)
        ]
        for part in market_parts
    ])
    shared_times = np.unique(all_times)
    if len(shared_times) < 20:
        raise ValueError("V13_COMMON_MARKET_TIME_WINDOW_TOO_SHORT")
    train_index = max(1, min(len(shared_times) - 3, int(len(shared_times) * 0.60)))
    final_index = max(
        train_index + 1,
        min(len(shared_times) - 1, int(len(shared_times) * 0.80)),
    )
    train_cutoff = float(shared_times[train_index])
    final_cutoff = float(shared_times[final_index])

    split_rows: dict[str, dict[str, list[np.ndarray]]] = {
        name: {"X": [], "y": [], "symbols": [], "regimes": [], "times": []}
        for name in ("train", "dev", "final")
    }
    market_audit: list[dict[str, Any]] = []
    for part in market_parts:
        masks = temporal_split_masks(
            part["times"],
            part["label_end_times"],
            train_cutoff,
            final_cutoff,
            common_end,
        )
        counts = [int(mask.sum()) for mask in masks]
        accepted = (
            counts[0] >= MIN_TRAIN_PER_MARKET
            and counts[1] >= MIN_DEV_PER_MARKET
            and counts[2] >= MIN_FINAL_PER_MARKET
        )
        market_audit.append({
            "symbol": part["symbol"],
            "accepted": accepted,
            "trainSamples": counts[0],
            "devSamples": counts[1],
            "finalSamples": counts[2],
            "trainClasses": engine.class_distribution(part["y"][masks[0]]),
            "devClasses": engine.class_distribution(part["y"][masks[1]]),
            "finalClasses": engine.class_distribution(part["y"][masks[2]]),
        })
        if not accepted:
            continue

        for name, mask in zip(("train", "dev", "final"), masks):
            rows = split_rows[name]
            count = int(mask.sum())
            rows["X"].append(part["X"][mask])
            rows["y"].append(part["y"][mask])
            rows["symbols"].append(np.full(count, part["symbol"], dtype=object))
            rows["regimes"].append(part["regimes"][mask])
            rows["times"].append(part["times"][mask])

    validated = sum(bool(row["accepted"]) for row in market_audit)
    if validated < engine.MIN_VALIDATION_MARKETS:
        raise ValueError(
            "V13_VALIDATED_MARKET_COVERAGE_INSUFFICIENT:"
            f"validated={validated},required={engine.MIN_VALIDATION_MARKETS}"
        )

    result: dict[str, Any] = {}
    for name, rows in split_rows.items():
        if not rows["X"]:
            raise ValueError(f"V13_SPLIT_EMPTY:{name}")
        result[name] = {
            key: np.concatenate(value, axis=0)
            for key, value in rows.items()
        }
    if len(result["final"]["y"]) < MIN_FINAL_SAMPLES:
        raise ValueError(
            f"V13_FINAL_SAMPLE_COUNT_BELOW_MINIMUM:{len(result['final']['y'])}"
        )

    train_classes = set(int(value) for value in result["train"]["y"])
    if train_classes != set(CLASS_LABELS):
        raise ValueError("V13_TRAIN_SPLIT_MUST_CONTAIN_SELL_HOLD_BUY")
    return {
        **result,
        "audit": {
            "commonStart": common_start,
            "commonEnd": common_end,
            "trainCutoff": train_cutoff,
            "finalCutoff": final_cutoff,
            "validatedMarkets": validated,
            "requiredMarkets": engine.MIN_VALIDATION_MARKETS,
            "markets": market_audit,
            "trainSamples": len(result["train"]["y"]),
            "devSamples": len(result["dev"]["y"]),
            "finalSamples": len(result["final"]["y"]),
            "classDistribution": {
                name: engine.class_distribution(result[name]["y"])
                for name in ("train", "dev", "final")
            },
            "labelEmbargo": "label_end_timestamp_strictly_before_next_split",
        },
    }


def _class_weights(labels: np.ndarray) -> torch.Tensor:
    encoded = np.asarray([engine.LABEL_TO_INDEX[int(value)] for value in labels], dtype=np.int64)
    counts = np.bincount(encoded, minlength=3).astype(np.float32)
    weights = len(encoded) / np.maximum(counts, 1.0)
    weights[counts == 0] = 0.0
    positive = weights[weights > 0]
    weights /= max(float(positive.mean()) if len(positive) else 1.0, 1.0)
    return torch.tensor(weights, dtype=torch.float32)


def _encode_labels(labels: np.ndarray) -> np.ndarray:
    return np.asarray(
        [engine.LABEL_TO_INDEX[int(value)] for value in labels],
        dtype=np.int64,
    )


def _decode_indices(indices: np.ndarray) -> np.ndarray:
    return np.asarray(
        [engine.INDEX_TO_LABEL[int(value)] for value in indices],
        dtype=np.int64,
    )


def _softmax(logits: np.ndarray) -> np.ndarray:
    values = np.asarray(logits, dtype=np.float64)
    shifted = values - np.max(values, axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / np.maximum(exp.sum(axis=1, keepdims=True), 1e-12)


def _nll(labels: np.ndarray, probabilities: np.ndarray) -> float:
    encoded = _encode_labels(labels)
    selected = np.clip(probabilities[np.arange(len(encoded)), encoded], 1e-9, 1.0)
    return float(-np.mean(np.log(selected)))


def fit_temperature(logits: np.ndarray, labels: np.ndarray) -> tuple[float, str]:
    """Fit one scalar temperature on development logits only."""
    values = np.asarray(logits, dtype=np.float64)
    targets = np.asarray(labels, dtype=np.int64)
    if values.ndim != 2 or values.shape != (len(targets), 3) or len(targets) < 30:
        return 1.0, "DEV_SAMPLE_COUNT_INSUFFICIENT"
    if set(int(value) for value in targets) != set(CLASS_LABELS):
        return 1.0, "DEV_REQUIRES_ALL_THREE_CLASSES"
    best_temperature = 1.0
    best_loss = math.inf
    for temperature in np.geomspace(0.35, 4.0, 81):
        loss = _nll(targets, _softmax(values / float(temperature)))
        if loss < best_loss:
            best_loss = loss
            best_temperature = float(temperature)
    return best_temperature, "FITTED_ON_DEVELOPMENT_ONLY"


def _expected_calibration_error(
    labels: np.ndarray,
    probabilities: np.ndarray,
    bins: int = 10,
) -> float:
    predicted = np.argmax(probabilities, axis=1)
    confidence = np.max(probabilities, axis=1)
    correct = (predicted == _encode_labels(labels)).astype(np.float64)
    error = 0.0
    edges = np.linspace(0.0, 1.0, bins + 1)
    for index in range(bins):
        mask = (
            (confidence >= edges[index])
            & (
                confidence <= edges[index + 1]
                if index == bins - 1
                else confidence < edges[index + 1]
            )
        )
        if mask.any():
            error += float(mask.mean()) * abs(float(correct[mask].mean()) - float(confidence[mask].mean()))
    return float(error)


def score_probabilities(
    labels: np.ndarray,
    probabilities: np.ndarray,
) -> dict[str, Any]:
    y_true = np.asarray(labels, dtype=np.int64)
    probs = np.asarray(probabilities, dtype=np.float64)
    if probs.shape != (len(y_true), 3) or not len(y_true):
        raise ValueError("V13_METRIC_INPUT_SHAPE_INVALID")
    if not np.isfinite(probs).all():
        raise ValueError("V13_METRIC_PROBABILITIES_NONFINITE")
    probs = np.clip(probs, 1e-9, 1.0)
    probs /= probs.sum(axis=1, keepdims=True)
    predicted = _decode_indices(np.argmax(probs, axis=1))
    recalls = recall_score(
        y_true,
        predicted,
        labels=list(CLASS_LABELS),
        average=None,
        zero_division=0,
    )
    support = {
        name: int(np.sum(y_true == label))
        for name, label in zip(CLASS_NAMES, CLASS_LABELS)
    }
    one_hot = np.eye(3, dtype=np.float64)[_encode_labels(y_true)]
    balanced_accuracy = float(balanced_accuracy_score(y_true, predicted))
    macro_f1 = float(f1_score(y_true, predicted, labels=list(CLASS_LABELS), average="macro", zero_division=0))
    selection_score = balanced_accuracy * 0.60 + macro_f1 * 0.40
    return {
        "samples": len(y_true),
        "accuracy": float(accuracy_score(y_true, predicted)),
        "balancedAccuracy": balanced_accuracy,
        "macroF1": macro_f1,
        "selectionScore": selection_score,
        "recall": {
            name: float(value)
            for name, value in zip(CLASS_NAMES, recalls)
        },
        "support": support,
        "nll": _nll(y_true, probs),
        "brierScore": float(np.mean(np.sum((probs - one_hot) ** 2, axis=1))),
        "ece10": _expected_calibration_error(y_true, probs),
        "classDistribution": engine.class_distribution(y_true),
    }


def _regime_metrics(
    labels: np.ndarray,
    probabilities: np.ndarray,
    regimes: np.ndarray,
) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for regime in sorted(set(str(value) for value in regimes)):
        mask = np.asarray([str(value) == regime for value in regimes], dtype=bool)
        if int(mask.sum()) < 10:
            output[regime] = {"samples": int(mask.sum()), "status": "TOO_FEW_SAMPLES"}
        else:
            output[regime] = score_probabilities(labels[mask], probabilities[mask])
    return output


def _fit_baseline(
    split: dict[str, Any],
    scaler: StandardScaler,
    epochs: int,
    seed: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Train the current RF + MLP architecture on the training split only."""
    x_train = scaler.transform(split["train"]["X"][:, -1, :]).astype(np.float32)
    x_dev = scaler.transform(split["dev"]["X"][:, -1, :]).astype(np.float32)
    x_final = scaler.transform(split["final"]["X"][:, -1, :]).astype(np.float32)
    y_train = split["train"]["y"]

    forest = RandomForestClassifier(
        n_estimators=120,
        max_depth=7,
        min_samples_leaf=4,
        random_state=seed,
        class_weight="balanced_subsample",
        n_jobs=1,
    )
    forest.fit(x_train, y_train)

    forest_classes = np.zeros((len(x_train), 3), dtype=np.float32)
    raw_train = forest.predict_proba(x_train)
    for column, label in enumerate(forest.classes_):
        forest_classes[:, engine.LABEL_TO_INDEX[int(label)]] = raw_train[:, column]

    np.random.seed(seed)
    torch.manual_seed(seed)
    model = engine.MLP(x_train.shape[1], 3)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.008, weight_decay=0.001)
    loss_function = nn.CrossEntropyLoss(weight=_class_weights(y_train))
    train_x = torch.from_numpy(x_train)
    train_y = torch.from_numpy(_encode_labels(y_train))
    model.train()
    for _ in range(max(1, int(epochs))):
        optimizer.zero_grad(set_to_none=True)
        loss = loss_function(model(train_x), train_y)
        loss.backward()
        optimizer.step()

    def probabilities(values: np.ndarray) -> np.ndarray:
        rf_raw = forest.predict_proba(values)
        rf_aligned = np.zeros((len(values), 3), dtype=np.float32)
        for column, label in enumerate(forest.classes_):
            rf_aligned[:, engine.LABEL_TO_INDEX[int(label)]] = rf_raw[:, column]
        model.eval()
        with torch.no_grad():
            torch_raw = torch.softmax(
                model(torch.from_numpy(values)),
                dim=1,
            ).cpu().numpy()
        blended = rf_aligned * engine.RF_ENSEMBLE_WEIGHT + torch_raw * engine.TORCH_ENSEMBLE_WEIGHT
        return blended / np.maximum(blended.sum(axis=1, keepdims=True), 1e-12)

    return probabilities(x_dev), probabilities(x_final)


def _train_transformer(
    x_train: np.ndarray,
    y_train: np.ndarray,
    x_dev: np.ndarray,
    y_dev: np.ndarray,
    epochs: int,
    seed: int,
) -> tuple[MarketSequenceTransformer, int]:
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.set_num_threads(max(1, min(4, int(os.getenv("KINGBOT_V13_TORCH_THREADS", "1")))))

    model = MarketSequenceTransformer(
        input_size=x_train.shape[2],
        sequence_length=x_train.shape[1],
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.0015, weight_decay=0.01)
    loss_function = nn.CrossEntropyLoss(weight=_class_weights(y_train))
    train_x = torch.from_numpy(x_train.astype(np.float32))
    train_y = torch.from_numpy(_encode_labels(y_train))
    dev_x = torch.from_numpy(x_dev.astype(np.float32))
    best_score = -math.inf
    best_state: dict[str, torch.Tensor] | None = None
    best_epoch = 0
    patience = 5
    stale_epochs = 0
    batch_size = min(128, len(train_x))

    for epoch in range(max(1, int(epochs))):
        model.train()
        order = torch.randperm(len(train_x))
        for start in range(0, len(train_x), batch_size):
            indices = order[start : start + batch_size]
            optimizer.zero_grad(set_to_none=True)
            logits = model(train_x[indices])
            loss = loss_function(logits, train_y[indices])
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()

        model.eval()
        with torch.no_grad():
            dev_logits = model(dev_x).cpu().numpy()
        dev_metrics = score_probabilities(y_dev, _softmax(dev_logits))
        score = float(dev_metrics["selectionScore"])
        if score > best_score + 1e-6:
            best_score = score
            best_epoch = epoch + 1
            best_state = copy.deepcopy(model.state_dict())
            stale_epochs = 0
        else:
            stale_epochs += 1
            if stale_epochs >= patience:
                break

    if best_state is None:
        raise RuntimeError("V13_TRANSFORMER_NO_DEVELOPMENT_CHECKPOINT")
    model.load_state_dict(best_state)
    model.eval()
    return model, best_epoch


def _model_logits(
    model: nn.Module,
    sequences: np.ndarray,
) -> np.ndarray:
    model.eval()
    with torch.no_grad():
        return model(torch.from_numpy(np.asarray(sequences, dtype=np.float32))).cpu().numpy()


def _fit_transformer_scaler(train_sequences: np.ndarray) -> StandardScaler:
    if train_sequences.ndim != 3:
        raise ValueError("V13_TRAIN_SEQUENCE_TENSOR_INVALID")
    scaler = StandardScaler()
    scaler.fit(train_sequences.reshape(-1, train_sequences.shape[-1]))
    return scaler


def _transform_sequences(
    sequences: np.ndarray,
    scaler: StandardScaler,
) -> np.ndarray:
    count, length, width = sequences.shape
    transformed = scaler.transform(sequences.reshape(-1, width))
    result = transformed.reshape(count, length, width).astype(np.float32)
    if not np.isfinite(result).all():
        raise ValueError("V13_STANDARDIZED_FEATURES_NONFINITE")
    return result


def run_experiment(
    markets: list[dict[str, Any]],
    strategy: str,
    timeframe: str = "5m",
    sequence_length: int = SEQUENCE_LENGTH,
    epochs: int = 18,
    seed: int = 42,
) -> dict[str, Any]:
    if strategy not in STRATEGIES:
        raise ValueError("V13_STRATEGY_NOT_SUPPORTED")
    if not isinstance(markets, list) or not markets:
        raise ValueError("V13_MARKET_DATA_REQUIRED")

    market_parts = [
        build_market_samples(market, strategy, sequence_length)
        for market in markets
    ]
    symbols = [part["symbol"] for part in market_parts]
    if len(set(symbols)) != len(symbols):
        raise ValueError("V13_DUPLICATE_MARKET_SYMBOL")
    split = assemble_three_way_split(market_parts)

    transformer_scaler = _fit_transformer_scaler(split["train"]["X"])
    x_train = _transform_sequences(split["train"]["X"], transformer_scaler)
    x_dev = _transform_sequences(split["dev"]["X"], transformer_scaler)
    x_final = _transform_sequences(split["final"]["X"], transformer_scaler)

    transformer, best_epoch = _train_transformer(
        x_train,
        split["train"]["y"],
        x_dev,
        split["dev"]["y"],
        epochs,
        seed,
    )
    transformer_dev_logits = _model_logits(transformer, x_dev)
    transformer_final_logits = _model_logits(transformer, x_final)
    transformer_temperature, transformer_calibration_status = fit_temperature(
        transformer_dev_logits,
        split["dev"]["y"],
    )
    transformer_dev_probabilities = _softmax(transformer_dev_logits / transformer_temperature)
    transformer_final_probabilities = _softmax(transformer_final_logits / transformer_temperature)

    # Reproduce the live ensemble family separately, using only the final candle
    # feature from each identical train/dev/final sample.
    baseline_scaler = StandardScaler().fit(split["train"]["X"][:, -1, :])
    baseline_dev_probabilities, baseline_final_probabilities = _fit_baseline(
        split,
        baseline_scaler,
        epochs=engine.TORCH_EPOCHS,
        seed=seed,
    )
    baseline_temperature, baseline_calibration_status = fit_temperature(
        np.log(np.clip(baseline_dev_probabilities, 1e-9, 1.0)),
        split["dev"]["y"],
    )
    baseline_final_probabilities = _softmax(
        np.log(np.clip(baseline_final_probabilities, 1e-9, 1.0)) / baseline_temperature
    )
    baseline_dev_probabilities = _softmax(
        np.log(np.clip(baseline_dev_probabilities, 1e-9, 1.0)) / baseline_temperature
    )

    baseline_final = score_probabilities(
        split["final"]["y"],
        baseline_final_probabilities,
    )
    transformer_final = score_probabilities(
        split["final"]["y"],
        transformer_final_probabilities,
    )
    delta = float(transformer_final["selectionScore"] - baseline_final["selectionScore"])
    supports = transformer_final["support"]
    recalls = transformer_final["recall"]
    quality_gate = (
        transformer_final["balancedAccuracy"] >= QUALITY_BALANCED_ACCURACY
        and transformer_final["macroF1"] >= QUALITY_MACRO_F1
        and transformer_final["samples"] >= MIN_FINAL_SAMPLES
        and all(supports[name] > 0 for name in CLASS_NAMES)
        and all(recalls[name] > 0.0 for name in CLASS_NAMES)
    )
    matched_improvement_gate = delta >= MIN_MATCHED_SCORE_DELTA

    return {
        "strategy": strategy,
        "timeframe": str(timeframe).lower(),
        "status": "PROMISING_MATCHED_FINAL_IMPROVEMENT" if quality_gate and matched_improvement_gate else "NOT_ACCEPTED_FOR_NEXT_STAGE",
        "researchOnly": True,
        "promotionAllowed": False,
        "featureVersion": engine.FEATURE_VERSION,
        "sequenceLength": sequence_length,
        "model": {
            "type": "two-layer-multivariate-transformer-encoder",
            "inputFeatures": len(engine.FEATURE_NAMES),
            "modelWidth": MODEL_WIDTH,
            "attentionHeads": ATTENTION_HEADS,
            "encoderLayers": ENCODER_LAYERS,
            "bestDevelopmentEpoch": best_epoch,
            "epochsMaximum": epochs,
        },
        "split": split["audit"],
        "calibration": {
            "transformerTemperature": transformer_temperature,
            "transformerStatus": transformer_calibration_status,
            "baselineTemperature": baseline_temperature,
            "baselineStatus": baseline_calibration_status,
            "fitPartition": "development_only",
        },
        "matchedBenchmark": {
            "baseline": baseline_final,
            "transformer": transformer_final,
            "selectionScoreDelta": delta,
            "requiredDelta": MIN_MATCHED_SCORE_DELTA,
            "balancedAccuracyFloor": QUALITY_BALANCED_ACCURACY,
            "macroF1Floor": QUALITY_MACRO_F1,
            "minimumFinalSamples": MIN_FINAL_SAMPLES,
            "qualityGate": quality_gate,
            "matchedImprovementGate": matched_improvement_gate,
        },
        "regimeRobustness": {
            "baseline": _regime_metrics(
                split["final"]["y"],
                baseline_final_probabilities,
                split["final"]["regimes"],
            ),
            "transformer": _regime_metrics(
                split["final"]["y"],
                transformer_final_probabilities,
                split["final"]["regimes"],
            ),
        },
        "developmentDiagnostics": {
            "baseline": score_probabilities(
                split["dev"]["y"],
                baseline_dev_probabilities,
            ),
            "transformer": score_probabilities(
                split["dev"]["y"],
                transformer_dev_probabilities,
            ),
        },
        "nextStageRequirements": [
            "repeat on multiple non-overlapping future walk-forward periods",
            "confirm performance by market regime and by all five specialist bots",
            "run cost-aware trade simulation with spread, commission, slippage and swap",
            "compare signal quality and abstention rate in shadow mode",
            "obtain explicit approval before any production integration or model promotion",
        ],
    }


def _load_markets(path: Path) -> tuple[list[dict[str, Any]], str]:
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    payload = json.loads(raw.decode("utf-8"))
    markets = payload.get("markets") if isinstance(payload, dict) else payload
    if not isinstance(markets, list):
        raise ValueError("V13_INPUT_JSON_MUST_BE_MARKET_LIST_OR_MARKETS_OBJECT")
    return markets, digest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="JSON file with timestamped closed-candle markets")
    parser.add_argument("--strategy", choices=("all", *STRATEGIES), default="all")
    parser.add_argument("--timeframe", default="5m")
    parser.add_argument("--sequence-length", type=int, default=SEQUENCE_LENGTH)
    parser.add_argument("--epochs", type=int, default=18)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--report", type=Path, default=Path("v13-sequence-transformer-report.json"))
    args = parser.parse_args(argv)

    markets, digest = _load_markets(args.input)
    strategies = STRATEGIES if args.strategy == "all" else (args.strategy,)
    report: dict[str, Any] = {
        "project": "KINGBOT V13 Advanced Intelligence Research",
        "status": "RESEARCH_ONLY",
        "inputSha256": digest,
        "inputMarkets": len(markets),
        "timeframe": args.timeframe,
        "experiments": [],
    }
    failed = False
    for strategy in strategies:
        try:
            result = run_experiment(
                markets,
                strategy,
                timeframe=args.timeframe,
                sequence_length=args.sequence_length,
                epochs=args.epochs,
                seed=args.seed,
            )
            report["experiments"].append(result)
            if result["status"] != "PROMISING_MATCHED_FINAL_IMPROVEMENT":
                failed = True
        except Exception as error:
            failed = True
            report["experiments"].append({
                "strategy": strategy,
                "status": "DATA_OR_TRAINING_BLOCKED",
                "researchOnly": True,
                "error": str(error)[:240],
            })

    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": report["status"],
        "report": str(args.report),
        "inputSha256": digest,
        "experiments": [
            {"strategy": item["strategy"], "status": item["status"]}
            for item in report["experiments"]
        ],
    }, indent=2))
    return 2 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
