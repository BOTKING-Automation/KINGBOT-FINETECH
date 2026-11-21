"""Leakage-aware multiclass probability calibration for KINGBOT ML models."""
from __future__ import annotations

import math
from typing import Any

import numpy as np

TEMPERATURE_MIN = 0.5
TEMPERATURE_MAX = 3.0
MIN_CALIBRATION_SAMPLES = 40
MIN_CLASS_SUPPORT = 5
_EPSILON = 1e-8


def _validated_probabilities(probabilities: Any) -> np.ndarray:
    values = np.asarray(probabilities, dtype=np.float64)
    if values.ndim != 2 or values.shape[1] != 3 or values.shape[0] < 1:
        raise ValueError("ML_CALIBRATION_PROBABILITY_SHAPE_INVALID")
    if not np.isfinite(values).all() or np.any(values < 0.0):
        raise ValueError("ML_CALIBRATION_PROBABILITIES_INVALID")
    totals = values.sum(axis=1, keepdims=True)
    if np.any(totals <= 0.0):
        raise ValueError("ML_CALIBRATION_PROBABILITIES_INVALID")
    return values / totals


def _validated_labels(labels: Any, sample_count: int) -> np.ndarray:
    values = np.asarray(labels, dtype=np.int64)
    if values.ndim != 1 or len(values) != sample_count or not np.isin(values, (-1, 0, 1)).all():
        raise ValueError("ML_CALIBRATION_LABELS_INVALID")
    return values + 1


def apply_probability_temperature(probabilities: Any, temperature: float = 1.0) -> np.ndarray:
    """Apply scalar temperature scaling without changing the predicted class."""
    value = float(temperature)
    if not math.isfinite(value) or not TEMPERATURE_MIN <= value <= TEMPERATURE_MAX:
        raise ValueError("ML_PROBABILITY_TEMPERATURE_INVALID")
    probs = _validated_probabilities(probabilities)
    if abs(value - 1.0) <= 1e-12:
        return probs.astype(np.float32)
    logits = np.log(np.clip(probs, _EPSILON, 1.0)) / value
    logits -= logits.max(axis=1, keepdims=True)
    exponentials = np.exp(logits)
    calibrated = exponentials / np.maximum(exponentials.sum(axis=1, keepdims=True), _EPSILON)
    return calibrated.astype(np.float32)


def probability_calibration_metrics(labels: Any, probabilities: Any, bins: int = 10) -> dict[str, float | int]:
    """Return multiclass NLL, Brier score, top-label ECE and sample count."""
    probs = _validated_probabilities(probabilities)
    actual = _validated_labels(labels, len(probs))
    predicted = np.argmax(probs, axis=1)
    confidence = np.max(probs, axis=1)
    correct = (predicted == actual).astype(np.float64)
    nll = -float(np.mean(np.log(np.clip(probs[np.arange(len(probs)), actual], _EPSILON, 1.0))))
    one_hot = np.eye(3, dtype=np.float64)[actual]
    brier = float(np.mean(np.sum((probs - one_hot) ** 2, axis=1)))
    bin_count = max(2, min(30, int(bins)))
    boundaries = np.linspace(0.0, 1.0, bin_count + 1)
    ece = 0.0
    for index in range(bin_count):
        lower = boundaries[index]
        upper = boundaries[index + 1]
        selected = (confidence >= lower) & (
            confidence <= upper if index == bin_count - 1 else confidence < upper
        )
        if np.any(selected):
            ece += float(np.mean(selected)) * abs(
                float(np.mean(correct[selected])) - float(np.mean(confidence[selected]))
            )
    return {
        "samples": int(len(probs)),
        "negativeLogLikelihood": nll,
        "brierScore": brier,
        "expectedCalibrationError": float(ece),
    }


def fit_probability_temperature(labels: Any, probabilities: Any) -> dict[str, Any]:
    """Fit one temperature on development-only probabilities.

    The caller must reserve a later chronological holdout for final acceptance.
    The fit is rejected unless NLL improves and Brier/ECE remain within bounded
    non-worsening tolerances.
    """
    probs = _validated_probabilities(probabilities)
    actual = _validated_labels(labels, len(probs))
    before = probability_calibration_metrics(labels, probs)
    class_counts = {
        name: int(np.sum(actual == index))
        for index, name in enumerate(("SELL", "HOLD", "BUY"))
    }
    if len(probs) < MIN_CALIBRATION_SAMPLES or min(class_counts.values()) < MIN_CLASS_SUPPORT:
        return {
            "status": "INSUFFICIENT_CLASS_COVERAGE",
            "accepted": False,
            "temperature": 1.0,
            "candidateTemperature": 1.0,
            "classSupport": class_counts,
            "before": before,
            "after": before,
        }

    candidates = np.geomspace(TEMPERATURE_MIN, TEMPERATURE_MAX, 251)
    best_temperature = 1.0
    best_nll = float(before["negativeLogLikelihood"])
    for candidate in candidates:
        calibrated = apply_probability_temperature(probs, float(candidate))
        metrics = probability_calibration_metrics(labels, calibrated)
        score = float(metrics["negativeLogLikelihood"])
        if score < best_nll - 1e-12:
            best_nll = score
            best_temperature = float(candidate)

    after = probability_calibration_metrics(
        labels, apply_probability_temperature(probs, best_temperature)
    )
    nll_improvement = float(before["negativeLogLikelihood"]) - float(after["negativeLogLikelihood"])
    brier_delta = float(after["brierScore"]) - float(before["brierScore"])
    ece_delta = (
        float(after["expectedCalibrationError"]) - float(before["expectedCalibrationError"])
    )
    accepted = (
        abs(best_temperature - 1.0) >= 0.02
        and nll_improvement >= 0.001
        and brier_delta <= 0.005
        and ece_delta <= 0.03
    )
    return {
        "status": "ACCEPTED" if accepted else "NO_DEVELOPMENT_IMPROVEMENT",
        "accepted": bool(accepted),
        "temperature": best_temperature if accepted else 1.0,
        "candidateTemperature": best_temperature,
        "nllImprovement": nll_improvement,
        "brierDelta": brier_delta,
        "eceDelta": ece_delta,
        "classSupport": class_counts,
        "before": before,
        "after": after,
    }
