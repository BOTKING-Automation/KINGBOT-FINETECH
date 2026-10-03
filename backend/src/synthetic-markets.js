const SYNTHETIC_FAMILIES = [
  { id:"volatility", label:"VOLATILITY INDICES", match:/^volatility|^1hz\d+v$|^r_\d+$/i },
  { id:"crash-boom", label:"CRASH / BOOM", match:/^(crash|boom)/i },
  { id:"jump", label:"JUMP INDICES", match:/^jump/i },
  { id:"step", label:"STEP INDICES", match:/^step|^multi step|^skew step/i },
  { id:"range-break", label:"RANGE BREAK", match:/^range break/i },
  { id:"basket", label:"BASKET INDICES", match:/basket/i },
  { id:"dex", label:"DEX INDICES", match:/^dex /i },
  { id:"hybrid", label:"HYBRID INDICES", match:/^(vol over|volatility over)/i },
  { id:"drift-switch", label:"DRIFT SWITCH", match:/^drift switch/i },
  { id:"tactical", label:"TACTICAL INDICES", match:/trend up|trend down|rebound|reversal|retrace|momentum/i },
  { id:"other", label:"OTHER SYNTHETICS", match:/.*/i }
];

const normalizeName = value => String(value || "").replace(/\s+/g," ").trim();

export function classifySyntheticSymbol(row = {}) {
  const name = normalizeName(row.underlying_symbol_name || row.display_name || row.market_display_name || row.symbol_name || "");
  const symbol = String(row.underlying_symbol || row.symbol || row.display_symbol || "").trim();
  const text = name || symbol;
  const family = SYNTHETIC_FAMILIES.find(item => item.match.test(text)) || SYNTHETIC_FAMILIES.at(-1);
  return {
    symbol,
    name: name || symbol,
    family: family.id,
    familyLabel: family.label,
    marketType: "SYNTHETIC",
    source: "DERIV_ACTIVE_SYMBOLS"
  };
}

export function isSyntheticSymbol(row = {}) {
  const symbol = classifySyntheticSymbol(row);
  return Boolean(symbol.symbol) && symbol.family !== "other"
    || /^(R_|1HZ|BOOM|CRASH|JUMP|STPRNG|STEP|RB|DEX)/i.test(symbol.symbol || "");
}

export function syntheticCatalog(rows = []) {
  const items = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isSyntheticSymbol(row)) continue;
    const item = classifySyntheticSymbol(row);
    if (!item.symbol || seen.has(item.symbol)) continue;
    seen.add(item.symbol);
    items.push(item);
  }
  return items.sort((a,b) => a.familyLabel.localeCompare(b.familyLabel) || a.name.localeCompare(b.name));
}

export const CORE_SYNTHETIC_FAMILIES = SYNTHETIC_FAMILIES
  .filter(x => x.id !== "other")
  .map(x => ({ id:x.id, label:x.label }));
