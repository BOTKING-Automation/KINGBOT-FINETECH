"""Real Qualtran smoke test; skipped in the lightweight no-dependency job."""
import importlib.util
import unittest

from research.quantum_lab.qualtran_adapter import estimate_xauusd_tail_probability_bloq


@unittest.skipUnless(
    importlib.util.find_spec("qualtran"),
    "Qualtran is tested in the dedicated optional interop job",
)
class RealQualtranIntegrationTests(unittest.TestCase):
    def test_builds_empirical_tail_qpe_and_reports_resource_status_truthfully(self):
        report = estimate_xauusd_tail_probability_bloq(
            [-2.0, -0.5, 0.25, 1.0],
            loss_threshold_r=1.0,
            phase_precision_bits=2,
            failure_probability=0.1,
        )
        self.assertEqual(report["estimand"], "empirical_probability_single_trade_loss_ge_threshold")
        self.assertEqual(report["empirical_trade_count"], 4)
        self.assertEqual(report["empirical_tail_event_count"], 1)
        self.assertAlmostEqual(report["empirical_tail_event_probability"], 0.25)
        self.assertEqual(report["state_preparation"], "StatePreparationAliasSampling")
        self.assertEqual(report["mean_operator"], "MeanEstimationOperator")
        self.assertEqual(report["phase_estimation"], "TextbookQPE")
        self.assertIn(
            report["qpe_resource_estimation_status"],
            {"COMPLETE", "BLOCKED_BY_QUALTRAN_CONTROLLED_ATOMIC_BLOQ"},
        )
        if report["qpe_resource_estimation_status"] == "COMPLETE":
            self.assertGreater(report["logical_resources"]["algorithm_qubits"], 0)
            self.assertGreater(report["logical_resources"]["approximate_t_count"], 0)
        else:
            # No full QPE gate or physical count is invented when Qualtran cannot
            # recurse through its controlled atomic-And call-graph edge.
            self.assertIsNone(report["logical_resources"])
            self.assertIsNone(report["physical_scenario"])
            self.assertIn("And is atomic", report["qpe_resource_estimation_error"])
            self.assertIn("component_resource_estimates", report)
        self.assertFalse(report["quantum_execution_performed"])
        self.assertFalse(report["can_generate_trade_signal"])
        self.assertFalse(report["can_place_order"])


if __name__ == "__main__":
    unittest.main()
