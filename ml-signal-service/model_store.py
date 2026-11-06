"""Durable KINGBOT ML artifact persistence through the authenticated backend API.

Artifacts are compressed Python pickle bundles. The storage API is private to the
ML service (shared secret) and persists bytes in a private PostgreSQL schema.
Only artifacts written by this trusted service are loaded with pickle.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import pickle
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

FORMAT_VERSION = "kingbot-ml-artifact-v1"
MAX_ARTIFACT_BYTES = 4 * 1024 * 1024


def _config() -> tuple[str, str, float]:
    url = str(os.getenv("KINGBOT_ML_ARTIFACTS_URL", "")).strip().rstrip("/")
    secret = str(os.getenv("KINGBOT_ML_SIGNAL_SECRET", "")).strip()
    timeout = max(5.0, min(120.0, float(os.getenv("KINGBOT_ML_ARTIFACT_TIMEOUT_SEC", "90"))))
    return url, secret, timeout


def _authorized_headers(secret: str) -> dict[str, str]:
    return {
        "accept": "application/json",
        "x-kingbot-ml-secret": secret,
    }


def _read_json_response(response: Any) -> dict[str, Any]:
    payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise RuntimeError("ML_ARTIFACT_STORE_RESPONSE_INVALID")
    return payload


def _open_with_retry(request: urllib.request.Request, timeout: float, attempts: int = 4) -> Any:
    for attempt in range(attempts):
        try:
            return urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            retryable = error.code in {429, 502, 503, 504}
            if not retryable or attempt >= attempts - 1:
                detail = ""
                try:
                    detail = error.read(300).decode("utf-8", errors="replace")
                except Exception:
                    pass
                raise RuntimeError(f"ML_ARTIFACT_STORE_HTTP_{error.code}:{detail[:120]}") from error

            retry_after = str(error.headers.get("Retry-After", "")).strip()
            try:
                delay = float(retry_after)
            except (TypeError, ValueError):
                delay = min(15.0, 2.0 ** (attempt + 1))
            time.sleep(max(1.0, min(30.0, delay)))
        except (TimeoutError, urllib.error.URLError) as error:
            if attempt >= attempts - 1:
                raise RuntimeError("ML_ARTIFACT_STORE_CONNECTION_FAILED") from error
            time.sleep(min(8.0, 1.5 * (attempt + 1)))
    raise RuntimeError("ML_ARTIFACT_STORE_UNAVAILABLE")


def save_model_artifact(kind: str, model_key: str, record: dict[str, Any]) -> dict[str, Any]:
    """Persist one champion/challenger record before it is exposed to inference."""
    base_url, secret, timeout = _config()
    if not base_url or not secret:
        raise RuntimeError("ML_ARTIFACT_PERSISTENCE_NOT_CONFIGURED")
    if kind not in {"champion", "challenger"} or not isinstance(record, dict):
        raise ValueError("ML_ARTIFACT_RECORD_INVALID")

    parts = str(model_key).split(":")
    if len(parts) != 2:
        raise ValueError("ML_ARTIFACT_KEY_INVALID")
    strategy, timeframe = parts
    path_parts = [kind, strategy, timeframe]
    encoded_path = "/".join(urllib.parse.quote(part, safe="") for part in path_parts)
    envelope = {
        "format": FORMAT_VERSION,
        "modelKey": model_key,
        "kind": kind,
        "record": record,
    }
    artifact = gzip.compress(
        pickle.dumps(envelope, protocol=pickle.HIGHEST_PROTOCOL),
        compresslevel=6,
        mtime=0,
    )
    if not artifact or len(artifact) > MAX_ARTIFACT_BYTES:
        raise RuntimeError("ML_ARTIFACT_SIZE_LIMIT_EXCEEDED")

    digest = hashlib.sha256(artifact).hexdigest()
    request = urllib.request.Request(
        f"{base_url}/{encoded_path}",
        data=artifact,
        method="PUT",
        headers={
            **_authorized_headers(secret),
            "content-type": "application/octet-stream",
            "content-length": str(len(artifact)),
            "x-kingbot-artifact-sha256": digest,
        },
    )
    with _open_with_retry(request, timeout) as response:
        result = _read_json_response(response)
    if result.get("sha256") != digest or result.get("modelKey") != f"{kind}:{model_key}":
        raise RuntimeError("ML_ARTIFACT_STORE_CONFIRMATION_MISMATCH")
    return result


def load_model_artifacts() -> list[dict[str, Any]]:
    """Load and verify persisted bundles. Invalid or incompatible bundles fail closed."""
    base_url, secret, timeout = _config()
    if not base_url or not secret:
        raise RuntimeError("ML_ARTIFACT_PERSISTENCE_NOT_CONFIGURED")

    request = urllib.request.Request(
        base_url,
        method="GET",
        headers=_authorized_headers(secret),
    )
    with _open_with_retry(request, timeout) as response:
        payload = _read_json_response(response)

    restored: list[dict[str, Any]] = []
    items = payload.get("items")
    if not isinstance(items, list):
        raise RuntimeError("ML_ARTIFACT_STORE_ITEMS_INVALID")

    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            kind = str(item.get("kind") or "")
            model_key = str(item.get("modelKey") or "")
            encoded = str(item.get("artifactBase64") or "")
            supplied_digest = str(item.get("sha256") or "").lower()
            if kind not in {"champion", "challenger"} or not encoded or len(supplied_digest) != 64:
                continue

            artifact = __import__("base64").b64decode(encoded, validate=True)
            if not artifact or len(artifact) > MAX_ARTIFACT_BYTES:
                continue
            actual_digest = hashlib.sha256(artifact).hexdigest()
            if actual_digest != supplied_digest:
                continue

            envelope = pickle.loads(gzip.decompress(artifact))
            if (
                not isinstance(envelope, dict)
                or envelope.get("format") != FORMAT_VERSION
                or envelope.get("modelKey") != model_key
                or envelope.get("kind") != kind
                or not isinstance(envelope.get("record"), dict)
            ):
                continue

            restored.append({
                "kind": kind,
                "modelKey": model_key,
                "record": envelope["record"],
                "updatedAt": item.get("updatedAt"),
            })
        except Exception:
            # One incompatible/corrupt record must not prevent other models loading.
            continue
    return restored
