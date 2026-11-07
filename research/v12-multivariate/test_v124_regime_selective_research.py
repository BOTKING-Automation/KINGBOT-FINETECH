import unittest

import numpy as np
import torch

from run_v124_regime_selective_research import (
    REGIME_FEATURE_NAMES,
    RegimeSelectiveTransformer,
    _closed_asof_lookup,
    _gate_probabilities,
    _select_action_threshold,
    _select_development_variant,
    compute_market_regime_features,
)


def synthetic_bars(count=180, future_shift=0.0):
    rows = []
    price = 100.0
    for index in range(count):
        drift = 0.035 if index % 90 < 45 else -0.012
        price += drift + 0.08 * np.sin(index / 5.0)
        center = price + future_shift
        rows.append({
            "open": center - 0.04,
            "high": center + 0.14,
            "low": center - 0.13,
            "close": center + 0.03,
            "volume": 100.0,
        })
    return rows


class V124RegimeSelectiveTests(unittest.TestCase):
    def test_regime_features_are_finite_bounded_and_aligned(self):
        features, states = compute_market_regime_features(synthetic_bars())
        self.assertEqual(features.shape, (180, len(REGIME_FEATURE_NAMES)))
        self.assertEqual(states.shape, (180,))
        self.assertTrue(np.isfinite(features).all())
        self.assertTrue(np.all(features >= -1.0))
        self.assertTrue(np.all(features <= 1.0))
        self.assertTrue(set(np.unique(states)).issubset({0, 1, 2, 3, 4}))

    def test_regime_features_are_causal_under_future_append(self):
        prefix = synthetic_bars(140)
        extended = prefix + synthetic_bars(40, future_shift=50.0)
        first_features, first_states = compute_market_regime_features(prefix)
        extended_features, extended_states = compute_market_regime_features(extended)
        np.testing.assert_allclose(first_features, extended_features[:len(prefix)], atol=1e-7)
        np.testing.assert_array_equal(first_states, extended_states[:len(prefix)])

    def test_context_asof_never_uses_unclosed_candle(self):
        features = np.zeros((2, len(REGIME_FEATURE_NAMES)), dtype=np.float32)
        features[0, 0], features[1, 0] = 1.0, 2.0
        looked_up, present = _closed_asof_lookup(
            features, np.asarray([100.0, 200.0]), 60,
            np.asarray([159.0, 160.0, 259.0, 260.0]),
        )
        np.testing.assert_array_equal(present, [False, True, True, True])
        np.testing.assert_allclose(looked_up[:, 0], [0.0, 1.0, 1.0, 2.0])

    def test_actionability_threshold_uses_calibration_labels(self):
        threshold, metrics = _select_action_threshold(
            np.asarray([0.1, 0.2, 0.25, 0.15, 0.7, 0.8, 0.9, 0.75, 0.6, 0.85]),
            np.asarray([False, False, False, False, True, True, True, True, True, True]),
        )
        self.assertGreaterEqual(threshold, 0.30)
        self.assertLessEqual(threshold, 0.85)
        self.assertGreater(metrics["f1"], 0.8)

    def test_gated_probabilities_sum_to_one_and_abstain_to_hold(self):
        probabilities, action_probability, buy_probability = _gate_probabilities(
            np.asarray([-2.0, 2.0]), np.asarray([-1.0, 1.0]),
            1.0, 1.0, 0.5,
        )
        np.testing.assert_allclose(probabilities.sum(axis=1), [1.0, 1.0])
        np.testing.assert_allclose(probabilities[0], [0.0, 1.0, 0.0])
        self.assertGreater(action_probability[1], 0.5)
        self.assertGreater(buy_probability[1], 0.5)
        self.assertGreater(probabilities[1, 2], probabilities[1, 0])

    def test_development_selection_respects_quality_gate(self):
        development = {"variants": {
            "single_head_full_cortex": {
                "passesDevelopmentGuard": False, "model": {"selectionScore": 0.99},
            },
            "regime_selective_two_stage": {
                "passesDevelopmentGuard": True, "model": {"selectionScore": 0.37},
            },
        }}
        self.assertEqual(
            _select_development_variant(development), "regime_selective_two_stage"
        )
        self.assertIsNone(_select_development_variant({"variants": {
            "single_head_full_cortex": {
                "passesDevelopmentGuard": False, "model": {"selectionScore": 0.99},
            },
        }}))

    def test_selective_transformer_has_separate_heads(self):
        model = RegimeSelectiveTransformer(91, 46, 5, 32)
        target = torch.randn(2, 32, 91)
        context = torch.randn(2, 5, 46)
        missing = torch.zeros(2, 5, dtype=torch.bool)
        action_logits, direction_logits = model(target, context, missing)
        self.assertEqual(tuple(action_logits.shape), (2,))
        self.assertEqual(tuple(direction_logits.shape), (2,))
        self.assertTrue(torch.isfinite(action_logits).all())
        self.assertTrue(torch.isfinite(direction_logits).all())


if __name__ == "__main__":
    unittest.main()
