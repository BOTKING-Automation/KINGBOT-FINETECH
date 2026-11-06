import math
import unittest

import numpy as np
import torch
from torch import nn

import service


def make_bars(count=180):
    bars = []
    previous = 2000.0
    for index in range(count):
        close = previous + 0.12 + math.sin(index / 6.0) * 0.18
        open_price = previous
        bars.append({
            "open": open_price,
            "high": max(open_price, close) + 0.25,
            "low": min(open_price, close) - 0.25,
            "close": close,
            "volume": 100.0,
        })
        previous = close
    bars[-1]["volume"] = 200.0
    return bars


class DummyRandomForest:
    classes_ = np.asarray([-1, 0, 1])

    def predict_proba(self, features):
        return np.tile(np.asarray([[0.20, 0.30, 0.50]], dtype=np.float32), (len(features), 1))


class UniformTorchModel(nn.Module):
    def forward(self, features):
        return torch.zeros((features.shape[0], 3), dtype=torch.float32)


class EngineFeatureParityTests(unittest.TestCase):
    def test_feature_schema_has_identical_training_and_inference_width(self):
        bars = make_bars()
        training = service.extract_features_from_bars(bars, len(bars) - 1)
        live = service.current_market_features({
            "symbol": "XAUUSD",
            "mlBars": bars,
            "price": bars[-1]["close"],
            "atr": 0.5,
            "trend": 0.7,
            "momentum": 0.5,
        }, "strategic")[0]
        self.assertIsNotNone(training)
        self.assertEqual(len(training), len(service.FEATURE_NAMES))
        self.assertEqual(live.shape[0], len(service.FEATURE_NAMES))
        np.testing.assert_allclose(
            live,
            service.apply_strategy_focus(training, "strategic"),
            atol=1e-7,
            rtol=1e-7,
        )

    def test_spread_is_not_a_live_only_model_feature(self):
        market = {
            "mlBars": make_bars(),
            "price": 100.0, "atr": 1.0, "emaFast": 101.0, "emaSlow": 99.0,
            "rsi": 56, "adx": 24, "trend": 0.5, "momentum": 0.4,
            "volatility": 0.4, "structure": "bullish",
            "spread": 0.5, "spreadAtr": 0.5, "velocityAtr": 0.4,
            "volume": 0.6,
        }
        row = service.current_market_features(market, "flipper")[0]
        self.assertEqual(float(row[service.FEATURE_NAMES.index("spread_atr")]), 0.0)

    def test_live_velocity_is_identical_to_the_training_ohlc_extractor(self):
        bars = make_bars()
        market = {
            "mlBars": bars,
            # These scanner summaries must not override or alter OHLC-derived features.
            "velocityAtr": -1.7,
            "velocityPoints": 800.0,
            "trend": -0.9,
            "momentum": -0.8,
        }
        row = service.current_market_features(market, "flipper")[0]
        training = service.extract_features_from_bars(bars, len(bars) - 1)
        expected = service.apply_strategy_focus(training, "flipper")
        np.testing.assert_allclose(row, expected, atol=1e-7, rtol=1e-7)

    def test_nested_execution_bars_support_persisted_trade_feedback(self):
        bars = make_bars()
        market = {"multiTimeframe": {"execution": {"mlBars": bars}}}
        top_level = service.current_market_features({"mlBars": bars}, "smc-pro")
        nested = service.current_market_features(market, "smc-pro")
        np.testing.assert_allclose(top_level, nested, atol=1e-7, rtol=1e-7)

    def test_normalize_market_bars_sorts_descending_timestamped_history(self):
        bars = make_bars(80)
        for index, bar in enumerate(bars):
            bar["time"] = f"2026-01-01T00:{index:02d}:00Z"
        normalized = service.normalize_market_bars(list(reversed(bars)))
        self.assertEqual(len(normalized), 80)
        self.assertAlmostEqual(normalized[0]["close"], bars[0]["close"])
        self.assertAlmostEqual(normalized[-1]["close"], bars[-1]["close"])

    def test_normalize_market_bars_deduplicates_timestamp_using_last_source_row(self):
        bars = make_bars(70)
        for index, bar in enumerate(bars):
            bar["timestamp"] = 1_700_000_000 + index * 60
        duplicate = dict(bars[35])
        duplicate["close"] += 0.25
        duplicate["high"] = max(duplicate["high"], duplicate["close"])
        bars.insert(36, duplicate)
        normalized = service.normalize_market_bars(bars)
        self.assertEqual(len(normalized), 70)
        self.assertAlmostEqual(normalized[35]["close"], duplicate["close"])

    def test_normalize_market_bars_accepts_epoch_milliseconds(self):
        bars = make_bars(60)
        for index, bar in enumerate(bars):
            bar["time"] = (1_700_000_000 + index * 60) * 1000
        normalized = service.normalize_market_bars(list(reversed(bars)))
        self.assertAlmostEqual(normalized[0]["close"], bars[0]["close"])
        self.assertAlmostEqual(normalized[-1]["close"], bars[-1]["close"])

    def test_normalize_market_bars_fails_closed_on_partial_timestamps(self):
        bars = make_bars(60)
        bars[0]["time"] = "2026-01-01T00:00:00Z"
        with self.assertRaisesRegex(ValueError, "ML_MARKET_BAR_TIMESTAMPS_INCONSISTENT"):
            service.normalize_market_bars(bars)

    def test_normalize_market_bars_fails_closed_on_invalid_timestamp(self):
        bars = make_bars(60)
        for bar in bars:
            bar["time"] = "not-a-timestamp"
        with self.assertRaisesRegex(ValueError, "ML_MARKET_BAR_TIMESTAMP_INVALID"):
            service.normalize_market_bars(bars)

    def test_normalize_market_bars_preserves_order_when_provider_has_no_timestamps(self):
        bars = make_bars(60)
        normalized = service.normalize_market_bars(bars)
        self.assertAlmostEqual(normalized[0]["close"], bars[0]["close"])
        self.assertAlmostEqual(normalized[-1]["close"], bars[-1]["close"])

    def test_prediction_fails_closed_without_raw_ohlc_history(self):
        with self.assertRaisesRegex(ValueError, "ML_PREDICT_OHLC_FEATURES_REQUIRED"):
            service.current_market_features({
                "price": 100.0,
                "atr": 1.0,
                "emaFast": 101.0,
                "emaSlow": 99.0,
                "rsi": 56,
                "adx": 24,
                "trend": 0.5,
                "momentum": 0.4,
            }, "strategic")

    def test_feature_extractor_is_causal_at_requested_bar(self):
        bars = make_bars(180)
        index = 120
        baseline = service.extract_features_from_bars(bars, index)
        changed_future = [dict(row) for row in bars]
        for future_index in range(index + 1, len(changed_future)):
            changed_future[future_index]["open"] *= 1.8
            changed_future[future_index]["high"] *= 1.8
            changed_future[future_index]["low"] *= 1.8
            changed_future[future_index]["close"] *= 1.8
            changed_future[future_index]["volume"] *= 10.0
        after_future_change = service.extract_features_from_bars(changed_future, index)
        np.testing.assert_allclose(baseline, after_future_change, atol=1e-7, rtol=1e-7)

    def test_training_extracts_relative_volume_and_order_block_features(self):
        bars = make_bars()
        features = service.extract_features_from_bars(bars, len(bars) - 1)
        self.assertAlmostEqual(
            float(features[service.FEATURE_NAMES.index("relative_volume")]),
            1.0,
            places=6,
        )
        order_block_bars = [
            {"open": 101.0, "high": 102.0, "low": 100.0, "close": 101.0, "volume": 100.0},
            {"open": 100.0, "high": 101.0, "low": 98.5, "close": 99.0, "volume": 100.0},
            {"open": 99.0, "high": 104.0, "low": 98.8, "close": 103.5, "volume": 120.0},
        ]
        self.assertEqual(service.detect_order_block_feature(order_block_bars, 2.0), 1.0)

    def test_walk_forward_split_has_forward_label_embargo(self):
        train_end, test_start = service.temporal_split_bounds(200)
        self.assertEqual(test_start - train_end, service.FORWARD_HORIZON)
        self.assertLess(train_end, test_start)
        self.assertGreaterEqual(train_end, 40)

    def test_validation_measures_the_live_probability_blend(self):
        features = np.zeros((2, len(service.FEATURE_NAMES)), dtype=np.float32)
        probabilities = service.ensemble_probabilities(
            DummyRandomForest(),
            UniformTorchModel(),
            features,
        )
        self.assertEqual(probabilities.shape, (2, 3))
        self.assertTrue(np.allclose(probabilities.sum(axis=1), 1.0))
        expected = np.asarray([
            0.20 * service.RF_ENSEMBLE_WEIGHT + (1.0 / 3.0) * service.TORCH_ENSEMBLE_WEIGHT,
            0.30 * service.RF_ENSEMBLE_WEIGHT + (1.0 / 3.0) * service.TORCH_ENSEMBLE_WEIGHT,
            0.50 * service.RF_ENSEMBLE_WEIGHT + (1.0 / 3.0) * service.TORCH_ENSEMBLE_WEIGHT,
        ])
        self.assertTrue(np.allclose(probabilities[0], expected, atol=1e-6))


if __name__ == "__main__":
    unittest.main()
