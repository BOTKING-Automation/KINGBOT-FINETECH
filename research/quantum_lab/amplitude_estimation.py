"""Theory-only query-budget comparison for a Bernoulli tail-event oracle."""
from __future__ import annotations
import math
from typing import Any, Sequence

def compare_tail_probability_query_budgets(
    net_pnl_r: Sequence[float],
    *,
    loss_threshold_r: float,
    additive_error: float = 0.02,
    confidence: float = 0.95,
) -> dict[str, Any]:
    """Compare classical Hoeffding samples with ideal textbook QAE query counts.

    Event: one closed trade has loss greater than or equal to the threshold.
    QAE query counts exclude QROM loading, state preparation, surface-code costs,
    physical error correction, hardware noise, readout and calibration.
    """
    if not net_pnl_r:
        raise ValueError("QAE_TRADE_SAMPLES_EMPTY")
    try:
        threshold = float(loss_threshold_r)
        epsilon = float(additive_error)
        confidence = float(confidence)
    except (TypeError, ValueError) as exc:
        raise ValueError("QAE_NUMERIC_ARGUMENT_INVALID") from exc
    if not math.isfinite(threshold) or threshold <= 0:
        raise ValueError("QAE_LOSS_THRESHOLD_INVALID")
    if not math.isfinite(epsilon) or not 0 < epsilon < 0.5:
        raise ValueError("QAE_ADDITIVE_ERROR_INVALID")
    if not math.isfinite(confidence) or not 0.5 < confidence < 1:
        raise ValueError("QAE_CONFIDENCE_INVALID")
    outcomes = [float(x) for x in net_pnl_r]
    if any(not math.isfinite(x) for x in outcomes):
        raise ValueError("QAE_TRADE_SAMPLE_NOT_FINITE")
    event_count = sum((-x) >= threshold for x in outcomes)
    p = event_count / len(outcomes)
    delta = 1.0 - confidence
    classical_samples = math.ceil(math.log(2.0 / delta) / (2.0 * epsilon * epsilon))
    success_lower_bound = 8.0 / (math.pi * math.pi)
    phase_dimension = 1
    while (
        2.0 * math.pi * math.sqrt(p * (1.0 - p)) / phase_dimension
        + math.pi * math.pi / (phase_dimension * phase_dimension)
    ) > epsilon:
        phase_dimension *= 2
        if phase_dimension > 2**30:
            raise ValueError("QAE_QUERY_BUDGET_TOO_LARGE")
    repeats = math.ceil(math.log(1.0 / delta) / (2.0 * (success_lower_bound - 0.5) ** 2))
    if repeats % 2 == 0:
        repeats += 1
    return {
        "schema_version": "kingbot-tail-probability-qae-budget-v1",
        "mode": "THEORY_ONLY_OFFLINE_RESEARCH",
        "event_definition": f"single_closed_trade_loss_r >= {threshold}",
        "trade_sample_count": len(outcomes),
        "sample_adequacy": "at_least_30" if len(outcomes) >= 30 else "small_sample",
        "empirical_event_count": event_count,
        "empirical_event_probability": p,
        "target_additive_error": epsilon,
        "target_confidence": confidence,
        "classical_monte_carlo": {
            "method": "Hoeffding_bound_for_Bernoulli_mean",
            "required_independent_samples": classical_samples,
        },
        "ideal_textbook_qae": {
            "method": "phase_estimation_amplitude_estimation",
            "phase_register_dimension": phase_dimension,
            "controlled_grover_queries_per_run": phase_dimension - 1,
            "majority_repetitions": repeats,
            "total_idealized_grover_query_budget": (phase_dimension - 1) * repeats,
            "single_run_success_lower_bound": success_lower_bound,
            "single_run_error_bound": (
                2.0 * math.pi * math.sqrt(p * (1.0 - p)) / phase_dimension
                + math.pi * math.pi / (phase_dimension * phase_dimension)
            ),
        },
        "qae_scope": "oracle_query_theory_only_no_circuit_execution",
        "excluded_costs": [
            "building and loading empirical distribution into QROM",
            "state preparation and inverse state preparation",
            "controlled Grover operators and uncomputation details",
            "logical-to-physical qubit overhead and surface-code factories",
            "hardware noise, readout error, calibration and queue latency",
        ],
        "interpretation": "Do not infer a practical quantum speedup from oracle-query counts alone.",
        "can_generate_trade_signal": False,
        "can_place_order": False,
    }
