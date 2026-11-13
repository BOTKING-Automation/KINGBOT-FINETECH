"""Prepare closed-trade loss distributions for offline quantum-risk research.

The output is a classical, auditable histogram suitable for later loading into
quantum circuits with primitives such as Qualtran QROM/QROAM and state preparation.
It does not run a quantum algorithm, generate a trading signal, or affect execution.
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

SCHEMA_VERSION = "kingbot-quantum-risk-input-v1"
DEFAULT_BINS = 64
DEFAULT_VALUE_SCALE = 1_000_000


def build_loss_distribution(
    net_pnl_samples: Sequence[float],
    *,
    bins: int = DEFAULT_BINS,
    confidence_level: float = 0.95,
    value_scale: int = DEFAULT_VALUE_SCALE,
    unit: str = "R",
) -> dict[str, Any]:
    """Build a reproducible loss histogram and empirical VaR/CVaR reference.

    Args:
        net_pnl_samples: Completed-trade PnL values after spread, commission,
            swap and slippage. Prefer R-multiples for cross-instrument comparisons.
            Positive values are profits; negative values become positive losses.
        bins: Requested equal-width histogram bins (2..256).
        confidence_level: Empirical VaR confidence in (0, 1), e.g. 0.95.
        value_scale: Integer fixed-point scale used for QROM-friendly values.
        unit: Unit of the supplied PnL values, e.g. ``R`` or ``USD``.

    Returns:
        A JSON-safe record containing histogram values, integer counts, normalized
        probabilities, and classical VaR/CVaR benchmarks. No trading authority is
        attached to the result.
    """
    if isinstance(bins, bool) or not isinstance(bins, int) or not 2 <= bins <= 256:
        raise ValueError("QUANTUM_RISK_BINS_OUT_OF_RANGE")
    try:
        confidence = float(confidence_level)
    except (TypeError, ValueError) as exc:
        raise ValueError("QUANTUM_RISK_CONFIDENCE_INVALID") from exc
    if not math.isfinite(confidence) or not 0.0 < confidence < 1.0:
        raise ValueError("QUANTUM_RISK_CONFIDENCE_INVALID")
    if isinstance(value_scale, bool) or not isinstance(value_scale, int) or not 1 <= value_scale <= 1_000_000_000:
        raise ValueError("QUANTUM_RISK_VALUE_SCALE_INVALID")
    if not isinstance(unit, str) or not unit.strip() or len(unit) > 24:
        raise ValueError("QUANTUM_RISK_UNIT_INVALID")
    if isinstance(net_pnl_samples, (str, bytes)) or not isinstance(net_pnl_samples, Sequence):
        raise ValueError("QUANTUM_RISK_SAMPLES_INVALID")
    if not net_pnl_samples:
        raise ValueError("QUANTUM_RISK_SAMPLES_EMPTY")

    pnl: list[float] = []
    for sample in net_pnl_samples:
        try:
            value = float(sample)
        except (TypeError, ValueError) as exc:
            raise ValueError("QUANTUM_RISK_SAMPLE_NOT_NUMERIC") from exc
        if not math.isfinite(value):
            raise ValueError("QUANTUM_RISK_SAMPLE_NOT_FINITE")
        pnl.append(value)

    # A zero floor makes this a loss distribution: profits contribute zero loss.
    losses = [max(0.0, -value) for value in pnl]
    ordered = sorted(losses)
    sample_count = len(ordered)
    var_index = max(0, math.ceil(confidence * sample_count) - 1)
    var_loss = ordered[var_index]
    tail_count = max(1, math.ceil((1.0 - confidence) * sample_count))
    cvar_loss = sum(ordered[-tail_count:]) / tail_count
    expected_loss = sum(losses) / sample_count

    minimum = min(losses)
    maximum = max(losses)
    if math.isclose(minimum, maximum, rel_tol=0.0, abs_tol=1e-15):
        rows = [{
            "index": 0,
            "loss": minimum,
            "encoded_loss": int(round(minimum * value_scale)),
            "count": sample_count,
            "probability": 1.0,
        }]
    else:
        width = (maximum - minimum) / bins
        counts = [0] * bins
        sums = [0.0] * bins
        for loss in losses:
            index = min(bins - 1, max(0, int((loss - minimum) / width)))
            counts[index] += 1
            sums[index] += loss
        rows = []
        for index, count in enumerate(counts):
            if not count:
                continue
            # Use the observed mean for a bin, not a synthetic midpoint.
            representative_loss = sums[index] / count
            rows.append({
                "index": index,
                "loss": representative_loss,
                "encoded_loss": int(round(representative_loss * value_scale)),
                "count": count,
                "probability": count / sample_count,
            })

    max_encoded_loss = max(row["encoded_loss"] for row in rows)
    loss_register_bits = max(1, max_encoded_loss.bit_length())
    count_register_bits = max(1, sample_count.bit_length())

    return {
        "schema_version": SCHEMA_VERSION,
        "mode": "OFFLINE_RESEARCH_ONLY",
        "source_semantics": "closed_trade_net_pnl_after_costs",
        "unit": unit.strip(),
        "sample_count": sample_count,
        "sample_adequacy": "at_least_30" if sample_count >= 30 else "small_sample",
        "confidence_level": confidence,
        "value_scale": value_scale,
        "quantum_data_encoding": {
            "loss_register": {
                "encoding": "unsigned_fixed_point",
                "scale": value_scale,
                "required_bits": loss_register_bits,
            },
            "count_register": {
                "encoding": "unsigned_integer",
                "required_bits": count_register_bits,
            },
            "probability": {
                "encoding": "count_over_denominator",
                "denominator": sample_count,
                "numerator_source": "histogram.count",
            },
        },
        "requested_bins": bins,
        "used_bins": len(rows),
        "expected_loss": expected_loss,
        "empirical_var": var_loss,
        "empirical_cvar": cvar_loss,
        "tail_sample_count": tail_count,
        "probability_denominator": sample_count,
        "histogram": rows,
        "quantum_loading_candidates": ["QROM", "QROAMClean", "StatePreparationAliasSampling"],
        "quantum_estimation_candidates": ["MeanEstimationOperator", "TextbookQPE"],
        "hardware_execution_configured": False,
        "can_generate_trade_signal": False,
        "can_place_order": False,
        "approval_status": "NOT_A_MODEL_OR_TRADING_CANDIDATE",
    }
