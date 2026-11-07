import unittest

import numpy as np

from technical_pattern_features import (
    CANDLE_FEATURE_NAMES,
    CHART_PATTERN_FEATURE_NAMES,
    FEATURE_NAMES,
    SMC_FEATURE_NAMES,
    compute_pattern_feature_matrix,
    select_feature_columns,
    asof_pattern_lookup,
)


def make_bars(length=180, seed=19):
    rng = np.random.default_rng(seed)
    close = 100.0 + np.cumsum(rng.normal(0.0, 0.35, length))
    open_ = np.concatenate(([close[0]], close[:-1]))
    high = np.maximum(open_, close) + rng.uniform(0.03, 0.22, length)
    low = np.minimum(open_, close) - rng.uniform(0.03, 0.22, length)
    return [
        {"open": float(open_[i]), "high": float(high[i]),
         "low": float(low[i]), "close": float(close[i])}
        for i in range(length)
    ]


class V123TechnicalPatternTests(unittest.TestCase):
    def test_feature_groups_are_unique_and_expected_width(self):
        self.assertEqual(len(FEATURE_NAMES), len(SMC_FEATURE_NAMES) + len(CANDLE_FEATURE_NAMES) + len(CHART_PATTERN_FEATURE_NAMES))
        self.assertEqual(len(set(FEATURE_NAMES)), len(FEATURE_NAMES))
        self.assertGreaterEqual(len(SMC_FEATURE_NAMES), 12)
        self.assertGreaterEqual(len(CANDLE_FEATURE_NAMES), 8)
        self.assertGreaterEqual(len(CHART_PATTERN_FEATURE_NAMES), 12)

    def test_feature_matrix_is_finite_and_one_row_per_candle(self):
        bars = make_bars()
        matrix = compute_pattern_feature_matrix(bars)
        self.assertEqual(matrix.shape, (len(bars), len(FEATURE_NAMES)))
        self.assertTrue(np.isfinite(matrix).all())
        self.assertLessEqual(float(np.max(matrix)), 1.0)
        self.assertGreaterEqual(float(np.min(matrix)), -1.0)

    def test_future_candles_cannot_change_past_features(self):
        bars = make_bars(180)
        baseline = compute_pattern_feature_matrix(bars)
        altered = [dict(bar) for bar in bars]
        for i in range(130, len(altered)):
            altered[i]["open"] *= 1.7
            altered[i]["high"] *= 1.7
            altered[i]["low"] *= 1.7
            altered[i]["close"] *= 1.7
        revised = compute_pattern_feature_matrix(altered)
        np.testing.assert_allclose(baseline[:130], revised[:130], rtol=0.0, atol=0.0)

    def test_swing_pivot_is_not_backfilled_before_confirmation(self):
        closes = [10, 11, 12, 15, 12, 11, 10, 11, 12, 11, 10, 9]
        bars = [
            {"open": value - 0.1, "high": value + 0.2,
             "low": value - 0.3, "close": value}
            for value in closes
        ]
        matrix = compute_pattern_feature_matrix(bars)
        swing_col = FEATURE_NAMES.index("swing_high_confirmed")
        self.assertEqual(float(matrix[3, swing_col]), 0.0)
        self.assertEqual(float(matrix[5, swing_col]), 1.0)

    def test_feature_variants_keep_base_rows_and_select_group_width(self):
        base = np.zeros((4, 32, 28), dtype=np.float32)
        patterns = np.ones((4, 32, len(FEATURE_NAMES)), dtype=np.float32)
        self.assertEqual(select_feature_columns(base, patterns, "baseline").shape, (4, 32, 28))
        self.assertEqual(select_feature_columns(base, patterns, "smc_only").shape, (4, 32, 28 + len(SMC_FEATURE_NAMES)))
        self.assertEqual(select_feature_columns(base, patterns, "technical_patterns_only").shape, (4, 32, 28 + len(CANDLE_FEATURE_NAMES) + len(CHART_PATTERN_FEATURE_NAMES)))
        self.assertEqual(select_feature_columns(base, patterns, "full_cortex").shape, (4, 32, 28 + len(FEATURE_NAMES)))

    def test_asof_context_uses_only_closed_feature_bars(self):
        patterns = np.zeros((3, len(FEATURE_NAMES)), dtype=np.float32)
        patterns[:, 0] = [0.1, 0.2, 0.3]
        opens = np.asarray([0.0, 60.0, 120.0])
        decisions = np.asarray([59.0, 60.0, 119.0, 120.0, 180.0])
        values, present = asof_pattern_lookup(patterns, opens, 60, decisions)
        np.testing.assert_array_equal(present, [False, True, True, True, True])
        np.testing.assert_allclose(values[:, 0], [0.0, 0.1, 0.1, 0.2, 0.3])

    def test_asof_context_rejects_unsorted_source_timestamps(self):
        patterns = np.zeros((2, len(FEATURE_NAMES)), dtype=np.float32)
        with self.assertRaises(ValueError):
            asof_pattern_lookup(
                patterns, np.asarray([60.0, 0.0]), 60, np.asarray([120.0])
            )

    def test_invalid_ohlc_is_rejected(self):
        with self.assertRaises(ValueError):
            compute_pattern_feature_matrix([{"open": 10, "high": 9, "low": 8, "close": 10}])


if __name__ == "__main__":
    unittest.main()
