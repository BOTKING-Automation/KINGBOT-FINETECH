"""Run the V10 temporal challenger against a matched V9 baseline."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

from temporal_challenger import PILOT_PROFILES, run_pilot


def run(input_path: Path, output_path: Path) -> int:
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    by_timeframe = payload.get("marketsByTimeframe")
    if not isinstance(by_timeframe, dict):
        raise ValueError("V10_TEMPORAL_TIMEFRAME_DATA_MISSING")

    started = time.time()
    results: list[dict[str, Any]] = []
    for strategy, timeframe in PILOT_PROFILES.items():
        markets = [
            {
                "symbol": str(row.get("symbol") or "").upper(),
                "bars": row.get("bars", []),
                "source": row.get("source"),
            }
            for row in by_timeframe.get(timeframe, [])
            if isinstance(row, dict)
            and row.get("symbol")
            and isinstance(row.get("bars"), list)
        ]
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
        print("[KINGBOT V10 TEMPORAL PILOT]", json.dumps({
            "strategy": strategy,
            "timeframe": timeframe,
            "status": result.get("status"),
            "developmentGate": (result.get("development") or {}).get("tcn", {}).get("qualityGate"),
            "finalGate": (result.get("final") or {}).get("tcn", {}).get("qualityGate"),
            "scoreDeltaVsV9": (result.get("final") or {}).get("selectionScoreDeltaVsV9"),
            "error": result.get("error"),
        }, sort_keys=True))

    evaluated = [row for row in results if row.get("status") not in {"SKIPPED_DATA_COVERAGE", "RESEARCH_ERROR"}]
    report = {
        "generatedAt": payload.get("generatedAt"),
        "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "researchVersion": "v10-causal-tcn-pilot-1",
        "researchOnly": True,
        "productionChanged": False,
        "modelArtifactsPersisted": False,
        "pilotScope": {
            "profiles": PILOT_PROFILES,
            "targetModels": len(PILOT_PROFILES),
            "completeBotsProvenReady": 0,
            "note": "One representative timeframe per specialist is evaluated; this is not a complete three-timeframe bot acceptance test.",
        },
        "temporalModel": {
            "architecture": "three-block causal temporal convolutional network",
            "sequenceLength": 32,
            "features": "existing V9 causal OHLC-derived strategy-masked features",
            "epochs": 18,
            "optimizer": "AdamW",
            "loss": "class-weighted cross entropy",
            "device": "CPU",
        },
        "validationProtocol": {
            "developmentWindow": "70%-85%",
            "finalWindow": "85%-100% untouched; no refit or tuning",
            "globalTimestampAlignment": True,
            "forwardLabelPurging": True,
            "matchedBaseline": "V9 RF + PyTorch MLP 55/45 on the same terminal rows, sample set and fold masks",
            "metricGate": {
                "balancedAccuracyMinimum": 0.36,
                "macroF1Minimum": 0.34,
                "minimumTestSamples": 30,
                "nonzeroRecall": ["SELL", "HOLD", "BUY"],
                "changed": False,
            },
            "additionalResearchGate": "Final TCN must pass the unchanged metric/class-coverage gates and beat the matched V9 baseline selection score by at least 0.005.",
        },
        "dataFetch": {
            "historyLimit": payload.get("historyLimit"),
            "fetchSummary": payload.get("fetchSummary", []),
            "fetchFailures": payload.get("fetchFailures", []),
        },
        "summary": {
            "targetModels": len(results),
            "evaluatedModels": len(evaluated),
            "developmentPassed": sum(bool((row.get("development") or {}).get("advanceToFinal")) for row in results),
            "finalEvaluated": sum(row.get("final") is not None for row in results),
            "finalQualityGatePassed": sum(bool((row.get("final") or {}).get("tcn", {}).get("qualityGate")) for row in results),
            "researchCandidatesPassed": sum(row.get("status") == "RESEARCH_CANDIDATE_PASS" for row in results),
            "completeBotsReady": 0,
            "elapsedSeconds": round(time.time() - started, 3),
        },
        "results": results,
        "promotion": {
            "status": "NONE",
            "reason": "Research output only; no candidate is saved, registered or deployed.",
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("[KINGBOT V10 TEMPORAL RESEARCH COMPLETE]", json.dumps(report["summary"], sort_keys=True))
    print("[KINGBOT V10 TEMPORAL REPORT]", str(output_path))
    return 0 if evaluated else 3


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: run_temporal_research.py INPUT_JSON OUTPUT_JSON")
    raise SystemExit(run(Path(sys.argv[1]), Path(sys.argv[2])))
