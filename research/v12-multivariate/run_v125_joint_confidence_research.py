"""V12.5: compare calibrated actionability-only and joint-confidence abstention.

Reuses V12.4's causal regime dataset. One two-head Transformer is trained per
specialist and produces two predeclared decision rules:
- actionability-only gate from V12.4;
- joint directional-confidence gate that abstains when direction is uncertain.

Thresholds and temperatures are selected on a purged calibration slice inside
the training fold only. Evaluation remains untouched until development passes.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

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
import run_v124_regime_selective_research as v124  # noqa: E402
from run_v122_hold_research import _detailed_metrics  # noqa: E402

EPOCHS = 12
CALIBRATION_TRAIN_FRACTION = 0.80
MIN_CALIBRATION_SAMPLES = 30
MIN_TRADE_COVERAGE = 0.10
MAX_TRADE_COVERAGE = 0.80
JOINT_THRESHOLD_GRID = tuple(float(value) for value in np.linspace(0.025, 0.90, 36))
VARIANTS = (
    "single_head_full_cortex",
    "actionability_only_gate",
    "joint_direction_confidence_gate",
)


def _sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(np.asarray(values, dtype=np.float64), -40.0, 40.0)))


def _one_hot_probabilities(labels: np.ndarray) -> np.ndarray:
    values = np.asarray(labels, dtype=np.int64)
    probabilities = np.zeros((len(values), 3), dtype=np.float64)
    for row, label in enumerate(values):
        probabilities[row, service.LABEL_TO_INDEX[int(label)]] = 1.0
    return probabilities


def _joint_directional_confidence(
    action_probability: np.ndarray,
    buy_probability: np.ndarray,
) -> np.ndarray:
    """P(actionable) times directional conviction above 50/50.

    This is a classification confidence score, not expected return.
    """
    action = np.asarray(action_probability, dtype=np.float64).reshape(-1)
    buy = np.asarray(buy_probability, dtype=np.float64).reshape(-1)
    if action.shape != buy.shape or not np.isfinite(action).all() or not np.isfinite(buy).all():
        raise ValueError("V125_CONFIDENCE_INPUT_INVALID")
    if np.any((action < 0.0) | (action > 1.0) | (buy < 0.0) | (buy > 1.0)):
        raise ValueError("V125_CONFIDENCE_PROBABILITY_RANGE_INVALID")
    return action * np.abs(2.0 * buy - 1.0)


def _joint_gate_labels(
    action_probability: np.ndarray,
    buy_probability: np.ndarray,
    threshold: float,
) -> tuple[np.ndarray, np.ndarray]:
    confidence = _joint_directional_confidence(action_probability, buy_probability)
    actionable = confidence >= float(threshold)
    labels = np.zeros(len(confidence), dtype=np.int64)
    buy = np.asarray(buy_probability, dtype=np.float64)
    labels[actionable & (buy >= 0.5)] = 1
    labels[actionable & (buy < 0.5)] = -1
    return labels, actionable


def _select_joint_threshold(
    action_probability: np.ndarray,
    buy_probability: np.ndarray,
    y_true: np.ndarray,
    *,
    min_coverage: float = MIN_TRADE_COVERAGE,
    max_coverage: float = MAX_TRADE_COVERAGE,
) -> tuple[float, dict]:
    """Select threshold using calibration rows only and a bounded trade-coverage range."""
    actual = np.asarray(y_true, dtype=np.int64).reshape(-1)
    confidence = _joint_directional_confidence(action_probability, buy_probability)
    if (len(actual) != len(confidence) or len(actual) < MIN_CALIBRATION_SAMPLES
            or not np.isin(actual, (-1, 0, 1)).all()
            or not 0.0 <= min_coverage < max_coverage <= 1.0):
        raise ValueError("V125_CALIBRATION_THRESHOLD_INPUT_INVALID")

    best = None
    best_details = None
    for threshold in JOINT_THRESHOLD_GRID:
        predicted, active = _joint_gate_labels(action_probability, buy_probability, threshold)
        coverage = float(active.mean()) if len(active) else 0.0
        if coverage < min_coverage or coverage > max_coverage:
            continue
        metrics = _detailed_metrics(actual, _one_hot_probabilities(predicted))
        if not metrics["classCoverageGate"]:
            continue
        candidate = (
            float(metrics["selectionScore"]),
            float(metrics["balancedAccuracy"]),
            float(metrics["macroF1"]),
            -coverage,
            float(threshold),
        )
        if best is None or candidate > best:
            best = candidate
            best_details = {
                "calibrationScore": float(metrics["selectionScore"]),
                "calibrationBalancedAccuracy": float(metrics["balancedAccuracy"]),
                "calibrationMacroF1": float(metrics["macroF1"]),
                "calibrationTradeCoverage": coverage,
                "calibrationSamples": int(len(actual)),
                "threshold": float(threshold),
                "objective": "0.60_balanced_accuracy_plus_0.40_macro_f1",
                "coverageConstraint": f"{min_coverage:.2f}-{max_coverage:.2f}",
                "thresholdSelectedOnCalibrationOnly": True,
            }

    if best is None or best_details is None:
        return 1.01, {
            "calibrationScore": 0.0,
            "calibrationBalancedAccuracy": 0.0,
            "calibrationMacroF1": 0.0,
            "calibrationTradeCoverage": 0.0,
            "calibrationSamples": int(len(actual)),
            "threshold": 1.01,
            "objective": "no_eligible_threshold_all_abstain",
            "coverageConstraint": f"{min_coverage:.2f}-{max_coverage:.2f}",
            "thresholdSelectedOnCalibrationOnly": True,
        }
    return float(best_details["threshold"]), best_details


def _binary_ece(probabilities: np.ndarray, targets: np.ndarray) -> float:
    p = np.asarray(probabilities, dtype=np.float64).reshape(-1)
    y = np.asarray(targets, dtype=np.float64).reshape(-1)
    if len(p) != len(y) or not len(p):
        return 0.0
    edges = np.linspace(0.0, 1.0, 11)
    result = 0.0
    for index in range(10):
        mask = (p >= edges[index]) & (
            p < edges[index + 1] if index < 9 else p <= edges[index + 1]
        )
        if mask.any():
            result += float(mask.mean()) * abs(float(p[mask].mean()) - float(y[mask].mean()))
    return result


def _diagnostics(y_true, action_probability, buy_probability, predicted_labels,
                 threshold, calibration):
    actual = np.asarray(y_true, dtype=np.int64)
    predicted = np.asarray(predicted_labels, dtype=np.int64)
    active = predicted != 0
    actionable_actual = actual != 0
    tp = int(np.sum(active & actionable_actual))
    precision = tp / max(1, int(active.sum()))
    recall = tp / max(1, int(actionable_actual.sum()))
    f1 = 2.0 * precision * recall / max(1e-12, precision + recall)
    directional_correct = (predicted[active] == actual[active]) if active.any() else np.asarray([], dtype=bool)
    confidence = _joint_directional_confidence(action_probability, buy_probability)
    return {
        "tradeCoverage": float(active.mean()) if len(active) else 0.0,
        "actionabilityPrecision": float(precision),
        "actionabilityRecall": float(recall),
        "actionabilityF1": float(f1),
        "directionAccuracyOnSelectedRows": float(directional_correct.mean()) if len(directional_correct) else 0.0,
        "meanJointConfidenceSelected": float(confidence[active].mean()) if active.any() else 0.0,
        "meanJointConfidenceAbstained": float(confidence[~active].mean()) if (~active).any() else 0.0,
        "jointConfidenceThreshold": float(threshold),
        "actionabilityBrier": float(np.mean((np.asarray(action_probability) - actionable_actual.astype(float)) ** 2)),
        "actionabilityECE": _binary_ece(action_probability, actionable_actual.astype(float)),
        "calibration": calibration,
    }


def _fit_two_head_and_compare_gates(data, core_indices, calibration_indices,
                                    evaluation_indices, epochs=EPOCHS):
    if not 1 <= epochs <= 80:
        raise ValueError("V125_TRAINING_EPOCHS_INVALID")
    X, C, M, A, y = (data[key] for key in ("X", "C", "M", "A", "y"))
    train_y = np.asarray(y[core_indices], dtype=np.int64)
    cal_y = np.asarray(y[calibration_indices], dtype=np.int64)
    if len(core_indices) < 90 or len(calibration_indices) < MIN_CALIBRATION_SAMPLES or len(evaluation_indices) < 1:
        raise ValueError("V125_SAMPLE_COVERAGE_INSUFFICIENT")

    combined_indices = np.concatenate((calibration_indices, evaluation_indices))
    tx, combined_x, tc, combined_c, tm, combined_m = v12._scale(
        X[core_indices], X[combined_indices], C[core_indices], C[combined_indices],
        M[core_indices], M[combined_indices], A[core_indices], A[combined_indices],
    )
    calibration_count = len(calibration_indices)
    cal_x, eval_x = combined_x[:calibration_count], combined_x[calibration_count:]
    cal_c, eval_c = combined_c[:calibration_count], combined_c[calibration_count:]
    cal_m, eval_m = combined_m[:calibration_count], combined_m[calibration_count:]

    action_targets = (train_y != 0).astype(np.float32)
    direction_mask = train_y != 0
    direction_targets = (train_y > 0).astype(np.float32)
    if len(np.unique(action_targets)) < 2 or len(np.unique(direction_targets[direction_mask])) < 2:
        raise ValueError("V125_TRAINING_CLASS_COVERAGE_INSUFFICIENT")

    hold_count, action_count = int(np.sum(~direction_mask)), int(np.sum(direction_mask))
    sell_count, buy_count = int(np.sum(train_y == -1)), int(np.sum(train_y == 1))
    action_pos_weight = max(0.10, min(10.0, hold_count / max(action_count, 1)))
    direction_pos_weight = max(0.25, min(4.0, sell_count / max(buy_count, 1)))

    torch.manual_seed(v12.SEED)
    np.random.seed(v12.SEED)
    torch.set_num_threads(1)
    model = v124.RegimeSelectiveTransformer(tx.shape[-1], tc.shape[-1], tc.shape[1], tx.shape[1])
    action_loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(action_pos_weight, dtype=torch.float32))
    direction_loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(direction_pos_weight, dtype=torch.float32))
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
        for bx, bc, bm, ba, bd, bmask in loader:
            action_logits, direction_logits = model(bx, bc, bm)
            action_loss = action_loss_fn(action_logits, ba)
            active = bmask.bool()
            if active.any():
                direction_loss = direction_loss_fn(direction_logits[active], bd[active])
            else:
                direction_loss = direction_logits.new_zeros(())
            loss = action_loss + 0.75 * direction_loss
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

    model.eval()
    with torch.no_grad():
        cal_action_logits, cal_direction_logits = model(torch.from_numpy(cal_x), torch.from_numpy(cal_c), torch.from_numpy(cal_m))
        eval_action_logits, eval_direction_logits = model(torch.from_numpy(eval_x), torch.from_numpy(eval_c), torch.from_numpy(eval_m))
    cal_action_logits = cal_action_logits.cpu().numpy()
    cal_direction_logits = cal_direction_logits.cpu().numpy()
    eval_action_logits = eval_action_logits.cpu().numpy()
    eval_direction_logits = eval_direction_logits.cpu().numpy()

    cal_action_targets = (cal_y != 0).astype(np.float64)
    cal_direction_mask = cal_y != 0
    cal_direction_targets = (cal_y[cal_direction_mask] > 0).astype(np.float64)
    if len(np.unique(cal_action_targets)) < 2 or len(np.unique(cal_direction_targets)) < 2:
        raise ValueError("V125_CALIBRATION_CLASS_COVERAGE_INSUFFICIENT")

    action_temperature = v124._fit_temperature(cal_action_logits, cal_action_targets)
    direction_temperature = v124._fit_temperature(cal_direction_logits[cal_direction_mask], cal_direction_targets)
    cal_action = _sigmoid(cal_action_logits / action_temperature)
    cal_buy = _sigmoid(cal_direction_logits / direction_temperature)
    eval_action = _sigmoid(eval_action_logits / action_temperature)
    eval_buy = _sigmoid(eval_direction_logits / direction_temperature)

    action_threshold, action_threshold_metrics = v124._select_action_threshold(
        cal_action, cal_action_targets.astype(bool)
    )
    action_only_probs, _, _ = v124._gate_probabilities(
        eval_action_logits, eval_direction_logits,
        action_temperature, direction_temperature, action_threshold,
    )
    action_only_labels = np.asarray(
        [service.INDEX_TO_LABEL[int(value)] for value in action_only_probs.argmax(axis=1)],
        dtype=np.int64,
    )

    joint_threshold, joint_calibration = _select_joint_threshold(cal_action, cal_buy, cal_y)
    joint_labels, _ = _joint_gate_labels(eval_action, eval_buy, joint_threshold)
    joint_probs = _one_hot_probabilities(joint_labels)
    eval_y = y[evaluation_indices]

    action_only_diag = _diagnostics(
        eval_y, eval_action, eval_buy, action_only_labels, action_threshold,
        {
            "calibrationSamples": int(len(cal_y)),
            "actionTemperature": float(action_temperature),
            "directionTemperature": float(direction_temperature),
            "actionThreshold": float(action_threshold),
            "thresholdSelection": action_threshold_metrics,
            "calibrationWasTrainingOnly": True,
        },
    )
    joint_diag = _diagnostics(
        eval_y, eval_action, eval_buy, joint_labels, joint_threshold,
        {
            "calibrationSamples": int(len(cal_y)),
            "actionTemperature": float(action_temperature),
            "directionTemperature": float(direction_temperature),
            **joint_calibration,
            "calibrationWasTrainingOnly": True,
        },
    )
    return {
        "actionability_only_gate": action_only_probs,
        "joint_direction_confidence_gate": joint_probs,
    }, {
        "actionability_only_gate": action_only_diag,
        "joint_direction_confidence_gate": joint_diag,
    }


def _fold_masks(data, train_fraction, test_fraction):
    train_mask, evaluation_mask, cutoff = service.global_temporal_split_masks(
        data["times"], data["ends"], train_fraction=train_fraction, test_fraction=test_fraction,
    )
    if train_mask.sum() < 120 or evaluation_mask.sum() < v12.MIN_N:
        raise ValueError("V125_FOLD_SAMPLE_COVERAGE_INSUFFICIENT")
    return train_mask, evaluation_mask, cutoff


def _run_fold(data, train_fraction, test_fraction):
    train_mask, evaluation_mask, cutoff = _fold_masks(data, train_fraction, test_fraction)
    outer_train_indices = np.flatnonzero(train_mask)
    evaluation_indices = np.flatnonzero(evaluation_mask)
    inner_train_mask, calibration_mask, calibration_cutoff = service.global_temporal_split_masks(
        data["times"][outer_train_indices], data["ends"][outer_train_indices],
        train_fraction=CALIBRATION_TRAIN_FRACTION, test_fraction=1.0,
    )
    core_indices = outer_train_indices[inner_train_mask]
    calibration_indices = outer_train_indices[calibration_mask]
    if len(calibration_indices) < MIN_CALIBRATION_SAMPLES:
        raise ValueError("V125_INNER_CALIBRATION_TOO_SMALL")

    y = data["y"]
    train_y, eval_y = y[core_indices], y[evaluation_indices]
    v9_probabilities = v12.matched_v9(
        data["v9Features"][core_indices], train_y,
        data["v9Features"][evaluation_indices], eval_y,
    )
    v9_metrics = _detailed_metrics(eval_y, v9_probabilities)
    single_head_probabilities = v123.fit_predict(
        data["X"][core_indices], data["C"][core_indices], data["M"][core_indices],
        data["A"][core_indices], train_y, data["X"][evaluation_indices],
        data["C"][evaluation_indices], data["M"][evaluation_indices], data["A"][evaluation_indices],
    )
    two_head_probabilities, two_head_diagnostics = _fit_two_head_and_compare_gates(
        data, core_indices, calibration_indices, evaluation_indices,
    )
    probabilities_by_variant = {
        "single_head_full_cortex": single_head_probabilities,
        **two_head_probabilities,
    }

    results = {}
    for variant in VARIANTS:
        probabilities = probabilities_by_variant[variant]
        metrics = _detailed_metrics(eval_y, probabilities)
        delta = metrics["selectionScore"] - v9_metrics["selectionScore"]
        results[variant] = {
            "model": metrics,
            "selectionScoreDeltaVsV9": float(delta),
            "passesDevelopmentGuard": bool(metrics["qualityGate"] and delta >= -0.01),
            "diagnostics": two_head_diagnostics.get(variant, {}),
        }
        if variant in ("actionability_only_gate", "joint_direction_confidence_gate"):
            results[variant]["diagnostics"]["regimeBreakdown"] = v124._regime_breakdown(
                eval_y, probabilities, data["regimeStates"][evaluation_indices]
            )

    return {
        "cutoffTimestamp": float(cutoff),
        "innerCalibrationCutoffTimestamp": float(calibration_cutoff),
        "coreTrainingSamples": int(len(core_indices)),
        "calibrationSamples": int(len(calibration_indices)),
        "testSamples": int(len(evaluation_indices)),
        "v9MatchedBaseline": v9_metrics,
        "variants": results,
    }


def _select_development_variant(development):
    eligible = [
        (name, result) for name, result in development["variants"].items()
        if result["passesDevelopmentGuard"]
    ]
    return max(eligible, key=lambda item: item[1]["model"]["selectionScore"])[0] if eligible else None


def run_pilot(strategy, timeframe, markets_by_timeframe):
    data = v124.build_v124_dataset(markets_by_timeframe, strategy, timeframe)
    development = _run_fold(data, 0.70, 0.85)
    selected_variant = _select_development_variant(development)
    final_fold = _run_fold(data, 0.85, 1.0) if selected_variant else None
    final_result = final_fold["variants"][selected_variant] if final_fold else None
    final_delta = final_result["selectionScoreDeltaVsV9"] if final_result else None
    passed = bool(final_result and final_result["model"]["qualityGate"] and final_delta >= v12.MIN_DELTA)
    return {
        "strategy": strategy, "timeframe": timeframe,
        "status": "RESEARCH_CANDIDATE_PASS" if passed else ("FINAL_REJECTED" if final_fold else "DEVELOPMENT_REJECTED"),
        "sequenceLength": data["sequenceLength"],
        "regimeFeatureCount": len(v124.REGIME_FEATURE_NAMES),
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
        raise ValueError("V125_MARKET_TIMEFRAME_DATA_MISSING")
    started = time.time()
    results = []
    for strategy, timeframe in v12.PILOTS.items():
        try:
            result = run_pilot(strategy, timeframe, markets)
        except Exception as error:
            result = {"strategy": strategy, "timeframe": timeframe, "status": "RESEARCH_ERROR", "error": str(error)[:400]}
        results.append(result)
        print("[KINGBOT V12.5 JOINT CONFIDENCE PILOT]", json.dumps({
            "strategy": strategy, "timeframe": timeframe,
            "status": result.get("status"), "selectedVariant": result.get("selectedVariant"),
            "developmentVariants": {
                name: {
                    "balancedAccuracy": values["model"]["balancedAccuracy"],
                    "macroF1": values["model"]["macroF1"],
                    "selectionScoreDeltaVsV9": values["selectionScoreDeltaVsV9"],
                    "qualityGate": values["model"]["qualityGate"],
                    "tradeCoverage": values.get("diagnostics", {}).get("tradeCoverage"),
                    "directionAccuracyOnSelectedRows": values.get("diagnostics", {}).get("directionAccuracyOnSelectedRows"),
                    "jointConfidenceThreshold": values.get("diagnostics", {}).get("jointConfidenceThreshold"),
                }
                for name, values in (result.get("development") or {}).get("variants", {}).items()
            },
            "error": result.get("error"),
        }, sort_keys=True))

    report = {
        "generatedAt": payload.get("generatedAt"),
        "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "researchVersion": "v12-5-joint-direction-confidence-abstention-1",
        "researchOnly": True, "productionChanged": False, "modelArtifactsPersisted": False,
        "architecture": {
            "dataset": "V12.4 causal regime-aware full-Cortex panels",
            "challengers": {
                "single_head_full_cortex": "V12.4 three-class Transformer",
                "actionability_only_gate": "V12.4 two-head model; HOLD gate uses calibrated actionability probability",
                "joint_direction_confidence_gate": "same two-head model; SELL/BUY accepted only when joint actionability and direction confidence clears the calibrated threshold",
            },
            "jointConfidence": "P(actionable) multiplied by absolute directional conviction from 50/50; classification confidence only, not expected returns",
            "thresholdCalibration": "temperatures and abstention thresholds fit only on purged chronological calibration rows inside the training fold",
            "labels": "unchanged V12 six-bar ATR triple-barrier SELL/HOLD/BUY",
            "training": "12 epochs, AdamW, same seed and split for the two-head decision-gate comparators, training-fold-only scaling",
            "causality": "V12.4 trailing OHLC regime features and closed-candle cross-market as-of context",
        },
        "validation": {
            "developmentWindow": "70%-85%", "finalWindow": "85%-100% untouched",
            "innerCalibration": "purged chronological 80%-20% split inside outer training fold",
            "forwardLabelPurging": True,
            "matchedBaseline": "V9 RF+PyTorch trained on identical inner core",
            "variantSelection": "development only; final evaluation only after a candidate passes the development guard",
            "developmentGuard": "balanced accuracy >=0.36, macro-F1 >=0.34, >=30 samples, nonzero SELL/HOLD/BUY recall and delta >=-0.01",
            "finalGate": "same absolute gate and final selection-score improvement >=0.005 versus matched V9",
            "jointThresholdCalibration": {
                "objective": "0.60 balanced accuracy + 0.40 macro-F1",
                "minTradeCoverage": MIN_TRADE_COVERAGE,
                "maxTradeCoverage": MAX_TRADE_COVERAGE,
                "grid": list(JOINT_THRESHOLD_GRID),
                "calibrationOnly": True,
            },
        },
        "dataFetch": {
            "historyLimit": payload.get("historyLimit"),
            "fetchSummary": payload.get("fetchSummary", []),
            "fetchWarnings": payload.get("fetchWarnings", []),
            "fetchFailures": payload.get("fetchFailures", []),
            "coverageWarning": "Fetcher and ML normalizer cap history at 3,000 bars; provider depth is itemized.",
        },
        "summary": {
            "targetModels": len(results),
            "evaluatedModels": sum(result.get("status") != "RESEARCH_ERROR" for result in results),
            "developmentPassed": sum(bool(result.get("selectedVariant")) for result in results),
            "finalEvaluated": sum(result.get("final") is not None for result in results),
            "finalQualityGatePassed": sum(bool((result.get("final") or {}).get("result", {}).get("model", {}).get("qualityGate")) for result in results),
            "researchCandidatesPassed": sum(result.get("status") == "RESEARCH_CANDIDATE_PASS" for result in results),
            "selectedVariants": {variant: sum(result.get("selectedVariant") == variant for result in results) for variant in VARIANTS},
            "completeBotsReady": 0,
            "elapsedSeconds": round(time.time() - started, 2),
        },
        "results": results,
        "promotion": "NONE_RESEARCH_ONLY",
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("[KINGBOT V12.5 SUMMARY]", json.dumps(report["summary"], sort_keys=True))
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: run_v125_joint_confidence_research.py INPUT_JSON OUTPUT_JSON")
    raise SystemExit(run(Path(sys.argv[1]), Path(sys.argv[2])))
