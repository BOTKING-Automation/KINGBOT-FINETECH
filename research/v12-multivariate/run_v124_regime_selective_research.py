"""KINGBOT V12.4 regime-aware selective Cortex research.

Compares the V12.3 three-class Transformer with a shared Transformer using
separate actionability (SELL/BUY versus HOLD) and direction (SELL versus BUY)
heads. Regime features are causal trailing OHLC measurements. Probability
calibration and abstention threshold fitting use a purged training-only slice.
No production model is written or promoted.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

_ROOT = Path(__file__).resolve().parents[2]
_ML = _ROOT / "ml-signal-service"
_RESEARCH = _ROOT / "research" / "v12-multivariate"
for candidate in (_ML, _RESEARCH):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

import service  # noqa: E402
import multivariate_transformer as v12  # noqa: E402
import run_v123_cortex_research as v123  # noqa: E402
from run_v122_hold_research import _detailed_metrics  # noqa: E402

REGIME_FEATURE_NAMES = (
    "return_1_atr_norm", "return_5_atr_norm", "return_20_atr_norm",
    "atr_pct_14_log", "atr_ratio_14_50", "realized_vol_20_atr",
    "efficiency_ratio_10", "efficiency_ratio_30", "ema_gap_20_50_atr",
    "true_range_expansion_20", "directional_persistence_12",
    "choppiness_14", "range_position_20",
    "state_neutral", "state_trend", "state_range", "state_volatile",
    "state_compression",
)
REGIME_NAMES = {
    0: "neutral_transition", 1: "trend", 2: "range",
    3: "volatile", 4: "compression",
}
EPOCHS = 12
CALIBRATION_TRAIN_FRACTION = 0.80
MIN_CALIBRATION_SAMPLES = 30


def _rolling_sum(values: np.ndarray, window: int) -> np.ndarray:
    values = np.asarray(values, dtype=np.float64)
    output = np.zeros(len(values), dtype=np.float64)
    if len(values) < window:
        return output
    cumulative = np.concatenate(([0.0], np.cumsum(values, dtype=np.float64)))
    output[window - 1:] = cumulative[window:] - cumulative[:-window]
    return output


def _rolling_mean(values: np.ndarray, window: int) -> np.ndarray:
    return _rolling_sum(values, window) / float(window)


def _rolling_std(values: np.ndarray, window: int) -> np.ndarray:
    values = np.asarray(values, dtype=np.float64)
    mean = _rolling_mean(values, window)
    second = _rolling_mean(values * values, window)
    return np.sqrt(np.maximum(second - mean * mean, 0.0))


def _ema(values: np.ndarray, period: int) -> np.ndarray:
    values = np.asarray(values, dtype=np.float64)
    output = np.zeros(len(values), dtype=np.float64)
    if len(values) < period:
        return output
    output[period - 1] = float(np.mean(values[:period]))
    alpha = 2.0 / (period + 1.0)
    for index in range(period, len(values)):
        output[index] = alpha * values[index] + (1.0 - alpha) * output[index - 1]
    return output


def _rolling_extreme(values: np.ndarray, window: int, maximum: bool) -> np.ndarray:
    values = np.asarray(values, dtype=np.float64)
    output = np.zeros(len(values), dtype=np.float64)
    operation = np.max if maximum else np.min
    for index in range(window - 1, len(values)):
        output[index] = operation(values[index - window + 1:index + 1])
    return output


def compute_market_regime_features(
    bars: list[dict[str, Any]],
) -> tuple[np.ndarray, np.ndarray]:
    """Return bounded trailing OHLC regime features and diagnostic state IDs.

    States are heuristic descriptions (neutral, trend, range, volatile,
    compression), not supervised ground-truth labels or order-flow evidence.
    """
    if not isinstance(bars, list):
        raise ValueError("V124_REGIME_BARS_INVALID")
    count = len(bars)
    if count == 0:
        return np.zeros((0, len(REGIME_FEATURE_NAMES)), np.float32), np.zeros(0, np.int64)

    opening = np.asarray([service.finite(row.get("open")) for row in bars], dtype=np.float64)
    high = np.asarray([service.finite(row.get("high")) for row in bars], dtype=np.float64)
    low = np.asarray([service.finite(row.get("low")) for row in bars], dtype=np.float64)
    close = np.asarray([service.finite(row.get("close")) for row in bars], dtype=np.float64)
    if (not all(np.isfinite(values).all() for values in (opening, high, low, close))
            or np.any(opening <= 0) or np.any(close <= 0)
            or np.any(high < np.maximum.reduce((opening, low, close)))
            or np.any(low > np.minimum.reduce((opening, high, close)))):
        raise ValueError("V124_REGIME_OHLC_INVALID")

    previous_close = np.concatenate(([close[0]], close[:-1]))
    true_range = np.maximum(
        high - low, np.maximum(np.abs(high - previous_close), np.abs(low - previous_close))
    )
    true_range[0] = high[0] - low[0]
    atr14 = _rolling_mean(true_range, 14)
    atr50 = _rolling_mean(true_range, 50)
    safe_atr = np.maximum(atr14, np.maximum(close * 1e-8, 1e-12))
    safe_close = np.maximum(close, 1e-12)

    log_returns = np.zeros(count, dtype=np.float64)
    log_returns[1:] = np.diff(np.log(safe_close))
    returns_by_lag = {}
    for lag in (1, 5, 20):
        values = np.zeros(count, dtype=np.float64)
        if count > lag:
            values[lag:] = np.log(safe_close[lag:] / safe_close[:-lag])
        returns_by_lag[lag] = values

    abs_returns = np.abs(np.diff(close, prepend=close[0]))
    efficiency = {}
    for window in (10, 30):
        path = _rolling_sum(abs_returns, window)
        net = np.zeros(count, dtype=np.float64)
        if count > window:
            net[window:] = np.abs(close[window:] - close[:-window])
        efficiency[window] = np.clip(net / np.maximum(path, 1e-12), 0.0, 1.0)

    ema20, ema50 = _ema(close, 20), _ema(close, 50)
    ema_gap = np.clip((ema20 - ema50) / safe_atr, -5.0, 5.0)
    atr_ratio = np.clip(atr14 / np.maximum(atr50, 1e-12), 0.0, 4.0)
    realized_vol20 = _rolling_std(log_returns, 20)
    realized_vol_atr = np.clip(
        realized_vol20 / np.maximum(atr14 / safe_close, 1e-12), 0.0, 4.0
    )
    atr_pct_log = np.clip(
        np.log1p(np.maximum(atr14 / safe_close, 0.0) * 1000.0), 0.0, 4.0
    ) / 4.0
    return_atr = {
        lag: np.clip(returns_by_lag[lag] * safe_close / safe_atr, -6.0, 6.0) / 6.0
        for lag in (1, 5, 20)
    }
    tr_expansion = np.clip(
        true_range / np.maximum(_rolling_mean(true_range, 20), 1e-12), 0.0, 4.0
    ) / 4.0
    persistence = np.clip(_rolling_mean(np.sign(log_returns), 12), -1.0, 1.0)

    rolling_high = _rolling_extreme(high, 20, True)
    rolling_low = _rolling_extreme(low, 20, False)
    range_width = np.maximum(rolling_high - rolling_low, safe_atr * 1e-8)
    range_position = np.clip(2.0 * (close - rolling_low) / range_width - 1.0, -1.0, 1.0)

    tr_sum14 = _rolling_sum(true_range, 14)
    high14 = _rolling_extreme(high, 14, True)
    low14 = _rolling_extreme(low, 14, False)
    range14 = np.maximum(high14 - low14, 1e-12)
    choppiness = np.clip(
        np.log10(np.maximum(tr_sum14 / range14, 1e-12)) / np.log10(14.0), 0.0, 1.0
    )

    valid = np.arange(count) >= 60
    trend_state = valid & (efficiency[30] >= 0.35) & (np.abs(ema_gap) >= 0.35)
    range_state = valid & (efficiency[30] <= 0.20) & (choppiness >= 0.52)
    compression_state = valid & (atr_ratio <= 0.75) & (efficiency[30] <= 0.35)
    volatile_state = valid & ((atr_ratio >= 1.55) | (tr_expansion >= 0.55))

    states = np.zeros(count, dtype=np.int64)
    states[trend_state] = 1
    states[range_state] = 2
    states[compression_state] = 4
    states[volatile_state] = 3

    one_hot = np.zeros((count, 5), dtype=np.float64)
    one_hot[np.arange(count), states] = 1.0
    features = np.column_stack((
        return_atr[1], return_atr[5], return_atr[20],
        atr_pct_log, atr_ratio / 4.0, realized_vol_atr / 4.0,
        efficiency[10], efficiency[30], ema_gap / 5.0,
        tr_expansion, persistence, choppiness, range_position, one_hot,
    ))
    features = np.clip(
        np.nan_to_num(features, nan=0.0, posinf=0.0, neginf=0.0), -1.0, 1.0
    )
    if features.shape != (count, len(REGIME_FEATURE_NAMES)):
        raise ValueError("V124_REGIME_FEATURE_SHAPE_INVALID")
    return features.astype(np.float32), states


def _closed_asof_lookup(
    feature_matrix: np.ndarray,
    open_times: np.ndarray,
    timeframe_seconds: int,
    decision_times: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    matrix = np.asarray(feature_matrix, dtype=np.float32)
    opens = np.asarray(open_times, dtype=np.float64)
    decisions = np.asarray(decision_times, dtype=np.float64)
    if (matrix.ndim != 2 or matrix.shape[1] != len(REGIME_FEATURE_NAMES)
            or opens.ndim != 1 or decisions.ndim != 1 or len(matrix) != len(opens)
            or timeframe_seconds <= 0 or not np.isfinite(matrix).all()
            or not np.isfinite(opens).all() or not np.isfinite(decisions).all()
            or np.any(np.diff(opens) < 0)):
        raise ValueError("V124_ASOF_INPUT_INVALID")
    available_at = opens + float(timeframe_seconds)
    positions = np.searchsorted(available_at, decisions, side="right") - 1
    present = positions >= 0
    output = np.zeros((len(decisions), len(REGIME_FEATURE_NAMES)), dtype=np.float32)
    if present.any():
        output[present] = matrix[positions[present]]
    if present.any() and np.any(available_at[positions[present]] > decisions[present]):
        raise ValueError("V124_FUTURE_CONTEXT_LEAK")
    return output, present


def build_v124_dataset(
    markets_by_timeframe: dict[str, Any],
    strategy: str,
    timeframe: str,
) -> dict[str, Any]:
    """Reuse V12.3 causal alignment and append regime target/context panels."""
    base = v123.build_v123_dataset(markets_by_timeframe, strategy, timeframe)
    series = {}
    for source_tf in v12.TIMEFRAMES:
        for row in markets_by_timeframe.get(source_tf, []):
            if not isinstance(row, dict):
                continue
            symbol, raw_bars = str(row.get("symbol") or "").upper(), row.get("bars")
            if symbol not in v12.SYMBOLS or not isinstance(raw_bars, list):
                continue
            bars = service.normalize_market_bars(raw_bars)
            if len(bars) < v12.SEQ + 60 + service.FORWARD_HORIZON + 50:
                continue
            opens = np.asarray([bar.get("_timestamp", np.nan) for bar in bars], np.float64)
            if not np.isfinite(opens).all():
                continue
            all_features, all_states = compute_market_regime_features(bars)
            feature_slice = slice(60, len(bars) - service.FORWARD_HORIZON)
            feature_rows, state_rows = all_features[feature_slice], all_states[feature_slice]
            _, _, _, sample_times, _ = service.bars_to_training_arrays(bars, strategy)
            if len(feature_rows) != len(sample_times) or len(state_rows) != len(sample_times):
                raise ValueError("V124_REGIME_FEATURE_ALIGNMENT_INVALID")
            series[f"{symbol}|{source_tf}"] = (
                feature_rows, opens[feature_slice], state_rows
            )

    target_windows, target_states = {}, {}
    for row in markets_by_timeframe.get(timeframe, []):
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("symbol") or "").upper()
        key = f"{symbol}|{timeframe}"
        if key not in series:
            continue
        feature_rows, _, state_rows = series[key]
        if len(feature_rows) < v12.SEQ:
            continue
        windows = np.lib.stride_tricks.sliding_window_view(
            feature_rows, window_shape=v12.SEQ, axis=0
        ).transpose(0, 2, 1)
        target_windows[symbol] = np.ascontiguousarray(windows, dtype=np.float32)
        target_states[symbol] = np.asarray(state_rows[v12.SEQ - 1:], dtype=np.int64)

    ordered_symbols = list(dict.fromkeys(base["symbols"]))
    missing_symbols = [symbol for symbol in ordered_symbols if symbol not in target_windows]
    if missing_symbols:
        raise ValueError("V124_TARGET_REGIME_SERIES_MISSING:" + ",".join(missing_symbols))
    regime_target = np.concatenate([target_windows[symbol] for symbol in ordered_symbols], axis=0)
    current_states = np.concatenate([target_states[symbol] for symbol in ordered_symbols], axis=0)
    if (regime_target.shape[:2] != base["X"].shape[:2]
            or len(regime_target) != len(base["y"]) or len(current_states) != len(base["y"])):
        raise ValueError("V124_TARGET_REGIME_PANEL_ALIGNMENT_INVALID")

    regime_context = np.zeros(
        (len(base["times"]), len(base["slots"]), len(REGIME_FEATURE_NAMES)), np.float32
    )
    target_keys = np.asarray(
        [f"{symbol}|{timeframe}" for symbol in base["symbols"]], dtype=object
    )
    decision_times = base["times"] + float(v12.TF_SECONDS[timeframe])
    missing_mask = np.asarray(base["M"], dtype=bool)
    for slot, key in enumerate(base["slots"]):
        if key not in series:
            expected = (~missing_mask[:, slot]) & (target_keys != key)
            if np.any(expected):
                raise ValueError("V124_CONTEXT_REGIME_SERIES_MISSING:" + key)
            continue
        feature_rows, source_opens, _ = series[key]
        source_tf = key.split("|")[1]
        looked_up, present = _closed_asof_lookup(
            feature_rows, source_opens, v12.TF_SECONDS[source_tf], decision_times
        )
        expected = (~missing_mask[:, slot]) & (target_keys != key)
        if not np.array_equal(present & (target_keys != key), expected):
            raise ValueError("V124_CONTEXT_REGIME_AVAILABILITY_MISMATCH:" + key)
        regime_context[expected, slot] = looked_up[expected]

    if not np.isfinite(regime_target).all() or not np.isfinite(regime_context).all():
        raise ValueError("V124_REGIME_PANEL_NONFINITE")
    base["v9Features"] = base["variants"]["baseline"]
    base["X"] = np.concatenate((base["variants"]["full_cortex"], regime_target), axis=2).astype(np.float32)
    base["C"] = np.concatenate((base["contextVariants"]["full_cortex"], regime_context), axis=2).astype(np.float32)
    base["regimeStates"] = current_states
    base["regimeFeatureNames"] = list(REGIME_FEATURE_NAMES)
    return base


class RegimeSelectiveTransformer(nn.Module):
    """Shared temporal/context encoder with actionability and direction heads."""
    def __init__(self, target_features, context_features_with_age, slots,
                 seq_len=v12.SEQ, dim=v12.D_MODEL):
        super().__init__()
        if min(target_features, context_features_with_age, slots, seq_len) < 1 or dim % 4:
            raise ValueError("V124_MODEL_DIMENSIONS_INVALID")
        self.seq_len, self.slots = seq_len, slots
        self.target_proj = nn.Linear(target_features, dim)
        self.context_proj = nn.Linear(context_features_with_age, dim)
        self.time_pos = nn.Parameter(torch.randn(1, seq_len, dim) * 0.02)
        self.slot_pos = nn.Parameter(torch.randn(1, slots, dim) * 0.02)
        layer = nn.TransformerEncoderLayer(
            dim, 4, dim * 4, dropout=0.1, activation="gelu",
            batch_first=True, norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(layer, 2, enable_nested_tensor=False)
        self.norm = nn.LayerNorm(dim)
        self.action_head = nn.Sequential(
            nn.Linear(dim, 32), nn.GELU(), nn.Dropout(0.1), nn.Linear(32, 1)
        )
        self.direction_head = nn.Sequential(
            nn.Linear(dim, 32), nn.GELU(), nn.Dropout(0.1), nn.Linear(32, 1)
        )

    def forward(self, target, context, missing):
        if target.ndim != 3 or context.ndim != 3 or missing.shape != context.shape[:2]:
            raise ValueError("V124_INPUT_SHAPE_INVALID")
        if target.shape[1] != self.seq_len or context.shape[1] != self.slots:
            raise ValueError("V124_SEQUENCE_OR_CONTEXT_SHAPE_INVALID")
        target_tokens = self.target_proj(target) + self.time_pos
        context_tokens = self.context_proj(context) + self.slot_pos
        tokens = torch.cat((target_tokens, context_tokens), dim=1)
        padding = torch.cat((
            torch.zeros((len(target), self.seq_len), dtype=torch.bool, device=target.device),
            missing.bool(),
        ), dim=1)
        encoded = self.norm(self.encoder(tokens, src_key_padding_mask=padding))
        pooled = encoded[:, self.seq_len - 1]
        return self.action_head(pooled).squeeze(1), self.direction_head(pooled).squeeze(1)


def _sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(np.asarray(values, dtype=np.float64), -40.0, 40.0)))


def _fit_temperature(logits: np.ndarray, targets: np.ndarray) -> float:
    logits = np.asarray(logits, dtype=np.float64).reshape(-1)
    targets = np.asarray(targets, dtype=np.float64).reshape(-1)
    if len(logits) < 10 or len(np.unique(targets)) < 2:
        return 1.0
    best_temperature, best_loss = 1.0, float("inf")
    for temperature in np.linspace(0.50, 4.00, 71):
        probability = np.clip(_sigmoid(logits / temperature), 1e-7, 1.0 - 1e-7)
        loss = -float(np.mean(
            targets * np.log(probability) + (1.0 - targets) * np.log(1.0 - probability)
        ))
        if loss < best_loss:
            best_temperature, best_loss = float(temperature), loss
    return best_temperature


def _select_action_threshold(action_probabilities, actionable_targets):
    probabilities = np.asarray(action_probabilities, dtype=np.float64).reshape(-1)
    targets = np.asarray(actionable_targets, dtype=bool).reshape(-1)
    if len(probabilities) != len(targets) or len(probabilities) < 10 or not targets.any():
        return 0.50, {"f1": 0.0, "precision": 0.0, "recall": 0.0}
    best = (-1.0, -1.0, 0.50, 0.0, 0.0, 0.0)
    for threshold in np.linspace(0.30, 0.85, 23):
        predicted = probabilities >= threshold
        tp = int(np.sum(predicted & targets))
        fp = int(np.sum(predicted & ~targets))
        fn = int(np.sum(~predicted & targets))
        precision = tp / max(1, tp + fp)
        recall = tp / max(1, tp + fn)
        f1 = 2.0 * precision * recall / max(1e-12, precision + recall)
        candidate = (f1, precision, float(threshold), precision, recall, f1)
        if candidate[:3] > best[:3]:
            best = candidate
    return best[2], {"f1": best[5], "precision": best[3], "recall": best[4]}


def _gate_probabilities(
    action_logits, direction_logits, action_temperature, direction_temperature, action_threshold
):
    action_probability = _sigmoid(np.asarray(action_logits) / max(action_temperature, 1e-6))
    buy_probability = _sigmoid(np.asarray(direction_logits) / max(direction_temperature, 1e-6))
    active = action_probability >= float(action_threshold)
    probabilities = np.zeros((len(active), 3), dtype=np.float64)
    probabilities[~active, 1] = 1.0
    probabilities[active, 0] = 1.0 - buy_probability[active]
    probabilities[active, 2] = buy_probability[active]
    return probabilities, action_probability, buy_probability


def _ece(probabilities, targets):
    probabilities = np.asarray(probabilities, dtype=np.float64)
    targets = np.asarray(targets, dtype=np.float64)
    if len(probabilities) == 0:
        return 0.0
    result = 0.0
    edges = np.linspace(0.0, 1.0, 11)
    for index in range(10):
        mask = (probabilities >= edges[index]) & (
            probabilities < edges[index + 1] if index < 9 else probabilities <= edges[index + 1]
        )
        if mask.any():
            result += float(mask.mean()) * abs(
                float(probabilities[mask].mean()) - float(targets[mask].mean())
            )
    return result


def _selective_diagnostics(y_true, action_probability, buy_probability, threshold, calibration):
    labels = np.asarray(y_true, dtype=np.int64)
    actionable = labels != 0
    active = np.asarray(action_probability) >= threshold
    tp = int(np.sum(active & actionable))
    precision = tp / max(1, int(active.sum()))
    recall = tp / max(1, int(actionable.sum()))
    f1 = 2.0 * precision * recall / max(1e-12, precision + recall)
    selected_directional = active & actionable
    direction_correct = (
        (np.asarray(buy_probability)[selected_directional] >= 0.5)
        == (labels[selected_directional] > 0)
    ) if selected_directional.any() else np.asarray([], dtype=bool)
    return {
        "tradeCoverage": float(active.mean()) if len(active) else 0.0,
        "actionabilityPrecision": float(precision),
        "actionabilityRecall": float(recall),
        "actionabilityF1": float(f1),
        "directionAccuracyOnSelectedDirectionalRows": (
            float(direction_correct.mean()) if len(direction_correct) else 0.0
        ),
        "actionabilityBrier": float(np.mean((action_probability - actionable.astype(float)) ** 2)),
        "actionabilityECE": _ece(action_probability, actionable.astype(float)),
        "calibration": calibration,
    }


def _regime_breakdown(y_true, probabilities, states):
    labels = np.asarray(y_true)
    state_values = np.asarray(states, dtype=np.int64)
    if len(labels) != len(state_values):
        raise ValueError("V124_REGIME_EVALUATION_ALIGNMENT_INVALID")
    output = {}
    for state, name in REGIME_NAMES.items():
        selected = state_values == state
        if selected.any():
            metrics = _detailed_metrics(labels[selected], probabilities[selected])
            output[name] = {
                "samples": int(selected.sum()),
                "balancedAccuracy": metrics["balancedAccuracy"],
                "macroF1": metrics["macroF1"],
                "classRecall": metrics["classRecall"],
            }
    return output


def _fit_selective_predict(data, core_indices, calibration_indices, evaluation_indices, epochs=EPOCHS):
    if not 1 <= epochs <= 80:
        raise ValueError("V124_TRAINING_EPOCHS_INVALID")
    X, C, M, A, y = (data[key] for key in ("X", "C", "M", "A", "y"))
    train_y = np.asarray(y[core_indices], dtype=np.int64)
    cal_y = np.asarray(y[calibration_indices], dtype=np.int64)
    eval_y = np.asarray(y[evaluation_indices], dtype=np.int64)
    if (len(core_indices) < 90 or len(calibration_indices) < MIN_CALIBRATION_SAMPLES
            or len(evaluation_indices) < 1):
        raise ValueError("V124_CALIBRATION_SAMPLE_COVERAGE_INSUFFICIENT")

    combined_indices = np.concatenate((calibration_indices, evaluation_indices))
    tx, combined_x, tc, combined_c, tm, combined_m = v12._scale(
        X[core_indices], X[combined_indices], C[core_indices], C[combined_indices],
        M[core_indices], M[combined_indices], A[core_indices], A[combined_indices],
    )
    cal_count = len(calibration_indices)
    cal_x, eval_x = combined_x[:cal_count], combined_x[cal_count:]
    cal_c, eval_c = combined_c[:cal_count], combined_c[cal_count:]
    cal_m, eval_m = combined_m[:cal_count], combined_m[cal_count:]

    action_targets = (train_y != 0).astype(np.float32)
    direction_mask = train_y != 0
    direction_targets = (train_y > 0).astype(np.float32)
    if len(np.unique(action_targets)) < 2 or len(np.unique(direction_targets[direction_mask])) < 2:
        raise ValueError("V124_TRAINING_CLASS_COVERAGE_INSUFFICIENT")
    hold_count, action_count = int(np.sum(~direction_mask)), int(np.sum(direction_mask))
    sell_count, buy_count = int(np.sum(train_y == -1)), int(np.sum(train_y == 1))
    action_pos_weight = max(0.10, min(10.0, hold_count / max(action_count, 1)))
    direction_pos_weight = max(0.25, min(4.0, sell_count / max(buy_count, 1)))

    torch.manual_seed(v12.SEED)
    np.random.seed(v12.SEED)
    torch.set_num_threads(1)
    model = RegimeSelectiveTransformer(tx.shape[-1], tc.shape[-1], tc.shape[1], tx.shape[1])
    action_loss_fn = nn.BCEWithLogitsLoss(
        pos_weight=torch.tensor(action_pos_weight, dtype=torch.float32)
    )
    direction_loss_fn = nn.BCEWithLogitsLoss(
        pos_weight=torch.tensor(direction_pos_weight, dtype=torch.float32)
    )
    dataset = TensorDataset(
        torch.from_numpy(tx), torch.from_numpy(tc), torch.from_numpy(tm),
        torch.from_numpy(action_targets), torch.from_numpy(direction_targets),
        torch.from_numpy(direction_mask),
    )
    loader = DataLoader(
        dataset, batch_size=min(v12.BATCH, len(dataset)), shuffle=True,
        generator=torch.Generator().manual_seed(v12.SEED),
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.0006, weight_decay=0.001)
    model.train()
    for _ in range(epochs):
        for bx, bc, bm, batch_action, batch_direction, batch_direction_mask in loader:
            action_logits, direction_logits = model(bx, bc, bm)
            action_loss = action_loss_fn(action_logits, batch_action)
            active = batch_direction_mask.bool()
            if not active.any():
                continue
            direction_loss = direction_loss_fn(
                direction_logits[active], batch_direction[active]
            )
            loss = action_loss + 0.75 * direction_loss
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

    model.eval()
    with torch.no_grad():
        cal_action_logits, cal_direction_logits = model(
            torch.from_numpy(cal_x), torch.from_numpy(cal_c), torch.from_numpy(cal_m)
        )
        eval_action_logits, eval_direction_logits = model(
            torch.from_numpy(eval_x), torch.from_numpy(eval_c), torch.from_numpy(eval_m)
        )
    cal_action = cal_action_logits.cpu().numpy()
    cal_direction = cal_direction_logits.cpu().numpy()
    eval_action = eval_action_logits.cpu().numpy()
    eval_direction = eval_direction_logits.cpu().numpy()

    cal_action_targets = (cal_y != 0).astype(np.float64)
    cal_direction_mask = cal_y != 0
    cal_direction_targets = (cal_y[cal_direction_mask] > 0).astype(np.float64)
    action_temperature = _fit_temperature(cal_action, cal_action_targets)
    direction_temperature = _fit_temperature(
        cal_direction[cal_direction_mask], cal_direction_targets
    )
    calibrated_action = _sigmoid(cal_action / action_temperature)
    action_threshold, threshold_metrics = _select_action_threshold(
        calibrated_action, cal_action_targets.astype(bool)
    )
    calibration_details = {
        "calibrationSamples": int(len(cal_y)),
        "actionTemperature": float(action_temperature),
        "directionTemperature": float(direction_temperature),
        "actionThreshold": float(action_threshold),
        "thresholdSelection": threshold_metrics,
        "calibrationWasTrainingOnly": True,
    }
    probabilities, action_probability, buy_probability = _gate_probabilities(
        eval_action, eval_direction, action_temperature, direction_temperature, action_threshold
    )
    diagnostics = _selective_diagnostics(
        eval_y, action_probability, buy_probability, action_threshold, calibration_details
    )
    return probabilities, diagnostics


def _fold_masks(data, train_fraction, test_fraction):
    train_mask, eval_mask, cutoff = service.global_temporal_split_masks(
        data["times"], data["ends"],
        train_fraction=train_fraction, test_fraction=test_fraction,
    )
    if train_mask.sum() < 120 or eval_mask.sum() < v12.MIN_N:
        raise ValueError("V124_FOLD_SAMPLE_COVERAGE_INSUFFICIENT")
    return train_mask, eval_mask, cutoff


def _run_fold(data, train_fraction, test_fraction, variants):
    train_mask, eval_mask, cutoff = _fold_masks(data, train_fraction, test_fraction)
    outer_train_indices = np.flatnonzero(train_mask)
    evaluation_indices = np.flatnonzero(eval_mask)
    inner_train_mask, calibration_mask, calibration_cutoff = service.global_temporal_split_masks(
        data["times"][outer_train_indices],
        data["ends"][outer_train_indices],
        train_fraction=CALIBRATION_TRAIN_FRACTION,
        test_fraction=1.0,
    )
    core_indices = outer_train_indices[inner_train_mask]
    calibration_indices = outer_train_indices[calibration_mask]
    if len(calibration_indices) < MIN_CALIBRATION_SAMPLES:
        raise ValueError("V124_INNER_CALIBRATION_TOO_SMALL")

    y = data["y"]
    train_y, eval_y = y[core_indices], y[evaluation_indices]
    v9_probabilities = v12.matched_v9(
        data["v9Features"][core_indices], train_y,
        data["v9Features"][evaluation_indices], eval_y,
    )
    v9_metrics = _detailed_metrics(eval_y, v9_probabilities)

    result_variants = {}
    for variant in variants:
        if variant == "single_head_full_cortex":
            probabilities = v123.fit_predict(
                data["X"][core_indices], data["C"][core_indices],
                data["M"][core_indices], data["A"][core_indices], train_y,
                data["X"][evaluation_indices], data["C"][evaluation_indices],
                data["M"][evaluation_indices], data["A"][evaluation_indices],
            )
            metrics, diagnostics = _detailed_metrics(eval_y, probabilities), {}
        elif variant == "regime_selective_two_stage":
            probabilities, diagnostics = _fit_selective_predict(
                data, core_indices, calibration_indices, evaluation_indices
            )
            metrics = _detailed_metrics(eval_y, probabilities)
            diagnostics["regimeBreakdown"] = _regime_breakdown(
                eval_y, probabilities, data["regimeStates"][evaluation_indices]
            )
        else:
            raise ValueError("V124_VARIANT_INVALID:" + variant)
        delta = metrics["selectionScore"] - v9_metrics["selectionScore"]
        result_variants[variant] = {
            "model": metrics,
            "selectionScoreDeltaVsV9": float(delta),
            "passesDevelopmentGuard": bool(metrics["qualityGate"] and delta >= -0.01),
            "diagnostics": diagnostics,
        }
    return {
        "cutoffTimestamp": float(cutoff),
        "innerCalibrationCutoffTimestamp": float(calibration_cutoff),
        "coreTrainingSamples": int(len(core_indices)),
        "calibrationSamples": int(len(calibration_indices)),
        "testSamples": int(len(evaluation_indices)),
        "v9MatchedBaseline": v9_metrics,
        "variants": result_variants,
    }


def _select_development_variant(development):
    eligible = [
        (name, result) for name, result in development["variants"].items()
        if result["passesDevelopmentGuard"]
    ]
    return max(eligible, key=lambda item: item[1]["model"]["selectionScore"])[0] if eligible else None


def run_pilot(strategy, timeframe, markets_by_timeframe):
    data = build_v124_dataset(markets_by_timeframe, strategy, timeframe)
    variants = ("single_head_full_cortex", "regime_selective_two_stage")
    development = _run_fold(data, 0.70, 0.85, variants)
    selected_variant = _select_development_variant(development)
    final_fold = _run_fold(data, 0.85, 1.0, (selected_variant,)) if selected_variant else None
    final_result = final_fold["variants"][selected_variant] if final_fold else None
    final_delta = final_result["selectionScoreDeltaVsV9"] if final_result else None
    passed = bool(
        final_result and final_result["model"]["qualityGate"]
        and final_delta >= v12.MIN_DELTA
    )
    return {
        "strategy": strategy,
        "timeframe": timeframe,
        "status": "RESEARCH_CANDIDATE_PASS" if passed else (
            "FINAL_REJECTED" if final_fold else "DEVELOPMENT_REJECTED"
        ),
        "regimeFeatureCount": len(REGIME_FEATURE_NAMES),
        "regimeNames": REGIME_NAMES,
        "sequenceLength": data["sequenceLength"],
        "contextSlots": len(data["slots"]),
        "marketCoverage": data["coverage"],
        "development": development,
        "selectedVariant": selected_variant,
        "final": ({
            "cutoffTimestamp": final_fold["cutoffTimestamp"],
            "innerCalibrationCutoffTimestamp": final_fold["innerCalibrationCutoffTimestamp"],
            "coreTrainingSamples": final_fold["coreTrainingSamples"],
            "calibrationSamples": final_fold["calibrationSamples"],
            "testSamples": final_fold["testSamples"],
            "v9MatchedBaseline": final_fold["v9MatchedBaseline"],
            "selectedVariant": selected_variant,
            "result": final_result,
        } if final_fold else None),
        "requiredImprovementMargin": v12.MIN_DELTA,
        "passesFinalResearchGate": passed,
        "promotion": "NONE_RESEARCH_ONLY",
    }


def run(input_path: Path, output_path: Path) -> int:
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    markets = payload.get("marketsByTimeframe")
    if not isinstance(markets, dict):
        raise ValueError("V124_MARKET_TIMEFRAME_DATA_MISSING")
    started = time.time()
    results = []
    for strategy, timeframe in v12.PILOTS.items():
        try:
            result = run_pilot(strategy, timeframe, markets)
        except Exception as error:
            result = {
                "strategy": strategy, "timeframe": timeframe,
                "status": "RESEARCH_ERROR", "error": str(error)[:400],
            }
        results.append(result)
        print("[KINGBOT V12.4 REGIME SELECTIVE PILOT]", json.dumps({
            "strategy": strategy, "timeframe": timeframe,
            "status": result.get("status"),
            "selectedVariant": result.get("selectedVariant"),
            "developmentVariants": {
                name: {
                    "balancedAccuracy": values["model"]["balancedAccuracy"],
                    "macroF1": values["model"]["macroF1"],
                    "selectionScoreDeltaVsV9": values["selectionScoreDeltaVsV9"],
                    "qualityGate": values["model"]["qualityGate"],
                    "diagnostics": values.get("diagnostics", {}),
                }
                for name, values in (result.get("development") or {}).get("variants", {}).items()
            },
            "error": result.get("error"),
        }, sort_keys=True))

    report = {
        "generatedAt": payload.get("generatedAt"),
        "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "researchVersion": "v12-4-regime-aware-selective-cortex-1",
        "researchOnly": True,
        "productionChanged": False,
        "modelArtifactsPersisted": False,
        "architecture": {
            "base": "V12.3 full-Cortex causal OHLC features and cross-market context",
            "regimeFeatures": list(REGIME_FEATURE_NAMES),
            "regimeStates": REGIME_NAMES,
            "regimeStateDefinition": "causal heuristic OHLC state, not institutional order-flow ground truth",
            "challengers": {
                "single_head_full_cortex": "V12.3 three-class Transformer retrained on V12.4 feature tensors",
                "regime_selective_two_stage": "shared Transformer with separate actionable-versus-HOLD and SELL-versus-BUY heads",
            },
            "selectiveDecision": "calibrated actionability probability below a training-only threshold maps to HOLD; otherwise the direction head selects SELL or BUY",
            "calibration": "temperature scaling and actionability F1 threshold selected on a purged chronological calibration slice inside each outer training fold",
            "labels": "unchanged six-bar ATR triple-barrier SELL/HOLD/BUY",
            "training": "12 epochs, AdamW, CPU, training-partition-only scaling and weighted binary cross-entropy heads",
            "causality": "trailing OHLC features; cross-market context only after source candle close",
        },
        "validation": {
            "developmentWindow": "70%-85%",
            "finalWindow": "85%-100% untouched",
            "innerCalibration": "purged chronological 80%-20% split within each outer training fold",
            "globalTimestampAlignment": True,
            "forwardLabelPurging": True,
            "matchedBaseline": "V9 RF+PyTorch trained on the identical inner core partition",
            "candidateSelection": "development only; no final evaluation without a development pass",
            "developmentGuard": "balanced accuracy >=0.36, macro-F1 >=0.34, >=30 test rows, nonzero SELL/HOLD/BUY recall and score delta >=-0.01",
            "finalGate": "same absolute quality gate plus selection-score improvement >=0.005 over matched V9",
            "calibrationUse": "calibration labels excluded from gradient updates; used only for temperature and actionability threshold fitting",
        },
        "dataFetch": {
            "historyLimit": payload.get("historyLimit"),
            "fetchSummary": payload.get("fetchSummary", []),
            "fetchWarnings": payload.get("fetchWarnings", []),
            "fetchFailures": payload.get("fetchFailures", []),
            "coverageWarning": "Shorter higher-timeframe FX feeds are reported as limited context; the fetcher and normalizer cap history at 3,000 bars.",
        },
        "summary": {
            "targetModels": len(results),
            "evaluatedModels": sum(result.get("status") != "RESEARCH_ERROR" for result in results),
            "developmentPassed": sum(bool(result.get("selectedVariant")) for result in results),
            "finalEvaluated": sum(result.get("final") is not None for result in results),
            "finalQualityGatePassed": sum(
                bool((result.get("final") or {}).get("result", {}).get("model", {}).get("qualityGate"))
                for result in results
            ),
            "researchCandidatesPassed": sum(
                result.get("status") == "RESEARCH_CANDIDATE_PASS" for result in results
            ),
            "selectedVariants": {
                variant: sum(result.get("selectedVariant") == variant for result in results)
                for variant in ("single_head_full_cortex", "regime_selective_two_stage")
            },
            "completeBotsReady": 0,
            "elapsedSeconds": round(time.time() - started, 2),
        },
        "results": results,
        "promotion": "NONE_RESEARCH_ONLY",
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("[KINGBOT V12.4 SUMMARY]", json.dumps(report["summary"], sort_keys=True))
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: run_v124_regime_selective_research.py INPUT_JSON OUTPUT_JSON")
    raise SystemExit(run(Path(sys.argv[1]), Path(sys.argv[2])))
