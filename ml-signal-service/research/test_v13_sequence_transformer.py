import math
import unittest

import numpy as np
import torch

import v13_sequence_transformer as v13


def make_market(symbol="XAUUSD", count=280, start=1_790_000_000):
    bars = []
    previous = 2000.0
    for index in range(count):
        delta = (
            0.09 * math.sin(index / 5.0)
            + 0.045 * math.sin(index / 17.0)
            + 0.025 * math.cos(index / 2.7)
        )
        close = previous + delta
        spread = 0.28 + 0.04 * (index % 4)
        bars.append({
            "open": previous,
            "high": max(previous, close) + spread,
            "low": min(previous, close) - spread,
            "close": close,
            "volume": 100.0 + (index % 13) * 4.0,
            "time": start + index * 300,
        })
        previous = close
    return {"symbol": symbol, "bars": bars}


class V13SequenceResearchTests(unittest.TestCase):
    def test_transformer_consumes_multivariate_sequences_and_returns_three_logits(self):
        model = v13.MarketSequenceTransformer(input_size=28, sequence_length=16)
        result = model(torch.zeros((4, 16, 28), dtype=torch.float32))
        self.assertEqual(tuple(result.shape), (4, 3))
        self.assertTrue(torch.isfinite(result).all())

    def test_sequence_builder_uses_existing_strategy_features_and_timestamped_labels(self):
        part = v13.build_market_samples(make_market(), "smc-pro", sequence_length=16)
        self.assertEqual(part["X"].ndim, 3)
        self.assertEqual(part["X"].shape[1:], (16, 28))
        self.assertEqual(len(part["X"]), len(part["y"]))
        self.assertEqual(len(part["X"]), len(part["times"]))
        self.assertEqual(len(part["X"]), len(part["label_end_times"]))
        self.assertTrue(np.isfinite(part["X"]).all())
        self.assertTrue(np.all(part["label_end_times"] > part["times"]))
        self.assertTrue(set(np.unique(part["y"])).issubset({-1, 0, 1}))

    def test_future_candle_changes_do_not_change_sequence_at_an_earlier_close(self):
        market = make_market(count=280)
        target_index = 160
        original = v13.build_market_samples(market, "strategic", sequence_length=16)
        target_time = market["bars"][target_index]["time"]
        original_row = int(np.where(original["times"] == target_time)[0][0])

        changed = {
            "symbol": market["symbol"],
            "bars": [dict(bar) for bar in market["bars"]],
        }
        for index in range(target_index + 1, len(changed["bars"])):
            bar = changed["bars"][index]
            for key in ("open", "high", "low", "close"):
                bar[key] += 25.0
        modified = v13.build_market_samples(changed, "strategic", sequence_length=16)
        modified_row = int(np.where(modified["times"] == target_time)[0][0])
        np.testing.assert_allclose(
            original["X"][original_row],
            modified["X"][modified_row],
            atol=1e-7,
            rtol=1e-7,
        )

    def test_sequence_research_requires_real_candle_timestamps(self):
        market = make_market(count=220)
        for bar in market["bars"]:
            bar.pop("time")
        with self.assertRaisesRegex(ValueError, "V13_TIMESTAMPED_CLOSED_CANDLES_REQUIRED"):
            v13.build_market_samples(market, "breakout", sequence_length=16)

    def test_three_way_split_purges_labels_that_cross_boundaries(self):
        times = np.arange(1, 121, dtype=np.float64)
        ends = times + 6.0
        train, dev, final = v13.temporal_split_masks(
            times,
            ends,
            train_cutoff=61.0,
            final_cutoff=91.0,
            common_end=120.0,
        )
        self.assertFalse(np.any(train & dev))
        self.assertFalse(np.any(train & final))
        self.assertFalse(np.any(dev & final))
        self.assertTrue(np.all(ends[train] < 61.0))
        self.assertTrue(np.all(ends[dev] < 91.0))
        self.assertTrue(np.all(times[final] >= 91.0))

    def test_standardizer_is_fitted_only_on_training_sequences(self):
        train = np.zeros((5, 16, 28), dtype=np.float32)
        train[:, :, 0] = 2.0
        scaler = v13._fit_transformer_scaler(train)
        dev = np.full((2, 16, 28), 10000.0, dtype=np.float32)
        transformed = v13._transform_sequences(dev, scaler)
        self.assertEqual(float(scaler.mean_[0]), 2.0)
        self.assertGreater(float(transformed[0, 0, 0]), 1000.0)

    def test_temperature_is_fit_from_development_logits(self):
        logits = np.asarray([
            [4.0, 0.0, -1.0],
            [0.0, 4.0, -1.0],
            [-1.0, 0.0, 4.0],
        ] * 12, dtype=np.float64)
        labels = np.asarray([-1, 0, 1] * 12, dtype=np.int64)
        temperature, status = v13.fit_temperature(logits, labels)
        self.assertIn(status, {"FITTED_ON_DEVELOPMENT_ONLY"})
        self.assertGreaterEqual(temperature, 0.35)
        self.assertLessEqual(temperature, 4.0)

    def test_temperature_fitting_fails_closed_without_all_development_classes(self):
        logits = np.zeros((40, 3), dtype=np.float64)
        labels = np.zeros(40, dtype=np.int64)
        temperature, status = v13.fit_temperature(logits, labels)
        self.assertEqual(temperature, 1.0)
        self.assertEqual(status, "DEV_REQUIRES_ALL_THREE_CLASSES")

    def test_metrics_expose_class_recall_and_probabilistic_calibration(self):
        labels = np.asarray([-1, 0, 1] * 10, dtype=np.int64)
        probabilities = np.tile(
            np.asarray([[0.80, 0.10, 0.10],
                        [0.10, 0.80, 0.10],
                        [0.10, 0.10, 0.80]]),
            (10, 1),
        )
        metrics = v13.score_probabilities(labels, probabilities)
        self.assertEqual(metrics["samples"], 30)
        self.assertEqual(metrics["recall"], {"SELL": 1.0, "HOLD": 1.0, "BUY": 1.0})
        self.assertEqual(metrics["support"], {"SELL": 10, "HOLD": 10, "BUY": 10})
        self.assertLess(metrics["nll"], 0.25)
        self.assertIn("brierScore", metrics)
        self.assertIn("ece10", metrics)

    def test_all_five_specialist_models_are_targets(self):
        self.assertEqual(
            set(v13.STRATEGIES),
            {"strategic", "flipper", "breakout", "smc-pro", "ladder-flip"},
        )


if __name__ == "__main__":
    unittest.main()
