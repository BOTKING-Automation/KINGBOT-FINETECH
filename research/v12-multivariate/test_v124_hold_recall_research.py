import unittest

import numpy as np
import torch

from run_v124_hold_recall_research import (
    LOSS_PROFILES,
    _batch_loss,
    class_weight_vector,
    select_development_profile,
)


class V124HoldRecallResearchTests(unittest.TestCase):
    def test_all_class_weight_profiles_are_finite_positive_and_training_only(self):
        train_y = np.asarray([-1] * 80 + [0] * 20 + [1] * 60, dtype=np.int64)
        for profile in LOSS_PROFILES:
            weights = class_weight_vector(train_y, profile)
            self.assertEqual(weights.shape, (3,))
            self.assertTrue(np.isfinite(weights).all())
            self.assertTrue((weights > 0).all())
            self.assertAlmostEqual(float(weights.mean()), 1.0, places=5)

    def test_sqrt_inverse_weights_are_less_extreme_than_inverse_frequency(self):
        train_y = np.asarray([-1] * 100 + [0] * 10 + [1] * 50, dtype=np.int64)
        inverse = class_weight_vector(train_y, "inverse_frequency_ce")
        square_root = class_weight_vector(train_y, "sqrt_inverse_frequency_ce")
        inverse_ratio = float(inverse.max() / inverse.min())
        square_root_ratio = float(square_root.max() / square_root.min())
        self.assertLess(square_root_ratio, inverse_ratio)

    def test_effective_number_focal_loss_has_finite_gradients(self):
        logits = torch.tensor(
            [[2.0, 0.2, -0.5], [0.1, 1.4, 0.2], [-0.4, 0.1, 1.8]],
            dtype=torch.float32,
            requires_grad=True,
        )
        labels = torch.tensor([0, 1, 2], dtype=torch.long)
        weights = torch.tensor([0.8, 1.4, 0.8], dtype=torch.float32)
        loss = _batch_loss(
            logits, labels, weights, "effective_number_focal"
        )
        self.assertTrue(torch.isfinite(loss))
        loss.backward()
        self.assertIsNotNone(logits.grad)
        self.assertTrue(torch.isfinite(logits.grad).all())

    def test_invalid_class_weight_profile_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "V124_LOSS_PROFILE_INVALID"):
            class_weight_vector(np.asarray([-1, 0, 1]), "future_test_weighting")

    def test_no_final_profile_is_selected_when_development_gate_fails(self):
        development = {
            "profiles": {
                name: {
                    "passesDevelopmentGuard": False,
                    "model": {"selectionScore": 0.99},
                    "holdRecall": 0.99,
                }
                for name in LOSS_PROFILES
            }
        }
        self.assertIsNone(select_development_profile(development))

    def test_profile_selection_uses_development_score_and_hold_recall_tie_break(self):
        development = {
            "profiles": {
                "inverse_frequency_ce": {
                    "passesDevelopmentGuard": True,
                    "model": {"selectionScore": 0.35},
                    "holdRecall": 0.20,
                },
                "effective_number_ce": {
                    "passesDevelopmentGuard": True,
                    "model": {"selectionScore": 0.35},
                    "holdRecall": 0.27,
                },
                "sqrt_inverse_frequency_ce": {
                    "passesDevelopmentGuard": False,
                    "model": {"selectionScore": 0.99},
                    "holdRecall": 0.99,
                },
            }
        }
        self.assertEqual(
            select_development_profile(development), "effective_number_ce"
        )


if __name__ == "__main__":
    unittest.main()
