const MAX_LABEL_LENGTH = 80;
const SYMBOL_PATTERN = /^[A-Z0-9._:-]{3,40}$/;
const ALLOWED_COST_SOURCES = new Set([
  "broker_published_specification",
  "client_confirmed",
  "estimate"
]);

function cleanLabel(value, maxLength = MAX_LABEL_LENGTH) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[\\u0000-\\u001F\\u007F]/g, "").slice(0, maxLength);
}

/**
 * Normalizes client-selected execution metadata for research reports only.
 * It does not connect to a broker, authenticate a broker account, or verify costs.
 */
export function normalizeClientExecutionProfile(raw) {
  const requiredFields = ["broker", "accountType", "brokerSymbol", "costsSource"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "ML_BACKTEST_EXECUTION_PROFILE_REQUIRED", requiredFields };
  }

  const broker = cleanLabel(raw.broker);
  const accountType = cleanLabel(raw.accountType);
  const brokerSymbol = cleanLabel(raw.brokerSymbol).toUpperCase();
  const costsSource = cleanLabel(raw.costsSource, 48).toLowerCase();

  const missingFields = [];
  if (!broker) missingFields.push("broker");
  if (!accountType) missingFields.push("accountType");
  if (!brokerSymbol) missingFields.push("brokerSymbol");
  if (!costsSource) missingFields.push("costsSource");
  if (missingFields.length) {
    return { ok: false, error: "ML_BACKTEST_EXECUTION_PROFILE_INCOMPLETE", requiredFields: missingFields };
  }
  if (broker.length > MAX_LABEL_LENGTH || accountType.length > MAX_LABEL_LENGTH
      || !SYMBOL_PATTERN.test(brokerSymbol)) {
    return { ok: false, error: "ML_BACKTEST_EXECUTION_PROFILE_INVALID", requiredFields };
  }
  if (!ALLOWED_COST_SOURCES.has(costsSource)) {
    return {
      ok: false,
      error: "ML_BACKTEST_COST_SOURCE_INVALID",
      requiredFields: ["costsSource: broker_published_specification | client_confirmed | estimate"]
    };
  }

  return {
    ok: true,
    profile: { broker, accountType, brokerSymbol, costsSource }
  };
}
