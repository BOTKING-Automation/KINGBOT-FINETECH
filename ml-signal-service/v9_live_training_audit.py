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


def run_one(
    strategy: str,
    timeframe: str,
    markets: list[dict[str, Any]],
    train_fraction: float = 0.78,
    test_fraction: float = 1.0,
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
            )
        except Exception as exc:
            error = str(exc)[:500]
    stdout = captured.getvalue()
    audit = parse_audit(stdout)
    diagnostics = parse_validation(stdout)
    metric_pass = metric_gate(result, diagnostics)
    class_pass = class_coverage_gate(diagnostics)
    service.MODELS.pop(key, None)
    service.CHALLENGERS.pop(key, None)
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
        "elapsedSeconds": round(time.time() - began, 3),
        "stdout": stdout[-16000:],
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
            "elapsedSeconds": round(time.time() - started_at, 3),
            "botsReadyAtBaseline": sum(
                all(item["deploymentReady"] for item in results if item["strategy"] == strategy)
                for strategy in TIMEFRAME_PROFILES
            ),
        },
        "results": results,
        "featureExperiments": candidates,
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
