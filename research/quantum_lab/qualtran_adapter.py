"""Optional Qualtran adapter for offline algorithm resource estimates.

Importing this module does not import Qualtran. The optional dependency is loaded
only when estimate_qualtran_bloq() is explicitly called.
"""
from __future__ import annotations

import math
from typing import Any

SUPPORTED_PHYSICAL_MODELS = {"none", "gidney-fowler", "beverland-et-al"}


def _json_safe(value: Any) -> Any:
    """Convert common NumPy/SymPy/Qualtran scalars into JSON-safe values."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return _json_safe(item())
        except (TypeError, ValueError):
            pass
    return str(value)


def estimate_qualtran_bloq(
    bloq: Any,
    *,
    physical_model: str = "none",
    data_code_distance: int = 15,
    beverland_data_block: str = "compact",
) -> dict[str, Any]:
    """Estimate logical and optionally physical resources for a Qualtran Bloq.

    ``physical_model`` values are literature-based scenarios, not claims about an
    available quantum computer. Physical estimates are omitted by default to avoid
    silently assuming hardware properties.
    """
    if physical_model not in SUPPORTED_PHYSICAL_MODELS:
        raise ValueError("QUANTUM_PHYSICAL_MODEL_UNSUPPORTED")
    if physical_model != "none":
        if isinstance(data_code_distance, bool) or not isinstance(data_code_distance, int):
            raise ValueError("QUANTUM_CODE_DISTANCE_INVALID")
        if data_code_distance < 3 or data_code_distance > 99 or data_code_distance % 2 == 0:
            raise ValueError("QUANTUM_CODE_DISTANCE_INVALID")
        if beverland_data_block not in {"compact", "fast", "intermediate"}:
            raise ValueError("QUANTUM_DATA_BLOCK_UNSUPPORTED")

    try:
        import qualtran
        from qualtran.surface_code import AlgorithmSummary, PhysicalCostModel
    except ImportError as exc:
        raise RuntimeError(
            "QUALTRAN_OPTIONAL_DEPENDENCY_MISSING: install research/quantum_lab/requirements.txt "
            "inside a separate research environment; do not add it to the live ML service"
        ) from exc

    summary = AlgorithmSummary.from_bloq(bloq)
    gates = summary.n_logical_gates
    logical_resources = {
        "algorithm_qubits": _json_safe(summary.n_algo_qubits),
        "gate_counts": _json_safe(gates.asdict()),
        "approximate_t_count": _json_safe(gates.total_t_count()),
        "t_count_assumptions": {
            "t_per_toffoli": 4,
            "t_per_cswap": 4,
            "t_per_and": 4,
            "t_per_rotation": 11,
            "note": "Qualtran GateCounts defaults; rotation approximation assumes its documented 1e-3 setting.",
        },
    }

    physical = None
    if physical_model == "gidney-fowler":
        model = PhysicalCostModel.make_gidney_fowler(data_d=data_code_distance)
        physical = {
            "scenario": physical_model,
            "data_code_distance": data_code_distance,
            "physical_qubits": _json_safe(model.n_phys_qubits(summary)),
            "duration_hours": _json_safe(model.duration_hr(summary)),
            "estimated_hardware_failure_probability": _json_safe(model.error(summary)),
            "interpretation": "literature-based estimate; not measured hardware performance",
        }
    elif physical_model == "beverland-et-al":
        model = PhysicalCostModel.make_beverland_et_al(
            data_d=data_code_distance,
            data_block_name=beverland_data_block,
        )
        physical = {
            "scenario": physical_model,
            "data_code_distance": data_code_distance,
            "data_block": beverland_data_block,
            "physical_qubits": _json_safe(model.n_phys_qubits(summary)),
            "duration_hours": _json_safe(model.duration_hr(summary)),
            "estimated_hardware_failure_probability": _json_safe(model.error(summary)),
            "interpretation": "literature-based estimate; not measured hardware performance",
        }

    return {
        "schema_version": "kingbot-qualtran-resource-report-v1",
        "mode": "OFFLINE_RESEARCH_ONLY",
        "qualtran_version": getattr(qualtran, "__version__", "unknown"),
        "bloq_type": type(bloq).__name__,
        "logical_resources": logical_resources,
        "physical_scenario": physical,
        "can_generate_trade_signal": False,
        "can_place_order": False,
        "approval_status": "NOT_A_MODEL_OR_TRADING_CANDIDATE",
    }
