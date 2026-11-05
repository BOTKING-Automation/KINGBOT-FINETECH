import unittest

import numpy as np

from temporal_model import (
    SEQUENCE_FEATURE_NAMES,
    SEQUENCE_LENGTH,
    bars_to_sequence_arrays,
    predict_temporal_probabilities,
    train_temporal_model,
)


def make_bars(count=180):
    rows = []
    previous = 100.0
    for index in range(count):
        close = 100.0 + np.sin(index / 7.0) * 2.2 + np.sin(index / 19.0) * 1.3 + np.sin(index / 3.0) * 0.3
        high = max(previous, close) + 0.4 + (index % 4) * 0.03
        low = min(previous, close) - 0.4 - (index % 3) * 0.02
        rows.append({
            "open": previous,
            "high": high,
            "low": low,
            "close": close,
            "volume": 100 + (index % 13) * 4,
        })
        previous = close
    return rows


class TemporalModelTests(unittest.TestCase):
    def test_sequence_dataset_has_expected_shape_and_three_class_labels(self):
        x, y = bars_to_sequence_arrays(make_bars(220), sequence_length=SEQUENCE_LENGTH)
        self.assertEqual(x.ndim, 3)
        self.assertEqual(x.shape[1], SEQUENCE_LENGTH)
        self.assertEqual(x.shape[2], len(SEQUENCE_FEATURE_NAMES))
        self.assertEqual(len(x), len(y))
        self.assertGreater(len(x), 100)
        self.assertTrue(set(np.unique(y)).issubset({-1, 0, 1}))

    def test_sequence_features_are_causal(self):
        original = make_bars(180)
        changed_future = [dict(row) for row in original]
        for row in changed_future[100:]:
            row["close"] *= 1.25
            row["high"] *= 1.25
            row["low"] *= 1.25

        x1, _ = bars_to_sequence_arrays(original)
        x2, _ = bars_to_sequence_arrays(changed_future)
        # Earlier windows cannot change when only later candles are modified.
        np.testing.assert_allclose(x1[:40], x2[:40], rtol=0, atol=1e-6)

    def test_temporal_gru_trains_and_returns_probabilities(self):
        rng = np.random.default_rng(73)
        x_train = rng.normal(size=(120, SEQUENCE_LENGTH, len(SEQUENCE_FEATURE_NAMES))).astype(np.float32)
        y_train = np.tile(np.array([-1, 0, 1], dtype=np.int64), 40)
        x_test = rng.normal(size=(36, SEQUENCE_LENGTH, len(SEQUENCE_FEATURE_NAMES))).astype(np.float32)
        y_test = np.tile(np.array([-1, 0, 1], dtype=np.int64), 12)

        model, scaler, metrics = train_temporal_model(x_train, y_train, x_test, y_test, epochs=8)
        self.assertIn("balancedAccuracy", metrics)
        self.assertIn("macroF1", metrics)
        probabilities = predict_temporal_probabilities(model, scaler, make_bars(100))
        self.assertIsNotNone(probabilities)
        self.assertEqual(probabilities.shape, (3,))
        self.assertAlmostEqual(float(probabilities.sum()), 1.0, places=5)


if __name__ == "__main__":
    unittest.main()
