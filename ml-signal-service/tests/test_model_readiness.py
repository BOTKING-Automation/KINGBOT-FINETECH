import sys
import tempfile
import time
import unittest
from pathlib import Path

import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import service


class ModelReadinessTests(unittest.TestCase):
    def setUp(self):
        self.secret = service.SECRET
        self.store = service.MODEL_STORE_DIR
        self.models = dict(service.MODELS)
        self.feedback = list(service.FEEDBACK_ROWS)
        self.status = dict(service.MODEL_STORE_STATUS)
        service.MODELS.clear()
        service.FEEDBACK_ROWS.clear()
        service.SECRET = "unit-test-secret-with-sufficient-entropy"
        service.MODEL_STORE_DIR = ""
        service.MODEL_STORE_STATUS.update({
            "restoredModels": 0, "rejectedModels": 0,
            "lastSavedAt": None, "lastFeedbackSavedAt": None, "lastError": None,
        })

    def tearDown(self):
        service.SECRET = self.secret
        service.MODEL_STORE_DIR = self.store
        service.MODELS.clear()
        service.MODELS.update(self.models)
        service.FEEDBACK_ROWS.clear()
        service.FEEDBACK_ROWS.extend(self.feedback)
        service.MODEL_STORE_STATUS.update(self.status)

    def _record(self):
        x = np.arange(3 * len(service.FEATURE_NAMES), dtype=np.float32).reshape(3, len(service.FEATURE_NAMES))
        y = np.asarray([-1, 0, 1])
        scaler = StandardScaler().fit(x)
        rf = RandomForestClassifier(n_estimators=4, random_state=7).fit(scaler.transform(x), y)
        now = time.time()
        return {
            "rf": rf, "torch": service.MLP(len(service.FEATURE_NAMES), 3), "scaler": scaler,
            "trained_at": now, "strategy": "strategic", "symbols": ["XAUUSD"], "timeframe": "5m",
            "samples": 100, "train_samples": 78, "test_samples": 22,
            "rf_accuracy": 0.6, "rf_balanced_accuracy": 0.6, "rf_macro_f1": 0.6,
            "torch_accuracy": 0.6, "torch_balanced_accuracy": 0.6, "torch_macro_f1": 0.6,
            "ensemble_accuracy": 0.6, "ensemble_balanced_accuracy": 0.6, "ensemble_macro_f1": 0.6,
            "quality_gate": True, "bar_count": 100, "feature_version": service.FEATURE_VERSION,
            "validation": {"type": "per-market-temporal-holdout", "trainFraction": 0.78},
            "selection_score": 0.6, "promotion": "CHAMPION", "promoted_at": now,
            "feedbackVersion": service.FEEDBACK_VERSION, "feedbackRowsUsed": 0,
            "profitability_validated": False,
        }

    def test_health_requires_recent_quality_gated_model(self):
        result = service.health_status()
        self.assertTrue(result["ok"])
        self.assertTrue(result["configured"])
        self.assertFalse(result["ready"])
        self.assertEqual(result["readinessReason"], "NO_FRESH_QUALITY_GATED_MODEL")
        self.assertFalse(result["validation"]["profitabilityValidated"])
        self.assertEqual(result["validation"]["costAwareBacktest"], "NOT_ESTABLISHED")

    def test_stale_models_do_not_make_service_ready(self):
        service.MODELS["strategic:5m"] = {
            "quality_gate": True, "trained_at": time.time() - service.MAX_MODEL_AGE_SECONDS - 10
        }
        result = service.health_status()
        self.assertFalse(result["ready"])
        self.assertEqual(result["modelsStaleOrBlocked"], 1)

    def test_signed_checkpoint_round_trips_model(self):
        with tempfile.TemporaryDirectory() as directory:
            service.MODEL_STORE_DIR = directory
            self.assertTrue(service.persist_model_record("strategic:5m", self._record()))
            service.MODELS.clear()
            result = service.load_persisted_models()
            self.assertEqual(result["restored"], 1)
            self.assertIn("strategic:5m", service.MODELS)
            self.assertTrue(service.model_is_usable(service.MODELS["strategic:5m"]))

    def test_tampered_checkpoint_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            service.MODEL_STORE_DIR = directory
            self.assertTrue(service.persist_model_record("strategic:5m", self._record()))
            path = Path(directory) / service._artifact_filename("strategic:5m")
            artifact = path.read_text(encoding="utf-8")
            path.write_text(artifact.replace('"signature":"', '"signature":"tampered-', 1), encoding="utf-8")
            service.MODELS.clear()
            result = service.load_persisted_models()
            self.assertEqual(result["restored"], 0)
            self.assertEqual(result["rejected"], 1)
            self.assertNotIn("strategic:5m", service.MODELS)


if __name__ == "__main__":
    unittest.main()
