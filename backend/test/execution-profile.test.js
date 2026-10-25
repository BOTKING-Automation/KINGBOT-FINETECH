import test from "node:test";
import assert from "node:assert/strict";
import { normalizeClientExecutionProfile } from "../src/execution-profile.js";

test("accepts client-selected broker, account type, symbol mapping, and cost source without a vendor allow-list", () => {
  const result = normalizeClientExecutionProfile({
    broker: "A broker selected by the client",
    accountType: "Client's preferred account",
    brokerSymbol: "XAUUSDm",
    costsSource: "broker_published_specification"
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.profile, {
    broker: "A broker selected by the client",
    accountType: "Client's preferred account",
    brokerSymbol: "XAUUSDM",
    costsSource: "broker_published_specification"
  });
});

test("requires broker/account details and a source label for client-supplied costs", () => {
  const result = normalizeClientExecutionProfile({
    broker: "Broker",
    accountType: "Standard",
    brokerSymbol: "XAUUSD",
    costsSource: "random"
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "ML_BACKTEST_COST_SOURCE_INVALID");
});

test("rejects missing or malformed execution profile fields", () => {
  assert.equal(normalizeClientExecutionProfile(null).error, "ML_BACKTEST_EXECUTION_PROFILE_REQUIRED");
  assert.equal(normalizeClientExecutionProfile({
    broker: "Broker", accountType: "Standard", brokerSymbol: "bad symbol", costsSource: "estimate"
  }).error, "ML_BACKTEST_EXECUTION_PROFILE_INVALID");
});
