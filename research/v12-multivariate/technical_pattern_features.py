"""Causal OHLC-only SMC and technical-pattern features for KINGBOT V12.3 research.

Every event is emitted no earlier than the close of the candle that confirms it.
Swing pivots use a two-bar right confirmation; no value is backfilled onto the pivot
candle. This module is research-only and does not alter production inference.
"""
from __future__ import annotations

from typing import Any
import math
import numpy as np

SMC_FEATURE_NAMES = (
    "swing_high_confirmed", "swing_low_confirmed",
    "bos_up", "bos_down", "choch_up", "choch_down",
    "liquidity_sweep_high", "liquidity_sweep_low",
    "equal_highs", "equal_lows",
    "fvg_bull", "fvg_bear", "fvg_gap_atr",
    "order_block_bull", "order_block_bear",
    "premium_discount",
)

CANDLE_FEATURE_NAMES = (
    "doji", "hammer", "shooting_star",
    "bullish_engulfing", "bearish_engulfing",
    "inside_bar", "outside_bar",
    "bullish_marubozu", "bearish_marubozu",
    "body_to_range", "upper_wick_ratio", "lower_wick_ratio",
)

CHART_PATTERN_FEATURE_NAMES = (
    "double_top_breakdown", "double_bottom_breakout",
    "head_shoulders_breakdown", "inverse_head_shoulders_breakout",
    "ascending_triangle_breakout", "descending_triangle_breakdown",
    "sym_triangle_state", "rising_wedge_state", "falling_wedge_state",
    "bull_flag_breakout", "bear_flag_breakdown",
    "range_position_32", "range_compression_20_60",
    "breakout_up", "breakout_down", "retest_up", "retest_down",
)

FEATURE_NAMES = SMC_FEATURE_NAMES + CANDLE_FEATURE_NAMES + CHART_PATTERN_FEATURE_NAMES
SMC_INDICES = tuple(range(len(SMC_FEATURE_NAMES)))
TECHNICAL_PATTERN_INDICES = tuple(range(len(SMC_FEATURE_NAMES), len(FEATURE_NAMES)))
FULL_INDICES = tuple(range(len(FEATURE_NAMES)))


def _finite(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else fallback
    except (TypeError, ValueError):
        return fallback


def _atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, index: int, period: int = 14) -> float:
    start = max(1, index - period + 1)
    if index < start or index < 1:
        return 0.0
    h, l, prev = high[start:index + 1], low[start:index + 1], close[start - 1:index]
    tr = np.maximum(h - l, np.maximum(np.abs(h - prev), np.abs(l - prev)))
    return float(np.mean(tr)) if len(tr) else 0.0


def _slope(points: list[tuple[int, float]], atr_value: float) -> float:
    if len(points) < 3 or atr_value <= 0:
        return 0.0
    x = np.asarray([item[0] for item in points[-4:]], dtype=np.float64)
    y = np.asarray([item[1] for item in points[-4:]], dtype=np.float64)
    if len(np.unique(x)) < 2:
        return 0.0
    return float(np.polyfit(x - x[-1], y / atr_value, 1)[0])


def compute_pattern_feature_matrix(bars: list[dict[str, Any]], *, pivot_depth: int = 2) -> np.ndarray:
    """Return one causal SMC/TA feature vector per input bar (including warm-up rows).

    Swing highs/lows are only announced on the confirmation candle, not at the
    historical pivot candle. Pattern breakouts are likewise emitted on their
    confirmation candle. All numeric values are finite and bounded where practical.
    """
    if not isinstance(bars, list) or pivot_depth != 2:
        raise ValueError("V123_PATTERN_INPUT_INVALID")
    n = len(bars)
    if n == 0:
        return np.zeros((0, len(FEATURE_NAMES)), dtype=np.float32)

    o = np.asarray([_finite(b.get("open")) for b in bars], dtype=np.float64)
    h = np.asarray([_finite(b.get("high")) for b in bars], dtype=np.float64)
    l = np.asarray([_finite(b.get("low")) for b in bars], dtype=np.float64)
    c = np.asarray([_finite(b.get("close")) for b in bars], dtype=np.float64)
    if not (np.isfinite(o).all() and np.isfinite(h).all() and np.isfinite(l).all() and np.isfinite(c).all()):
        raise ValueError("V123_PATTERN_NONFINITE_OHLC")
    if np.any(o <= 0) or np.any(h < np.maximum.reduce([o, l, c])) or np.any(l > np.minimum.reduce([o, h, c])):
        raise ValueError("V123_PATTERN_OHLC_INVALID")

    output = np.zeros((n, len(FEATURE_NAMES)), dtype=np.float32)
    swing_highs: list[tuple[int, float]] = []
    swing_lows: list[tuple[int, float]] = []
    structure_direction = 0
    previous_close = c[0]

    for i in range(n):
        atr_value = _atr(h, l, c, i)
        safe_atr = max(atr_value, max(abs(c[i]) * 1e-8, 1e-12))
        new_swing_high = False
        new_swing_low = False
        pivot = i - pivot_depth
        if pivot >= pivot_depth:
            left_h = h[pivot - pivot_depth:pivot]
            right_h = h[pivot + 1:i + 1]
            left_l = l[pivot - pivot_depth:pivot]
            right_l = l[pivot + 1:i + 1]
            if h[pivot] >= np.max(left_h) and h[pivot] > np.max(right_h):
                swing_highs.append((pivot, float(h[pivot])))
                new_swing_high = True
            if l[pivot] <= np.min(left_l) and l[pivot] < np.min(right_l):
                swing_lows.append((pivot, float(l[pivot])))
                new_swing_low = True

        if len(swing_highs) > 12:
            swing_highs = swing_highs[-12:]
        if len(swing_lows) > 12:
            swing_lows = swing_lows[-12:]

        last_sh = swing_highs[-1][1] if swing_highs else None
        last_sl = swing_lows[-1][1] if swing_lows else None
        bos_up = bool(last_sh is not None and c[i] > last_sh and previous_close <= last_sh)
        bos_down = bool(last_sl is not None and c[i] < last_sl and previous_close >= last_sl)
        choch_up = bool(bos_up and structure_direction < 0)
        choch_down = bool(bos_down and structure_direction > 0)
        if bos_up:
            structure_direction = 1
        elif bos_down:
            structure_direction = -1

        sweep_high = bool(last_sh is not None and h[i] > last_sh and c[i] < last_sh)
        sweep_low = bool(last_sl is not None and l[i] < last_sl and c[i] > last_sl)
        equal_highs = bool(len(swing_highs) >= 2 and abs(swing_highs[-1][1] - swing_highs[-2][1]) <= 0.30 * safe_atr)
        equal_lows = bool(len(swing_lows) >= 2 and abs(swing_lows[-1][1] - swing_lows[-2][1]) <= 0.30 * safe_atr)

        fvg_bull = bool(i >= 2 and l[i] > h[i - 2])
        fvg_bear = bool(i >= 2 and h[i] < l[i - 2])
        gap_atr = ((l[i] - h[i - 2]) if fvg_bull else (l[i - 2] - h[i]) if fvg_bear else 0.0) / safe_atr

        body = abs(c[i] - o[i])
        candle_range = max(h[i] - l[i], safe_atr * 1e-8)
        upper_wick = max(0.0, h[i] - max(o[i], c[i]))
        lower_wick = max(0.0, min(o[i], c[i]) - l[i])
        body_ratio = body / candle_range
        upper_ratio = upper_wick / candle_range
        lower_ratio = lower_wick / candle_range
        doji = body_ratio <= 0.10
        hammer = lower_wick >= 2.0 * max(body, candle_range * 0.03) and upper_ratio <= 0.30 and body_ratio <= 0.45
        shooting_star = upper_wick >= 2.0 * max(body, candle_range * 0.03) and lower_ratio <= 0.30 and body_ratio <= 0.45
        if i >= 1:
            prev_body_low, prev_body_high = sorted((o[i - 1], c[i - 1]))
            body_low, body_high = sorted((o[i], c[i]))
            bullish_engulfing = bool(c[i] > o[i] and c[i - 1] < o[i - 1] and body_low <= prev_body_low and body_high >= prev_body_high)
            bearish_engulfing = bool(c[i] < o[i] and c[i - 1] > o[i - 1] and body_low <= prev_body_low and body_high >= prev_body_high)
            inside_bar = bool(h[i] <= h[i - 1] and l[i] >= l[i - 1])
            outside_bar = bool(h[i] > h[i - 1] and l[i] < l[i - 1])
        else:
            bullish_engulfing = bearish_engulfing = inside_bar = outside_bar = False
        bullish_marubozu = bool(c[i] > o[i] and body_ratio >= 0.85)
        bearish_marubozu = bool(c[i] < o[i] and body_ratio >= 0.85)

        ob_bull = ob_bear = False
        if i >= 1 and (bos_up or choch_up) and body >= 0.80 * safe_atr:
            for j in range(i - 1, max(-1, i - 7), -1):
                if c[j] < o[j] and c[i] > h[j]:
                    ob_bull = True
                    break
        if i >= 1 and (bos_down or choch_down) and body >= 0.80 * safe_atr:
            for j in range(i - 1, max(-1, i - 7), -1):
                if c[j] > o[j] and c[i] < l[j]:
                    ob_bear = True
                    break

        start32 = max(0, i - 31)
        hi32, lo32 = float(np.max(h[start32:i + 1])), float(np.min(l[start32:i + 1]))
        range_position32 = 2.0 * (c[i] - lo32) / max(hi32 - lo32, safe_atr * 1e-8) - 1.0
        start64 = max(0, i - 63)
        hi64, lo64 = float(np.max(h[start64:i + 1])), float(np.min(l[start64:i + 1]))
        premium_discount = 2.0 * (c[i] - lo64) / max(hi64 - lo64, safe_atr * 1e-8) - 1.0
        hi20_prev = float(np.max(h[max(0, i - 20):i])) if i >= 1 else h[i]
        lo20_prev = float(np.min(l[max(0, i - 20):i])) if i >= 1 else l[i]
        breakout_up = bool(i >= 20 and c[i] > hi20_prev and previous_close <= hi20_prev)
        breakout_down = bool(i >= 20 and c[i] < lo20_prev and previous_close >= lo20_prev)
        retest_up = bool(i >= 2 and c[i - 1] > np.max(h[max(0, i - 21):i - 1]) and l[i] <= c[i - 1] and c[i] >= c[i - 1])
        retest_down = bool(i >= 2 and c[i - 1] < np.min(l[max(0, i - 21):i - 1]) and h[i] >= c[i - 1] and c[i] <= c[i - 1])

        double_top = double_bottom = head_shoulders = inverse_hs = False
        if len(swing_highs) >= 2:
            h1, h2 = swing_highs[-2], swing_highs[-1]
            intervening_lows = [x for x in swing_lows if h1[0] < x[0] < h2[0]]
            if abs(h1[1] - h2[1]) <= 0.35 * safe_atr and intervening_lows:
                neckline = min(x[1] for x in intervening_lows)
                double_top = bool(c[i] < neckline and previous_close >= neckline)
        if len(swing_lows) >= 2:
            l1, l2 = swing_lows[-2], swing_lows[-1]
            intervening_highs = [x for x in swing_highs if l1[0] < x[0] < l2[0]]
            if abs(l1[1] - l2[1]) <= 0.35 * safe_atr and intervening_highs:
                neckline = max(x[1] for x in intervening_highs)
                double_bottom = bool(c[i] > neckline and previous_close <= neckline)
        if len(swing_highs) >= 3:
            p1, p2, p3 = swing_highs[-3:]
            lows_12 = [x for x in swing_lows if p1[0] < x[0] < p2[0]]
            lows_23 = [x for x in swing_lows if p2[0] < x[0] < p3[0]]
            if lows_12 and lows_23:
                shoulder_tol = 0.40 * safe_atr
                neckline = (lows_12[-1][1] + lows_23[-1][1]) / 2.0
                head_shoulders = bool(abs(p1[1] - p3[1]) <= shoulder_tol and p2[1] > max(p1[1], p3[1]) + 0.25 * safe_atr and c[i] < neckline and previous_close >= neckline)
        if len(swing_lows) >= 3:
            p1, p2, p3 = swing_lows[-3:]
            highs_12 = [x for x in swing_highs if p1[0] < x[0] < p2[0]]
            highs_23 = [x for x in swing_highs if p2[0] < x[0] < p3[0]]
            if highs_12 and highs_23:
                shoulder_tol = 0.40 * safe_atr
                neckline = (highs_12[-1][1] + highs_23[-1][1]) / 2.0
                inverse_hs = bool(abs(p1[1] - p3[1]) <= shoulder_tol and p2[1] < min(p1[1], p3[1]) - 0.25 * safe_atr and c[i] > neckline and previous_close <= neckline)

        hi_slope = _slope(swing_highs, safe_atr)
        lo_slope = _slope(swing_lows, safe_atr)
        recent_h = [x[1] for x in swing_highs[-3:]]
        recent_l = [x[1] for x in swing_lows[-3:]]
        asc_triangle = desc_triangle = sym_triangle = rising_wedge = falling_wedge = False
        if len(recent_h) == 3 and len(recent_l) == 3:
            resistance = max(recent_h)
            support = min(recent_l)
            asc_triangle = bool(abs(hi_slope) <= 0.025 and lo_slope > 0.025 and c[i] > resistance and previous_close <= resistance)
            desc_triangle = bool(abs(lo_slope) <= 0.025 and hi_slope < -0.025 and c[i] < support and previous_close >= support)
            sym_triangle = bool(hi_slope < -0.02 and lo_slope > 0.02 and recent_h[-1] < recent_h[0] and recent_l[-1] > recent_l[0])
            rising_wedge = bool(hi_slope > 0.02 and lo_slope > hi_slope + 0.02)
            falling_wedge = bool(lo_slope < -0.02 and hi_slope < lo_slope - 0.02)

        bull_flag = bear_flag = False
        if i >= 18:
            impulse_up = (c[i - 5] - c[i - 12]) / safe_atr
            impulse_down = (c[i - 5] - c[i - 12]) / safe_atr
            flag_range = float(np.max(h[i - 5:i]) - np.min(l[i - 5:i]))
            if flag_range <= 1.8 * safe_atr:
                bull_flag = bool(impulse_up >= 1.5 and c[i] > np.max(h[i - 5:i]))
                bear_flag = bool(impulse_down <= -1.5 and c[i] < np.min(l[i - 5:i]))

        range20 = float(np.max(h[max(0, i - 19):i + 1]) - np.min(l[max(0, i - 19):i + 1]))
        range60 = float(np.max(h[max(0, i - 59):i + 1]) - np.min(l[max(0, i - 59):i + 1]))
        compression = range20 / max(range60, safe_atr * 1e-8)

        values = [
            float(new_swing_high), float(new_swing_low),
            float(bos_up), float(bos_down), float(choch_up), float(choch_down),
            float(sweep_high), float(sweep_low), float(equal_highs), float(equal_lows),
            float(fvg_bull), float(fvg_bear), float(np.clip(gap_atr, 0.0, 4.0) / 4.0),
            float(ob_bull), float(ob_bear), float(np.clip(premium_discount, -1.0, 1.0)),
            float(doji), float(hammer), float(shooting_star),
            float(bullish_engulfing), float(bearish_engulfing), float(inside_bar), float(outside_bar),
            float(bullish_marubozu), float(bearish_marubozu), float(np.clip(body_ratio, 0.0, 1.0)),
            float(np.clip(upper_ratio, 0.0, 1.0)), float(np.clip(lower_ratio, 0.0, 1.0)),
            float(double_top), float(double_bottom), float(head_shoulders), float(inverse_hs),
            float(asc_triangle), float(desc_triangle), float(sym_triangle),
            float(rising_wedge), float(falling_wedge), float(bull_flag), float(bear_flag),
            float(np.clip(range_position32, -1.0, 1.0)), float(np.clip(compression, 0.0, 2.0) / 2.0),
            float(breakout_up), float(breakout_down), float(retest_up), float(retest_down),
        ]
        if len(values) != len(FEATURE_NAMES) or not np.isfinite(values).all():
            raise ValueError("V123_PATTERN_FEATURE_OUTPUT_INVALID")
        output[i] = np.asarray(values, dtype=np.float32)
        previous_close = c[i]

    return output


def select_feature_columns(base_features: np.ndarray, pattern_features: np.ndarray, variant: str) -> np.ndarray:
    """Append only the feature group selected by a predeclared research ablation."""
    base = np.asarray(base_features, dtype=np.float32)
    patterns = np.asarray(pattern_features, dtype=np.float32)
    if base.ndim != 3 or patterns.ndim != 3 or base.shape[:2] != patterns.shape[:2]:
        raise ValueError("V123_FEATURE_ALIGNMENT_INVALID")
    if variant == "baseline":
        return base.copy()
    if variant == "smc_only":
        indices = SMC_INDICES
    elif variant == "technical_patterns_only":
        indices = TECHNICAL_PATTERN_INDICES
    elif variant == "full_cortex":
        indices = FULL_INDICES
    else:
        raise ValueError("V123_FEATURE_VARIANT_INVALID")
    return np.concatenate((base, patterns[:, :, indices]), axis=2).astype(np.float32)
