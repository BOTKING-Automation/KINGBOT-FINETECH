import csv
import tempfile
import unittest
from pathlib import Path

from research.quantum_lab.trade_dataset import load_xauusd_trade_csv


class TradeDatasetTests(unittest.TestCase):
    def write_csv(self, rows, headers):
        tmp = tempfile.NamedTemporaryFile(mode="w", newline="", encoding="utf-8", suffix=".csv", delete=False)
        with tmp:
            writer = csv.DictWriter(tmp, fieldnames=headers)
            writer.writeheader()
            writer.writerows(rows)
        self.addCleanup(Path(tmp.name).unlink, missing_ok=True)
        return tmp.name

    def test_loads_after_costs_r_and_normalizes_utc(self):
        path = self.write_csv([
            {"trade_id":"t1","closed_at":"2026-01-01T10:00:00+03:00","symbol":"XAUUSDm","net_pnl_after_costs_r":"-0.5"},
            {"trade_id":"t2","closed_at":"2026-01-01T11:00:00+03:00","symbol":"XAUUSD","net_pnl_after_costs_r":"1.2"},
        ], ["trade_id","closed_at","symbol","net_pnl_after_costs_r"])
        report = load_xauusd_trade_csv(path)
        self.assertEqual(report["trade_count"], 2)
        self.assertEqual(report["records"][0]["closed_at"], "2026-01-01T07:00:00Z")
        self.assertEqual(report["records"][0]["net_pnl_r"], -0.5)
        self.assertFalse(report["can_place_order"])

    def test_calculates_net_r_from_signed_cost_ledger(self):
        headers = ["closed_at","symbol","gross_pnl_cash","commission_cash","swap_cash","spread_cost_cash","slippage_cost_cash","initial_risk_cash"]
        row = {"closed_at":"2026-01-01T00:00:00Z","symbol":"GOLD","gross_pnl_cash":"120","commission_cash":"-4","swap_cash":"1","spread_cost_cash":"5","slippage_cost_cash":"2","initial_risk_cash":"100"}
        result = load_xauusd_trade_csv(self.write_csv([row], headers))
        self.assertAlmostEqual(result["records"][0]["net_pnl_r"], 1.10)

    def test_rejects_naive_timestamps(self):
        path = self.write_csv([{"closed_at":"2026-01-01T00:00:00","symbol":"XAUUSD","net_pnl_after_costs_r":"1"}], ["closed_at","symbol","net_pnl_after_costs_r"])
        with self.assertRaisesRegex(ValueError, "TIMEZONE_AWARE"):
            load_xauusd_trade_csv(path)

    def test_rejects_non_gold_symbols(self):
        path = self.write_csv([{"closed_at":"2026-01-01T00:00:00Z","symbol":"EURUSD","net_pnl_after_costs_r":"1"}], ["closed_at","symbol","net_pnl_after_costs_r"])
        with self.assertRaisesRegex(ValueError, "UNSUPPORTED_SYMBOL"):
            load_xauusd_trade_csv(path)


if __name__ == "__main__":
    unittest.main()
