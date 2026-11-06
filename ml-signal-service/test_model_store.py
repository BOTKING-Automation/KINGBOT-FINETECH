import base64
import gzip
import hashlib
import json
import os
import pickle
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

    def test_save_sends_compressed_bundle_and_digest(self):
        observed = {}

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
            result = model_store.save_model_artifact(
                "champion",
                "strategic:4h",
                {"samples": 240, "metric": 0.61},
            )

        self.assertEqual(result["modelKey"], "champion:strategic:4h")
        self.assertEqual(observed["method"], "PUT")
        self.assertTrue(observed["url"].endswith("/champion/strategic/4h"))
        self.assertEqual(observed["digest"], hashlib.sha256(observed["artifact"]).hexdigest())
        restored = pickle.loads(gzip.decompress(observed["artifact"]))
        self.assertEqual(restored["format"], model_store.FORMAT_VERSION)
        self.assertEqual(restored["record"]["samples"], 240)

    def test_load_verifies_digest_before_unpickling(self):
        envelope = {
            "format": model_store.FORMAT_VERSION,
            "modelKey": "strategic:4h",
            "kind": "champion",
            "record": {"samples": 320},
        }
        artifact = gzip.compress(pickle.dumps(envelope, protocol=pickle.HIGHEST_PROTOCOL), mtime=0)
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
        self.assertEqual(restored[0]["record"]["samples"], 320)

    def test_load_skips_digest_mismatch(self):
        artifact = gzip.compress(b"not-a-model")
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


if __name__ == "__main__":
    unittest.main()
