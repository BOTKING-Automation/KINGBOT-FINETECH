"""KINGBOT V12.3: causal SMC, candle and classical-chart-pattern research ablation.

Four matched feature variants are compared using identical samples, temporal folds,
context tokens, training budget and a shared V9 reference prediction set. Selection
uses development only; final rows stay untouched unless a candidate passes the
unchanged development gate. No model is persisted or promoted.
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
from technical_pattern_features import (  # noqa: E402
    CANDLE_FEATURE_NAMES,
    CHART_PATTERN_FEATURE_NAMES,
    FEATURE_NAMES as PATTERN_FEATURE_NAMES,
    SMC_FEATURE_NAMES,
    select_feature_columns,
    compute_pattern_feature_matrix,
)
from run_v122_hold_research import _detailed_metrics  # noqa: E402

VARIANTS = ("baseline", "smc_only", "technical_patterns_only", "full_cortex")
EPOCHS = 12


class CortexTransformer(nn.Module):
    """Separate projections let base context stay at V12 width while target gains features."""
    def __init__(self, target_features: int, context_features_with_age: int,
                 slots: int, seq_len: int = v12.SEQ, dim: int = v12.D_MODEL):
        super().__init__()
        if min(target_features, context_features_with_age, slots, seq_len) < 1 or dim % 4:
            raise ValueError("V123_MODEL_DIMENSIONS_INVALID")
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
        self.head = nn.Sequential(nn.Linear(dim, 48), nn.GELU(), nn.Dropout(0.1), nn.Linear(48, 3))

    def forward(self, target: torch.Tensor, context: torch.Tensor,
                missing: torch.Tensor) -> torch.Tensor:
        if target.ndim != 3 or context.ndim != 3 or missing.shape != context.shape[:2]:
            raise ValueError("V123_INPUT_SHAPE_INVALID")
        if target.shape[1] != self.seq_len or context.shape[1] != self.slots:
            raise ValueError("V123_SEQUENCE_OR_CONTEXT_SHAPE_INVALID")
        t = self.target_proj(target) + self.time_pos
        c = self.context_proj(context) + self.slot_pos
        tokens = torch.cat((t, c), dim=1)
        padding = torch.cat((
            torch.zeros((len(t), self.seq_len), dtype=torch.bool, device=t.device),
            missing.bool(),
        ), dim=1)
        encoded = self.norm(self.encoder(tokens, src_key_padding_mask=padding))
        return self.head(encoded[:, self.seq_len - 1])


def _append_pattern_windows(markets_by_timeframe: dict[str, Any], strategy: str,
                            timeframe: str, base: dict[str, Any]) -> np.ndarray:
    """Rebuild feature windows against identical broker timestamps from V12.1."""
    windows_by_symbol: dict[str, np.ndarray] = {}
    for row in markets_by_timeframe.get(timeframe, []):
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("symbol") or "").upper()
        raw = row.get("bars")
        if symbol not in v12.SYMBOLS or not isinstance(raw, list):
            continue
        bars = service.normalize_market_bars(raw)
        if len(bars) < v12.SEQ + 60 + service.FORWARD_HORIZON + 50:
            continue
        _, _, _, times, _ = service.bars_to_training_arrays(bars, strategy)
        matrix = compute_pattern_feature_matrix(bars)
        pattern_rows = matrix[60:len(bars) - service.FORWARD_HORIZON]
        if len(pattern_rows) != len(times):
            raise ValueError("V123_PATTERN_TARGET_TIME_ALIGNMENT_INVALID")
        if len(pattern_rows) < v12.SEQ:
            continue
        windows = np.lib.stride_tricks.sliding_window_view(
            pattern_rows, window_shape=v12.SEQ, axis=0
        ).transpose(0, 2, 1)
        windows_by_symbol[symbol] = np.ascontiguousarray(windows, dtype=np.float32)

    ordered_symbols = list(dict.fromkeys(base["symbols"]))
    missing = [symbol for symbol in ordered_symbols if symbol not in windows_by_symbol]
    if missing:
        raise ValueError("V123_PATTERN_SERIES_MISSING:" + ",".join(missing))
    extra = np.concatenate([windows_by_symbol[symbol] for symbol in ordered_symbols], axis=0)
    if extra.shape[:2] != base["X"].shape[:2] or extra.shape[0] != base["X"].shape[0]:
        raise ValueError("V123_PATTERN_PANEL_ALIGNMENT_INVALID")
    if not np.isfinite(extra).all():
        raise ValueError("V123_PATTERN_PANEL_NONFINITE")
    return extra


def build_v123_dataset(markets_by_timeframe: dict[str, Any], strategy: str,
                        timeframe: str) -> dict[str, Any]:
    base = v12.build_dataset(markets_by_timeframe, strategy, timeframe)
    pattern_windows = _append_pattern_windows(markets_by_timeframe, strategy, timeframe, base)
    variants = {
        name: select_feature_columns(base["X"], pattern_windows, name)
        for name in VARIANTS
    }
    for name, features in variants.items():
        if features.shape[:2] != base["X"].shape[:2] or not np.isfinite(features).all():
            raise ValueError("V123_FEATURE_VARIANT_INVALID:" + name)
    base["variants"] = variants
    base["patternFeatureNames"] = list(PATTERN_FEATURE_NAMES)
    return base


def _class_weights(train_y: np.ndarray) -> np.ndarray:
    labels = np.asarray([service.LABEL_TO_INDEX[int(value)] for value in train_y], dtype=np.int64)
    counts = np.bincount(labels, minlength=3).astype(np.float32)
    weights = len(labels) / np.maximum(counts, 1.0)
    weights /= max(float(weights.mean()), 1e-8)
    return weights.astype(np.float32)


def fit_predict(train_x: np.ndarray, train_c: np.ndarray, train_m: np.ndarray,
                train_a: np.ndarray, train_y: np.ndarray, eval_x: np.ndarray,
                eval_c: np.ndarray, eval_m: np.ndarray, eval_a: np.ndarray,
                *, epochs: int = EPOCHS) -> np.ndarray:
    if not 1 <= epochs <= 80:
        raise ValueError("V123_TRAINING_CONFIGURATION_INVALID")
    tx, ex, tc, ec, tm, em = v12._scale(
        train_x, eval_x, train_c, eval_c, train_m, eval_m, train_a, eval_a
    )
    ty = np.asarray([service.LABEL_TO_INDEX[int(value)] for value in train_y], dtype=np.int64)
    if len(tx) < 90 or len(ex) < 1:
        raise ValueError("V123_TRAINING_SAMPLE_COVERAGE_INSUFFICIENT")

    torch.manual_seed(v12.SEED)
    np.random.seed(v12.SEED)
    torch.set_num_threads(1)
    model = CortexTransformer(tx.shape[-1], tc.shape[-1], tc.shape[1], tx.shape[1])
    weight_tensor = torch.as_tensor(_class_weights(train_y), dtype=torch.float32)
    loss_fn = nn.CrossEntropyLoss(weight=weight_tensor)
    dataset = TensorDataset(
        torch.from_numpy(tx), torch.from_numpy(tc), torch.from_numpy(tm), torch.from_numpy(ty)
    )
    loader = DataLoader(
        dataset, batch_size=min(v12.BATCH, len(dataset)), shuffle=True,
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
        raise ValueError("V123_PREDICTION_OUTPUT_INVALID")
    return probabilities


def _fold_masks(data: dict[str, Any], train_fraction: float, test_fraction: float):
    train_mask, eval_mask, cutoff = service.global_temporal_split_masks(
        data["times"], data["ends"], train_fraction=train_fraction,
        test_fraction=test_fraction,
    )
    if train_mask.sum() < 90 or eval_mask.sum() < v12.MIN_N:
        raise ValueError("V123_FOLD_SAMPLE_COVERAGE_INSUFFICIENT")
    return train_mask, eval_mask, cutoff


def _run_fold(data: dict[str, Any], train_fraction: float, test_fraction: float,
              variants: tuple[str, ...]) -> dict[str, Any]:
    train_mask, eval_mask, cutoff = _fold_masks(data, train_fraction, test_fraction)
    C, M, A, y = (data[key] for key in ("C", "M", "A", "y"))
    train_y, eval_y = y[train_mask], y[eval_mask]
    baseline_probabilities = v12.matched_v9(
        data["variants"]["baseline"][train_mask], train_y,
        data["variants"]["baseline"][eval_mask], eval_y,
    )
    baseline_metrics = _detailed_metrics(eval_y, baseline_probabilities)
    variant_results: dict[str, Any] = {}
    for variant in variants:
        X = data["variants"][variant]
        probabilities = fit_predict(
            X[train_mask], C[train_mask], M[train_mask], A[train_mask], train_y,
            X[eval_mask], C[eval_mask], M[eval_mask], A[eval_mask],
        )
        model_metrics = _detailed_metrics(eval_y, probabilities)
        delta = model_metrics["selectionScore"] - baseline_metrics["selectionScore"]
        variant_results[variant] = {
            "model": model_metrics,
            "selectionScoreDeltaVsV9": float(delta),
            "passesDevelopmentGuard": bool(model_metrics["qualityGate"] and delta >= -0.01),
        }
    return {
        "cutoffTimestamp": float(cutoff),
        "trainSamples": int(train_mask.sum()),
        "testSamples": int(eval_mask.sum()),
        "v9MatchedBaseline": baseline_metrics,
        "variants": variant_results,
    }


def _select_development_variant(development: dict[str, Any]) -> str | None:
    eligible = [
        (name, result) for name, result in development["variants"].items()
        if result["passesDevelopmentGuard"]
    ]
    if not eligible:
        return None
    return max(eligible, key=lambda item: item[1]["model"]["selectionScore"])[0]


def run_pilot(strategy: str, timeframe: str,
              markets_by_timeframe: dict[str, Any]) -> dict[str, Any]:
    data = build_v123_dataset(markets_by_timeframe, strategy, timeframe)
    development = _run_fold(data, 0.70, 0.85, VARIANTS)
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
        "sequenceLength": data["sequenceLength"],
        "baseFeatureCount": int(data["variants"]["baseline"].shape[-1]),
        "smcFeatureCount": len(SMC_FEATURE_NAMES),
        "candleFeatureCount": len(CANDLE_FEATURE_NAMES),
        "chartPatternFeatureCount": len(CHART_PATTERN_FEATURE_NAMES),
        "patternFeatureCount": len(PATTERN_FEATURE_NAMES),
        "contextSlots": len(data["slots"]),
        "marketCoverage": data["coverage"],
        "development": development,
        "selectedVariant": selected_variant,
        "final": ({
            "cutoffTimestamp": final_fold["cutoffTimestamp"],
            "trainSamples": final_fold["trainSamples"],
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
        raise ValueError("V123_MARKET_TIMEFRAME_DATA_MISSING")
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
        print("[KINGBOT V12.3 CORTEX PILOT]", json.dumps({
            "strategy": strategy,
            "timeframe": timeframe,
            "status": result.get("status"),
            "selectedVariant": result.get("selectedVariant"),
            "developmentVariants": {
                name: {
                    "balancedAccuracy": values["model"]["balancedAccuracy"],
                    "macroF1": values["model"]["macroF1"],
                    "selectionScoreDeltaVsV9": values["selectionScoreDeltaVsV9"],
                    "qualityGate": values["model"]["qualityGate"],
                }
                for name, values in (result.get("development") or {}).get("variants", {}).items()
            },
            "error": result.get("error"),
        }, sort_keys=True))

    final_evaluated = sum(result.get("final") is not None for result in results)
    report = {
        "generatedAt": payload.get("generatedAt"),
        "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "researchVersion": "v12-3-cortex-smc-technical-pattern-ablation-1",
        "researchOnly": True,
        "productionChanged": False,
        "modelArtifactsPersisted": False,
        "architecture": {
            "model": "Two-layer Transformer encoder, 64-dimensional embeddings, four attention heads",
            "targetSequence": "32 closed-bar target candles with appended causal SMC/TA features",
            "crossMarketContext": "V12.2 context tokens remain unchanged; context candles are available only after close",
            "featureGroups": {
                "smc": list(SMC_FEATURE_NAMES),
                "candlestick": list(CANDLE_FEATURE_NAMES),
                "chartPatterns": list(CHART_PATTERN_FEATURE_NAMES),
            },
            "featureVariants": list(VARIANTS),
            "labeling": "V12 six-bar ATR triple-barrier SELL/HOLD/BUY; label definitions unchanged",
            "training": "12 epochs, AdamW, CPU, training-fold-only scaling, inverse-frequency cross-entropy",
            "causality": "two-bar right-confirmed pivots are emitted only on the confirmation bar; all patterns use current/past closed OHLC only",
        },
        "validation": {
            "developmentWindow": "70%-85%",
            "finalWindow": "85%-100% untouched",
            "globalTimestampAlignment": True,
            "forwardLabelPurging": True,
            "matchedBaseline": "one matched V9 RF+PyTorch 55/45 prediction set shared by all feature variants on identical rows and masks",
            "variantSelection": "best eligible variant selected on development only; selected variant frozen before untouched final evaluation",
            "developmentGuard": "unchanged quality gates and selection score delta >= -0.01",
            "gatesUnchanged": {
                "balancedAccuracy": v12.MIN_BA,
                "macroF1": v12.MIN_F1,
                "minimumTestSamples": v12.MIN_N,
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
            "developmentPassed": sum(bool(result.get("selectedVariant")) for result in results),
            "finalEvaluated": final_evaluated,
            "finalQualityGatePassed": sum(
                bool((result.get("final") or {}).get("result", {}).get("model", {}).get("qualityGate"))
                for result in results
            ),
            "researchCandidatesPassed": sum(result.get("status") == "RESEARCH_CANDIDATE_PASS" for result in results),
            "selectedVariants": {
                variant: sum(result.get("selectedVariant") == variant for result in results)
                for variant in VARIANTS
            },
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
    print("[KINGBOT V12.3 COMPLETE]", json.dumps(report["summary"], sort_keys=True))
    return 0 if report["summary"]["evaluatedModels"] else 3


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: run_v123_cortex_research.py INPUT_JSON OUTPUT_JSON")
    raise SystemExit(run(Path(sys.argv[1]), Path(sys.argv[2])))
