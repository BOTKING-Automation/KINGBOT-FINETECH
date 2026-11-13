"""Deterministic classical Monte Carlo baselines for closed-trade risk."""
from __future__ import annotations
import math
import random
from typing import Any, Sequence

def _quantile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, math.ceil(q * len(ordered)) - 1))]

def run_classical_monte_carlo(
    net_pnl_r: Sequence[float],
    *,
    simulations: int = 20_000,
    horizon_trades: int = 20,
    ruin_loss_r: float = 3.0,
    block_length: int = 1,
    seed: int = 20261113,
) -> dict[str, Any]:
    """Bootstrap paths; block_length=1 is IID, larger values preserve local blocks."""
    if not net_pnl_r:
        raise ValueError("MC_TRADE_SAMPLES_EMPTY")
    if isinstance(simulations, bool) or not isinstance(simulations, int) or not 100 <= simulations <= 1_000_000:
        raise ValueError("MC_SIMULATION_COUNT_OUT_OF_RANGE")
    if isinstance(horizon_trades, bool) or not isinstance(horizon_trades, int) or not 1 <= horizon_trades <= 10_000:
        raise ValueError("MC_HORIZON_OUT_OF_RANGE")
    if isinstance(block_length, bool) or not isinstance(block_length, int) or not 1 <= block_length <= len(net_pnl_r):
        raise ValueError("MC_BLOCK_LENGTH_OUT_OF_RANGE")
    try:
        threshold = float(ruin_loss_r)
    except (TypeError, ValueError) as exc:
        raise ValueError("MC_RUIN_THRESHOLD_INVALID") from exc
    if not math.isfinite(threshold) or threshold <= 0:
        raise ValueError("MC_RUIN_THRESHOLD_INVALID")
    outcomes = [float(x) for x in net_pnl_r]
    if any(not math.isfinite(x) for x in outcomes):
        raise ValueError("MC_TRADE_SAMPLE_NOT_FINITE")
    rng = random.Random(seed)
    totals: list[float] = []
    maximum_drawdowns: list[float] = []
    n = len(outcomes)
    for _ in range(simulations):
        path: list[float] = []
        while len(path) < horizon_trades:
            start = rng.randrange(n)
            take = min(block_length, horizon_trades - len(path))
            path.extend(outcomes[(start + offset) % n] for offset in range(take))
        cumulative = 0.0
        peak = 0.0
        max_dd = 0.0
        for pnl in path:
            cumulative += pnl
            peak = max(peak, cumulative)
            max_dd = max(max_dd, peak - cumulative)
        totals.append(cumulative)
        maximum_drawdowns.append(max_dd)
    positive_losses = sorted(max(0.0, -value) for value in totals)
    tail_count = max(1, math.ceil(0.05 * simulations))
    return {
        "schema_version": "kingbot-classical-monte-carlo-v1",
        "mode": "OFFLINE_RESEARCH_ONLY",
        "method": "iid_bootstrap" if block_length == 1 else "circular_moving_block_bootstrap",
        "trade_sample_count": n,
        "simulations": simulations,
        "horizon_trades": horizon_trades,
        "block_length": block_length,
        "seed": seed,
        "ruin_loss_threshold_r": threshold,
        "probability_horizon_loss_exceeds_threshold": sum(x <= -threshold for x in totals) / simulations,
        "horizon_net_pnl_r": {
            "mean": sum(totals) / simulations,
            "p05": _quantile(totals, 0.05),
            "median": _quantile(totals, 0.50),
            "p95": _quantile(totals, 0.95),
        },
        "maximum_drawdown_r": {
            "p50": _quantile(maximum_drawdowns, 0.50),
            "p95": _quantile(maximum_drawdowns, 0.95),
        },
        "horizon_loss_var_95_r": _quantile(positive_losses, 0.95),
        "horizon_loss_cvar_95_r": sum(positive_losses[-tail_count:]) / tail_count,
        "limitations": [
            "Empirical bootstrap assumes historical trade outcomes remain relevant.",
            "IID mode ignores serial dependence; block mode preserves only local blocks.",
            "Results are not a model acceptance or live risk-limit decision.",
        ],
        "can_generate_trade_signal": False,
        "can_place_order": False,
    }
