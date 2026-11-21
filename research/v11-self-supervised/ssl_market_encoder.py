"""Research-only masked self-supervised market encoder for KINGBOT V11."""
from __future__ import annotations
from pathlib import Path
import sys
from typing import Any
import numpy as np
import torch
from torch import nn
from torch.nn import functional as F
from torch.utils.data import DataLoader, TensorDataset
from sklearn.preprocessing import StandardScaler

_ROOT = Path(__file__).resolve().parents[2]
_ML = _ROOT / "ml-signal-service"
if str(_ML) not in sys.path:
    sys.path.insert(0, str(_ML))
import service  # noqa: E402

SEQUENCE_LENGTH = 32
MIN_SEQUENCES_PER_MARKET = 50
RANDOM_SEED = 20261108
BATCH_SIZE = 128
PRETRAIN_EPOCHS = 12
FINETUNE_EPOCHS = 12
MIN_BA = 0.36
MIN_MACRO_F1 = 0.34
MIN_TEST_SAMPLES = 30
MIN_SCORE_DELTA = 0.005
PILOT_PROFILES = {"strategic": "1h", "flipper": "5m", "breakout": "15m", "smc-pro": "15m", "ladder-flip": "15m"}


class MaskedMarketEncoder(nn.Module):
    """Transformer encoder pretrained by reconstructing masked time steps."""
    def __init__(self, input_features: int, sequence_length: int = SEQUENCE_LENGTH,
                 d_model: int = 64, heads: int = 4, layers: int = 2, dropout: float = 0.10):
        super().__init__()
        if input_features < 1 or sequence_length < 2:
            raise ValueError("V11_ENCODER_DIMENSIONS_INVALID")
        self.input_features = input_features
        self.sequence_length = sequence_length
        self.input_projection = nn.Linear(input_features, d_model)
        self.position = nn.Parameter(torch.zeros(1, sequence_length, d_model))
        self.mask_token = nn.Parameter(torch.zeros(1, 1, d_model))
        block = nn.TransformerEncoderLayer(d_model=d_model, nhead=heads, dim_feedforward=d_model * 4,
            dropout=dropout, activation="gelu", batch_first=True, norm_first=True)
        self.encoder = nn.TransformerEncoder(block, num_layers=layers, enable_nested_tensor=False)
        self.norm = nn.LayerNorm(d_model)
        self.reconstruction = nn.Linear(d_model, input_features)
        self.classifier = nn.Sequential(nn.LayerNorm(d_model), nn.Linear(d_model, 48),
            nn.GELU(), nn.Dropout(dropout), nn.Linear(48, 3))
        nn.init.normal_(self.position, mean=0.0, std=0.02)
        nn.init.normal_(self.mask_token, mean=0.0, std=0.02)

    def encode(self, values: torch.Tensor, masked_steps: torch.Tensor | None = None) -> torch.Tensor:
        if values.ndim != 3 or values.shape[1:] != (self.sequence_length, self.input_features):
            raise ValueError("V11_ENCODER_INPUT_SHAPE_INVALID")
        hidden = self.input_projection(values)
        if masked_steps is not None:
            hidden = torch.where(masked_steps.unsqueeze(-1), self.mask_token.expand_as(hidden), hidden)
        # Keep positional information available at masked steps for reconstruction.
        hidden = hidden + self.position
        return self.norm(self.encoder(hidden))

    def reconstruct(self, values: torch.Tensor, masked_steps: torch.Tensor) -> torch.Tensor:
        return self.reconstruction(self.encode(values, masked_steps))

    def forward(self, values: torch.Tensor) -> torch.Tensor:
        return self.classifier(self.encode(values)[:, -1, :])


def build_dataset(markets: list[dict[str, Any]], strategy: str, sequence_length: int = SEQUENCE_LENGTH) -> dict[str, Any]:
    if not isinstance(markets, list) or not markets:
        raise ValueError("V11_MARKETS_REQUIRED")
    if sequence_length < 8 or sequence_length > 128:
        raise ValueError("V11_SEQUENCE_LENGTH_INVALID")
    sequences, labels_all, times_all, ends_all, market_info = [], [], [], [], []
    for market in markets:
        if not isinstance(market, dict):
            continue
        symbol, raw = str(market.get("symbol") or "").strip().upper(), market.get("bars")
        if not symbol or not isinstance(raw, list):
            continue
        bars = service.normalize_market_bars(raw)
        features, labels, _, sample_times, label_end_times = service.bars_to_training_arrays(bars, strategy)
        count = len(features) - sequence_length + 1
        if count < MIN_SEQUENCES_PER_MARKET:
            market_info.append({"symbol": symbol, "accepted": False, "sequences": max(0, count)})
            continue
        if not np.isfinite(sample_times).all() or not np.isfinite(label_end_times).all():
            market_info.append({"symbol": symbol, "accepted": False, "sequences": 0, "reason": "TIMESTAMPS_REQUIRED"})
            continue
        windows = np.lib.stride_tricks.sliding_window_view(features, window_shape=sequence_length, axis=0).transpose(0, 2, 1)
        windows = np.ascontiguousarray(windows, dtype=np.float32)
        y = np.asarray(labels[sequence_length - 1:], dtype=np.int64)
        ts = np.asarray(sample_times[sequence_length - 1:], dtype=np.float64)
        ends = np.asarray(label_end_times[sequence_length - 1:], dtype=np.float64)
        if len(windows) != len(y) or len(y) != len(ts) or len(ts) != len(ends):
            raise ValueError("V11_SEQUENCE_ALIGNMENT_INVALID")
        if not np.isfinite(windows).all():
            raise ValueError("V11_FEATURES_NONFINITE")
        sequences.append(windows); labels_all.append(y); times_all.append(ts); ends_all.append(ends)
        market_info.append({"symbol": symbol, "accepted": True, "bars": len(bars), "sequences": len(windows)})
    if not sequences:
        raise ValueError("V11_NO_MARKETS_WITH_SEQUENCE_HISTORY")
    return {"X": np.concatenate(sequences), "y": np.concatenate(labels_all),
        "sampleTimes": np.concatenate(times_all), "labelEndTimes": np.concatenate(ends_all),
        "markets": market_info, "sequenceLength": sequence_length, "featureCount": int(sequences[0].shape[-1])}


def split_masks(dataset: dict[str, Any], train_fraction: float, test_fraction: float):
    return service.global_temporal_split_masks(dataset["sampleTimes"], dataset["labelEndTimes"],
        train_fraction=train_fraction, test_fraction=test_fraction)


def _scale_windows(train: np.ndarray, other: np.ndarray):
    scaler = StandardScaler().fit(train.reshape(-1, train.shape[-1]))
    a = scaler.transform(train.reshape(-1, train.shape[-1])).reshape(train.shape).astype(np.float32)
    b = scaler.transform(other.reshape(-1, other.shape[-1])).reshape(other.shape).astype(np.float32)
    return a, b


def pretrain_and_finetune(train_x: np.ndarray, train_y: np.ndarray, eval_x: np.ndarray,
                          pretrain_epochs: int = PRETRAIN_EPOCHS, finetune_epochs: int = FINETUNE_EPOCHS) -> np.ndarray:
    X, E, y = np.asarray(train_x, dtype=np.float32), np.asarray(eval_x, dtype=np.float32), np.asarray(train_y, dtype=np.int64)
    if X.ndim != 3 or E.ndim != 3 or X.shape[1:] != E.shape[1:] or len(X) != len(y) or len(X) < 90 or len(E) < 1:
        raise ValueError("V11_TRAINING_INPUT_INVALID")
    if not np.isfinite(X).all() or not np.isfinite(E).all():
        raise ValueError("V11_NONFINITE_INPUT")
    if not (1 <= pretrain_epochs <= 60 and 1 <= finetune_epochs <= 60):
        raise ValueError("V11_EPOCHS_INVALID")
    Xs, Es = _scale_windows(X, E)
    torch.manual_seed(RANDOM_SEED); np.random.seed(RANDOM_SEED); torch.set_num_threads(1)
    model = MaskedMarketEncoder(X.shape[-1], X.shape[1])
    optimizer = torch.optim.AdamW([p for n, p in model.named_parameters() if not n.startswith("classifier.")],
        lr=0.0008, weight_decay=0.0005)
    loader = DataLoader(TensorDataset(torch.from_numpy(Xs)), batch_size=min(BATCH_SIZE, len(Xs)), shuffle=True,
        generator=torch.Generator().manual_seed(RANDOM_SEED))
    model.train()
    for _ in range(pretrain_epochs):
        for (batch,) in loader:
            mask = torch.rand(batch.shape[:2]) < 0.20
            empty = ~mask.any(dim=1)
            if empty.any():
                mask[empty, -1] = True
            prediction = model.reconstruct(batch, mask)
            loss = F.smooth_l1_loss(prediction[mask], batch[mask])
            optimizer.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); optimizer.step()
    encoded_y = torch.tensor([service.LABEL_TO_INDEX[int(v)] for v in y], dtype=torch.long)
    counts = torch.bincount(encoded_y, minlength=3).float()
    weights = len(y) / counts.clamp_min(1.0); weights = weights / weights.mean()
    loss_fn = nn.CrossEntropyLoss(weight=weights)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.0005, weight_decay=0.001)
    supervised = DataLoader(TensorDataset(torch.from_numpy(Xs), encoded_y), batch_size=min(BATCH_SIZE, len(Xs)),
        shuffle=True, generator=torch.Generator().manual_seed(RANDOM_SEED + 1))
    model.train()
    for _ in range(finetune_epochs):
        for batch, target in supervised:
            loss = loss_fn(model(batch), target)
            optimizer.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); optimizer.step()
    model.eval()
    with torch.no_grad():
        probabilities = torch.softmax(model(torch.from_numpy(Es)), dim=1).cpu().numpy()
    if probabilities.shape != (len(E), 3) or not np.isfinite(probabilities).all():
        raise ValueError("V11_PREDICTION_OUTPUT_INVALID")
    return probabilities


def matched_v9_probabilities(train_x: np.ndarray, train_y: np.ndarray, eval_x: np.ndarray, eval_y: np.ndarray) -> np.ndarray:
    from sklearn.ensemble import RandomForestClassifier
    X_train, X_eval, y = np.asarray(train_x[:, -1, :], dtype=np.float32), np.asarray(eval_x[:, -1, :], dtype=np.float32), np.asarray(train_y, dtype=np.int64)
    scaler = StandardScaler().fit(X_train)
    rf = RandomForestClassifier(n_estimators=120, max_depth=8, min_samples_leaf=3,
        class_weight="balanced_subsample", random_state=42, n_jobs=1).fit(X_train, y)
    rf_prob = np.zeros((len(X_eval), 3), dtype=np.float64)
    for col, cls in enumerate(rf.classes_):
        rf_prob[:, service.LABEL_TO_INDEX[int(cls)]] = rf.predict_proba(X_eval)[:, col]
    # eval_y is used only for diagnostic metrics; train_torch never uses it for updates.
    mlp, _ = service.train_torch(X_train, y, X_eval, np.asarray(eval_y, dtype=np.int64), scaler,
        np.ones(len(X_train), dtype=np.float32))
    with torch.no_grad():
        mlp_prob = torch.softmax(mlp(torch.from_numpy(scaler.transform(X_eval).astype(np.float32))), dim=1).numpy()
    return 0.55 * rf_prob + 0.45 * mlp_prob


def metrics(y_true: np.ndarray, probabilities: np.ndarray) -> dict[str, Any]:
    from sklearn.metrics import accuracy_score, balanced_accuracy_score, f1_score, recall_score
    actual = np.asarray([service.LABEL_TO_INDEX[int(v)] for v in y_true], dtype=np.int64)
    predicted = probabilities.argmax(axis=1)
    recall = recall_score(actual, predicted, labels=[0, 1, 2], average=None, zero_division=0)
    class_recall = {name: float(recall[i]) for i, name in enumerate(("SELL", "HOLD", "BUY"))}
    ba = float(balanced_accuracy_score(actual, predicted))
    f1 = float(f1_score(actual, predicted, labels=[0, 1, 2], average="macro", zero_division=0))
    coverage = all(v > 0 for v in class_recall.values())
    enough = len(actual) >= MIN_TEST_SAMPLES
    return {"accuracy": float(accuracy_score(actual, predicted)), "balancedAccuracy": ba, "macroF1": f1,
        "classRecall": class_recall, "testSamples": int(len(actual)), "classCoverageGate": coverage,
        "metricGate": enough and ba >= MIN_BA and f1 >= MIN_MACRO_F1, "qualityGate": enough and coverage and ba >= MIN_BA and f1 >= MIN_MACRO_F1,
        "selectionScore": 0.60 * ba + 0.40 * f1}


def run_fold(dataset: dict[str, Any], train_fraction: float, test_fraction: float) -> dict[str, Any]:
    train_mask, test_mask, cutoff = split_masks(dataset, train_fraction, test_fraction)
    if train_mask.sum() < 90 or test_mask.sum() < MIN_TEST_SAMPLES:
        raise ValueError("V11_FOLD_SAMPLE_COVERAGE_INSUFFICIENT")
    X, y = dataset["X"], dataset["y"]
    train_x, train_y, test_x, test_y = X[train_mask], y[train_mask], X[test_mask], y[test_mask]
    ssl = pretrain_and_finetune(train_x, train_y, test_x)
    baseline = matched_v9_probabilities(train_x, train_y, test_x, test_y)
    return {"cutoffTimestamp": float(cutoff), "trainSamples": int(len(train_y)),
        "ssl": metrics(test_y, ssl), "v9MatchedBaseline": metrics(test_y, baseline)}


def run_pilot(strategy: str, timeframe: str, markets: list[dict[str, Any]]) -> dict[str, Any]:
    dataset = build_dataset(markets, strategy)
    development = run_fold(dataset, 0.70, 0.85)
    final = run_fold(dataset, 0.85, 1.0) if development["ssl"]["qualityGate"] else None
    delta, candidate = None, False
    if final:
        delta = final["ssl"]["selectionScore"] - final["v9MatchedBaseline"]["selectionScore"]
        candidate = final["ssl"]["qualityGate"] and delta >= MIN_SCORE_DELTA
    return {"strategy": strategy, "timeframe": timeframe,
        "status": "RESEARCH_CANDIDATE_PASS" if candidate else ("FINAL_REJECTED" if final else "DEVELOPMENT_REJECTED"),
        "marketCoverage": dataset["markets"], "sequenceLength": dataset["sequenceLength"],
        "featureCount": dataset["featureCount"], "pretraining": "masked time-step reconstruction",
        "pretrainEpochs": PRETRAIN_EPOCHS, "finetuneEpochs": FINETUNE_EPOCHS,
        "development": development, "final": final, "selectionScoreDeltaVsV9": delta,
        "requiredImprovementMargin": MIN_SCORE_DELTA, "passesFinalResearchGate": candidate,
        "promotion": "NONE_RESEARCH_ONLY"}
