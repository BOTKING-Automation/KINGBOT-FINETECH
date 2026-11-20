import test from "node:test";
import assert from "node:assert/strict";
import { databaseSslOptions } from "../src/database-ssl.js";

const remoteUrl = "postgresql://kingbot:secret@ep-example.eu-central-1.aws.neon.tech/kingbot?sslmode=require";
const localComposeUrl = "postgresql://kingbot:secret@postgres:5432/kingbot";

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

test("production never disables certificate verification for a loopback URL", () => {
  assert.deepEqual(
    databaseSslOptions("postgresql://127.0.0.1:5432/kingbot", { nodeEnv: "production" }),
    { rejectUnauthorized: true }
  );
});

test("isolated Compose database may disable TLS only with both explicit opt-ins", () => {
  assert.equal(databaseSslOptions(localComposeUrl, {
    nodeEnv: "production",
    sslMode: "disable",
    trustedLocalDb: "1"
  }), false);
});

test("Compose database still verifies TLS if either opt-in is absent", () => {
  assert.deepEqual(databaseSslOptions(localComposeUrl, {
    nodeEnv: "production",
    sslMode: "disable",
    trustedLocalDb: "0"
  }), { rejectUnauthorized: true });
  assert.deepEqual(databaseSslOptions(localComposeUrl, {
    nodeEnv: "production",
    sslMode: "require",
    trustedLocalDb: "1"
  }), { rejectUnauthorized: true });
});

test("the local TLS exception never applies to remote database hosts", () => {
  assert.deepEqual(databaseSslOptions(remoteUrl, {
    nodeEnv: "production",
    sslMode: "disable",
    trustedLocalDb: "1"
  }), { rejectUnauthorized: true });
});

test("invalid database URLs fail closed", () => {
  assert.throws(
    () => databaseSslOptions("not-a-postgres-url", { nodeEnv: "production" }),
    /DATABASE_URL_MUST_BE_A_VALID_POSTGRES_URL/
  );
});
