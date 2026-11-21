import unittest
from datetime import datetime, timedelta, timezone

import service


def make_payload(count=80):
    start = datetime(2026, 1, 5, 8, 0, tzinfo=timezone.utc)
    bars = []
    for index in range(count):
        price = 2500.0 + index * 0.2
        bars.append({
            "timestamp": (start + timedelta(minutes=5 * index)).isoformat().replace("+00:00", "Z"),
            "open": price, "high": price + 0.4, "low": price - 0.3,
            "close": price + 0.1, "volume": 100.0,
        })
    last = start + timedelta(minutes=5 * (count - 1))
    future = [
        (last + timedelta(minutes=5 * index)).isoformat().replace("+00:00", "Z")
        for index in range(1, 4)
    ]
    return {
        "symbol": "XAUUSD", "timeframe": "5m", "bars": bars,
        "futureTimestamps": future, "forecastSteps": 3, "samples": 5, "seed": 123,
    }


class KronosResearchValidationTests(unittest.TestCase):
    def test_valid_payload_normalizes_and_caps_context(self):
        validated = service.validate_request(make_payload(700))
        self.assertEqual(validated["inputBars"], 700)
        self.assertEqual(validated["contextBars"], 512)
        self.assertEqual(validated["symbol"], "XAUUSD")
        self.assertEqual(len(validated["futureTimestamps"]), 3)

    def test_rejects_naive_timestamps(self):
        payload = make_payload()
        payload["bars"][0]["timestamp"] = "2026-01-05T08:00:00"
        with self.assertRaisesRegex(ValueError, "TIMEZONE_REQUIRED"):
            service.validate_request(payload)

    def test_rejects_duplicate_or_reversed_bar_times(self):
        payload = make_payload()
        payload["bars"][2]["timestamp"] = payload["bars"][1]["timestamp"]
        with self.assertRaisesRegex(ValueError, "NOT_STRICTLY_INCREASING"):
            service.validate_request(payload)

    def test_rejects_invalid_ohlc(self):
        payload = make_payload()
        payload["bars"][5]["high"] = payload["bars"][5]["close"] - 1
        with self.assertRaisesRegex(ValueError, "OHLC_HIGH_INVARIANT"):
            service.validate_request(payload)

    def test_requires_explicit_future_timestamps(self):
        payload = make_payload()
        payload.pop("futureTimestamps")
        with self.assertRaisesRegex(ValueError, "FUTURE_TIMESTAMPS_REQUIRED"):
            service.validate_request(payload)

    def test_rejects_unknown_timeframe(self):
        payload = make_payload()
        payload["timeframe"] = "2m"
        with self.assertRaisesRegex(ValueError, "TIMEFRAME_UNSUPPORTED"):
            service.validate_request(payload)

    def test_sample_count_must_support_distribution(self):
        payload = make_payload()
        payload["samples"] = 1
        with self.assertRaisesRegex(ValueError, "SAMPLE_COUNT_OUT_OF_RANGE"):
            service.validate_request(payload)

    def test_aggregation_preserves_close_distribution(self):
        future = [datetime(2026, 1, 5, 15, 0, tzinfo=timezone.utc)]
        paths = [
            [{"open": 100, "high": 102, "low": 97, "close": close, "volume": 10}]
            for close in [98, 99, 100, 101, 102]
        ]
        result = service.aggregate_forecasts(paths, future)[0]
        self.assertEqual(result["closeP50"], 100)
        self.assertAlmostEqual(result["closeP10"], 98.4)
        self.assertAlmostEqual(result["closeP90"], 101.6)
        self.assertGreater(result["closeStdDev"], 0)
        self.assertGreaterEqual(result["high"], result["close"])
        self.assertLessEqual(result["low"], result["close"])

    def test_aggregation_rejects_mismatched_path_lengths(self):
        future = [datetime(2026, 1, 5, 15, 0, tzinfo=timezone.utc)]
        one = {"open": 100, "high": 101, "low": 99, "close": 100, "volume": 1}
        paths = [[one], [one], []]
        with self.assertRaisesRegex(ValueError, "FORECAST_PATH_LENGTH_MISMATCH"):
            service.aggregate_forecasts(paths, future)


if __name__ == "__main__":
    unittest.main()
