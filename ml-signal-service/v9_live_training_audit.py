"""Run the real-market, V9-only KINGBOT strategy/timeframe training audit.

This runner consumes closed OHLC bars fetched by backend/scripts/v9-fetch-live-markets.mjs.
It calls the unmodified V9 train_model implementation and records class balance even
when model fitting later fails the existing quality gate.
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
REPO_ROOT = SERVICE_DIR.parent
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


def parse_audit(stdout: str) -> dict[str, Any] | None:
    prefix = "[KINGBOT ML AUDIT] "
    for line in stdout.splitlines():
        if line.startswith(prefix):
            try:
                return json.loads(line[len(prefix):])
            except json.JSONDecodeError:
                return {"parseError": line[len(prefix):][:1000]}
    return None


def parse_validation(stdout: str) -> dict[str, Any] | None:
    prefix = "[KINGBOT ML VALIDATION] "
    for line in stdout.splitlines():
        if line.startswith(prefix):
            try:
                return json.loads(line[len(prefix):])
            except json.JSONDecodeError:
                return {"parseError": line[len(prefix):][:1000]}
    return None


def run(input_path: Path, output_path: Path) -> int:
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    if service.FEATURE_VERSION != EXPECTED_FEATURE_VERSION:
        raise RuntimeError("V9_FEATURE_VERSION_MISMATCH:" + str(service.FEATURE_VERSION))
    markets_by_timeframe = payload.get("marketsByTimeframe")
    if not isinstance(markets_by_timeframe, dict):
        raise ValueError("V9_MARKET_DATA_TIMEFRAMES_MISSING")

    results: list[dict[str, Any]] = []
    started_at = time.time()
    for strategy, timeframes in TIMEFRAME_PROFILES.items():
        for timeframe in timeframes:
            markets = markets_by_timeframe.get(timeframe, [])
            prepared = [
                {"symbol": str(item.get("symbol", "")).upper(), "bars": item.get("bars", [])}
                for item in markets
                if isinstance(item, dict) and item.get("symbol") and isinstance(item.get("bars"), list)
            ]
            captured = io.StringIO()
            began = time.time()
            result: dict[str, Any] | None = None
            error: str | None = None
            with contextlib.redirect_stdout(captured):
                try:
                    result = service.train_model(strategy, timeframe, prepared)
                except Exception as exc:  # Expected for candidates that fail the unchanged quality gate.
                    error = str(exc)[:500]
            audit = parse_audit(captured.getvalue())
            passed = bool(result and result.get("ready") and result.get("validation", {}).get("qualityGate"))
            row = {
                "strategy": strategy,
                "timeframe": timeframe,
                "status": "PASSED" if passed else "FAILED",
                "error": error,
                "featureVersion": service.FEATURE_VERSION,
                "inputMarkets": [
                    {"symbol": market["symbol"], "bars": len(market["bars"])}
                    for market in prepared
                ],
                "audit": audit,
                "validationDiagnostics": parse_validation(captured.getvalue()),
                "metrics": (result or {}).get("validation"),
                "dataset": (result or {}).get("dataset"),
                "candidate": (result or {}).get("candidate"),
                "elapsedSeconds": round(time.time() - began, 3),
                "stdout": captured.getvalue()[-12000:],
            }
            results.append(row)
            print("[KINGBOT V9 RESULT]", json.dumps({
                "strategy": strategy,
                "timeframe": timeframe,
                "status": row["status"],
                "error": error,
                "markets": len(prepared),
                "trainClasses": (audit or {}).get("trainClassDistribution"),
                "testClasses": (audit or {}).get("testClassDistribution"),
                "balancedAccuracy": (
                    ((result or {}).get("validation") or {}).get("ensemble", {}).get("balancedAccuracy")
                    if result else (parse_validation(captured.getvalue()) or {}).get("ensemble", {}).get("balancedAccuracy")
                ),
                "macroF1": (
                    ((result or {}).get("validation") or {}).get("ensemble", {}).get("macroF1")
                    if result else (parse_validation(captured.getvalue()) or {}).get("ensemble", {}).get("macroF1")
                ),
            }, sort_keys=True))

    passed = sum(row["status"] == "PASSED" for row in results)
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
            "trained": passed,
            "failed": len(results) - passed,
            "elapsedSeconds": round(time.time() - started_at, 3),
            "botsReady": sum(
                all(item["status"] == "PASSED" for item in results if item["strategy"] == strategy)
                for strategy in TIMEFRAME_PROFILES
            ),
        },
        "results": results,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("[KINGBOT V9 CYCLE COMPLETE]", json.dumps(report["summary"], sort_keys=True))
    print("[KINGBOT V9 REPORT]", str(output_path))
    # Model validation failures are audit outcomes, not CI infrastructure failures.
    return 0 if len(results) == 15 else 3


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: v9_live_training_audit.py INPUT_JSON OUTPUT_JSON")
    raise SystemExit(run(Path(sys.argv[1]), Path(sys.argv[2])))
