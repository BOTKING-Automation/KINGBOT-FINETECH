"""Optional Qualtran adapter for offline algorithm resource estimates.

Qualtran is imported lazily, only when a researcher explicitly builds or estimates
an algorithm. No live service imports this module.
"""
from __future__ import annotations

import math
from typing import Any, Sequence

SUPPORTED_PHYSICAL_MODELS = {"none", "gidney-fowler", "beverland-et-al"}


def _json_safe(value: Any) -> Any:
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


def _load_qualtran_resource_api():
    try:
        import qualtran
        from qualtran.surface_code import AlgorithmSummary, PhysicalCostModel
    except ImportError as exc:
        raise RuntimeError(
            "QUALTRAN_OPTIONAL_DEPENDENCY_MISSING: install research/quantum_lab/requirements.txt "
            "inside a separate research environment; do not add it to the live ML service"
        ) from exc
    return qualtran, AlgorithmSummary, PhysicalCostModel


def estimate_qualtran_bloq(
    bloq: Any,
    *,
    physical_model: str = "none",
    data_code_distance: int = 15,
    beverland_data_block: str = "compact",
) -> dict[str, Any]:
    """Estimate logical and optionally physical resources for a Qualtran Bloq."""
    if physical_model not in SUPPORTED_PHYSICAL_MODELS:
        raise ValueError("QUANTUM_PHYSICAL_MODEL_UNSUPPORTED")
    if physical_model != "none":
        if isinstance(data_code_distance, bool) or not isinstance(data_code_distance, int):
            raise ValueError("QUANTUM_CODE_DISTANCE_INVALID")
        if data_code_distance < 3 or data_code_distance > 99 or data_code_distance % 2 == 0:
            raise ValueError("QUANTUM_CODE_DISTANCE_INVALID")
        if beverland_data_block not in {"compact", "fast", "intermediate"}:
            raise ValueError("QUANTUM_DATA_BLOCK_UNSUPPORTED")

    qualtran, AlgorithmSummary, PhysicalCostModel = _load_qualtran_resource_api()
    summary = AlgorithmSummary.from_bloq(bloq)
    gates = summary.n_logical_gates
    logical = {
        "algorithm_qubits": _json_safe(summary.n_algo_qubits),
        "gate_counts": _json_safe(gates.asdict()),
        "approximate_t_count": _json_safe(gates.total_t_count()),
        "t_count_assumptions": {
            "t_per_toffoli": 4,
            "t_per_cswap": 4,
            "t_per_and": 4,
            "t_per_rotation": 11,
            "note": "Qualtran GateCounts defaults; rotation approximation assumes documented 1e-3 error setting.",
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
            data_d=data_code_distance, data_block_name=beverland_data_block
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
        "logical_resources": logical,
        "physical_scenario": physical,
        "can_generate_trade_signal": False,
        "can_place_order": False,
        "approval_status": "NOT_A_MODEL_OR_TRADING_CANDIDATE",
    }


def estimate_xauusd_tail_probability_bloq(
    net_pnl_r: Sequence[float],
    *,
    loss_threshold_r: float,
    phase_precision_bits: int = 4,
    failure_probability: float = 0.1,
    physical_model: str = "none",
    data_code_distance: int = 15,
) -> dict[str, Any]:
    """Build a state-preparation + mean-estimation + textbook-QPE Bloq.

    Every empirical trade has equal probability. The one-bit SELECT oracle returns
    1 exactly when that trade's loss meets the requested threshold. The report is a
    circuit-resource estimate, not a circuit execution or measured quantum result.
    """
    if not net_pnl_r:
        raise ValueError("QUALTRAN_TRADE_SAMPLES_EMPTY")
    threshold = float(loss_threshold_r)
    if not math.isfinite(threshold) or threshold <= 0:
        raise ValueError("QUALTRAN_RISK_THRESHOLD_INVALID")
    if isinstance(phase_precision_bits, bool) or not isinstance(phase_precision_bits, int) or not 1 <= phase_precision_bits <= 12:
        raise ValueError("QUALTRAN_PHASE_PRECISION_OUT_OF_RANGE")
    delta = float(failure_probability)
    if not math.isfinite(delta) or not 0 < delta < 0.5:
        raise ValueError("QUALTRAN_FAILURE_PROBABILITY_INVALID")

    outcomes = [float(value) for value in net_pnl_r]
    if any(not math.isfinite(value) for value in outcomes):
        raise ValueError("QUALTRAN_TRADE_SAMPLE_NOT_FINITE")
    indicators = tuple(1 if -value >= threshold else 0 for value in outcomes)
    probabilities = [1.0 / len(indicators)] * len(indicators)
    if len(indicators) == 1:
        indicators = (indicators[0], indicators[0])
        probabilities = [1.0, 0.0]

    try:
        import attrs
        import cirq
        from functools import cached_property
        from typing import Iterator
        from qualtran import QAny, QUInt, Register
        from qualtran.bloqs.mean_estimation.mean_estimation_operator import (
            CodeForRandomVariable,
            MeanEstimationOperator,
        )
        from qualtran.bloqs.multiplexers.select_base import SelectOracle
        from qualtran.bloqs.phase_estimation.qpe_window_state import RectangularWindowState
        from qualtran.bloqs.phase_estimation.text_book_qpe import TextbookQPE
        from qualtran.bloqs.state_preparation.state_preparation_alias_sampling import (
            StatePreparationAliasSampling,
        )
    except ImportError as exc:
        raise RuntimeError(
            "QUALTRAN_OPTIONAL_DEPENDENCY_MISSING: install research/quantum_lab/requirements.txt "
            "inside a separate research environment; do not add it to the live ML service"
        ) from exc

    synthesizer = StatePreparationAliasSampling.from_probabilities(
        probabilities, precision=1.0e-5
    )

    @attrs.frozen
    class _TailIndicatorEncoder(SelectOracle):
        selection_registers: tuple
        values: tuple[int, ...]

        @cached_property
        def control_registers(self):
            return ()

        @cached_property
        def target_registers(self):
            return (Register("target", QAny(1)),)

        def decompose_from_registers(
            self,
            context,
            *,
            selection: Sequence[cirq.Qid],
            target: Sequence[cirq.Qid],
        ) -> Iterator[cirq.OP_TREE]:
            for index, value in enumerate(self.values):
                if value:
                    control_bits = QUInt(len(selection)).to_bits(index)
                    yield cirq.X(target[0]).controlled_by(
                        *selection, control_values=control_bits
                    )

    encoder = _TailIndicatorEncoder(
        selection_registers=tuple(synthesizer.selection_registers),
        values=indicators,
    )
    code = CodeForRandomVariable(synthesizer=synthesizer, encoder=encoder)
    mean_operator = MeanEstimationOperator(code, arctan_bitsize=16)
    phase_state = RectangularWindowState.from_precision_and_delta(
        phase_precision_bits, delta
    )
    qpe_bloq = TextbookQPE(mean_operator, phase_state)
    report = estimate_qualtran_bloq(
        qpe_bloq, physical_model=physical_model, data_code_distance=data_code_distance
    )
    report.update({
        "estimand": "empirical_probability_single_trade_loss_ge_threshold",
        "loss_threshold_r": threshold,
        "empirical_trade_count": len(outcomes),
        "empirical_tail_event_count": sum(indicators),
        "empirical_tail_event_probability": sum(indicators) / len(indicators),
        "phase_precision_bits": phase_precision_bits,
        "failure_probability_parameter": delta,
        "state_preparation": "StatePreparationAliasSampling",
        "mean_operator": "MeanEstimationOperator",
        "phase_estimation": "TextbookQPE",
        "quantum_execution_performed": False,
        "warning": "Resource estimate only. State preparation, QROM, oracle and hardware costs must be reviewed before any speedup claim.",
    })
    return report
