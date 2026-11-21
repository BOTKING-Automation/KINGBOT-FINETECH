"""Run KINGBOT V11 masked self-supervised representation learning pilots."""
from __future__ import annotations
import json, sys, time
from pathlib import Path
from typing import Any
from ssl_market_encoder import PILOT_PROFILES, run_pilot


def run(input_path: Path, output_path: Path) -> int:
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    by_tf = payload.get("marketsByTimeframe")
    if not isinstance(by_tf, dict):
        raise ValueError("V11_TIMEFRAME_DATA_MISSING")
    started = time.time()
    results: list[dict[str, Any]] = []
    for strategy, timeframe in PILOT_PROFILES.items():
        markets = [{"symbol": str(row.get("symbol") or "").upper(), "bars": row.get("bars", [])}
            for row in by_tf.get(timeframe, []) if isinstance(row, dict) and row.get("symbol") and isinstance(row.get("bars"), list)]
        try:
            result = run_pilot(strategy, timeframe, markets)
        except Exception as error:
            result = {"strategy": strategy, "timeframe": timeframe, "status": "RESEARCH_ERROR", "error": str(error)[:400]}
        results.append(result)
        print("[KINGBOT V11 SSL PILOT]", json.dumps({
            "strategy": strategy, "timeframe": timeframe, "status": result.get("status"),
            "developmentGate": (result.get("development") or {}).get("ssl", {}).get("qualityGate"),
            "finalGate": (result.get("final") or {}).get("ssl", {}).get("qualityGate"),
            "scoreDeltaVsV9": result.get("selectionScoreDeltaVsV9"), "error": result.get("error"),
        }, sort_keys=True))
    report = {
        "generatedAt": payload.get("generatedAt"), "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "researchVersion": "v11-masked-self-supervised-encoder-pilot-1",
        "researchOnly": True, "productionChanged": False, "modelArtifactsPersisted": False,
        "architecture": {"encoder": "2-layer Transformer encoder, d_model=64, 4 attention heads",
            "pretraining": "masked time-step reconstruction; 20% time-step masking",
            "pretrainingData": "training-fold windows only; labels are not used for self-supervised loss",
            "fineTuning": "supervised SELL/HOLD/BUY classification on the same training fold",
            "sequenceLength": 32, "pretrainEpochs": 12, "finetuneEpochs": 12},
        "validation": {"developmentWindow": "70%-85%", "finalWindow": "85%-100% untouched",
            "globalTimestampAlignment": True, "forwardLabelPurging": True,
            "matchedBaseline": "V9 RF + PyTorch MLP 55/45 on identical terminal rows and fold masks",
            "gatesUnchanged": {"balancedAccuracy": 0.36, "macroF1": 0.34, "minimumTestSamples": 30,
                "nonzeroRecall": ["SELL", "HOLD", "BUY"]},
            "additionalGate": "Final SSL model must pass unchanged gates and beat matched V9 selection score by >=0.005"},
        "dataFetch": {"historyLimit": payload.get("historyLimit"), "fetchSummary": payload.get("fetchSummary", []),
            "fetchFailures": payload.get("fetchFailures", [])},
        "summary": {"targetModels": len(results),
            "evaluatedModels": sum(r.get("status") != "RESEARCH_ERROR" for r in results),
            "developmentPassed": sum(bool((r.get("development") or {}).get("ssl", {}).get("qualityGate")) for r in results),
            "finalEvaluated": sum(r.get("final") is not None for r in results),
            "finalQualityGatePassed": sum(bool((r.get("final") or {}).get("ssl", {}).get("qualityGate")) for r in results),
            "researchCandidatesPassed": sum(r.get("status") == "RESEARCH_CANDIDATE_PASS" for r in results),
            "completeBotsReady": 0, "elapsedSeconds": round(time.time() - started, 3)},
        "results": results, "promotion": {"status": "NONE", "reason": "Research only; no model is saved, registered, or deployed."}}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("[KINGBOT V11 SSL COMPLETE]", json.dumps(report["summary"], sort_keys=True))
    return 0 if report["summary"]["evaluatedModels"] else 3


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: run_ssl_research.py INPUT_JSON OUTPUT_JSON")
    raise SystemExit(run(Path(sys.argv[1]), Path(sys.argv[2])))
