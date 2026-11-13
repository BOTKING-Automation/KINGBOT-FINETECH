import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  calculatePaystackAmountKes,
  getPaystackConfig,
  paystackAmountSubunit,
  paystackStatus,
  verifyPaystackWebhookSignature
} from "../src/paystack.js";

const testEnv = {
  PAYSTACK_MODE: "test",
  PAYSTACK_SECRET_KEY: "sk_test_1234567890abcdef",
  PAYSTACK_WEBHOOK_SECRET: "whsec_1234567890abcdef",
  PAYSTACK_USD_KES_RATE: "130",
  PAYSTACK_CALLBACK_URL: "https://example.com/subscription.html?gateway=paystack"
};

test("Paystack status enables only a fully configured test checkout", () => {
  assert.equal(getPaystackConfig(testEnv).configured, true);
  assert.equal(paystackStatus(testEnv).mode, "test");
  assert.equal(paystackStatus(testEnv).configured, true);
  assert.equal(getPaystackConfig({ ...testEnv, PAYSTACK_SECRET_KEY: "sk_live_1234567890abcdef" }).configured, false);
  assert.equal(getPaystackConfig({ ...testEnv, PAYSTACK_WEBHOOK_SECRET: "" }).configured, false);
  assert.equal(getPaystackConfig({ ...testEnv, PAYSTACK_USD_KES_RATE: "" }).configured, false);
});

test("server-side KES quotes preserve the 30 percent three-month discount", () => {
  assert.equal(calculatePaystackAmountKes(350, 1, 130), 45500);
  assert.equal(calculatePaystackAmountKes(350, 3, 130), 95550);
  assert.equal(paystackAmountSubunit(45500), 4550000);
  assert.throws(() => calculatePaystackAmountKes(350, 6, 130), /PAYSTACK_PRICE_CONFIGURATION_INVALID/);
});

test("Paystack webhook v1 signatures validate raw bytes and reject stale timestamps", () => {
  const rawBody = Buffer.from('{"event":"charge.success","data":{"reference":"KB-12345678"}}');
  const timestamp = 1760000000;
  const digest = crypto.createHmac("sha512", testEnv.PAYSTACK_WEBHOOK_SECRET)
    .update(String(timestamp) + ".")
    .update(rawBody)
    .digest("hex");
  const header = "t=" + timestamp + ",v1=whk_test123:" + digest;

  assert.equal(verifyPaystackWebhookSignature({ rawBody, signatureHeader: header, env: testEnv, now: timestamp }), true);
  assert.equal(verifyPaystackWebhookSignature({ rawBody, signatureHeader: header, env: testEnv, now: timestamp + 301 }), false);
  assert.equal(verifyPaystackWebhookSignature({ rawBody: Buffer.from("tampered"), signatureHeader: header, env: testEnv, now: timestamp }), false);
});

test("legacy Paystack signatures are also validated with the test secret", () => {
  const rawBody = Buffer.from('{"event":"charge.success"}');
  const signature = crypto.createHmac("sha512", testEnv.PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
  assert.equal(verifyPaystackWebhookSignature({ rawBody, legacySignature: signature, env: testEnv }), true);
});
