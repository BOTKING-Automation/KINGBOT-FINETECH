"""Research-only temporal convolutional challenger for KINGBOT V10.

This module trains on causal OHLC-derived feature sequences and uses purged,
global timestamp splits. It never writes model artifacts or changes live inference.
"""
from __future__ import annotations

import math
from pathlib import Path
import sys
from typing import Any

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F
from torch.utils.data import DataLoader, TensorDataset
from sklearn.preprocessing import StandardScaler

_REPO_ROOT = Path(__file__).resolve().parents[2]
_ML_SERVICE_DIR = _REPO_ROOT / "ml-signal-service"
if str(_ML_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_ML_SERVICE_DIR))

import service  # noqa: E402

SEQUENCE_LENGTH = 32
DEFAULT_EPOCHS = 18
BATCH_SIZE = 192
TCN_CHANNELS = 32
TCN_DROPOUT = 0.15
RF_BASELINE_WEIGHT = 0.55
MIN_MARKETS = 3
MIN_SEQUENCES_PER_MARKET = 50
IMPROVEMENT_MARGIN = 0.005
QUALITY_MIN_BALANCED_ACCURACY = 0.36
QUALITY_MIN_MACRO_F1 = 0.34
MIN_TEST_SAMPLES = 30
RANDOM_SEED = 20261107

# One representative timeframe per specialist is the first research pilot.
# A candidate is not a complete bot until all three production timeframes pass.
PILOT_PROFILES = {
    "strategic": "1h",
    "flipper": "5m",
    "breakout": "15m",
    "smc-pro": "15m",
    "ladder-flip": "15m",
}


class CausalTemporalBlock(nn.Module):
    """Residual temporal block whose output at t cannot see observations after t."""

    def __init__(self, input_channels: int, output_channels: int, dilation: int, dropout: float):
        super().__init__()
        self.padding = 2 * dilation
        self.conv1 = nn.Conv1d(
            input_channels, output_channels, kernel_size=3,
            dilation=dilation, padding=self.padding
        )
        self.conv2 = nn.Conv1d(
            output_channels, output_channels, kernel_size=3,
            dilation=dilation, padding=self.padding
        )
        self.dropout = nn.Dropout(dropout)
        self.projection = (
            nn.Identity()
            if input_channels == output_channels
            else nn.Conv1d(input_channels, output_channels, kernel_size=1)
        )

    def _causal_convolution(self, layer: nn.Module, values: torch.Tensor) -> torch.Tensor:
        output = layer(values)
        if self.padding:
            output = output[..., :-self.padding]
        return output

    def forward(self, values: torch.Tensor) -> torch.Tensor:
        residual = self.projection(values)
        output = F.relu(self._causal_convolution(self.conv1, values))
        output = self.dropout(output)
        output = F.relu(self._causal_convolution(self.conv2, output))
        output = self.dropout(output)
        return F.relu(output + residual)


class TemporalConvClassifier(nn.Module):
    """Small TCN classifier over [batch, sequence, feature] input windows."""

    def __init__(
        self,
        input_features: int,
        channels: int = TCN_CHANNELS,
        dropout: float = TCN_DROPOUT,
    ):
        super().__init__()
        self.temporal = nn.Sequential(
            CausalTemporalBlock(input_features, channels, dilation=1, dropout=dropout),
            CausalTemporalBlock(channels, channels, dilation=2, dropout=dropout),
            CausalTemporalBlock(channels, channels, dilation=4, dropout=dropout),
        )
        self.classifier = nn.Linear(channels, 3)

    def forward(self, sequences: torch.Tensor) -> torch.Tensor:
        if sequences.ndim != 3:
            raise ValueError("V10_TEMPORAL_INPUT_SHAPE_INVALID")
        channels_first = sequences.transpose(1, 2)
        encoded = self.temporal(channels_first)
        return self.classifier(encoded[:, :, -1])


def build_temporal_dataset(
    markets: list[dict[str, Any]],
    strategy: str,
    sequence_length: int = SEQUENCE_LENGTH,
) -> dict[str, Any]:
    """Create non-crossing per-market windows with forward labels and UTC timestamps."""
    if not isinstance(markets, list) or not markets:
        raise ValueError("V10_TEMPORAL_MARKETS_REQUIRED")
    if not isinstance(sequence_length, int) or sequence_length < 2 or sequence_length > 256:
        raise ValueError("V10_TEMPORAL_SEQUENCE_LENGTH_INVALID")

    all_sequences: list[np.ndarray] = []
    all_labels: list[np.ndarray] = []
    all_times: list[np.ndarray] = []
    all_label_ends: list[np.ndarray] = []
    market_rows: list[dict[str, Any]] = []

    for market in markets:
        if not isinstance(market, dict):
            continue
        symbol = str(market.get("symbol") or "").strip().upper()
        raw_bars = market.get("bars")
        if not symbol or not isinstance(raw_bars, list):
            continue

        bars = service.normalize_market_bars(raw_bars)
        features, labels, _, sample_times, label_end_times = service.bars_to_training_arrays(
            bars, strategy
        )
        if len(features) < sequence_length + MIN_SEQUENCES_PER_MARKET:
            market_rows.append({
                "symbol": symbol,
                "accepted": False,
                "bars": len(bars),
                "sequences": max(0, len(features) - sequence_length + 1),
                "reason": "INSUFFICIENT_SEQUENCE_HISTORY",
            })
            continue
        if not np.isfinite(sample_times).all() or not np.isfinite(label_end_times).all():
            market_rows.append({
                "symbol": symbol,
                "accepted": False,
                "bars": len(bars),
                "sequences": 0,
                "reason": "TIMESTAMPED_CANDLES_REQUIRED",
            })
            continue

        # sliding_window_view returns [samples, features, window]; transpose to
        # [samples, window, features]. The label belongs to the window's last bar.
        windows = np.lib.stride_tricks.sliding_window_view(
            features, window_shape=sequence_length, axis=0
        ).transpose(0, 2, 1)
        windows = np.ascontiguousarray(windows, dtype=np.float32)
        aligned_labels = np.asarray(labels[sequence_length - 1:], dtype=np.int64)
        aligned_times = np.asarray(sample_times[sequence_length - 1:], dtype=np.float64)
        aligned_label_ends = np.asarray(label_end_times[sequence_length - 1:], dtype=np.float64)

        if (
            len(windows) != len(aligned_labels)
            or len(windows) != len(aligned_times)
            or len(windows) != len(aligned_label_ends)
            or not np.isfinite(windows).all()
        ):
            raise ValueError("V10_TEMPORAL_SEQUENCE_ALIGNMENT_INVALID")

        all_sequences.append(windows)
        all_labels.append(aligned_labels)
        all_times.append(aligned_times)
        all_label_ends.append(aligned_label_ends)
        market_rows.append({
            "symbol": symbol,
            "accepted": True,
            "bars": len(bars),
            "sequences": int(len(windows)),
            "firstSample": float(aligned_times[0]),
            "lastSample": float(aligned_times[-1]),
        })

    if not all_sequences:
        raise ValueError("V10_TEMPORAL_NO_MARKETS_WITH_SEQUENCE_HISTORY")

    return {
        "X": np.concatenate(all_sequences, axis=0),
        "y": np.concatenate(all_labels, axis=0),
        "sampleTimes": np.concatenate(all_times, axis=0),
        "labelEndTimes": np.concatenate(all_label_ends, axis=0),
        "markets": market_rows,
        "sequenceLength": sequence_length,
        "featureCount": int(all_sequences[0].shape[2]),
    }


def temporal_split_masks(
    dataset: dict[str, Any],
    train_fraction: float,
    test_fraction: float,
) -> tuple[np.ndarray, np.ndarray, float]:
    """Use the V9 global timestamp split with forward-label purging."""
    return service.global_temporal_split_masks(
        dataset["sampleTimes"],
        dataset["labelEndTimes"],
        train_fraction=train_fraction,
        test_fraction=test_fraction,
    )


def _class_weights(labels: np.ndarray) -> torch.Tensor:
    indices = np.asarray(
        [service.LABEL_TO_INDEX[int(value)] for value in labels],
        dtype=np.int64,
    )
    counts = np.bincount(indices, minlength=3).astype(np.float32)
    if np.any(counts <= 0):
        raise ValueError("V10_TEMPORAL_TRAINING_REQUIRES_ALL_CLASSES")
    weights = len(indices) / counts
    weights /= float(weights.mean())
    return torch.tensor(weights, dtype=torch.float32)


def fit_predict_temporal(
    train_sequences: np.ndarray,
    train_labels: np.ndarray,
    test_sequences: np.ndarray,
    epochs: int = DEFAULT_EPOCHS,
    batch_size: int = BATCH_SIZE,
) -> np.ndarray:
    """Fit a fixed TCN configuration on training data and return test probabilities."""
    X_train = np.asarray(train_sequences, dtype=np.float32)
    X_test = np.asarray(test_sequences, dtype=np.float32)
    y_train = np.asarray(train_labels, dtype=np.int64)

    if (
        X_train.ndim != 3
        or X_test.ndim != 3
        or X_train.shape[1:] != X_test.shape[1:]
        or len(X_train) != len(y_train)
        or len(X_train) < 60
        or len(X_test) < 1
        or not np.isfinite(X_train).all()
        or not np.isfinite(X_test).all()
    ):
        raise ValueError("V10_TEMPORAL_TRAINING_INPUT_INVALID")
    if not isinstance(epochs, int) or epochs < 1 or epochs > 100:
        raise ValueError("V10_TEMPORAL_EPOCHS_INVALID")
    if not isinstance(batch_size, int) or batch_size < 8 or batch_size > 2048:
        raise ValueError("V10_TEMPORAL_BATCH_SIZE_INVALID")

    scaler = StandardScaler()
    scaler.fit(X_train.reshape(-1, X_train.shape[-1]))
    X_train_scaled = scaler.transform(
        X_train.reshape(-1, X_train.shape[-1])
    ).reshape(X_train.shape).astype(np.float32)
    X_test_scaled = scaler.transform(
        X_test.reshape(-1, X_test.shape[-1])
    ).reshape(X_test.shape).astype(np.float32)

    torch.manual_seed(RANDOM_SEED)
    np.random.seed(RANDOM_SEED)
    torch.set_num_threads(1)
    model = TemporalConvClassifier(X_train.shape[2])
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.001, weight_decay=0.0005)
    loss_function = nn.CrossEntropyLoss(weight=_class_weights(y_train))
    train_indices = torch.tensor(
        [service.LABEL_TO_INDEX[int(value)] for value in y_train],
        dtype=torch.long,
    )
    dataset = TensorDataset(
        torch.from_numpy(X_train_scaled),
        train_indices,
    )
    generator = torch.Generator().manual_seed(RANDOM_SEED)
    loader = DataLoader(
        dataset,
        batch_size=min(batch_size, len(dataset)),
        shuffle=True,
        generator=generator,
        num_workers=0,
        drop_last=False,
    )

    model.train()
    for _ in range(epochs):
        for batch_x, batch_y in loader:
            optimizer.zero_grad(set_to_none=True)
            logits = model(batch_x)
            loss = loss_function(logits, batch_y)
            if not torch.isfinite(loss):
                raise ValueError("V10_TEMPORAL_TRAINING_LOSS_NONFINITE")
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()

    model.eval()
    with torch.no_grad():
        logits = model(torch.from_numpy(X_test_scaled))
        probabilities = torch.softmax(logits, dim=1).cpu().numpy().astype(np.float32)

    if not np.isfinite(probabilities).all() or not np.allclose(
        probabilities.sum(axis=1), 1.0, atol=1e-5
    ):
        raise ValueError("V10_TEMPORAL_PREDICTIONS_INVALID")
    return probabilities


def fit_predict_v9_matched_baseline(
    train_sequences: np.ndarray,
    train_labels: np.ndarray,
    test_sequences: np.ndarray,
    test_labels: np.ndarray,
) -> np.ndarray:
    """Train the existing V9 RF/MLP ensemble on the same terminal rows and samples."""
    X_train = np.asarray(train_sequences, dtype=np.float32)[:, -1, :]
    X_test = np.asarray(test_sequences, dtype=np.float32)[:, -1, :]
    y_train = np.asarray(train_labels, dtype=np.int64)
    weights = np.ones(len(y_train), dtype=np.float32)

    scaler = service.StandardScaler()
    scaler.fit(X_train)
    X_train_scaled = scaler.transform(X_train).astype(np.float32)
    X_test_scaled = scaler.transform(X_test).astype(np.float32)

    forest = service.RandomForestClassifier(
        n_estimators=service.MAX_RF_TREES,
        max_depth=7,
        min_samples_leaf=4,
        random_state=42,
        class_weight="balanced_subsample",
        n_jobs=1,
    )
    forest.fit(X_train_scaled, y_train, sample_weight=weights)
    torch_model, _ = service.train_torch(
        X_train, y_train, X_test, np.asarray(test_labels, dtype=np.int64),
        scaler, weights,
    )
    return service.ensemble_probabilities(
        forest,
        torch_model,
        X_test_scaled,
        rf_weight=RF_BASELINE_WEIGHT,
    )


def evaluate_probabilities(labels: np.ndarray, probabilities: np.ndarray) -> dict[str, Any]:
    metrics = service.ensemble_class_metrics(labels, probabilities)
    per_class = metrics.get("perClass", {})
    coverage = all(
        name in per_class and float(per_class[name].get("recall", 0.0)) > 0.0
        for name in ("SELL", "HOLD", "BUY")
    )
    samples = int(len(labels))
    metric_gate = (
        float(metrics["balancedAccuracy"]) >= QUALITY_MIN_BALANCED_ACCURACY
        and float(metrics["macroF1"]) >= QUALITY_MIN_MACRO_F1
        and samples >= MIN_TEST_SAMPLES
    )
    score = (
        float(metrics["balancedAccuracy"]) * 0.60
        + float(metrics["macroF1"]) * 0.40
    )
    return {
        **metrics,
        "testSamples": samples,
        "classCoverageGate": bool(coverage),
        "metricGate": bool(metric_gate),
        "qualityGate": bool(metric_gate and coverage),
        "selectionScore": float(score),
    }


def _evaluate_fold(
    dataset: dict[str, Any],
    train_fraction: float,
    test_fraction: float,
) -> dict[str, Any]:
    train_mask, test_mask, cutoff = temporal_split_masks(
        dataset, train_fraction, test_fraction
    )
    X = dataset["X"]
    y = dataset["y"]
    return {
        "trainSequences": X[train_mask],
        "trainLabels": y[train_mask],
        "testSequences": X[test_mask],
        "testLabels": y[test_mask],
        "cutoff": cutoff,
        "trainMask": train_mask,
        "testMask": test_mask,
    }


def run_pilot(
    strategy: str,
    timeframe: str,
    markets: list[dict[str, Any]],
    epochs: int = DEFAULT_EPOCHS,
) -> dict[str, Any]:
    """Evaluate development then untouched final; never saves or promotes a model."""
    dataset = build_temporal_dataset(markets, strategy)
    accepted_markets = [row for row in dataset["markets"] if row.get("accepted")]
    if len(accepted_markets) < MIN_MARKETS:
        return {
            "strategy": strategy,
            "timeframe": timeframe,
            "status": "SKIPPED_DATA_COVERAGE",
            "acceptedMarkets": len(accepted_markets),
            "marketCoverage": dataset["markets"],
        }

    development = _evaluate_fold(dataset, 0.70, 0.85)
    tcn_dev_probs = fit_predict_temporal(
        development["trainSequences"],
        development["trainLabels"],
        development["testSequences"],
        epochs=epochs,
    )
    baseline_dev_probs = fit_predict_v9_matched_baseline(
        development["trainSequences"],
        development["trainLabels"],
        development["testSequences"],
        development["testLabels"],
    )
    tcn_dev = evaluate_probabilities(development["testLabels"], tcn_dev_probs)
    baseline_dev = evaluate_probabilities(development["testLabels"], baseline_dev_probs)
    development_advance = bool(
        tcn_dev["qualityGate"]
        and tcn_dev["selectionScore"] >= baseline_dev["selectionScore"] - 0.01
    )

    row: dict[str, Any] = {
        "strategy": strategy,
        "timeframe": timeframe,
        "variant": "V10_CAUSAL_TCN_RESEARCH_CANDIDATE",
        "status": "DEVELOPMENT_REJECTED",
        "sequenceLength": dataset["sequenceLength"],
        "featureCount": dataset["featureCount"],
        "marketCoverage": dataset["markets"],
        "development": {
            "window": "70%-85%",
            "cutoffTimestamp": development["cutoff"],
            "temporalSequences": int(len(development["testLabels"])),
            "tcn": tcn_dev,
            "v9MatchedBaseline": baseline_dev,
            "advanceToFinal": development_advance,
        },
        "final": None,
        "promotion": "NONE_RESEARCH_ONLY",
    }

    if not development_advance:
        row["reason"] = (
            "TCN did not pass the unchanged metric and class-recall gates, "
            "or its development score was materially below the matched V9 baseline"
        )
        return row

    final_fold = _evaluate_fold(dataset, 0.85, 1.0)
    tcn_final_probs = fit_predict_temporal(
        final_fold["trainSequences"],
        final_fold["trainLabels"],
        final_fold["testSequences"],
        epochs=epochs,
    )
    baseline_final_probs = fit_predict_v9_matched_baseline(
        final_fold["trainSequences"],
        final_fold["trainLabels"],
        final_fold["testSequences"],
        final_fold["testLabels"],
    )
    tcn_final = evaluate_probabilities(final_fold["testLabels"], tcn_final_probs)
    baseline_final = evaluate_probabilities(final_fold["testLabels"], baseline_final_probs)
    score_delta = float(tcn_final["selectionScore"] - baseline_final["selectionScore"])
    final_pass = bool(
        tcn_final["qualityGate"]
        and score_delta >= IMPROVEMENT_MARGIN
    )

    row["final"] = {
        "window": "85%-100% untouched",
        "cutoffTimestamp": final_fold["cutoff"],
        "temporalSequences": int(len(final_fold["testLabels"])),
        "tcn": tcn_final,
        "v9MatchedBaseline": baseline_final,
        "selectionScoreDeltaVsV9": score_delta,
        "requiredImprovementMargin": IMPROVEMENT_MARGIN,
        "passesFinalResearchGate": final_pass,
    }
    row["status"] = "RESEARCH_CANDIDATE_PASS" if final_pass else "FINAL_REJECTED"
    if not final_pass:
        row["reason"] = (
            "Final TCN did not meet the unchanged quality gates or did not exceed "
            "the matched V9 baseline by the required selection-score margin"
        )
    return row
