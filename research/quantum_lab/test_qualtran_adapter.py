import sys
import types
import unittest
from unittest.mock import patch

from research.quantum_lab.qualtran_adapter import estimate_qualtran_bloq


class FakeGateCounts:
    def asdict(self):
        return {"t": 12, "toffoli": 2}

    def total_t_count(self):
        return 20


class FakeAlgorithmSummary:
    n_algo_qubits = 7
    n_logical_gates = FakeGateCounts()

    @classmethod
    def from_bloq(cls, bloq):
        if bloq != "test-bloq":
            raise ValueError("unexpected bloq")
        return cls()


class FakePhysicalCostModel:
    def __init__(self, scenario):
        self.scenario = scenario

    @classmethod
    def make_gidney_fowler(cls, data_d):
        return cls(("gidney-fowler", data_d))

    @classmethod
    def make_beverland_et_al(cls, data_d, data_block_name="compact"):
        return cls(("beverland-et-al", data_d, data_block_name))

    def n_phys_qubits(self, summary):
        return 1234

    def duration_hr(self, summary):
        return 0.25

    def error(self, summary):
        return 0.0001


class QualtranAdapterSafetyTests(unittest.TestCase):
    def _mock_qualtran(self):
        root = types.ModuleType("qualtran")
        root.__version__ = "0.7.0-test-double"
        surface = types.ModuleType("qualtran.surface_code")
        surface.AlgorithmSummary = FakeAlgorithmSummary
        surface.PhysicalCostModel = FakePhysicalCostModel
        return {"qualtran": root, "qualtran.surface_code": surface}

    def test_unknown_physical_model_is_rejected_before_optional_import(self):
        with self.assertRaisesRegex(ValueError, "QUANTUM_PHYSICAL_MODEL_UNSUPPORTED"):
            estimate_qualtran_bloq(object(), physical_model="real-market-live")

    def test_even_code_distance_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "QUANTUM_CODE_DISTANCE_INVALID"):
            estimate_qualtran_bloq(object(), physical_model="gidney-fowler", data_code_distance=10)

    def test_logical_estimate_is_json_safe_and_research_only(self):
        with patch.dict(sys.modules, self._mock_qualtran()):
            report = estimate_qualtran_bloq("test-bloq")
        self.assertEqual(report["qualtran_version"], "0.7.0-test-double")
        self.assertEqual(report["logical_resources"]["algorithm_qubits"], 7)
        self.assertEqual(report["logical_resources"]["approximate_t_count"], 20)
        self.assertIsNone(report["physical_scenario"])
        self.assertFalse(report["can_generate_trade_signal"])
        self.assertFalse(report["can_place_order"])

    def test_physical_scenarios_are_explicitly_labelled(self):
        with patch.dict(sys.modules, self._mock_qualtran()):
            report = estimate_qualtran_bloq(
                "test-bloq", physical_model="beverland-et-al", data_code_distance=17
            )
        self.assertEqual(report["physical_scenario"]["scenario"], "beverland-et-al")
        self.assertEqual(report["physical_scenario"]["physical_qubits"], 1234)
        self.assertIn(
            "not measured hardware performance",
            report["physical_scenario"]["interpretation"],
        )


if __name__ == "__main__":
    unittest.main()
