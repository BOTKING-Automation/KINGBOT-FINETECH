import { isSyntheticSymbol } from "./synthetic-markets.js";

export const AI_STRATEGY_BOTS = Object.freeze([
  "strategic", "flipper", "breakout", "smc-pro", "ladder-flip"
]);

export const BACKTEST_TIMEFRAME_SECONDS = Object.freeze({
  "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400, "1w": 604800
});

export function isAllowedBacktestSymbol(value) {
  const symbol = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9._:-]{3,40}$/.test(symbol)
    && !isSyntheticSymbol({ symbol });
}
