import test from "node:test";
import assert from "node:assert/strict";
import { allowedOrigins, sameTenant, redactLogValue } from "../src/security.js";

test("sameTenant rejects missing or different ownership", () => {
  assert.equal(sameTenant({id:"user-a"}, "user-a"), true);
  assert.equal(sameTenant({id:"user-a"}, "user-b"), false);
  assert.equal(sameTenant(null, "user-a"), false);
  assert.equal(sameTenant({id:"user-a"}, ""), false);
});

test("redactLogValue removes control characters and caps length", () => {
  const value = redactLogValue("abc\nsecret\tdata\r", 8);
  assert.equal(value, "abc secret");
});

test("allowedOrigins never falls back to wildcard origin", () => {
  const origins = allowedOrigins();
  assert.equal(origins.has("*"), false);
  assert.equal(origins instanceof Set, true);
});
