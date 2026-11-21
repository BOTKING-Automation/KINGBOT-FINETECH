"""Run V12 cross-market, multi-timeframe Transformer pilots."""
from __future__ import annotations
import json, sys, time
from pathlib import Path
from typing import Any
from multivariate_transformer import ABLATION_MODES, CONTEXT_COVERAGE_THRESHOLD, PILOTS, run_pilot


def run(input_path: Path, output_path: Path) -> int:
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    markets = payload.get("marketsByTimeframe")
    if not isinstance(markets, dict):
        raise ValueError("V12_MARKET_TIMEFRAME_DATA_MISSING")
    start = time.time()
    results: list[dict[str, Any]] = []
    for strategy, timeframe in PILOTS.items():
        try:
            result = run_pilot(strategy, timeframe, markets)
        except Exception as error:
            result = {"strategy": strategy, "timeframe": timeframe,
                      "status": "RESEARCH_ERROR", "error": str(error)[:400]}
        results.append(result)
        print("[KINGBOT V12 MULTIVARIATE PILOT]", json.dumps({
            "strategy": strategy, "timeframe": timeframe, "status": result.get("status"),
            "developmentGate": any(v.get("passesDevelopmentGuard", False) for v in (result.get("development") or {}).get("ablations", {}).values()),
            "finalGate": (result.get("final") or {}).get("result", {}).get("multivariate", {}).get("qualityGate"),
            "selectedAblation": result.get("selectedAblation"),
            "scoreDeltaVsV9": result.get("selectionScoreDeltaVsV9"), "error": result.get("error"),
        }, sort_keys=True))
    report = {
        "generatedAt": payload.get("generatedAt"),
        "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "researchVersion": "v12-1-overlap-ablation-and-history-repair-1",
        "researchOnly": True, "productionChanged": False, "modelArtifactsPersisted": False,
        "architecture": {
            "model": "2-layer Transformer encoder, 64-dimensional embeddings, 4 attention heads",
            "targetHistory": "32-bar target-market sequence",
            "context": "three controlled ablations: target-only, >=60% training-fold coverage, and all available training-covered slots",
            "alignment": "context candle feature is available only after its candle close",
            "staleness": "log1p age measured in target-timeframe units",
            "missingData": "unavailable/not-yet-closed context tokens are masked; high-coverage slot selection uses training-fold coverage only",
            "training": "supervised SELL/HOLD/BUY; training-fold-only scaling",
            "epochs": 12, "optimizer": "AdamW", "device": "CPU",
        },
        "validation": {
            "developmentWindow": "70%-85%", "finalWindow": "85%-100% untouched",
            "globalTimestampAlignment": True, "forwardLabelPurging": True,
            "matchedBaseline": "one V9 RF + PyTorch MLP 55/45 prediction set reused across ablations on identical rows and fold masks",
            "contextAblations": list(ABLATION_MODES),
            "highCoverageThreshold": CONTEXT_COVERAGE_THRESHOLD,
            "modeSelection": "best eligible development ablation only; mode is frozen before untouched final evaluation",
            "gatesUnchanged": {"balancedAccuracy": 0.36, "macroF1": 0.34,
                "minimumTestSamples": 30, "nonzeroRecall": ["SELL", "HOLD", "BUY"]},
            "additionalGate": "Final multivariate model passes unchanged gates and exceeds matched V9 selection score by >=0.005",
        },
        "dataFetch": {"historyLimit": payload.get("historyLimit"),
            "fetchSummary": payload.get("fetchSummary", []), "fetchFailures": payload.get("fetchFailures", [])},
        "summary": {
            "targetModels": len(results),
            "evaluatedModels": sum(r.get("status") != "RESEARCH_ERROR" for r in results),
            "developmentPassed": sum(bool(r.get("selectedAblation")) for r in results),
            "finalEvaluated": sum(r.get("final") is not None for r in results),
            "finalQualityGatePassed": sum(bool((r.get("final") or {}).get("result", {}).get("multivariate", {}).get("qualityGate")) for r in results),
            "researchCandidatesPassed": sum(r.get("status") == "RESEARCH_CANDIDATE_PASS" for r in results),
            "selectedAblations": {mode: sum(r.get("selectedAblation") == mode for r in results) for mode in ABLATION_MODES},
            "completeBotsReady": 0, "elapsedSeconds": round(time.time() - start, 3),
        },
        "results": results,
        "promotion": {"status": "NONE", "reason": "Research only; no model weights are saved, registered, promoted or deployed."},
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("[KINGBOT V12 MULTIVARIATE COMPLETE]", json.dumps(report["summary"], sort_keys=True))
    return 0 if report["summary"]["evaluatedModels"] else 3


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: run_multivariate_research.py INPUT_JSON OUTPUT_JSON")
    raise SystemExit(run(Path(sys.argv[1]), Path(sys.argv[2])))
