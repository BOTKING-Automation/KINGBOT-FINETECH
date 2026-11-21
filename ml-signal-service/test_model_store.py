import base64
import hashlib
import json
import os
import unittest
from unittest.mock import patch

import model_store


class FakeResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode("utf-8")

    def read(self):
        return self.payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class ModelStoreTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {
            "KINGBOT_ML_ARTIFACTS_URL": "https://api.example.test/api/ml-artifacts",
            "KINGBOT_ML_SIGNAL_SECRET": "test-only-secret",
            "KINGBOT_ML_ARTIFACT_TIMEOUT_SEC": "10",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_save_sends_opaque_bytes_and_digest(self):
        observed = {}
        artifact = b"npz numeric archive placeholder"

        def fake_urlopen(request, timeout):
            observed["url"] = request.full_url
            observed["method"] = request.get_method()
            observed["timeout"] = timeout
            observed["artifact"] = request.data
            observed["digest"] = request.get_header("X-kingbot-artifact-sha256")
            digest = hashlib.sha256(request.data).hexdigest()
            return FakeResponse({
                "ok": True,
                "modelKey": "champion:strategic:4h",
                "sha256": digest,
            })

        with patch("model_store.urllib.request.urlopen", side_effect=fake_urlopen):
            result = model_store.save_model_artifact("champion", "strategic:4h", artifact)

        self.assertEqual(result["modelKey"], "champion:strategic:4h")
        self.assertEqual(observed["method"], "PUT")
        self.assertTrue(observed["url"].endswith("/champion/strategic/4h"))
        self.assertEqual(observed["artifact"], artifact)
        self.assertEqual(observed["digest"], hashlib.sha256(artifact).hexdigest())

    def test_load_verifies_digest_and_returns_opaque_bytes(self):
        artifact = b"npz numeric archive placeholder"
        digest = hashlib.sha256(artifact).hexdigest()
        payload = {
            "ok": True,
            "count": 1,
            "items": [{
                "modelKey": "strategic:4h",
                "kind": "champion",
                "strategy": "strategic",
                "timeframe": "4h",
                "artifactBase64": base64.b64encode(artifact).decode("ascii"),
                "sha256": digest,
            }],
        }

        with patch("model_store.urllib.request.urlopen", return_value=FakeResponse(payload)):
            restored = model_store.load_model_artifacts()

        self.assertEqual(len(restored), 1)
        self.assertEqual(restored[0]["kind"], "champion")
        self.assertEqual(restored[0]["modelKey"], "strategic:4h")
        self.assertEqual(restored[0]["artifact"], artifact)

    def test_load_skips_digest_mismatch(self):
        artifact = b"tampered-model-data"
        payload = {
            "ok": True,
            "items": [{
                "modelKey": "strategic:4h",
                "kind": "champion",
                "artifactBase64": base64.b64encode(artifact).decode("ascii"),
                "sha256": "0" * 64,
            }],
        }

        with patch("model_store.urllib.request.urlopen", return_value=FakeResponse(payload)):
            restored = model_store.load_model_artifacts()

        self.assertEqual(restored, [])


    def test_save_feedback_posts_stable_decision_identity(self):
        observed = {}
        row = {
            "decisionId": "550e8400-e29b-41d4-a716-446655440000",
            "strategy": "strategic",
            "symbol": "XAUUSD",
        }

        def fake_urlopen(request, timeout):
            observed["url"] = request.full_url
            observed["method"] = request.get_method()
            observed["body"] = json.loads(request.data.decode("utf-8"))
            observed["secret"] = request.get_header("X-kingbot-ml-secret")
            return FakeResponse({"ok": True, "created": True, "duplicate": False})

        with patch("model_store.urllib.request.urlopen", side_effect=fake_urlopen):
            result = model_store.save_feedback_row(row)

        self.assertTrue(result["created"])
        self.assertEqual(observed["method"], "POST")
        self.assertTrue(observed["url"].endswith("/feedback"))
        self.assertEqual(observed["body"]["decisionId"], row["decisionId"])
        self.assertEqual(observed["secret"], "test-only-secret")

    def test_save_feedback_rejects_non_json_values(self):
        with self.assertRaisesRegex(ValueError, "ML_FEEDBACK_PAYLOAD_INVALID"):
            model_store.save_feedback_row({
                "decisionId": "550e8400-e29b-41d4-a716-446655440000",
                "notFinite": float("nan"),
            })

    def test_load_feedback_rows_returns_persisted_items(self):
        items = [
            {"decisionId": "550e8400-e29b-41d4-a716-446655440000"},
            {"decisionId": "550e8400-e29b-41d4-a716-446655440001"},
        ]
        with patch("model_store.urllib.request.urlopen", return_value=FakeResponse({
            "ok": True,
            "count": len(items),
            "items": items,
        })) as mocked:
            restored = model_store.load_feedback_rows()

        self.assertEqual(restored, items)
        self.assertEqual(mocked.call_args.args[0].get_method(), "GET")
        self.assertTrue(mocked.call_args.args[0].full_url.endswith("/feedback"))


if __name__ == "__main__":
    unittest.main()
