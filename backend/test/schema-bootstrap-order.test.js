import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../src");
const read = (name) => fs.readFileSync(path.join(src, name), "utf8");

test("subscription base tables are created before audit integrity triggers", () => {
  const server = read("server.js");
  const auth = read("auth.js");
  const subscriptions = read("subscriptions.js");

  assert.match(auth, /CREATE TABLE IF NOT EXISTS kingbot_users/);
  assert.match(subscriptions, /CREATE TABLE IF NOT EXISTS kingbot_audit_log/);

  const authIndex = server.indexOf("ensureAuthSchema(pool)");
  const subscriptionIndex = server.indexOf("ensureSubscriptionSchema(pool)", authIndex);
  const auditIndex = server.indexOf("ensureAuditIntegritySchema(pool)", authIndex);
  assert.notEqual(authIndex, -1);
  assert.ok(subscriptionIndex > authIndex, "subscription schema must follow user schema");
  assert.ok(auditIndex > subscriptionIndex, "audit integrity must follow audit-log table creation");
});

test("route registration does not launch database schema migrations out of order", () => {
  const goldSignals = read("gold-signals.js");
  const scanner = read("ai-market-scanner.js");

  assert.doesNotMatch(goldSignals, /void\s+ensureGoldSignalsSchema\(pool\)/);
  assert.doesNotMatch(scanner, /void\s+ensureScannerSchema\(pool\)/);
});
