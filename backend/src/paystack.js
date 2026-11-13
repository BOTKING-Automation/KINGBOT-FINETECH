import crypto from "node:crypto";

const DEFAULT_CALLBACK_URL = "https://botking-automation.github.io/KINGBOT-FINETECH/subscription.html";

export function getPaystackConfig(env = process.env) {
  const mode = String(env.PAYSTACK_MODE || "test").trim().toLowerCase();
  const secretKey = String(env.PAYSTACK_SECRET_KEY || "").trim();
  const webhookSecret = String(env.PAYSTACK_WEBHOOK_SECRET || "").trim();
  const usdKesRate = Number(env.PAYSTACK_USD_KES_RATE);
  const callbackUrl = String(env.PAYSTACK_CALLBACK_URL || DEFAULT_CALLBACK_URL).trim();

  let callbackIsHttps = false;
  try {
    callbackIsHttps = new URL(callbackUrl).protocol === "https:";
  } catch {
    callbackIsHttps = false;
  }

  const validRate = Number.isFinite(usdKesRate) && usdKesRate > 0 && usdKesRate <= 1000;
  const isTestSecret = /^sk_test_[A-Za-z0-9_-]{8,}$/.test(secretKey);
  const hasWebhookSecret = /^whsec_[A-Za-z0-9_-]{8,}$/.test(webhookSecret);
  const configured = mode === "test" && isTestSecret && hasWebhookSecret && validRate && callbackIsHttps;

  return {
    mode,
    secretKey,
    webhookSecret,
    usdKesRate,
    callbackUrl,
    validRate,
    isTestSecret,
    hasWebhookSecret,
    configured
  };
}

export function paystackStatus(env = process.env) {
  const config = getPaystackConfig(env);
  return {
    configured: config.configured,
    mode: "test",
    currency: "KES",
    rateConfigured: config.validRate,
    webhookConfigured: config.hasWebhookSecret,
    message: config.configured
      ? "Paystack sandbox checkout is ready."
      : "Paystack sandbox checkout is not fully configured on the payment server."
  };
}

export function calculatePaystackAmountKes(priceUsd, billingMonths, usdKesRate) {
  const usd = Number(priceUsd);
  const months = Number(billingMonths);
  const rate = Number(usdKesRate);
  if (!Number.isFinite(usd) || usd <= 0 || ![1, 3].includes(months) || !Number.isFinite(rate) || rate <= 0 || rate > 1000) {
    throw new Error("PAYSTACK_PRICE_CONFIGURATION_INVALID");
  }
  const totalUsd = usd * (months === 3 ? 2.1 : 1);
  return Number((totalUsd * rate).toFixed(2));
}

export function paystackAmountSubunit(amountKes) {
  const amount = Number(amountKes);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
    throw new Error("PAYSTACK_AMOUNT_INVALID");
  }
  return Math.round(amount * 100);
}

async function paystackRequest(path, { method = "GET", body, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = getPaystackConfig(env);
  if (!config.configured) throw new Error("PAYSTACK_TEST_NOT_CONFIGURED");
  if (typeof fetchImpl !== "function") throw new Error("PAYSTACK_FETCH_UNAVAILABLE");

  const response = await fetchImpl("https://api.paystack.co" + path, {
    method,
    headers: {
      Authorization: "Bearer " + config.secretKey,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.status !== true) {
    const detail = String(payload?.message || "Paystack API request failed.").slice(0, 180);
    throw new Error("PAYSTACK_API_ERROR: " + detail);
  }
  return payload.data || {};
}

export async function initializePaystackTransaction({ email, amountKes, reference, metadata, env = process.env, fetchImpl = globalThis.fetch }) {
  const config = getPaystackConfig(env);
  if (!config.configured) throw new Error("PAYSTACK_TEST_NOT_CONFIGURED");
  const customerEmail = String(email || "").trim().toLowerCase();
  const transactionReference = String(reference || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) throw new Error("PAYSTACK_CUSTOMER_EMAIL_REQUIRED");
  if (!/^[A-Za-z0-9.=-]{8,100}$/.test(transactionReference)) throw new Error("PAYSTACK_REFERENCE_INVALID");

  const data = await paystackRequest("/transaction/initialize", {
    method: "POST",
    body: {
      email: customerEmail,
      amount: String(paystackAmountSubunit(amountKes)),
      currency: "KES",
      reference: transactionReference,
      callback_url: config.callbackUrl,
      metadata: metadata || {}
    },
    env,
    fetchImpl
  });
  if (!data.authorization_url || String(data.authorization_url).indexOf("https://checkout.paystack.com/") !== 0 || data.reference !== transactionReference) {
    throw new Error("PAYSTACK_CHECKOUT_RESPONSE_INVALID");
  }
  return data;
}

export async function verifyPaystackTransaction({ reference, env = process.env, fetchImpl = globalThis.fetch }) {
  const value = String(reference || "").trim();
  if (!/^[A-Za-z0-9.=-]{8,100}$/.test(value)) throw new Error("PAYSTACK_REFERENCE_INVALID");
  return paystackRequest("/transaction/verify/" + encodeURIComponent(value), { env, fetchImpl });
}

function matchesHex(expected, supplied) {
  if (!/^[0-9a-f]{128}$/i.test(String(supplied || ""))) return false;
  const actual = Buffer.from(String(supplied), "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(expected, actual);
}

export function verifyPaystackWebhookSignature({
  rawBody,
  signatureHeader,
  legacySignature,
  env = process.env,
  now = Math.floor(Date.now() / 1000)
} = {}) {
  if (!Buffer.isBuffer(rawBody)) return false;
  const config = getPaystackConfig(env);

  if (typeof signatureHeader === "string" && config.hasWebhookSecret) {
    let timestamp = null;
    const signatures = [];
    for (const part of signatureHeader.split(",")) {
      const index = part.indexOf("=");
      if (index < 0) continue;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (key === "t") {
        if (timestamp !== null || !/^\d+$/.test(value)) return false;
        timestamp = Number(value);
      } else if (key === "v1") {
        const split = value.indexOf(":");
        if (split > 0) signatures.push({ keyId: value.slice(0, split), hex: value.slice(split + 1) });
      }
    }
    if (timestamp !== null && Math.abs(Number(now) - timestamp) <= 300) {
      const expected = crypto.createHmac("sha512", config.webhookSecret)
        .update(String(timestamp) + ".")
        .update(rawBody)
        .digest();
      for (const entry of signatures) {
        if (/^whk_[A-Za-z0-9_-]+$/.test(entry.keyId) && matchesHex(expected, entry.hex)) return true;
      }
    }
  }

  if (typeof legacySignature === "string" && config.isTestSecret) {
    const expected = crypto.createHmac("sha512", config.secretKey).update(rawBody).digest();
    return matchesHex(expected, legacySignature);
  }
  return false;
}
