"""Run the offline XAUUSD loss, classical Monte Carlo and QAE baseline."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path

from research.quantum_lab.amplitude_estimation import compare_tail_probability_query_budgets
from research.quantum_lab.market_risk import build_loss_distribution
from research.quantum_lab.monte_carlo import run_classical_monte_carlo
from research.quantum_lab.trade_dataset import load_xauusd_trade_csv


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trades-csv", required=True, help="Closed XAUUSD export using the documented CSV schema")
    parser.add_argument("--output", default="xauusd-quantum-risk-research.json")
    parser.add_argument("--loss-threshold-r", type=float, default=1.0)
    parser.add_argument("--simulations", type=int, default=20_000)
    parser.add_argument("--horizon-trades", type=int, default=20)
    parser.add_argument("--block-length", type=int, default=1)
    parser.add_argument("--seed", type=int, default=20261113)
    parser.add_argument("--bins", type=int, default=64)
    parser.add_argument("--error", type=float, default=0.02)
    parser.add_argument("--confidence", type=float, default=0.95)
    parser.add_argument("--with-qualtran-resource-estimate", action="store_true")
    parser.add_argument("--physical-model", choices=("none", "gidney-fowler", "beverland-et-al"), default="none")
    args = parser.parse_args()

    source = Path(args.trades_csv)
    dataset = load_xauusd_trade_csv(source)
    net_pnl = [row["net_pnl_r"] for row in dataset["records"]]
    loss_distribution = build_loss_distribution(
        net_pnl, bins=args.bins, confidence_level=args.confidence, unit="R"
    )
    monte_carlo = run_classical_monte_carlo(
        net_pnl,
        simulations=args.simulations,
        horizon_trades=args.horizon_trades,
        ruin_loss_r=args.loss_threshold_r,
        block_length=args.block_length,
        seed=args.seed,
    )
    qae_budget = compare_tail_probability_query_budgets(
        net_pnl,
        loss_threshold_r=args.loss_threshold_r,
        additive_error=args.error,
        confidence=args.confidence,
    )
    report = {
        "schema_version": "kingbot-xauusd-quantum-risk-study-v1",
        "mode": "OFFLINE_RESEARCH_ONLY",
        "source_file_name": source.name,
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "dataset": {
            key: dataset[key]
            for key in ("instrument", "trade_count", "time_start", "time_end", "pnl_semantics")
        },
        "loss_distribution": loss_distribution,
        "classical_monte_carlo": monte_carlo,
        "tail_probability_qae_query_budget": qae_budget,
        "qualtran_resource_estimate": None,
        "can_generate_trade_signal": False,
        "can_place_order": False,
        "decision": "RESEARCH_ONLY_NOT_A_MODEL_OR_EXECUTION_CANDIDATE",
    }
    if args.with_qualtran_resource_estimate:
        from research.quantum_lab.qualtran_adapter import estimate_xauusd_tail_probability_bloq
        report["qualtran_resource_estimate"] = estimate_xauusd_tail_probability_bloq(
            net_pnl,
            loss_threshold_r=args.loss_threshold_r,
            physical_model=args.physical_model,
        )
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps({
        "output": str(destination),
        "trade_count": dataset["trade_count"],
        "expected_loss_r": loss_distribution["expected_loss"],
        "var_95_r": loss_distribution["empirical_var"],
        "cvar_95_r": loss_distribution["empirical_cvar"],
        "classical_probability_horizon_loss": monte_carlo["probability_horizon_loss_exceeds_threshold"],
        "empirical_single_trade_tail_probability": qae_budget["empirical_event_probability"],
        "qae_idealized_grover_query_budget": qae_budget["ideal_textbook_qae"]["total_idealized_grover_query_budget"],
        "qualtran_resource_estimate_included": report["qualtran_resource_estimate"] is not None,
        "mode": report["mode"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
