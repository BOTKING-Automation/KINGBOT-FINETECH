import unittest

import numpy as np
import torch

from temporal_challenger import (
    CausalTemporalBlock,
    TemporalConvClassifier,
    build_temporal_dataset,
    evaluate_probabilities,
    fit_predict_temporal,
    temporal_split_masks,
)

def make_bars(count=260):
    bars = []
    previous = 2000.0
    for index in range(count):
        drift = 0.08 * np.sin(index / 9.0) + 0.03 * np.cos(index / 4.0)
        close = previous + drift
        open_price = previous
        bars.append({
            "time": 1_767_225_600 + index * 300,
            "open": float(open_price),
            "high": float(max(open_price, close) + 0.30 + (index % 4) * 0.02),
            "low": float(min(open_price, close) - 0.28 - (index % 3) * 0.02),
            "close": float(close),
            "volume": float(100 + index % 17),
        })
        previous = close
    return bars


class TemporalSequenceConstructionTests(unittest.TestCase):
    def test_sequence_windows_align_to_terminal_bar_labels(self):
        bars = make_bars(300)
        dataset = build_temporal_dataset(
            [{"symbol": "XAUUSD", "bars": bars}],
            "strategic",
            sequence_length=12,
        )
        self.assertEqual(dataset["X"].ndim, 3)
        self.assertEqual(dataset["X"].shape[1], 12)
        self.assertEqual(dataset["X"].shape[2], len(__import__("service").FEATURE_NAMES))
        self.assertEqual(len(dataset["X"]), len(dataset["y"]))
        self.assertEqual(len(dataset["X"]), len(dataset["sampleTimes"]))
        self.assertEqual(len(dataset["X"]), len(dataset["labelEndTimes"]))
        self.assertTrue(np.isfinite(dataset["X"]).all())

    def test_sequence_features_are_causal_to_the_terminal_observation(self):
        bars = make_bars(300)
        first = build_temporal_dataset(
            [{"symbol": "XAUUSD", "bars": bars}],
            "strategic",
            sequence_length=12,
        )
        changed_future = [dict(row) for row in bars]
        for index in range(120, len(changed_future)):
            changed_future[index]["open"] *= 1.5
            changed_future[index]["high"] *= 1.5
            changed_future[index]["low"] *= 1.5
            changed_future[index]["close"] *= 1.5
            changed_future[index]["volume"] *= 4.0
        second = build_temporal_dataset(
            [{"symbol": "XAUUSD", "bars": changed_future}],
            "strategic",
            sequence_length=12,
        )
        np.testing.assert_allclose(first["X"][:20], second["X"][:20], atol=1e-7)
        np.testing.assert_array_equal(first["sampleTimes"][:20], second["sampleTimes"][:20])

    def test_temporal_split_purges_forward_labels_and_keeps_windows_disjoint(self):
        markets = [
            {"symbol": f"FX{i}", "bars": make_bars(420)}
            for i in range(3)
        ]
        dataset = build_temporal_dataset(markets, "strategic", sequence_length=12)
        train, test, cutoff = temporal_split_masks(dataset, 0.70, 0.85)
        self.assertFalse(np.any(train & test))
        self.assertTrue(np.all(dataset["sampleTimes"][train] < cutoff))
        self.assertTrue(np.all(dataset["labelEndTimes"][train] < cutoff))
        self.assertTrue(np.all(dataset["sampleTimes"][test] >= cutoff))
        self.assertTrue(np.all(dataset["labelEndTimes"][test] < np.inf))

    def test_timestamped_candles_are_required_for_global_split(self):
        bars = make_bars(300)
        for row in bars:
            row.pop("time")
        with self.assertRaisesRegex(ValueError, "V10_TEMPORAL_NO_MARKETS_WITH_SEQUENCE_HISTORY"):
            build_temporal_dataset(
                [{"symbol": "XAUUSD", "bars": bars}],
                "strategic",
                sequence_length=12,
            )


class TemporalConvClassifierTests(unittest.TestCase):
    def test_tcn_forward_returns_three_class_logits(self):
        model = TemporalConvClassifier(input_features=28)
        sequences = torch.randn(4, 32, 28)
        logits = model(sequences)
        self.assertEqual(tuple(logits.shape), (4, 3))
        self.assertTrue(torch.isfinite(logits).all())

    def test_causal_block_output_has_same_time_dimension(self):
        block = CausalTemporalBlock(8, 16, dilation=4, dropout=0.0)
        values = torch.randn(3, 8, 32)
        output = block(values)
        self.assertEqual(tuple(output.shape), (3, 16, 32))

    def test_fit_predict_temporal_produces_normalized_probabilities(self):
        rng = np.random.default_rng(20261107)
        train = rng.normal(size=(180, 12, 28)).astype(np.float32)
        labels = np.asarray([-1, 0, 1] * 60, dtype=np.int64)
        test = rng.normal(size=(24, 12, 28)).astype(np.float32)
        probabilities = fit_predict_temporal(train, labels, test, epochs=2, batch_size=32)
        self.assertEqual(probabilities.shape, (24, 3))
        self.assertTrue(np.isfinite(probabilities).all())
        np.testing.assert_allclose(probabilities.sum(axis=1), 1.0, atol=1e-5)

    def test_metrics_apply_unchanged_quality_thresholds_and_class_recall(self):
        labels = np.asarray([-1, 0, 1] * 20, dtype=np.int64)
        probabilities = np.tile(
            np.asarray([[0.85, 0.10, 0.05], [0.05, 0.90, 0.05], [0.05, 0.10, 0.85]]),
            (20, 1),
        )
        metrics = evaluate_probabilities(labels, probabilities)
        self.assertTrue(metrics["metricGate"])
        self.assertTrue(metrics["classCoverageGate"])
        self.assertTrue(metrics["qualityGate"])


if __name__ == "__main__":
    unittest.main()
