"""KINGBOT V12.4: controlled class-imbalance/loss ablation for Cortex.

V12.3 found that full Cortex cleared development on one specialist but missed
final balanced-accuracy and macro-F1 thresholds, with weak HOLD recall. V12.4
keeps the same feature panel, labels, model, chronological folds and matched V9
reference while testing training-fold-only class-weight/loss choices.

No acceptance threshold is lowered. The final window is only evaluated after a
development candidate passes the unchanged gates and is frozen.
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
import run_v123_cortex_research as v123  # noqa: E402
from run_v122_hold_research import _detailed_metrics  # noqa: E402


LOSS_PROFILES = (
    "inverse_frequency_ce",
    "sqrt_inverse_frequency_ce",
    "effective_number_ce",
    "effective_number_focal",
)
EPOCHS = 12
FOCAL_GAMMA = 1.5
EFFECTIVE_BETA = 0.999


def unchanged_acceptance_gates() -> dict[str, Any]:
    """Return the V12 acceptance thresholds without redefining or weakening them."""
    return {
        "balancedAccuracy": v12.MIN_BA,
        "macroF1": v12.MIN_F1,
        "minimumFinalSamples": v12.MIN_N,
        "nonzeroRecall": ["SELL", "HOLD", "BUY"],
        "finalSelectionScoreDeltaVsV9": v12.MIN_DELTA,
    }


def _labels(train_y: np.ndarray) -> np.ndarray:
    return np.asarray(
        [service.LABEL_TO_INDEX[int(value)] for value in train_y],
        dtype=np.int64,
    )


def class_weight_vector(train_y: np.ndarray, profile: str) -> np.ndarray:
    """Compute class weights from training labels only; output order is SELL/HOLD/BUY."""
    if profile not in LOSS_PROFILES:
        raise ValueError("V124_LOSS_PROFILE_INVALID")
    labels = _labels(train_y)
    counts = np.bincount(labels, minlength=3).astype(np.float64)
    if len(labels) < 1 or np.any(counts <= 0):
        raise ValueError("V124_TRAINING_CLASS_COVERAGE_INSUFFICIENT")

    if profile == "inverse_frequency_ce":
        weights = v123._class_weights(train_y).astype(np.float64)
    elif profile == "sqrt_inverse_frequency_ce":
        weights = np.sqrt(len(labels) / counts)
    else:
        # Cui et al. effective-number class-balanced weight:
        # alpha_c = (1 - beta) / (1 - beta ** n_c).
        # Rare classes therefore receive larger weights than frequent classes.
        weights = (1.0 - EFFECTIVE_BETA) / (
            1.0 - np.power(EFFECTIVE_BETA, counts)
        )

    weights = weights / max(float(weights.mean()), 1e-12)
    if not np.isfinite(weights).all() or np.any(weights <= 0):
        raise ValueError("V124_CLASS_WEIGHTS_INVALID")
    return weights.astype(np.float32)


def _batch_loss(logits: torch.Tensor, labels: torch.Tensor,
                weights: torch.Tensor, profile: str) -> torch.Tensor:
    """Weighted CE controls plus effective-number class-balanced focal loss."""
    if profile == "effective_number_focal":
        per_row_ce = F.cross_entropy(logits, labels, reduction="none")
        true_class_probability = torch.softmax(logits, dim=1).gather(
            1, labels.unsqueeze(1)
        ).squeeze(1)
        alpha = weights.gather(0, labels)
        return (alpha * (1.0 - true_class_probability).pow(FOCAL_GAMMA) * per_row_ce).mean()
    return F.cross_entropy(logits, labels, weight=weights)


def fit_predict(train_x: np.ndarray, train_c: np.ndarray, train_m: np.ndarray,
                train_a: np.ndarray, train_y: np.ndarray, eval_x: np.ndarray,
                eval_c: np.ndarray, eval_m: np.ndarray, eval_a: np.ndarray,
                *, loss_profile: str, epochs: int = EPOCHS) -> np.ndarray:
    if loss_profile not in LOSS_PROFILES or not 1 <= epochs <= 80:
        raise ValueError("V124_TRAINING_CONFIGURATION_INVALID")

    # v12._scale fits only on the supplied training fold; evaluation rows never
    # influence feature scaling or class-weight estimation.
    tx, ex, tc, ec, tm, em = v12._scale(
        train_x, eval_x, train_c, eval_c, train_m, eval_m, train_a, eval_a
    )
    ty = torch.as_tensor(_labels(train_y), dtype=torch.long)
    if len(tx) < 90 or len(ex) < 1:
        raise ValueError("V124_TRAINING_SAMPLE_COVERAGE_INSUFFICIENT")

    torch.manual_seed(v12.SEED)
    np.random.seed(v12.SEED)
    torch.set_num_threads(1)
    model = v123.CortexTransformer(
        tx.shape[-1], tc.shape[-1], tc.shape[1], tx.shape[1]
    )
    weights = torch.as_tensor(
        class_weight_vector(train_y, loss_profile), dtype=torch.float32
    )
    dataset = TensorDataset(
        torch.from_numpy(tx), torch.from_numpy(tc), torch.from_numpy(tm), ty
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
            logits = model(batch_x, batch_c, batch_m)
            loss = _batch_loss(logits, batch_y, weights, loss_profile)
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

    model.eval()
    with torch.no_grad():
        probabilities = torch.softmax(
            model(
                torch.from_numpy(ex), torch.from_numpy(ec), torch.from_numpy(em)
            ),
            dim=1,
        ).cpu().numpy()
    if probabilities.shape != (len(ex), 3) or not np.isfinite(probabilities).all():
        raise ValueError("V124_PREDICTION_OUTPUT_INVALID")
    return probabilities


def _matched_v9(data: dict[str, Any], train_mask: np.ndarray,
                eval_mask: np.ndarray, train_y: np.ndarray,
                eval_y: np.ndarray) -> np.ndarray:
    baseline = data["variants"]["baseline"]
    return v12.matched_v9(
        baseline[train_mask], train_y, baseline[eval_mask], eval_y
    )


def _run_loss_fold(data: dict[str, Any], train_fraction: float,
                   test_fraction: float,
                   profiles: tuple[str, ...] = LOSS_PROFILES) -> dict[str, Any]:
    train_mask, eval_mask, cutoff = v123._fold_masks(
        data, train_fraction, test_fraction
    )
    M, A, y = (data[key] for key in ("M", "A", "y"))
    train_y, eval_y = y[train_mask], y[eval_mask]

    v9_probabilities = _matched_v9(
        data, train_mask, eval_mask, train_y, eval_y
    )
    v9_metrics = _detailed_metrics(eval_y, v9_probabilities)
    target = data["variants"]["full_cortex"]
    context = data["contextVariants"]["full_cortex"]
    requested_profiles = tuple(profiles)
    if (
        not requested_profiles
        or len(set(requested_profiles)) != len(requested_profiles)
        or any(profile not in LOSS_PROFILES for profile in requested_profiles)
    ):
        raise ValueError("V124_LOSS_PROFILE_SELECTION_INVALID")

    profile_results: dict[str, Any] = {}
    for profile in requested_profiles:
        probabilities = fit_predict(
            target[train_mask], context[train_mask], M[train_mask], A[train_mask],
            train_y, target[eval_mask], context[eval_mask], M[eval_mask],
            A[eval_mask], loss_profile=profile,
        )
        metrics = _detailed_metrics(eval_y, probabilities)
        hold_recall = float(metrics["classRecall"].get("HOLD", 0.0))
        delta = float(metrics["selectionScore"] - v9_metrics["selectionScore"])
        profile_results[profile] = {
            "model": metrics,
            "holdRecall": hold_recall,
            "selectionScoreDeltaVsV9": delta,
            "passesDevelopmentGuard": bool(
                metrics["qualityGate"] and delta >= -0.01
            ),
            "classWeights": class_weight_vector(train_y, profile).tolist(),
        }

    return {
        "cutoffTimestamp": float(cutoff),
        "trainSamples": int(train_mask.sum()),
        "testSamples": int(eval_mask.sum()),
        "v9MatchedBaseline": v9_metrics,
        "profiles": profile_results,
    }


def select_development_profile(development: dict[str, Any]) -> str | None:
    """Select only among unchanged-gate development passes; HOLD recall breaks ties."""
    eligible = [
        (name, result)
        for name, result in development.get("profiles", {}).items()
        if result.get("passesDevelopmentGuard") is True
    ]
    if not eligible:
        return None
    return max(
        eligible,
        key=lambda item: (
            float(item[1]["model"]["selectionScore"]),
            float(item[1].get("holdRecall", 0.0)),
        ),
    )[0]


def run_pilot(strategy: str, timeframe: str,
              markets_by_timeframe: dict[str, Any]) -> dict[str, Any]:
    data = v123.build_v123_dataset(
        markets_by_timeframe, strategy, timeframe
    )
    development = _run_loss_fold(data, 0.70, 0.85)
    selected = select_development_profile(development)
    # Final data is run only once for the single profile frozen by development.
    final_fold = _run_loss_fold(data, 0.85, 1.0, (selected,)) if selected else None
    final_result = final_fold["profiles"][selected] if final_fold else None
    final_delta = (
        float(final_result["selectionScoreDeltaVsV9"])
        if final_result else None
    )
    passed = bool(
        final_result
        and final_result["model"]["qualityGate"]
        and final_delta >= v12.MIN_DELTA
    )
    return {
        "strategy": strategy,
        "timeframe": timeframe,
        "status": "RESEARCH_CANDIDATE_PASS" if passed else (
            "FINAL_REJECTED" if final_fold else "DEVELOPMENT_REJECTED"
        ),
        "selectedProfile": selected,
        "sequenceLength": data["sequenceLength"],
        "featurePanel": "V12.3 full_cortex SMC + candlestick + chart-pattern features",
        "marketCoverage": data["coverage"],
        "development": development,
        "final": ({
            "cutoffTimestamp": final_fold["cutoffTimestamp"],
            "trainSamples": final_fold["trainSamples"],
            "testSamples": final_fold["testSamples"],
            "v9MatchedBaseline": final_fold["v9MatchedBaseline"],
            "selectedProfile": selected,
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
    results: list[dict[str, Any]] = []
    for strategy, timeframe in v12.PILOTS.items():
        try:
            result = run_pilot(strategy, timeframe, markets)
        except Exception as error:
            result = {
                "strategy": strategy, "timeframe": timeframe,
                "status": "RESEARCH_ERROR", "error": str(error)[:400],
            }
        results.append(result)
        print("[KINGBOT V12.4 HOLD-RECALL PILOT]", json.dumps({
            "strategy": strategy,
            "timeframe": timeframe,
            "status": result.get("status"),
            "selectedProfile": result.get("selectedProfile"),
            "developmentProfiles": {
                name: {
                    "balancedAccuracy": values["model"]["balancedAccuracy"],
                    "macroF1": values["model"]["macroF1"],
                    "holdRecall": values["holdRecall"],
                    "selectionScoreDeltaVsV9": values["selectionScoreDeltaVsV9"],
                    "qualityGate": values["model"]["qualityGate"],
                }
                for name, values in (result.get("development") or {}).get("profiles", {}).items()
            },
            "error": result.get("error"),
        }, sort_keys=True))

    report = {
        "generatedAt": payload.get("generatedAt"),
        "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "researchVersion": "v12-4-cortex-class-balance-loss-ablation-1",
        "researchOnly": True,
        "productionChanged": False,
        "v9v10BenchmarksChanged": False,
        "modelArtifactsPersisted": False,
        "architecture": {
            "model": "V12.3 two-layer Cortex Transformer, 64-dimensional embeddings, four attention heads",
            "features": "V12.3 full_cortex SMC + candlestick + classical chart-pattern feature panel",
            "labels": "Unchanged V12 six-bar ATR triple-barrier SELL/HOLD/BUY labels",
            "profiles": list(LOSS_PROFILES),
            "lossProfiles": {
                "inverse_frequency_ce": "Exact V12.3 inverse-frequency weighted cross-entropy control",
                "sqrt_inverse_frequency_ce": "Square-root inverse-frequency weighted cross-entropy",
                "effective_number_ce": "Effective-number class-balanced cross-entropy, beta=0.999",
                "effective_number_focal": "Effective-number class weights with focal modulation, gamma=1.5, beta=0.999",
            },
            "weighting": "Class weights are computed from each training fold only; no evaluation labels enter loss weighting.",
            "training": "12 epochs, AdamW, CPU, training-fold-only scaling, fixed common seed per profile",
        },
        "validation": {
            "developmentWindow": "70%-85%",
            "finalWindow": "85%-100% untouched",
            "globalTimestampAlignment": True,
            "forwardLabelPurging": True,
            "matchedBaseline": "V9 RF+PyTorch 55/45 on the identical fold rows; recomputed per fold",
            "selection": "Only profiles passing unchanged development quality gates and delta >= -0.01 are eligible; best development selection score wins, HOLD recall is a tie-break only.",
            "unchangedGates": unchanged_acceptance_gates(),
            "promotion": "No model persistence, registry, production inference or execution promotion.",
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
            "developmentPassed": sum(
                bool(result.get("selectedProfile")) for result in results
            ),
            "finalEvaluated": sum(result.get("final") is not None for result in results),
            "finalQualityGatePassed": sum(
                bool((result.get("final") or {}).get("result", {}).get("model", {}).get("qualityGate"))
                for result in results
            ),
            "researchCandidatesPassed": sum(
                result.get("status") == "RESEARCH_CANDIDATE_PASS" for result in results
            ),
            "completeBotsReady": 0,
            "elapsedSeconds": round(time.time() - started, 3),
        },
        "results": results,
        "promotion": {
            "status": "NONE",
            "reason": "Research-only experiment; no weights saved, registered, promoted or deployed.",
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("[KINGBOT V12.4 COMPLETE]", json.dumps(report["summary"], sort_keys=True))
    return 0 if report["summary"]["evaluatedModels"] else 3


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(
            "usage: run_v124_hold_recall_research.py INPUT_JSON OUTPUT_JSON"
        )
    raise SystemExit(run(Path(sys.argv[1]), Path(sys.argv[2])))
