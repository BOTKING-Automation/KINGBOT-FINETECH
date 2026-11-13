import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  calculatePaystackAmountKes,
  getPaystackConfig,
  initializePaystackTransaction,
  paystackAmountSubunit,
  paystackStatus,
  verifyPaystackTransaction,
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


test("Paystack initialization sends the server-calculated KES subunits and validates the hosted checkout URL", async () => {
  let captured = null;
  const checkout = await initializePaystackTransaction({
    email: "customer@example.com",
    amountKes: calculatePaystackAmountKes(350, 1, 130),
    reference: "KB1760000000000-aabbccddeeff11",
    metadata: { kingbot_payment_id: "payment-1" },
    env: testEnv,
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          status: true,
          data: {
            authorization_url: "https://checkout.paystack.com/abc123",
            reference: "KB1760000000000-aabbccddeeff11"
          }
        })
      };
    }
  });

  assert.equal(captured.url, "https://api.paystack.co/transaction/initialize");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers.Authorization, "Bearer " + testEnv.PAYSTACK_SECRET_KEY);
  assert.equal(captured.body.amount, "4550000");
  assert.equal(captured.body.currency, "KES");
  assert.equal(captured.body.metadata.kingbot_payment_id, "payment-1");
  assert.equal(checkout.authorization_url, "https://checkout.paystack.com/abc123");

  await assert.rejects(
    initializePaystackTransaction({
      email: "customer@example.com",
      amountKes: 45500,
      reference: "KB1760000000000-aabbccddeeff11",
      env: testEnv,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          status: true,
          data: {
            authorization_url: "https://attacker.example/checkout",
            reference: "KB1760000000000-aabbccddeeff11"
          }
        })
      })
    }),
    /PAYSTACK_CHECKOUT_RESPONSE_INVALID/
  );
});

test("Paystack verification requests the transaction by its encoded reference", async () => {
  let requestedUrl = "";
  const result = await verifyPaystackTransaction({
    reference: "KB1760000000000-aabbccddeeff11",
    env: testEnv,
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      assert.equal(options.method, "GET");
      return { ok: true, json: async () => ({ status: true, data: { status: "success", currency: "KES" } }) };
    }
  });
  assert.equal(requestedUrl, "https://api.paystack.co/transaction/verify/KB1760000000000-aabbccddeeff11");
  assert.equal(result.status, "success");
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
