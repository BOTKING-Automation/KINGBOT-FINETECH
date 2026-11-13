import unittest
from research.quantum_lab.monte_carlo import run_classical_monte_carlo


class MonteCarloTests(unittest.TestCase):
    def test_reproducible_for_fixed_seed(self):
        data = [-1.0, -0.5, 0.2, 0.5, 1.0] * 10
        a = run_classical_monte_carlo(data, simulations=1000, horizon_trades=10, seed=7)
        b = run_classical_monte_carlo(data, simulations=1000, horizon_trades=10, seed=7)
        self.assertEqual(a, b)
        self.assertIn("probability_horizon_loss_exceeds_threshold", a)
        self.assertFalse(a["can_place_order"])

    def test_block_bootstrap_is_reported(self):
        data = [-1.0, 0.5, 0.7, -0.2, 1.0] * 5
        report = run_classical_monte_carlo(data, simulations=1000, horizon_trades=12, block_length=3)
        self.assertEqual(report["method"], "circular_moving_block_bootstrap")

    def test_invalid_simulation_count_rejected(self):
        with self.assertRaisesRegex(ValueError, "SIMULATION_COUNT"):
            run_classical_monte_carlo([1.0, -1.0], simulations=10)


if __name__ == "__main__":
    unittest.main()
