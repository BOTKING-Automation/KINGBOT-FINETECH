"""V12.2 research: controlled HOLD-aware loss objective ablation.

This module reuses V12.1 causal alignment, temporal purging, Transformer architecture,
and matched V9 baseline. Context mode is frozen per specialist from V12.1's best
development selection score; only the training objective is varied here.
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
from torch.nn import functional as F
from torch.utils.data import DataLoader, TensorDataset

_ROOT = Path(__file__).resolve().parents[2]
_ML = _ROOT / "ml-signal-service"
_RESEARCH = _ROOT / "research" / "v12-multivariate"
for candidate in (_ML, _RESEARCH):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

import service  # noqa: E402
import multivariate_transformer as v12  # noqa: E402

PILOT_CONTEXT_MODES = {
    "strategic": "high_coverage",
    "flipper": "target_only",
    "breakout": "full_context",
    "smc-pro": "target_only",
    "ladder-flip": "target_only",
}
LOSS_MODES = (
    "inverse_frequency_cross_entropy",
    "hold_boost_cross_entropy",
    "inverse_frequency_focal_gamma_1_5",
    "hold_boost_focal_gamma_1_5",
)
HOLD_WEIGHT_MULTIPLIER = 1.25
FOCAL_GAMMA = 1.5


def _objective_parameters(mode: str) -> tuple[float, float]:
    if mode not in LOSS_MODES:
        raise ValueError("V122_LOSS_OBJECTIVE_INVALID")
    hold_multiplier = HOLD_WEIGHT_MULTIPLIER if mode.startswith("hold_boost_") else 1.0
    gamma = FOCAL_GAMMA if "_focal_" in mode else 0.0
    return hold_multiplier, gamma


def _class_weights(train_y: np.ndarray, hold_multiplier: float) -> np.ndarray:
    labels = np.asarray([service.LABEL_TO_INDEX[int(value)] for value in train_y], dtype=np.int64)
    counts = np.bincount(labels, minlength=3).astype(np.float32)
    weights = len(labels) / np.maximum(counts, 1.0)
    weights /= max(float(weights.mean()), 1e-8)
    # HOLD is class index 1 under the service's SELL/HOLD/BUY mapping.
    weights[1] *= float(hold_multiplier)
    weights /= max(float(weights.mean()), 1e-8)
    return weights.astype(np.float32)


class WeightedFocalLoss(nn.Module):
    """Weighted multiclass focal loss with CE-compatible class-weight normalization."""

    def __init__(self, class_weights: np.ndarray, gamma: float = FOCAL_GAMMA):
        super().__init__()
        if gamma < 0:
            raise ValueError("V122_FOCAL_GAMMA_INVALID")
        self.register_buffer("class_weights", torch.as_tensor(class_weights, dtype=torch.float32))
        self.gamma = float(gamma)

    def forward(self, logits: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
        if logits.ndim != 2 or logits.shape[1] != 3 or targets.ndim != 1:
            raise ValueError("V122_FOCAL_INPUT_SHAPE_INVALID")
        log_probs = F.log_softmax(logits, dim=1)
        target_log_probs = log_probs.gather(1, targets.view(-1, 1)).squeeze(1)
        target_probs = target_log_probs.exp()
        sample_weights = self.class_weights[targets]
        focal_factor = (1.0 - target_probs).clamp_min(0.0).pow(self.gamma)
        weighted_losses = sample_weights * focal_factor * (-target_log_probs)
        return weighted_losses.sum() / sample_weights.sum().clamp_min(1e-8)


def _detailed_metrics(y_true: np.ndarray, probabilities: np.ndarray) -> dict[str, Any]:
    from sklearn.metrics import confusion_matrix, precision_recall_fscore_support

    result = v12.metrics(y_true, probabilities)
    actual = np.asarray([service.LABEL_TO_INDEX[int(value)] for value in y_true], dtype=np.int64)
    predicted = probabilities.argmax(axis=1)
    precision, recall, f1, support = precision_recall_fscore_support(
        actual, predicted, labels=[0, 1, 2], zero_division=0
    )
    names = ("SELL", "HOLD", "BUY")
    result.update({
        "classPrecision": {name: float(precision[index]) for index, name in enumerate(names)},
        "classRecall": {name: float(recall[index]) for index, name in enumerate(names)},
        "classF1": {name: float(f1[index]) for index, name in enumerate(names)},
        "actualClassCounts": {name: int(support[index]) for index, name in enumerate(names)},
        "predictedClassCounts": {
            name: int(np.sum(predicted == index)) for index, name in enumerate(names)
        },
        "confusionMatrixSellHoldBuy": confusion_matrix(actual, predicted, labels=[0, 1, 2]).tolist(),
    })
    return result


def fit_predict(
    train_x: np.ndarray,
    train_c: np.ndarray,
    train_m: np.ndarray,
    train_a: np.ndarray,
    train_y: np.ndarray,
    eval_x: np.ndarray,
    eval_c: np.ndarray,
    eval_m: np.ndarray,
    eval_a: np.ndarray,
    objective: str,
    epochs: int = v12.EPOCHS,
) -> np.ndarray:
    if objective not in LOSS_MODES or not 1 <= epochs <= 80:
        raise ValueError("V122_TRAINING_CONFIGURATION_INVALID")
    hold_multiplier, gamma = _objective_parameters(objective)
    tx, ex, tc, ec, tm, em = v12._scale(
        train_x, eval_x, train_c, eval_c, train_m, eval_m, train_a, eval_a
    )
    ty = np.asarray([service.LABEL_TO_INDEX[int(value)] for value in train_y], dtype=np.int64)
    if len(tx) < 90 or len(ex) < 1:
        raise ValueError("V122_TRAINING_SAMPLE_COVERAGE_INSUFFICIENT")

    torch.manual_seed(v12.SEED)
    np.random.seed(v12.SEED)
    torch.set_num_threads(1)
    model = v12.CrossMarketTransformer(tx.shape[-1], tc.shape[1], tx.shape[1])
    weights = _class_weights(train_y, hold_multiplier)
    weight_tensor = torch.as_tensor(weights, dtype=torch.float32)
    loss_fn: nn.Module
    if gamma > 0:
        loss_fn = WeightedFocalLoss(weights, gamma=gamma)
    else:
        loss_fn = nn.CrossEntropyLoss(weight=weight_tensor)

    dataset = TensorDataset(
        torch.from_numpy(tx),
        torch.from_numpy(tc),
        torch.from_numpy(tm),
        torch.from_numpy(ty),
    )
    loader = DataLoader(
        dataset,
        batch_size=min(v12.BATCH, len(dataset)),
        shuffle=True,
        generator=torch.Generator().manual_seed(v12.SEED),
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.0006, weight_decay=0.001)
    model.train()
    for _ in range(epochs):
        for batch_x, batch_c, batch_m, batch_y in loader:
            loss = loss_fn(model(batch_x, batch_c, batch_m), batch_y)
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

    model.eval()
    with torch.no_grad():
        probabilities = torch.softmax(
            model(torch.from_numpy(ex), torch.from_numpy(ec), torch.from_numpy(em)), dim=1
        ).cpu().numpy()
    if probabilities.shape != (len(ex), 3) or not np.isfinite(probabilities).all():
        raise ValueError("V122_PREDICTION_OUTPUT_INVALID")
    return probabilities


def _fold_masks(data: dict[str, Any], train_fraction: float, test_fraction: float):
    train_mask, eval_mask, cutoff = service.global_temporal_split_masks(
        data["times"], data["ends"],
        train_fraction=train_fraction,
        test_fraction=test_fraction,
    )
    if train_mask.sum() < 90 or eval_mask.sum() < v12.MIN_N:
        raise ValueError("V122_FOLD_SAMPLE_COVERAGE_INSUFFICIENT")
    return train_mask, eval_mask, cutoff


def _run_fold(
    data: dict[str, Any],
    strategy: str,
    train_fraction: float,
    test_fraction: float,
    objectives: tuple[str, ...],
) -> dict[str, Any]:
    train_mask, eval_mask, cutoff = _fold_masks(data, train_fraction, test_fraction)
    X, C, M, A, y = (data[key] for key in ("X", "C", "M", "A", "y"))
    train_y, eval_y = y[train_mask], y[eval_mask]
    # This one V9 prediction set is shared across all four loss-objective variants.
    baseline_probabilities = v12.matched_v9(
        X[train_mask], train_y, X[eval_mask], eval_y
    )
    baseline_metrics = _detailed_metrics(eval_y, baseline_probabilities)

    context_mode = PILOT_CONTEXT_MODES[strategy]
    train_rows = np.flatnonzero(train_mask)
    context, missing, ages, selected, coverage = v12.context_ablation(
        C, M, A, train_rows, context_mode
    )
    objective_results: dict[str, Any] = {}
    for objective in objectives:
        probabilities = fit_predict(
            X[train_mask], context[train_mask], missing[train_mask], ages[train_mask],
            train_y, X[eval_mask], context[eval_mask], missing[eval_mask], ages[eval_mask],
            objective,
        )
        model_metrics = _detailed_metrics(eval_y, probabilities)
        delta = model_metrics["selectionScore"] - baseline_metrics["selectionScore"]
        objective_results[objective] = {
            "model": model_metrics,
            "selectionScoreDeltaVsV9": float(delta),
            "passesDevelopmentGuard": bool(
                model_metrics["qualityGate"] and delta >= -0.01
            ),
        }

    return {
        "cutoffTimestamp": float(cutoff),
        "trainSamples": int(train_mask.sum()),
        "testSamples": int(eval_mask.sum()),
        "contextMode": context_mode,
        "selectedContextSlots": [data["slots"][index] for index in selected],
        "selectedContextCount": len(selected),
        "trainingContextCoverage": {
            data["slots"][index]: float(coverage[index])
            for index in range(len(data["slots"]))
        },
        "v9MatchedBaseline": baseline_metrics,
        "objectives": objective_results,
    }


def _select_development_objective(development: dict[str, Any]) -> str | None:
    eligible = [
        (name, result)
        for name, result in development["objectives"].items()
        if result["passesDevelopmentGuard"]
    ]
    if not eligible:
        return None
    return max(eligible, key=lambda item: item[1]["model"]["selectionScore"])[0]


def run_pilot(strategy: str, timeframe: str, markets_by_timeframe: dict[str, Any]) -> dict[str, Any]:
    data = v12.build_dataset(markets_by_timeframe, strategy, timeframe)
    development = _run_fold(data, strategy, 0.70, 0.85, LOSS_MODES)
    selected_objective = _select_development_objective(development)

    final_fold = None
    passed = False
    if selected_objective:
        final_fold = _run_fold(data, strategy, 0.85, 1.0, (selected_objective,))
        final_metrics = final_fold["objectives"][selected_objective]
        delta = final_metrics["selectionScoreDeltaVsV9"]
        passed = bool(final_metrics["model"]["qualityGate"] and delta >= v12.MIN_DELTA)

    return {
        "strategy": strategy,
        "timeframe": timeframe,
        "status": (
            "RESEARCH_CANDIDATE_PASS" if passed
            else "FINAL_REJECTED" if final_fold is not None
            else "DEVELOPMENT_REJECTED"
        ),
        "contextModeFrozenFromV121": PILOT_CONTEXT_MODES[strategy],
        "lossObjectives": list(LOSS_MODES),
        "development": development,
        "selectedObjective": selected_objective,
        "final": (
            {
                "cutoffTimestamp": final_fold["cutoffTimestamp"],
                "trainSamples": final_fold["trainSamples"],
                "testSamples": final_fold["testSamples"],
                "v9MatchedBaseline": final_fold["v9MatchedBaseline"],
                "selectedObjective": selected_objective,
                "result": final_fold["objectives"][selected_objective],
            } if final_fold is not None else None
        ),
        "requiredImprovementMargin": v12.MIN_DELTA,
        "passesFinalResearchGate": passed,
        "promotion": "NONE_RESEARCH_ONLY",
        "marketCoverage": data["coverage"],
        "seriesDiagnostics": data["seriesDiagnostics"],
        "contextCoverageOverall": data["contextCoverage"],
    }


def run(input_path: Path, output_path: Path) -> int:
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    markets = payload.get("marketsByTimeframe")
    if not isinstance(markets, dict):
        raise ValueError("V122_MARKET_TIMEFRAME_DATA_MISSING")

    started = time.time()
    results: list[dict[str, Any]] = []
    for strategy, timeframe in v12.PILOTS.items():
        try:
            result = run_pilot(strategy, timeframe, markets)
        except Exception as error:
            result = {
                "strategy": strategy,
                "timeframe": timeframe,
                "status": "RESEARCH_ERROR",
                "error": str(error)[:400],
            }
        results.append(result)
        print("[KINGBOT V12.2 PILOT]", json.dumps({
            "strategy": strategy,
            "timeframe": timeframe,
            "status": result.get("status"),
            "selectedObjective": result.get("selectedObjective"),
            "developmentCandidates": {
                name: {
                    "balancedAccuracy": values["model"]["balancedAccuracy"],
                    "macroF1": values["model"]["macroF1"],
                    "selectionScoreDeltaVsV9": values["selectionScoreDeltaVsV9"],
                    "holdRecall": values["model"]["classRecall"]["HOLD"],
                    "qualityGate": values["model"]["qualityGate"],
                }
                for name, values in (result.get("development") or {}).get("objectives", {}).items()
            },
            "error": result.get("error"),
        }, sort_keys=True))

    final_evaluated = sum(result.get("final") is not None for result in results)
    report = {
        "generatedAt": payload.get("generatedAt"),
        "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "researchVersion": "v12-2-hold-aware-objective-research-1",
        "researchOnly": True,
        "productionChanged": False,
        "modelArtifactsPersisted": False,
        "architecture": {
            "model": "V12.1 2-layer Transformer encoder, 64-dimensional embeddings, 4 attention heads",
            "data": "V12.2 isolated BTC history provider fallback and explicit degraded-depth diagnostics",
            "context": "one context mode per specialist frozen from V12.1's best development selection score",
            "objectives": list(LOSS_MODES),
            "holdWeightMultiplier": HOLD_WEIGHT_MULTIPLIER,
            "focalGamma": FOCAL_GAMMA,
            "training": "12 epochs, AdamW, CPU, training-fold-only scaling",
        },
        "validation": {
            "developmentWindow": "70%-85%",
            "finalWindow": "85%-100% untouched",
            "globalTimestampAlignment": True,
            "forwardLabelPurging": True,
            "matchedBaseline": "one matched V9 RF+PyTorch 55/45 prediction set reused across objective variants on identical rows",
            "objectiveSelection": "best eligible loss objective selected on development only; selected objective frozen before untouched final evaluation",
            "developmentGuard": "unchanged quality gates and selection score delta >= -0.01",
            "gatesUnchanged": {
                "balancedAccuracy": 0.36,
                "macroF1": 0.34,
                "minimumTestSamples": 30,
                "nonzeroRecall": ["SELL", "HOLD", "BUY"],
            },
            "additionalFinalGate": "final selection score exceeds matched V9 by >=0.005",
        },
        "dataFetch": {
            "historyLimit": payload.get("historyLimit"),
            "fetchSummary": payload.get("fetchSummary", []),
            "fetchWarnings": payload.get("fetchWarnings", []),
            "fetchFailures": payload.get("fetchFailures", []),
        },
        "summary": {
            "targetModels": len(results),
            "evaluatedModels": sum(result.get("status") != "RESEARCH_ERROR" for result in results),
            "developmentPassed": sum(bool(result.get("selectedObjective")) for result in results),
            "finalEvaluated": final_evaluated,
            "finalQualityGatePassed": sum(
                bool((result.get("final") or {}).get("result", {}).get("model", {}).get("qualityGate"))
                for result in results
            ),
            "researchCandidatesPassed": sum(result.get("status") == "RESEARCH_CANDIDATE_PASS" for result in results),
            "selectedObjectives": {
                objective: sum(result.get("selectedObjective") == objective for result in results)
                for objective in LOSS_MODES
            },
            "degradedBtcFeeds": sum(
                item.get("symbol") == "BTCUSD" and item.get("quality") != "FULL_DEPTH"
                for item in payload.get("fetchSummary", [])
            ),
            "completeBotsReady": 0,
            "elapsedSeconds": round(time.time() - started, 3),
        },
        "results": results,
        "promotion": {
            "status": "NONE",
            "reason": "Research only; no model weights are saved, registered, promoted or deployed.",
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("[KINGBOT V12.2 COMPLETE]", json.dumps(report["summary"], sort_keys=True))
    return 0 if report["summary"]["evaluatedModels"] else 3


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: run_v122_hold_research.py INPUT_JSON OUTPUT_JSON")
    raise SystemExit(run(Path(sys.argv[1]), Path(sys.argv[2])))
