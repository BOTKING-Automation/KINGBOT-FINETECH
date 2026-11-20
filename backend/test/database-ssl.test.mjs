import test from "node:test";
import assert from "node:assert/strict";
import { databaseSslOptions } from "../src/database-ssl.js";

const remoteUrl = "postgresql://kingbot:secret@ep-example.eu-central-1.aws.neon.tech/kingbot?sslmode=require";

test("remote PostgreSQL connections verify TLS certificates in production", () => {
  assert.deepEqual(databaseSslOptions(remoteUrl, { nodeEnv: "production" }), {
    rejectUnauthorized: true
  });
});

test("remote PostgreSQL connections verify TLS certificates in development too", () => {
  assert.deepEqual(databaseSslOptions(remoteUrl, { nodeEnv: "development" }), {
    rejectUnauthorized: true
  });
});

test("local development PostgreSQL may use loopback without TLS", () => {
  assert.equal(
    databaseSslOptions("postgresql://localhost:5432/kingbot", { nodeEnv: "development" }),
    false
  );
});

test("production never disables certificate verification for loopback hosts", () => {
  assert.deepEqual(
    databaseSslOptions("postgresql://127.0.0.1:5432/kingbot", { nodeEnv: "production" }),
    { rejectUnauthorized: true }
  );
});

test("invalid database URLs fail closed", () => {
  assert.throws(
    () => databaseSslOptions("not-a-postgres-url", { nodeEnv: "production" }),
    /DATABASE_URL_MUST_BE_A_VALID_POSTGRES_URL/
  );
});
