import unittest
import numpy as np
import torch
from ssl_market_encoder import MaskedMarketEncoder, build_dataset, pretrain_and_finetune, split_masks


def make_bars(count=340):
    rows, previous = [], 2000.0
    for i in range(count):
        drift = 0.11 * np.sin(i / 8.0) + 0.025 * np.cos(i / 3.0)
        close = previous + drift
        rows.append({"time": 1_767_225_600 + i * 300, "open": float(previous),
            "high": float(max(previous, close) + 0.32 + (i % 4) * 0.02),
            "low": float(min(previous, close) - 0.29 - (i % 3) * 0.02),
            "close": float(close), "volume": float(100 + i % 19)})
        previous = close
    return rows


class SSLMarketEncoderTests(unittest.TestCase):
    def test_encoder_reconstructs_masked_time_steps(self):
        model = MaskedMarketEncoder(28, 32)
        x, mask = torch.randn(4, 32, 28), torch.zeros(4, 32, dtype=torch.bool)
        mask[:, 5] = True
        output = model.reconstruct(x, mask)
        self.assertEqual(tuple(output.shape), (4, 32, 28))
        self.assertTrue(torch.isfinite(output).all())

    def test_classifier_returns_three_class_logits(self):
        model = MaskedMarketEncoder(28, 32)
        output = model(torch.randn(3, 32, 28))
        self.assertEqual(tuple(output.shape), (3, 3))
        self.assertTrue(torch.isfinite(output).all())

    def test_market_sequences_keep_timestamp_and_label_alignment(self):
        data = build_dataset([{"symbol": "XAUUSD", "bars": make_bars()}], "strategic", 16)
        self.assertEqual(data["X"].shape[1], 16)
        self.assertEqual(len(data["X"]), len(data["y"]))
        self.assertEqual(len(data["y"]), len(data["sampleTimes"]))
        self.assertEqual(len(data["y"]), len(data["labelEndTimes"]))
        self.assertTrue(np.isfinite(data["X"]).all())

    def test_global_split_purges_training_labels(self):
        data = build_dataset([{"symbol": f"FX{i}", "bars": make_bars(420)} for i in range(3)], "strategic", 16)
        train, test, cutoff = split_masks(data, 0.70, 0.85)
        self.assertFalse(np.any(train & test))
        self.assertTrue(np.all(data["sampleTimes"][train] < cutoff))
        self.assertTrue(np.all(data["labelEndTimes"][train] < cutoff))
        self.assertTrue(np.all(data["sampleTimes"][test] >= cutoff))

    def test_masked_pretraining_and_finetuning_return_probabilities(self):
        rng = np.random.default_rng(20261108)
        X = rng.normal(size=(180, 12, 28)).astype(np.float32)
        y = np.asarray([-1, 0, 1] * 60, dtype=np.int64)
        E = rng.normal(size=(24, 12, 28)).astype(np.float32)
        p = pretrain_and_finetune(X, y, E, pretrain_epochs=1, finetune_epochs=1)
        self.assertEqual(p.shape, (24, 3))
        self.assertTrue(np.isfinite(p).all())
        np.testing.assert_allclose(p.sum(axis=1), 1.0, atol=1e-5)


if __name__ == "__main__":
    unittest.main()
