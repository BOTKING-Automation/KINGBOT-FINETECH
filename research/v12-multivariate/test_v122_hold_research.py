import unittest

import numpy as np
import torch

from run_v122_hold_research import (
    FOCAL_GAMMA,
    HOLD_WEIGHT_MULTIPLIER,
    LOSS_MODES,
    PILOT_CONTEXT_MODES,
    WeightedFocalLoss,
    _class_weights,
    _detailed_metrics,
    _objective_parameters,
    _select_development_objective,
)


class V122HoldObjectiveTests(unittest.TestCase):
    def test_loss_modes_are_fixed_and_explicit(self):
        self.assertEqual(len(LOSS_MODES), 4)
        self.assertEqual(_objective_parameters("inverse_frequency_cross_entropy"), (1.0, 0.0))
        self.assertEqual(_objective_parameters("hold_boost_cross_entropy"), (HOLD_WEIGHT_MULTIPLIER, 0.0))
        self.assertEqual(_objective_parameters("inverse_frequency_focal_gamma_1_5"), (1.0, FOCAL_GAMMA))
        self.assertEqual(_objective_parameters("hold_boost_focal_gamma_1_5"), (HOLD_WEIGHT_MULTIPLIER, FOCAL_GAMMA))

    def test_hold_boost_only_increases_normalized_hold_weight(self):
        labels = np.asarray([-1] * 90 + [0] * 20 + [1] * 70, dtype=np.int64)
        normal = _class_weights(labels, 1.0)
        boosted = _class_weights(labels, HOLD_WEIGHT_MULTIPLIER)
        self.assertGreater(boosted[1], normal[1])
        self.assertAlmostEqual(float(boosted.mean()), 1.0, places=6)
        self.assertAlmostEqual(float(normal.mean()), 1.0, places=6)

    def test_weighted_focal_loss_has_finite_gradient(self):
        weights = np.asarray([1.0, 1.25, 0.75], dtype=np.float32)
        loss_fn = WeightedFocalLoss(weights, gamma=FOCAL_GAMMA)
        logits = torch.tensor(
            [[2.0, 0.1, -0.5], [0.1, 1.7, -0.1], [-0.2, 0.3, 1.4]],
            dtype=torch.float32,
            requires_grad=True,
        )
        targets = torch.tensor([0, 1, 2], dtype=torch.long)
        loss = loss_fn(logits, targets)
        self.assertTrue(torch.isfinite(loss))
        loss.backward()
        self.assertIsNotNone(logits.grad)
        self.assertTrue(torch.isfinite(logits.grad).all())

    def test_metrics_include_hold_precision_recall_and_confusion(self):
        labels = np.asarray([-1, 0, 1, -1, 0, 1], dtype=np.int64)
        probabilities = np.asarray([
            [0.8, 0.1, 0.1],
            [0.1, 0.8, 0.1],
            [0.1, 0.1, 0.8],
            [0.6, 0.3, 0.1],
            [0.2, 0.7, 0.1],
            [0.1, 0.2, 0.7],
        ], dtype=np.float64)
        metrics = _detailed_metrics(labels, probabilities)
        self.assertGreater(metrics["classRecall"]["HOLD"], 0)
        self.assertIn("HOLD", metrics["classPrecision"])
        self.assertEqual(metrics["actualClassCounts"], {"SELL": 2, "HOLD": 2, "BUY": 2})
        self.assertEqual(len(metrics["confusionMatrixSellHoldBuy"]), 3)

    def test_v121_context_configuration_is_frozen_per_specialist(self):
        self.assertEqual(PILOT_CONTEXT_MODES["strategic"], "high_coverage")
        self.assertEqual(PILOT_CONTEXT_MODES["flipper"], "target_only")
        self.assertEqual(PILOT_CONTEXT_MODES["breakout"], "full_context")
        self.assertEqual(PILOT_CONTEXT_MODES["smc-pro"], "target_only")
        self.assertEqual(PILOT_CONTEXT_MODES["ladder-flip"], "target_only")

    def test_objective_selection_requires_original_development_quality_gate(self):
        rejected = {
            "objectives": {
                "hold_boost_cross_entropy": {
                    "passesDevelopmentGuard": False,
                    "model": {"selectionScore": 0.99},
                },
                "inverse_frequency_cross_entropy": {
                    "passesDevelopmentGuard": False,
                    "model": {"selectionScore": 0.98},
                },
            }
        }
        self.assertIsNone(_select_development_objective(rejected))
        eligible = {
            "objectives": {
                "hold_boost_cross_entropy": {
                    "passesDevelopmentGuard": True,
                    "model": {"selectionScore": 0.35},
                },
                "inverse_frequency_cross_entropy": {
                    "passesDevelopmentGuard": True,
                    "model": {"selectionScore": 0.36},
                },
            }
        }
        self.assertEqual(_select_development_objective(eligible), "inverse_frequency_cross_entropy")


if __name__ == "__main__":
    unittest.main()
