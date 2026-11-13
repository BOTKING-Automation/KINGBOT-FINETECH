import unittest

from research.quantum_lab.market_risk import build_loss_distribution


class MarketRiskDistributionTests(unittest.TestCase):
    def test_histogram_probabilities_and_counts_are_conserved(self):
        pnl = [-20, -10, -5, -2, -1, 0, 1, 2, 3, 4] * 4
        report = build_loss_distribution(pnl, bins=8, confidence_level=0.95)
        histogram = report["histogram"]
        self.assertEqual(report["sample_count"], 40)
        self.assertEqual(sum(row["count"] for row in histogram), 40)
        self.assertAlmostEqual(sum(row["probability"] for row in histogram), 1.0)
        self.assertTrue(all(row["encoded_loss"] >= 0 for row in histogram))
        self.assertGreaterEqual(report["quantum_data_encoding"]["loss_register"]["required_bits"], 1)
        self.assertEqual(
            report["quantum_data_encoding"]["probability"]["denominator"], 40
        )
        self.assertFalse(report["can_place_order"])

    def test_var_and_cvar_match_empirical_worst_tail(self):
        pnl = [-20, -10, -5, -2, -2] + [0.5] * 35
        report = build_loss_distribution(pnl, confidence_level=0.90)
        self.assertEqual(report["empirical_var"], 2.0)
        self.assertEqual(report["tail_sample_count"], 4)
        self.assertEqual(report["empirical_cvar"], 9.25)

    def test_constant_loss_distribution_uses_one_bin(self):
        report = build_loss_distribution([-2.0] * 12)
        self.assertEqual(report["used_bins"], 1)
        self.assertEqual(report["histogram"][0]["count"], 12)
        self.assertEqual(report["histogram"][0]["loss"], 2.0)

    def test_invalid_samples_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "QUANTUM_RISK_SAMPLE_NOT_FINITE"):
            build_loss_distribution([1.0, float("nan")])

    def test_confidence_and_bin_limits_are_validated(self):
        with self.assertRaisesRegex(ValueError, "QUANTUM_RISK_CONFIDENCE_INVALID"):
            build_loss_distribution([1.0], confidence_level=1.0)
        with self.assertRaisesRegex(ValueError, "QUANTUM_RISK_BINS_OUT_OF_RANGE"):
            build_loss_distribution([1.0], bins=1)
        with self.assertRaisesRegex(ValueError, "QUANTUM_RISK_CONFIDENCE_INVALID"):
            build_loss_distribution([1.0], confidence_level="invalid")


if __name__ == "__main__":
    unittest.main()
