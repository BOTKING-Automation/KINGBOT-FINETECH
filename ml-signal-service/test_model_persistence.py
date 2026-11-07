import unittest

import numpy as np
import torch
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler

import service


class ModelArtifactRoundTripTests(unittest.TestCase):
    def test_npz_round_trip_preserves_ensemble_probabilities(self):
        rng = np.random.default_rng(20261106)
        X = rng.normal(size=(240, len(service.FEATURE_NAMES))).astype(np.float32)
        signal = X[:, 0] * 0.9 + X[:, 1] * 0.7 - X[:, 2] * 0.4
        y = np.where(signal > 0.35, 1, np.where(signal < -0.35, -1, 0)).astype(np.int64)

        scaler = StandardScaler().fit(X)
        X_scaled = scaler.transform(X).astype(np.float32)
        rf = RandomForestClassifier(
            n_estimators=12,
            max_depth=5,
            min_samples_leaf=2,
            random_state=42,
            class_weight="balanced_subsample",
            n_jobs=1,
        ).fit(X_scaled, y)

        torch.manual_seed(42)
        torch_model = service.MLP(len(service.FEATURE_NAMES), 3)
        torch_model.eval()

        record = {
            "rf": rf,
            "torch": torch_model,
            "scaler": scaler,
            "trained_at": 1770000000.0,
            "strategy": "strategic",
            "timeframe": "4h",
            "samples": int(len(X)),
            "quality_gate": True,
            "probability_temperature": 1.35,
            "selection_score": 0.51,
            "validation": {"type": "test", "balancedAccuracy": 0.5},
        }

        artifact = service.serialize_model_record(record)
        restored = service.deserialize_model_record(artifact)
        X_sample = X[:24]
        before_scaled = scaler.transform(X_sample).astype(np.float32)
        after_scaled = restored["scaler"].transform(X_sample).astype(np.float32)

        before = service.ensemble_probabilities(rf, torch_model, before_scaled)
        after = service.ensemble_probabilities(restored["rf"], restored["torch"], after_scaled)

        self.assertEqual(restored["strategy"], "strategic")
        self.assertEqual(restored["timeframe"], "4h")
        self.assertEqual(restored["samples"], len(X))
        self.assertAlmostEqual(restored["probability_temperature"], 1.35)
        self.assertTrue(np.allclose(before, after, atol=1e-6, rtol=1e-6))


if __name__ == "__main__":
    unittest.main()
