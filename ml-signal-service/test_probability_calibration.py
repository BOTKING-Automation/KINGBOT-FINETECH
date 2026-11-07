import unittest

import numpy as np

from probability_calibration import (
    TEMPERATURE_MAX,
    TEMPERATURE_MIN,
    apply_probability_temperature,
    fit_probability_temperature,
    probability_calibration_metrics,
)


class ProbabilityTemperatureCalibrationTests(unittest.TestCase):
    def test_temperature_one_preserves_normalized_probabilities(self):
        probabilities = np.asarray([[0.2, 0.3, 0.5], [0.6, 0.25, 0.15]], dtype=np.float32)
        calibrated = apply_probability_temperature(probabilities, 1.0)
        np.testing.assert_allclose(calibrated, probabilities, atol=1e-7)
        np.testing.assert_allclose(calibrated.sum(axis=1), 1.0, atol=1e-7)

    def test_temperature_scaling_preserves_argmax_and_probability_normalization(self):
        probabilities = np.asarray([[0.65, 0.25, 0.10], [0.15, 0.70, 0.15]], dtype=np.float32)
        calibrated = apply_probability_temperature(probabilities, 2.0)
        np.testing.assert_array_equal(np.argmax(calibrated, axis=1), np.argmax(probabilities, axis=1))
        np.testing.assert_allclose(calibrated.sum(axis=1), 1.0, atol=1e-6)
        self.assertTrue(np.all(calibrated >= 0.0))
        self.assertTrue(np.all(calibrated <= 1.0))

    def test_temperature_bounds_and_invalid_probabilities_fail_closed(self):
        probabilities = np.asarray([[0.2, 0.3, 0.5]], dtype=np.float32)
        for value in (0.0, TEMPERATURE_MIN - 0.01, TEMPERATURE_MAX + 0.01, float("nan")):
            with self.assertRaisesRegex(ValueError, "ML_PROBABILITY_TEMPERATURE_INVALID"):
                apply_probability_temperature(probabilities, value)
        with self.assertRaisesRegex(ValueError, "ML_CALIBRATION_PROBABILITIES_INVALID"):
            apply_probability_temperature(np.asarray([[0.2, -0.1, 0.9]]), 1.0)

    def test_fit_temperature_improves_overconfident_development_probabilities(self):
        labels = np.asarray([-1, 0, 1] * 40, dtype=np.int64)
        probabilities = np.tile(
            np.asarray([[0.55, 0.25, 0.20], [0.20, 0.55, 0.25], [0.25, 0.20, 0.55]]),
            (40, 1),
        )
        fit = fit_probability_temperature(labels, probabilities)
        self.assertTrue(fit["accepted"], fit)
        self.assertNotAlmostEqual(fit["temperature"], 1.0, places=2)
        before = probability_calibration_metrics(labels, probabilities)
        after = probability_calibration_metrics(
            labels, apply_probability_temperature(probabilities, fit["temperature"])
        )
        self.assertLess(after["negativeLogLikelihood"], before["negativeLogLikelihood"])
        self.assertLessEqual(after["brierScore"], before["brierScore"] + 0.005)

    def test_fit_requires_minimum_support_for_all_three_classes(self):
        labels = np.asarray([-1] * 30 + [0] * 20 + [1] * 3, dtype=np.int64)
        probabilities = np.tile(np.asarray([[0.6, 0.25, 0.15]]), (len(labels), 1))
        fit = fit_probability_temperature(labels, probabilities)
        self.assertFalse(fit["accepted"])
        self.assertEqual(fit["status"], "INSUFFICIENT_CLASS_COVERAGE")
        self.assertEqual(fit["temperature"], 1.0)

    def test_metrics_report_valid_multiclass_scores(self):
        labels = np.asarray([-1, 0, 1], dtype=np.int64)
        probabilities = np.asarray([[0.8, 0.1, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8]])
        metrics = probability_calibration_metrics(labels, probabilities)
        self.assertEqual(metrics["samples"], 3)
        self.assertGreaterEqual(metrics["negativeLogLikelihood"], 0.0)
        self.assertGreaterEqual(metrics["brierScore"], 0.0)
        self.assertGreaterEqual(metrics["expectedCalibrationError"], 0.0)


if __name__ == "__main__":
    unittest.main()
