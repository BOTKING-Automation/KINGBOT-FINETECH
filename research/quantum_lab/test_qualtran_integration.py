"""Real Qualtran smoke test; skipped in the lightweight no-dependency job."""
import importlib.util
import unittest
from research.quantum_lab.qualtran_adapter import estimate_xauusd_tail_probability_bloq


@unittest.skipUnless(importlib.util.find_spec("qualtran"), "Qualtran is tested in the dedicated optional interop job")
class RealQualtranIntegrationTests(unittest.TestCase):
    def test_builds_tail_probability_mean_estimation_and_qpe_resources(self):
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
        self.assertGreater(report["logical_resources"]["algorithm_qubits"], 0)
        self.assertGreater(report["logical_resources"]["approximate_t_count"], 0)
        self.assertEqual(report["phase_estimation"], "TextbookQPE")
        self.assertFalse(report["quantum_execution_performed"])
        self.assertFalse(report["can_place_order"])


if __name__ == "__main__":
    unittest.main()
