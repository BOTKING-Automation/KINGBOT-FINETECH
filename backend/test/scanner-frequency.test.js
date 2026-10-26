import test from "node:test";
import assert from "node:assert/strict";
import { resolveScannerIntervalMs } from "../src/ai-market-scanner.js";

test("scanner defaults to a responsive 2.5-second target cadence", () => {
  assert.equal(resolveScannerIntervalMs(""), 2500);
  assert.equal(resolveScannerIntervalMs("2500"), 2500);
});

test("scanner interval is clamped to protect market-data providers", () => {
  assert.equal(resolveScannerIntervalMs("1000"), 2500);
  assert.equal(resolveScannerIntervalMs("1500"), 2500);
  assert.equal(resolveScannerIntervalMs("6000"), 6000);
  assert.equal(resolveScannerIntervalMs("60000"), 30000);
});

test("invalid scanner interval configuration fails to a safe default", () => {
  assert.equal(resolveScannerIntervalMs("fast"), 2500);
  assert.equal(resolveScannerIntervalMs("-100"), 2500);
});
