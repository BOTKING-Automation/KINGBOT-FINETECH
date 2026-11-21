import unittest
from research.quantum_lab.amplitude_estimation import compare_tail_probability_query_budgets


class AmplitudeEstimationBudgetTests(unittest.TestCase):
    def test_computes_event_probability_and_query_budgets(self):
        data = [-2.0, -1.0, -0.5, 0.2, 0.5, 1.0, -3.0, 2.0]
        report = compare_tail_probability_query_budgets(data, loss_threshold_r=1.0, additive_error=0.05)
        self.assertAlmostEqual(report["empirical_event_probability"], 0.375)
        self.assertGreater(report["classical_monte_carlo"]["required_independent_samples"], 0)
        self.assertGreater(report["ideal_textbook_qae"]["total_idealized_grover_query_budget"], 0)
        self.assertIn("oracle_query_theory_only", report["qae_scope"])

    def test_rejects_invalid_event_threshold(self):
        with self.assertRaisesRegex(ValueError, "THRESHOLD"):
            compare_tail_probability_query_budgets([-1.0, 1.0], loss_threshold_r=0)


if __name__ == "__main__":
    unittest.main()
