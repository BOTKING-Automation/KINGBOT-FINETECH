"""Run V9 baseline and walk-forward feature experiments on real market candles.

The baseline uses the exact V9 strategy masks and default purged holdout.
Rejected candidates are tested using one contextual feature expansion on a
70%-85% development window, followed by an untouched 85%-100% final window.
The production metric gate is never changed.
"""
from __future__ import annotations

import contextlib
import io
import json
import sys
import time
from pathlib import Path
from typing import Any

SERVICE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SERVICE_DIR))
import service  # noqa: E402

TIMEFRAME_PROFILES = {
    "strategic": ["4h", "1h", "15m"],
    "flipper": ["15m", "5m", "1m"],
    "breakout": ["1h", "15m", "5m"],
    "smc-pro": ["4h", "15m", "5m"],
    "ladder-flip": ["1h", "15m", "5m"],
}
EXPECTED_FEATURE_VERSION = "ai-strategies-v9-real-strategy-mask-barrier6-atr0.60-fallback0.35-global-time"
EXPERIMENT_EXTRA_FEATURES = {
    "strategic": {
        "adx_norm", "rsi_norm", "atr_pct", "ema_gap",
        "range_position_20", "candle_close_location", "return_1_atr",
    },
    "flipper": {
        "trend", "volatility", "atr_pct", "adx_norm", "rsi_norm",
        "ema_gap", "ema20_slope_atr", "range_position_20",
        "structure_bull", "structure_bear",
    },
    "breakout": {
        "trend", "adx_norm", "ema_gap", "ema20_slope_atr",
        "structure_bull", "structure_bear", "candle_body_atr",
        "upper_wick_ratio", "lower_wick_ratio",
    },
    "smc-pro": {
        "trend", "momentum", "volatility", "atr_pct", "rsi_norm",
        "adx_norm", "ema_gap", "return_1_atr", "return_3_atr",
        "ema20_slope_atr", "efficiency_10",
    },
    "ladder-flip": {
        "trend", "momentum", "volatility", "atr_pct",
        "structure_bull", "structure_bear", "range_position_20",
        "candle_body_atr", "candle_close_location", "efficiency_10",
    },
}


def parse_json_line(stdout: str, prefix: str) -> dict[str, Any] | None:
    for line in stdout.splitlines():
        if line.startswith(prefix):
            try:
                return json.loads(line[len(prefix):])
            except json.JSONDecodeError:
                return {"parseError": line[len(prefix):][:1000]}
    return None


def parse_audit(stdout: str) -> dict[str, Any] | None:
    return parse_json_line(stdout, "[KINGBOT ML AUDIT] ")


def parse_validation(stdout: str) -> dict[str, Any] | None:
    return parse_json_line(stdout, "[KINGBOT ML VALIDATION] ")


def parse_probability_audit(stdout: str) -> dict[str, Any] | None:
    return parse_json_line(stdout, "[KINGBOT ML PROBABILITY AUDIT] ")


def class_coverage_gate(diagnostics: dict[str, Any] | None) -> bool:
    per_class = (diagnostics or {}).get("ensemble", {}).get("perClass", {})
    return all(
        name in per_class and float(per_class[name].get("recall", 0.0)) > 0.0
        for name in ("SELL", "HOLD", "BUY")
    )


def metric_gate(result: dict[str, Any] | None, diagnostics: dict[str, Any] | None) -> bool:
    if result:
        return bool(result.get("ready") and result.get("validation", {}).get("qualityGate"))
    ensemble = (diagnostics or {}).get("ensemble", {})
    test_samples = (diagnostics or {}).get("testSamples", 0)
    return (
        float(ensemble.get("balancedAccuracy", 0.0)) >= 0.36
        and float(ensemble.get("macroF1", 0.0)) >= 0.34
        and int(test_samples) >= 30
    )


def sweep_ensemble_weights(parts: dict[str, Any] | None) -> dict[str, Any]:
    """Choose an RF share on the development window only; final data is never tuned."""
    if not isinstance(parts, dict):
        return {"candidates": [], "selected": None, "error": "PROBABILITY_PARTS_MISSING"}
    try:
        labels = service.np.asarray(parts["labels"], dtype=service.np.int64)
        rf_probabilities = service.np.asarray(parts["rf"], dtype=service.np.float32)
        torch_probabilities = service.np.asarray(parts["torch"], dtype=service.np.float32)
        if (
            labels.ndim != 1
            or len(labels) < 30
            or rf_probabilities.shape != (len(labels), 3)
            or torch_probabilities.shape != (len(labels), 3)
        ):
            raise ValueError("PROBABILITY_PARTS_SHAPE_INVALID")
    except (KeyError, TypeError, ValueError) as error:
        return {"candidates": [], "selected": None, "error": str(error)[:160]}

    rows: list[dict[str, Any]] = []
    for step in range(11):
        rf_weight = round(step / 10.0, 1)
        blended = service.blend_probability_parts(
            rf_probabilities, torch_probabilities, rf_weight
        )
        metrics = service.ensemble_class_metrics(labels, blended)
        per_class = metrics.get("perClass", {})
        class_coverage = all(
            float(per_class.get(name, {}).get("recall", 0.0)) > 0.0
            for name in ("SELL", "HOLD", "BUY")
        )
        balanced_accuracy = float(metrics["balancedAccuracy"])
        macro_f1 = float(metrics["macroF1"])
        metric_pass = (
            balanced_accuracy >= 0.36
            and macro_f1 >= 0.34
            and len(labels) >= 30
        )
        rows.append({
            "rfWeight": rf_weight,
            "torchWeight": round(1.0 - rf_weight, 1),
            "balancedAccuracy": round(balanced_accuracy, 6),
            "macroF1": round(macro_f1, 6),
            "testSamples": int(len(labels)),
            "classCoverageGate": class_coverage,
            "metricGate": metric_pass,
            "deploymentReady": bool(metric_pass and class_coverage),
            "score": round(balanced_accuracy * 0.60 + macro_f1 * 0.40, 6),
            "perClass": per_class,
        })
    eligible = [row for row in rows if row["deploymentReady"]]
    selected = max(
        eligible,
        key=lambda row: (row["score"], -abs(row["rfWeight"] - 0.55)),
    ) if eligible else None
    return {"candidates": rows, "selected": selected, "error": None}


def run_one(
    strategy: str,
    timeframe: str,
    markets: list[dict[str, Any]],
    train_fraction: float = 0.78,
    test_fraction: float = 1.0,
    ensemble_rf_weight: float | None = None,
    capture_validation_probabilities: bool = False,
) -> dict[str, Any]:
    captured = io.StringIO()
    result: dict[str, Any] | None = None
    error: str | None = None
    began = time.time()
    key = strategy + ":" + timeframe
    service.MODELS.pop(key, None)
    service.CHALLENGERS.pop(key, None)
    with contextlib.redirect_stdout(captured):
        try:
            result = service.train_model(
                strategy,
                timeframe,
                markets,
                train_fraction=train_fraction,
                test_fraction=test_fraction,
                ensemble_rf_weight=ensemble_rf_weight,
                capture_validation_probabilities=capture_validation_probabilities,
            )
        except Exception as exc:
            error = str(exc)[:500]
    stdout = captured.getvalue()
    audit = parse_audit(stdout)
    diagnostics = parse_validation(stdout)
    metric_pass = metric_gate(result, diagnostics)
    class_pass = class_coverage_gate(diagnostics)
    probability_parts = (
        parse_probability_audit(stdout) if capture_validation_probabilities else None
    )
    service.MODELS.pop(key, None)
    service.CHALLENGERS.pop(key, None)
    clean_stdout = "\n".join(
        line for line in stdout.splitlines()
        if not line.startswith("[KINGBOT ML PROBABILITY AUDIT] ")
    )
    return {
        "status": "PASSED" if metric_pass else "FAILED",
        "deploymentReady": bool(metric_pass and class_pass),
        "metricGate": metric_pass,
        "classCoverageGate": class_pass,
        "error": error,
        "featureVersion": service.FEATURE_VERSION,
        "trainFraction": train_fraction,
        "testFraction": test_fraction,
        "audit": audit,
        "validationDiagnostics": diagnostics,
        "metrics": (result or {}).get("validation"),
        "dataset": (result or {}).get("dataset"),
        "candidate": (result or {}).get("candidate"),
        "ensembleRfWeight": (result or {}).get("validation", {}).get("ensembleRfWeight", ensemble_rf_weight),
        "probabilityParts": probability_parts,
        "elapsedSeconds": round(time.time() - began, 3),
        "stdout": clean_stdout[-16000:],
    }


def run(input_path: Path, output_path: Path) -> int:
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    if service.FEATURE_VERSION != EXPECTED_FEATURE_VERSION:
        raise RuntimeError("V9_FEATURE_VERSION_MISMATCH:" + str(service.FEATURE_VERSION))
    markets_by_timeframe = payload.get("marketsByTimeframe")
    if not isinstance(markets_by_timeframe, dict):
        raise ValueError("V9_MARKET_DATA_TIMEFRAMES_MISSING")

    results: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []
    started_at = time.time()

    # Stage 1: untouched V9 baseline, original 78/22 purged holdout.
    for strategy, timeframes in TIMEFRAME_PROFILES.items():
        for timeframe in timeframes:
            prepared = [
                {"symbol": str(item.get("symbol", "")).upper(), "bars": item.get("bars", [])}
                for item in markets_by_timeframe.get(timeframe, [])
                if isinstance(item, dict) and item.get("symbol") and isinstance(item.get("bars"), list)
            ]
            baseline = run_one(strategy, timeframe, prepared)
            baseline["strategy"] = strategy
            baseline["timeframe"] = timeframe
            baseline["inputMarkets"] = [
                {"symbol": market["symbol"], "bars": len(market["bars"])}
                for market in prepared
            ]
            results.append(baseline)
            print("[KINGBOT V9 BASELINE]", json.dumps({
                "strategy": strategy,
                "timeframe": timeframe,
                "metricGate": baseline["metricGate"],
                "classCoverageGate": baseline["classCoverageGate"],
                "deploymentReady": baseline["deploymentReady"],
                "balancedAccuracy": (baseline.get("validationDiagnostics") or {}).get("ensemble", {}).get("balancedAccuracy"),
                "macroF1": (baseline.get("validationDiagnostics") or {}).get("ensemble", {}).get("macroF1"),
                "perClass": (baseline.get("validationDiagnostics") or {}).get("ensemble", {}).get("perClass"),
                "error": baseline["error"],
            }, sort_keys=True))

    # Stage 2: one strategy-specific contextual mask per non-ready baseline.
    # Use an earlier purged development fold, then reserve the latest segment.
    for baseline in results:
        if baseline["deploymentReady"] or not baseline.get("audit"):
            continue
        strategy = baseline["strategy"]
        timeframe = baseline["timeframe"]
        prepared = [
            {"symbol": str(item.get("symbol", "")).upper(), "bars": item.get("bars", [])}
            for item in markets_by_timeframe.get(timeframe, [])
            if isinstance(item, dict) and item.get("symbol") and isinstance(item.get("bars"), list)
        ]
        if len(prepared) < 3:
            candidates.append({
                "strategy": strategy, "timeframe": timeframe,
                "status": "SKIPPED_DATA_COVERAGE",
                "reason": "Fewer than three real-market datasets are available",
                "inputMarkets": len(prepared),
            })
            continue

        baseline_focus = set(service.STRATEGY_FOCUS[strategy])
        candidate_focus = baseline_focus | EXPERIMENT_EXTRA_FEATURES[strategy]
        service.STRATEGY_FOCUS[strategy] = candidate_focus
        try:
            development = run_one(
                strategy, timeframe, prepared,
                train_fraction=0.70, test_fraction=0.85,
            )
            candidate_row: dict[str, Any] = {
                "strategy": strategy,
                "timeframe": timeframe,
                "variant": "V9_CONTEXT_EXPANSION",
                "featureFocus": sorted(candidate_focus),
                "development": development,
                "final": None,
            }
            # Advance only when the development fold passes the original metric
            # gate and predicts all three labels. No final-period tuning.
            if development["metricGate"] and development["classCoverageGate"]:
                final = run_one(
                    strategy, timeframe, prepared,
                    train_fraction=0.85, test_fraction=1.0,
                )
                candidate_row["final"] = final
                candidate_row["status"] = (
                    "FINAL_PASS"
                    if final["metricGate"] and final["classCoverageGate"]
                    else "FINAL_REJECTED"
                )
            else:
                candidate_row["status"] = "DEVELOPMENT_REJECTED"
            candidates.append(candidate_row)
            print("[KINGBOT V9 FEATURE EXPERIMENT]", json.dumps({
                "strategy": strategy,
                "timeframe": timeframe,
                "status": candidate_row["status"],
                "developmentBalancedAccuracy": (development.get("validationDiagnostics") or {}).get("ensemble", {}).get("balancedAccuracy"),
                "developmentMacroF1": (development.get("validationDiagnostics") or {}).get("ensemble", {}).get("macroF1"),
                "developmentPerClass": (development.get("validationDiagnostics") or {}).get("ensemble", {}).get("perClass"),
                "finalBalancedAccuracy": ((candidate_row.get("final") or {}).get("validationDiagnostics") or {}).get("ensemble", {}).get("balancedAccuracy"),
                "finalMacroF1": ((candidate_row.get("final") or {}).get("validationDiagnostics") or {}).get("ensemble", {}).get("macroF1"),
                "finalPerClass": ((candidate_row.get("final") or {}).get("validationDiagnostics") or {}).get("ensemble", {}).get("perClass"),
            }, sort_keys=True))
        finally:
            service.STRATEGY_FOCUS[strategy] = baseline_focus

    # Stage 3: tune the RF/PyTorch blend on the development window only.
    # The selected weight is frozen before the latest 85%-100% final window.
    ensemble_weight_candidates: list[dict[str, Any]] = []
    for baseline in results:
        if baseline["deploymentReady"] or not baseline.get("audit"):
            continue
        strategy = baseline["strategy"]
        timeframe = baseline["timeframe"]
        prepared = [
            {"symbol": str(item.get("symbol", "")).upper(), "bars": item.get("bars", [])}
            for item in markets_by_timeframe.get(timeframe, [])
            if isinstance(item, dict) and item.get("symbol") and isinstance(item.get("bars"), list)
        ]
        if len(prepared) < 3:
            ensemble_weight_candidates.append({
                "strategy": strategy,
                "timeframe": timeframe,
                "variant": "V9_DEVELOPMENT_TUNED_ENSEMBLE_WEIGHT",
                "status": "SKIPPED_DATA_COVERAGE",
                "reason": "Fewer than three real-market datasets are available",
            })
            continue

        development = run_one(
            strategy,
            timeframe,
            prepared,
            train_fraction=0.70,
            test_fraction=0.85,
            capture_validation_probabilities=True,
        )
        probability_parts = development.pop("probabilityParts", None)
        development.pop("stdout", None)
        weight_sweep = sweep_ensemble_weights(probability_parts)
        selected = weight_sweep.get("selected")
        candidate_row: dict[str, Any] = {
            "strategy": strategy,
            "timeframe": timeframe,
            "variant": "V9_DEVELOPMENT_TUNED_ENSEMBLE_WEIGHT",
            "development": development,
            "weightSweep": weight_sweep.get("candidates", []),
            "selectedRfWeight": selected.get("rfWeight") if selected else None,
            "selectedTorchWeight": selected.get("torchWeight") if selected else None,
            "final": None,
        }
        if selected:
            final = run_one(
                strategy,
                timeframe,
                prepared,
                train_fraction=0.85,
                test_fraction=1.0,
                ensemble_rf_weight=float(selected["rfWeight"]),
            )
            candidate_row["final"] = final
            candidate_row["status"] = (
                "FINAL_PASS"
                if final["metricGate"] and final["classCoverageGate"]
                else "FINAL_REJECTED"
            )
        else:
            candidate_row["status"] = "DEVELOPMENT_REJECTED"
            candidate_row["reason"] = weight_sweep.get("error") or (
                "No development-window blend weight passed the original metric gate "
                "and the nonzero SELL/HOLD/BUY recall guard"
            )
        ensemble_weight_candidates.append(candidate_row)
        print("[KINGBOT V9 ENSEMBLE WEIGHT EXPERIMENT]", json.dumps({
            "strategy": strategy,
            "timeframe": timeframe,
            "status": candidate_row["status"],
            "selectedRfWeight": candidate_row["selectedRfWeight"],
            "selectedTorchWeight": candidate_row["selectedTorchWeight"],
            "finalBalancedAccuracy": (
                (candidate_row.get("final") or {}).get("validationDiagnostics") or {}
            ).get("ensemble", {}).get("balancedAccuracy"),
            "finalMacroF1": (
                (candidate_row.get("final") or {}).get("validationDiagnostics") or {}
            ).get("ensemble", {}).get("macroF1"),
            "finalPerClass": (
                (candidate_row.get("final") or {}).get("validationDiagnostics") or {}
            ).get("ensemble", {}).get("perClass"),
        }, sort_keys=True))

    metric_pass_count = sum(row["metricGate"] for row in results)
    deployment_ready_count = sum(row["deploymentReady"] for row in results)
    experiment_final_passes = sum(row.get("status") == "FINAL_PASS" for row in candidates)
    report = {
        "generatedAt": payload.get("generatedAt"),
        "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "featureVersion": service.FEATURE_VERSION,
        "qualityGate": {
            "ensembleBalancedAccuracyMinimum": 0.36,
            "ensembleMacroF1Minimum": 0.34,
            "minimumTestSamples": 30,
            "changed": False,
        },
        "additionalDeploymentGuard": {
            "requireNonZeroRecallFor": ["SELL", "HOLD", "BUY"],
            "purpose": "Prevent a nominally passing three-class model that never predicts one class",
            "replacesMetricGate": False,
        },
        "labelConfiguration": {
            "forwardBars": service.FORWARD_HORIZON,
            "primaryAtrBarrier": service.LABEL_ATR,
            "fallbackAtr": service.LABEL_FALLBACK_ATR,
            "changed": False,
        },
        "dataFetch": {
            "historyLimit": payload.get("historyLimit"),
            "fetchSummary": payload.get("fetchSummary", []),
            "fetchFailures": payload.get("fetchFailures", []),
        },
        "summary": {
            "targetModels": len(results),
            "originalMetricGatePassed": metric_pass_count,
            "deploymentReadyAtBaseline": deployment_ready_count,
            "baselineNotDeploymentReady": len(results) - deployment_ready_count,
            "featureExperiments": len(candidates),
            "featureExperimentsFinalPassed": experiment_final_passes,
            "ensembleWeightExperiments": len(ensemble_weight_candidates),
            "ensembleWeightExperimentsFinalPassed": sum(
                row.get("status") == "FINAL_PASS" for row in ensemble_weight_candidates
            ),
            "elapsedSeconds": round(time.time() - started_at, 3),
            "botsReadyAtBaseline": sum(
                all(item["deploymentReady"] for item in results if item["strategy"] == strategy)
                for strategy in TIMEFRAME_PROFILES
            ),
        },
        "results": results,
        "featureExperiments": candidates,
        "ensembleWeightPolicy": {
            "defaultRfWeight": 0.55,
            "defaultTorchWeight": 0.45,
            "candidateRfWeights": [round(step / 10.0, 1) for step in range(11)],
            "selection": "Highest 0.60*balancedAccuracy + 0.40*macroF1 among development candidates passing the unchanged metric and three-class recall gates",
            "developmentWindow": "70%-85%",
            "finalWindow": "85%-100%, untouched during weight selection",
            "labelConfigurationChanged": False,
            "featureMasksChanged": False,
        },
        "ensembleWeightExperiments": ensemble_weight_candidates,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("[KINGBOT V9 CYCLE COMPLETE]", json.dumps(report["summary"], sort_keys=True))
    print("[KINGBOT V9 REPORT]", str(output_path))
    return 0 if len(results) == 15 else 3


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: v9_live_training_audit.py INPUT_JSON OUTPUT_JSON")
    raise SystemExit(run(Path(sys.argv[1]), Path(sys.argv[2])))
