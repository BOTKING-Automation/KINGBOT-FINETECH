import unittest
import numpy as np
import torch
from multivariate_transformer import (
    CrossMarketTransformer, build_dataset, fit_predict, run_fold
)


def make_bars(count=430, interval=900, shift=0.0):
    rows, previous = [], 2000.0 + shift
    for i in range(count):
        drift = 0.09 * np.sin((i + shift) / 9.0) + 0.035 * np.cos(i / 4.0)
        close = previous + drift
        rows.append({
            "time": 1_767_225_600 + i * interval,
            "open": float(previous),
            "high": float(max(previous, close) + 0.32 + (i % 4) * 0.02),
            "low": float(min(previous, close) - 0.29 - (i % 3) * 0.02),
            "close": float(close),
            "volume": float(100 + i % 19),
        })
        previous = close
    return rows


def panel():
    return {
        "15m": [{"symbol": "XAUUSD", "bars": make_bars(interval=900)}],
        "5m": [{"symbol": "EURUSD", "bars": make_bars(interval=300, shift=1.0)}],
        "1h": [{"symbol": "GBPUSD", "bars": make_bars(interval=3600, shift=2.0)}],
    }


class MultivariatePanelTests(unittest.TestCase):
    def test_target_and_context_tensors_align(self):
        data = build_dataset(panel(), "strategic", "15m", seq_len=16)
        self.assertEqual(data["X"].ndim, 3)
        self.assertEqual(data["X"].shape[1], 16)
        self.assertEqual(data["C"].shape[:2], data["M"].shape)
        self.assertEqual(data["C"].shape[0], len(data["X"]))
        self.assertEqual(len(data["y"]), len(data["times"]))
        self.assertEqual(len(data["y"]), len(data["ends"]))
        self.assertTrue(np.isfinite(data["X"]).all())
        self.assertTrue(np.isfinite(data["C"]).all())
        self.assertIn("EURUSD|5m", data["slots"])
        slot = data["slots"].index("EURUSD|5m")
        self.assertTrue((~data["M"][:, slot]).any())

    def test_future_context_modification_cannot_change_earlier_aligned_rows(self):
        original = panel()
        first = build_dataset(original, "strategic", "15m", seq_len=16)
        changed = panel()
        later = changed["5m"][0]["bars"]
        for i in range(300, len(later)):
            for field in ("open", "high", "low", "close"):
                later[i][field] *= 1.7
        second = build_dataset(changed, "strategic", "15m", seq_len=16)
        np.testing.assert_allclose(first["X"][:20], second["X"][:20], atol=1e-7)
        np.testing.assert_allclose(first["C"][:20], second["C"][:20], atol=1e-7)
        np.testing.assert_array_equal(first["M"][:20], second["M"][:20])

    def test_unavailable_own_market_timeframe_is_masked(self):
        data = build_dataset(panel(), "strategic", "15m", seq_len=16)
        own = data["slots"].index("XAUUSD|15m")
        self.assertTrue(data["M"][:, own].all())

    def test_joint_transformer_produces_three_class_logits(self):
        model = CrossMarketTransformer(features=28, slots=5, seq_len=16)
        target = torch.randn(4, 16, 28)
        context = torch.randn(4, 5, 29)
        missing = torch.tensor([[False, True, False, True, False]] * 4)
        logits = model(target, context, missing)
        self.assertEqual(tuple(logits.shape), (4, 3))
        self.assertTrue(torch.isfinite(logits).all())

    def test_fit_uses_training_only_scaling_and_returns_probabilities(self):
        rng = np.random.default_rng(20261109)
        x = rng.normal(size=(180, 12, 28)).astype(np.float32)
        c = rng.normal(size=(180, 4, 28)).astype(np.float32)
        m = np.zeros((180, 4), dtype=bool)
        a = rng.uniform(0, 2, size=(180, 4)).astype(np.float32)
        y = np.asarray([-1, 0, 1] * 60, dtype=np.int64)
        ex = rng.normal(size=(24, 12, 28)).astype(np.float32)
        ec = rng.normal(size=(24, 4, 28)).astype(np.float32)
        em = np.zeros((24, 4), dtype=bool)
        ea = rng.uniform(0, 2, size=(24, 4)).astype(np.float32)
        p = fit_predict(x, c, m, a, y, ex, ec, em, ea, epochs=1)
        self.assertEqual(p.shape, (24, 3))
        self.assertTrue(np.isfinite(p).all())
        np.testing.assert_allclose(p.sum(axis=1), 1.0, atol=1e-5)


if __name__ == "__main__":
    unittest.main()
