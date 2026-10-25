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


class CostAwareBacktestTests(ModelReadinessTests):
    def _historical_bars(self, count=420):
        import math
        from datetime import datetime, timedelta, timezone

        start = datetime(2025, 1, 1, tzinfo=timezone.utc)
        rows = []
        previous = 100.0
        for index in range(count):
            close = 100.0 + index * 0.012 + 3.0 * math.sin(index / 5.0) + 1.5 * math.sin(index / 13.0)
            opening = previous
            rows.append({
                "timestamp": (start + timedelta(minutes=5 * index)).isoformat().replace("+00:00", "Z"),
                "open": opening,
                "high": max(opening, close) + 0.7,
                "low": min(opening, close) - 0.7,
                "close": close,
                "volume": 100 + index % 17,
            })
            previous = close
        return rows

    def _costs(self):
        return {
            "spread_price": 0.25,
            "slippage_price_per_side": 0.05,
            "commission_per_lot_round_turn": 7.0,
            "swap_long_per_lot_per_day": -3.0,
            "swap_short_per_lot_per_day": -1.0,
            "units_per_lot": 100.0,
            "volume_lots": 0.01,
            "quote_to_account_rate": 1.0,
            "starting_equity": 1000.0,
            "account_currency": "USD",
            "quote_currency": "USD",
        }

    def test_costed_trade_accounts_for_spread_slippage_commission_and_swap(self):
        bars = self._historical_bars(10)
        timestamps = [service._parse_bar_timestamp(row) for row in bars]
        costs = self._costs()
        trade = service._costed_backtest_trade(
            direction=1,
            signal_index=1,
            entry_index=2,
            exit_index=4,
            bars=service.normalize_market_bars(bars),
            timestamps=timestamps,
            timeframe_seconds=300,
            costs=costs,
        )
        expected_spread = costs["spread_price"] * costs["units_per_lot"] * costs["volume_lots"]
        expected_slippage = 2 * costs["slippage_price_per_side"] * costs["units_per_lot"] * costs["volume_lots"]
        expected_commission = costs["commission_per_lot_round_turn"] * costs["volume_lots"]
        self.assertAlmostEqual(trade["spreadCostAccount"], expected_spread)
        self.assertAlmostEqual(trade["slippageCostAccount"], expected_slippage)
        self.assertAlmostEqual(trade["commissionCostAccount"], expected_commission)
        self.assertLess(trade["swapPnlAccount"], 0)
        self.assertAlmostEqual(
            trade["netPnlAccount"],
            trade["grossPricePnlAccount"] - expected_spread - expected_slippage
            - expected_commission + trade["swapPnlAccount"],
        )

    def test_walk_forward_backtest_reports_folds_costs_and_unverified_provenance(self):
        bars = self._historical_bars()
        with patcher_for_backtest_globals():
            result = service.walk_forward_cost_aware_backtest(
                "strategic", "XAUUSD", "5m", bars, self._costs(), 2, "unit-test historical fixture"
            )
        self.assertTrue(result["ok"])
        self.assertEqual(result["evaluation"], "EXPANDING_ROLLING_PURGED_WALK_FORWARD")
        self.assertEqual(result["foldCount"], 2)
        self.assertEqual(result["data"]["timestampCoveragePct"], 100.0)
        self.assertFalse(result["data"]["sourceIndependentlyVerified"])
        self.assertFalse(result["profitabilityValidated"])
        self.assertIn("netPnlAccount", result["performance"])
        self.assertIn("commissionCostAccount", result["performance"])
        self.assertIn("swapPnlAccount", result["performance"])
        for fold in result["folds"]:
            self.assertGreaterEqual(fold["trainingSamples"], 70)
            self.assertGreater(fold["testSamples"], 0)

    def test_walk_forward_rejects_missing_cost_assumptions(self):
        costs = self._costs()
        costs.pop("spread_price")
        with self.assertRaisesRegex(ValueError, "ML_BACKTEST_COST_REQUIRED_SPREAD_PRICE"):
            service.walk_forward_cost_aware_backtest(
                "strategic", "XAUUSD", "5m", self._historical_bars(), costs, 2, "fixture"
            )

    def test_walk_forward_rejects_nonmonotonic_timestamps(self):
        bars = self._historical_bars()
        bars[10]["timestamp"] = bars[9]["timestamp"]
        with self.assertRaisesRegex(ValueError, "ML_BACKTEST_TIMESTAMPS_MUST_BE_STRICTLY_INCREASING"):
            service.walk_forward_cost_aware_backtest(
                "strategic", "XAUUSD", "5m", bars, self._costs(), 2, "fixture"
            )

    def test_backtest_rejects_execution_costs_that_create_nonpositive_fill(self):
        bars = service.normalize_market_bars(self._historical_bars(10))
        timestamps = [service._parse_bar_timestamp(row) for row in self._historical_bars(10)]
        costs = self._costs()
        costs["spread_price"] = 1_000_000.0
        with self.assertRaisesRegex(ValueError, "ML_BACKTEST_EXECUTION_COST_EXCEEDS_PRICE"):
            service._costed_backtest_trade(
                direction=1, signal_index=1, entry_index=2, exit_index=4,
                bars=bars, timestamps=timestamps, timeframe_seconds=300, costs=costs
            )


class patcher_for_backtest_globals:
    """Context manager that keeps the CI fixture fast while exercising real fold training."""
    def __enter__(self):
        self.trees = service.MAX_RF_TREES
        self.epochs = service.TORCH_EPOCHS
        service.MAX_RF_TREES = 40
        service.TORCH_EPOCHS = 10
        return self

    def __exit__(self, *_):
        service.MAX_RF_TREES = self.trees
        service.TORCH_EPOCHS = self.epochs
