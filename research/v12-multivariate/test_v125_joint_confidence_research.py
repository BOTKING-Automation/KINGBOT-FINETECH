import unittest

import numpy as np

from run_v125_joint_confidence_research import (
    JOINT_THRESHOLD_GRID,
    _joint_directional_confidence,
    _joint_gate_labels,
    _one_hot_probabilities,
    _select_joint_threshold,
)


class V125JointConfidenceTests(unittest.TestCase):
    def test_joint_confidence_is_zero_when_direction_is_uncertain(self):
        result = _joint_directional_confidence(
            np.asarray([0.99, 0.99, 0.50]),
            np.asarray([0.50, 0.90, 0.50]),
        )
        np.testing.assert_allclose(result, [0.0, 0.792, 0.0], atol=1e-8)

    def test_joint_gate_abstains_when_confidence_is_below_threshold(self):
        labels, active = _joint_gate_labels(
            np.asarray([0.99, 0.99, 0.40]),
            np.asarray([0.51, 0.90, 0.50]),
            0.50,
        )
        np.testing.assert_array_equal(active, [False, True, False])
        np.testing.assert_array_equal(labels, [0, 1, 0])

    def test_one_hot_output_preserves_sell_hold_buy_order(self):
        result = _one_hot_probabilities(np.asarray([-1, 0, 1]))
        np.testing.assert_array_equal(result, np.eye(3))

    def test_joint_threshold_is_selected_with_coverage_constraints(self):
        action = np.asarray([0.98] * 32 + [0.10] * 8, dtype=float)
        direction = np.asarray(
            [0.95, 0.94, 0.93, 0.92, 0.91, 0.90, 0.89, 0.88] +
            [0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12] +
            [0.53, 0.52, 0.51, 0.49, 0.48, 0.47, 0.54, 0.46,
             0.52, 0.48, 0.51, 0.49, 0.53, 0.47, 0.54, 0.46] +
            [0.50] * 8,
            dtype=float,
        )
        labels = np.asarray(
            [1] * 8 + [-1] * 8 + [0] * 24,
            dtype=np.int64,
        )
        threshold, details = _select_joint_threshold(
            action, direction, labels, min_coverage=0.10, max_coverage=0.80
        )
        self.assertIn(threshold, JOINT_THRESHOLD_GRID)
        self.assertGreaterEqual(details["calibrationTradeCoverage"], 0.10)
        self.assertLessEqual(details["calibrationTradeCoverage"], 0.80)
        self.assertTrue(details["thresholdSelectedOnCalibrationOnly"])

    def test_joint_threshold_abstains_all_when_no_eligible_directional_pattern(self):
        threshold, details = _select_joint_threshold(
            np.ones(30),
            np.full(30, 0.50),
            np.asarray([0] * 30, dtype=np.int64),
        )
        self.assertEqual(threshold, 1.01)
        self.assertEqual(details["objective"], "no_eligible_threshold_all_abstain")

    def test_invalid_probability_values_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "V125_CONFIDENCE_PROBABILITY_RANGE_INVALID"):
            _joint_directional_confidence(np.asarray([1.2]), np.asarray([0.7]))


if __name__ == "__main__":
    unittest.main()
