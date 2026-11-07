"""Research-only multivariate cross-market Transformer challenger for KINGBOT V12."""
from __future__ import annotations
from pathlib import Path
import sys
from typing import Any
import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset
from sklearn.preprocessing import StandardScaler

_ROOT = Path(__file__).resolve().parents[2]
_ML = _ROOT / "ml-signal-service"
if str(_ML) not in sys.path:
    sys.path.insert(0, str(_ML))
import service  # noqa: E402

TF_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400}
TIMEFRAMES = tuple(TF_SECONDS)
SYMBOLS = ("XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD")
PILOTS = {"strategic": "1h", "flipper": "5m", "breakout": "15m", "smc-pro": "15m", "ladder-flip": "15m"}
SEQ = 32
D_MODEL = 64
EPOCHS = 12
BATCH = 128
SEED = 20261109
MIN_BA, MIN_F1, MIN_N, MIN_DELTA = 0.36, 0.34, 30, 0.005
N_FEATURES = len(service.FEATURE_NAMES)


class CrossMarketTransformer(nn.Module):
    """Transformer over target-market history and closed-bar context tokens."""
    def __init__(self, features: int, slots: int, seq_len: int = SEQ, dim: int = D_MODEL):
        super().__init__()
        if min(features, slots, seq_len) < 1 or dim % 4:
            raise ValueError("V12_MODEL_DIMENSIONS_INVALID")
        self.seq_len, self.slots = seq_len, slots
        self.target_proj = nn.Linear(features, dim)
        self.context_proj = nn.Linear(features + 1, dim)
        self.time_pos = nn.Parameter(torch.randn(1, seq_len, dim) * 0.02)
        self.slot_pos = nn.Parameter(torch.randn(1, slots, dim) * 0.02)
        layer = nn.TransformerEncoderLayer(dim, 4, dim * 4, dropout=0.1, activation="gelu",
                                           batch_first=True, norm_first=True)
        self.encoder = nn.TransformerEncoder(layer, 2, enable_nested_tensor=False)
        self.norm = nn.LayerNorm(dim)
        self.head = nn.Sequential(nn.Linear(dim, 48), nn.GELU(), nn.Dropout(0.1), nn.Linear(48, 3))

    def forward(self, target, context, missing):
        if target.ndim != 3 or context.ndim != 3 or missing.shape != context.shape[:2]:
            raise ValueError("V12_INPUT_SHAPE_INVALID")
        if target.shape[1] != self.seq_len or context.shape[1] != self.slots:
            raise ValueError("V12_SEQUENCE_OR_CONTEXT_SHAPE_INVALID")
        t = self.target_proj(target) + self.time_pos
        c = self.context_proj(context) + self.slot_pos
        tokens = torch.cat((t, c), dim=1)
        padding = torch.cat((torch.zeros((len(t), self.seq_len), dtype=torch.bool, device=t.device),
                             missing.bool()), dim=1)
        encoded = self.norm(self.encoder(tokens, src_key_padding_mask=padding))
        return self.head(encoded[:, self.seq_len - 1])


def build_dataset(markets_by_timeframe: dict[str, Any], strategy: str,
                  target_tf: str, seq_len: int = SEQ) -> dict[str, Any]:
    """Build independent target sequences and causal as-of context from all markets/timeframes.

    A context feature is used only after that context candle's close (open timestamp +
    timeframe duration) is no later than the target candle's close. V9 sample and
    label-end timestamps are retained for the same global purged temporal split.
    """
    if target_tf not in TF_SECONDS or not 8 <= seq_len <= 128:
        raise ValueError("V12_TIMEFRAME_OR_SEQUENCE_INVALID")
    series, coverage = {}, []
    for tf in TIMEFRAMES:
        rows = markets_by_timeframe.get(tf, [])
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            symbol, raw = str(row.get("symbol") or "").upper(), row.get("bars")
            if symbol not in SYMBOLS or not isinstance(raw, list):
                continue
            key = f"{symbol}|{tf}"
            try:
                bars = service.normalize_market_bars(raw)
                f, y, _, times, ends = service.bars_to_training_arrays(bars, strategy)
                if len(f) < seq_len + 50:
                    coverage.append({"key": key, "bars": len(bars), "rows": len(f), "accepted": False, "reason": "INSUFFICIENT_HISTORY"})
                    continue
                if not np.isfinite(times).all() or not np.isfinite(ends).all():
                    coverage.append({"key": key, "accepted": False, "reason": "TIMESTAMPS_REQUIRED"})
                    continue
                series[key] = {"key": key, "symbol": symbol, "tf": tf, "duration": TF_SECONDS[tf],
                    "f": np.asarray(f, np.float32), "y": np.asarray(y, np.int64),
                    "t": np.asarray(times, np.float64), "ends": np.asarray(ends, np.float64),
                    "available": np.asarray(times, np.float64) + TF_SECONDS[tf],
                    "bars": len(bars), "source": row.get("source", "unspecified")}
                coverage.append({"key": key, "bars": len(bars), "rows": len(f), "accepted": True,
                                 "source": row.get("source", "unspecified")})
            except Exception as exc:
                coverage.append({"key": key, "accepted": False, "reason": str(exc)[:200]})
    targets = [v for v in series.values() if v["tf"] == target_tf]
    if not targets:
        raise ValueError("V12_NO_TARGET_MARKETS_WITH_HISTORY")
    slots = sorted(series)
    xs, cs, ms, ages, ys, ts, ends, symbols = [], [], [], [], [], [], [], []
    for target in targets:
        windows = np.lib.stride_tricks.sliding_window_view(
            target["f"], window_shape=seq_len, axis=0).transpose(0, 2, 1)
        windows = np.ascontiguousarray(windows, dtype=np.float32)
        y, t, e = target["y"][seq_len-1:], target["t"][seq_len-1:], target["ends"][seq_len-1:]
        if not (len(windows) == len(y) == len(t) == len(e)):
            raise ValueError("V12_TARGET_ALIGNMENT_INVALID")
        decision = t + target["duration"]
        context = np.zeros((len(windows), len(slots), N_FEATURES), np.float32)
        missing = np.ones((len(windows), len(slots)), bool)
        age = np.zeros((len(windows), len(slots)), np.float32)
        for slot, key in enumerate(slots):
            if key == target["key"]:
                continue
            src = series[key]
            idx = np.searchsorted(src["available"], decision, side="right") - 1
            valid = idx >= 0
            if valid.any():
                chosen = idx[valid]
                context[valid, slot] = src["f"][chosen]
                missing[valid, slot] = False
                age[valid, slot] = np.log1p(np.maximum(decision[valid] - src["available"][chosen], 0) /
                                            float(target["duration"])).astype(np.float32)
        xs.append(windows); cs.append(context); ms.append(missing); ages.append(age)
        ys.append(y); ts.append(t); ends.append(e); symbols.extend([target["symbol"]] * len(y))
    X, C, M, A = map(lambda arr: np.concatenate(arr, axis=0), (xs, cs, ms, ages))
    y, T, E = map(lambda arr: np.concatenate(arr, axis=0), (ys, ts, ends))
    if not (len(X) == len(C) == len(M) == len(A) == len(y) == len(T) == len(E)):
        raise ValueError("V12_PANEL_ALIGNMENT_INVALID")
    if not np.isfinite(X).all() or not np.isfinite(C).all() or not np.isfinite(A).all():
        raise ValueError("V12_NONFINITE_FEATURES")
    return {"X": X, "C": C, "M": M, "A": A, "y": y, "times": T, "ends": E,
            "symbols": symbols, "slots": slots, "coverage": coverage,
            "contextCoverage": {slots[i]: float((~M[:, i]).mean()) for i in range(len(slots))},
            "targetTimeframe": target_tf, "sequenceLength": seq_len}


def _scale(train_x, eval_x, train_c, eval_c, train_m, eval_m, train_a, eval_a):
    sx = StandardScaler().fit(train_x.reshape(-1, train_x.shape[-1]))
    tx = sx.transform(train_x.reshape(-1, train_x.shape[-1])).reshape(train_x.shape).astype(np.float32)
    ex = sx.transform(eval_x.reshape(-1, eval_x.shape[-1])).reshape(eval_x.shape).astype(np.float32)
    tc, ec, tm, em = np.zeros_like(train_c), np.zeros_like(eval_c), train_m.copy(), eval_m.copy()
    for k in range(train_c.shape[1]):
        valid = ~tm[:, k]
        if valid.sum() < 2:
            tm[:, k] = True; em[:, k] = True
            continue
        sc = StandardScaler().fit(train_c[valid, k])
        tc[valid, k] = sc.transform(train_c[valid, k])
        ev = ~em[:, k]
        if ev.any():
            ec[ev, k] = sc.transform(eval_c[ev, k])
    tc = np.concatenate([tc, train_a[:, :, None]], axis=2).astype(np.float32)
    ec = np.concatenate([ec, eval_a[:, :, None]], axis=2).astype(np.float32)
    return tx, ex, tc, ec, tm, em


def fit_predict(train_x, train_c, train_m, train_a, train_y,
                eval_x, eval_c, eval_m, eval_a, epochs: int = EPOCHS):
    if not 1 <= epochs <= 80:
        raise ValueError("V12_EPOCHS_INVALID")
    tx, ex, tc, ec, tm, em = _scale(train_x, eval_x, train_c, eval_c, train_m, eval_m, train_a, eval_a)
    ty = np.asarray([service.LABEL_TO_INDEX[int(v)] for v in train_y], np.int64)
    if len(tx) < 90 or len(ex) < 1:
        raise ValueError("V12_TRAINING_SAMPLE_COVERAGE_INSUFFICIENT")
    torch.manual_seed(SEED); np.random.seed(SEED); torch.set_num_threads(1)
    model = CrossMarketTransformer(tx.shape[-1], tc.shape[1], tx.shape[1])
    counts = np.bincount(ty, minlength=3).astype(np.float32)
    weights = len(ty) / np.maximum(counts, 1.0); weights /= weights.mean()
    loss_fn = nn.CrossEntropyLoss(weight=torch.tensor(weights, dtype=torch.float32))
    ds = TensorDataset(torch.from_numpy(tx), torch.from_numpy(tc), torch.from_numpy(tm), torch.from_numpy(ty))
    dl = DataLoader(ds, batch_size=min(BATCH, len(ds)), shuffle=True,
                    generator=torch.Generator().manual_seed(SEED))
    opt = torch.optim.AdamW(model.parameters(), lr=0.0006, weight_decay=0.001)
    model.train()
    for _ in range(epochs):
        for bx, bc, bm, by in dl:
            loss = loss_fn(model(bx, bc, bm), by)
            opt.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step()
    model.eval()
    with torch.no_grad():
        p = torch.softmax(model(torch.from_numpy(ex), torch.from_numpy(ec), torch.from_numpy(em)), dim=1).numpy()
    if p.shape != (len(ex), 3) or not np.isfinite(p).all():
        raise ValueError("V12_PREDICTION_OUTPUT_INVALID")
    return p


def matched_v9(train_x, train_y, eval_x, eval_y):
    from sklearn.ensemble import RandomForestClassifier
    X, V, y = train_x[:, -1, :].astype(np.float32), eval_x[:, -1, :].astype(np.float32), np.asarray(train_y)
    scaler = StandardScaler().fit(X)
    rf = RandomForestClassifier(n_estimators=120, max_depth=8, min_samples_leaf=3,
        class_weight="balanced_subsample", random_state=42, n_jobs=1).fit(X, y)
    rp = np.zeros((len(V), 3), np.float64)
    for col, cls in enumerate(rf.classes_):
        rp[:, service.LABEL_TO_INDEX[int(cls)]] = rf.predict_proba(V)[:, col]
    mlp, _ = service.train_torch(X, y, V, np.asarray(eval_y), scaler, np.ones(len(X), np.float32))
    with torch.no_grad():
        mp = torch.softmax(mlp(torch.from_numpy(scaler.transform(V).astype(np.float32))), dim=1).numpy()
    return 0.55 * rp + 0.45 * mp


def metrics(y_true, p):
    from sklearn.metrics import accuracy_score, balanced_accuracy_score, f1_score, recall_score
    actual = np.asarray([service.LABEL_TO_INDEX[int(v)] for v in y_true], np.int64)
    predicted = p.argmax(axis=1)
    rec = recall_score(actual, predicted, labels=[0, 1, 2], average=None, zero_division=0)
    recall = dict(zip(("SELL", "HOLD", "BUY"), map(float, rec)))
    ba = float(balanced_accuracy_score(actual, predicted))
    f1 = float(f1_score(actual, predicted, labels=[0, 1, 2], average="macro", zero_division=0))
    ok_n, ok_rec = len(actual) >= MIN_N, all(v > 0 for v in recall.values())
    return {"accuracy": float(accuracy_score(actual, predicted)), "balancedAccuracy": ba, "macroF1": f1,
        "testSamples": len(actual), "classRecall": recall, "classCoverageGate": ok_rec,
        "metricGate": ok_n and ba >= MIN_BA and f1 >= MIN_F1,
        "qualityGate": ok_n and ok_rec and ba >= MIN_BA and f1 >= MIN_F1,
        "selectionScore": 0.60 * ba + 0.40 * f1}


def run_fold(data, train_fraction, test_fraction):
    tr, te, cutoff = service.global_temporal_split_masks(data["times"], data["ends"],
        train_fraction=train_fraction, test_fraction=test_fraction)
    if tr.sum() < 90 or te.sum() < MIN_N:
        raise ValueError("V12_FOLD_SAMPLE_COVERAGE_INSUFFICIENT")
    X, C, M, A, y = (data[k] for k in ("X", "C", "M", "A", "y"))
    yp, yt = y[tr], y[te]
    model_p = fit_predict(X[tr], C[tr], M[tr], A[tr], yp, X[te], C[te], M[te], A[te])
    base_p = matched_v9(X[tr], yp, X[te], yt)
    return {"cutoffTimestamp": float(cutoff), "trainSamples": int(tr.sum()),
        "contextCoverage": data["contextCoverage"], "multivariate": metrics(yt, model_p),
        "v9MatchedBaseline": metrics(yt, base_p)}


def run_pilot(strategy, timeframe, markets_by_timeframe):
    data = build_dataset(markets_by_timeframe, strategy, timeframe)
    dev = run_fold(data, 0.70, 0.85)
    dev_delta = dev["multivariate"]["selectionScore"] - dev["v9MatchedBaseline"]["selectionScore"]
    advance = dev["multivariate"]["qualityGate"] and dev_delta >= -0.01
    final = run_fold(data, 0.85, 1.0) if advance else None
    delta = final["multivariate"]["selectionScore"] - final["v9MatchedBaseline"]["selectionScore"] if final else None
    passed = bool(final and final["multivariate"]["qualityGate"] and delta >= MIN_DELTA)
    return {"strategy": strategy, "timeframe": timeframe,
        "status": "RESEARCH_CANDIDATE_PASS" if passed else ("FINAL_REJECTED" if final else "DEVELOPMENT_REJECTED"),
        "sequenceLength": data["sequenceLength"], "contextSlots": len(data["slots"]),
        "contextSlotKeys": data["slots"], "marketCoverage": data["coverage"],
        "contextCoverageOverall": data["contextCoverage"], "development": dev,
        "developmentScoreDeltaVsV9": float(dev_delta), "final": final,
        "selectionScoreDeltaVsV9": float(delta) if delta is not None else None,
        "requiredImprovementMargin": MIN_DELTA, "passesFinalResearchGate": passed,
        "promotion": "NONE_RESEARCH_ONLY"}
