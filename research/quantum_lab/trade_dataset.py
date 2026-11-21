"""Strict loader for closed XAUUSD trade outcomes used by offline risk research."""
from __future__ import annotations
import csv
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SUPPORTED_SYMBOLS = {"XAUUSD", "XAUUSDm", "GOLD"}
DIRECT_NET_COLUMN = "net_pnl_after_costs_r"
COST_COLUMNS = {"gross_pnl_cash", "commission_cash", "swap_cash", "spread_cost_cash", "slippage_cost_cash", "initial_risk_cash"}
REQUIRED_COLUMNS = {"closed_at", "symbol"}

def _parse_timestamp(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise ValueError("XAUUSD_TRADE_CLOSED_AT_INVALID") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("XAUUSD_TRADE_CLOSED_AT_MUST_BE_TIMEZONE_AWARE")
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

def _finite_float(value: str, error_code: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(error_code) from exc
    if not math.isfinite(result):
        raise ValueError(error_code)
    return result

def load_xauusd_trade_csv(path: str | Path) -> dict[str, Any]:
    """Load a timezone-aware chronological XAUUSD CSV.

    Provide either net_pnl_after_costs_r, or all six cash ledger columns:
    gross_pnl_cash, commission_cash, swap_cash, spread_cost_cash,
    slippage_cost_cash, initial_risk_cash. Commission and swap are signed;
    spread and slippage are non-negative costs.
    """
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError("XAUUSD_TRADE_DATASET_FILE_NOT_FOUND")
    with file_path.open("r", newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        headers = set(reader.fieldnames or [])
        if not REQUIRED_COLUMNS.issubset(headers):
            raise ValueError("XAUUSD_TRADE_DATASET_REQUIRED_COLUMNS_MISSING")
        direct = DIRECT_NET_COLUMN in headers
        has_cost_fields = COST_COLUMNS.issubset(headers)
        any_cost_field = any(column in headers for column in COST_COLUMNS)
        if (direct and any_cost_field) or (not direct and not has_cost_fields):
            raise ValueError("XAUUSD_TRADE_DATASET_PNL_SCHEMA_AMBIGUOUS")
        records = []
        seen_ids: set[str] = set()
        previous_timestamp: str | None = None
        for row_number, row in enumerate(reader, start=2):
            symbol = (row.get("symbol") or "").strip()
            if symbol not in SUPPORTED_SYMBOLS:
                raise ValueError(f"XAUUSD_TRADE_DATASET_UNSUPPORTED_SYMBOL_ROW_{row_number}")
            closed_at = _parse_timestamp(row.get("closed_at") or "")
            if previous_timestamp is not None and closed_at < previous_timestamp:
                raise ValueError(f"XAUUSD_TRADE_DATASET_NOT_CHRONOLOGICAL_ROW_{row_number}")
            previous_timestamp = closed_at
            trade_id = (row.get("trade_id") or f"row-{row_number}").strip()
            if not trade_id or trade_id in seen_ids:
                raise ValueError(f"XAUUSD_TRADE_DATASET_DUPLICATE_TRADE_ID_ROW_{row_number}")
            seen_ids.add(trade_id)
            if direct:
                net_r = _finite_float(row.get(DIRECT_NET_COLUMN, ""), "XAUUSD_TRADE_NET_R_INVALID")
            else:
                gross = _finite_float(row.get("gross_pnl_cash", ""), "XAUUSD_TRADE_GROSS_PNL_INVALID")
                commission = _finite_float(row.get("commission_cash", ""), "XAUUSD_TRADE_COMMISSION_INVALID")
                swap = _finite_float(row.get("swap_cash", ""), "XAUUSD_TRADE_SWAP_INVALID")
                spread = _finite_float(row.get("spread_cost_cash", ""), "XAUUSD_TRADE_SPREAD_INVALID")
                slippage = _finite_float(row.get("slippage_cost_cash", ""), "XAUUSD_TRADE_SLIPPAGE_INVALID")
                risk = _finite_float(row.get("initial_risk_cash", ""), "XAUUSD_TRADE_INITIAL_RISK_INVALID")
                if spread < 0 or slippage < 0 or risk <= 0:
                    raise ValueError(f"XAUUSD_TRADE_COST_OR_RISK_INVALID_ROW_{row_number}")
                net_r = (gross + commission + swap - spread - slippage) / risk
            records.append({"trade_id": trade_id, "closed_at": closed_at, "symbol": "XAUUSD", "net_pnl_r": net_r})
    if not records:
        raise ValueError("XAUUSD_TRADE_DATASET_EMPTY")
    return {
        "schema_version": "kingbot-xauusd-closed-trades-v1",
        "mode": "OFFLINE_RESEARCH_ONLY",
        "instrument": "XAUUSD",
        "trade_count": len(records),
        "time_start": records[0]["closed_at"],
        "time_end": records[-1]["closed_at"],
        "pnl_semantics": "net_after_spread_commission_swap_slippage_in_R",
        "records": records,
        "can_generate_trade_signal": False,
        "can_place_order": False,
    }
