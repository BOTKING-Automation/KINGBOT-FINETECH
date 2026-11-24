import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const sessionSource = readFileSync(new URL("../../system/session.js", import.meta.url), "utf8");
const PRODUCTION_API = "https://kingbot-fintech-api-etfv.onrender.com/api";
const FIREBASE_TOKEN = "test-firebase-id-token";

function createHarness(pageUrl) {
  const calls = [];
  const location = new URL(pageUrl);
  let replacedUrl = null;
  location.replace = value => { replacedUrl = String(value); };
  const browserWindow = {
    location,
    KINGBOT_FIREBASE: {
      getToken: async () => FIREBASE_TOKEN
    },
    dispatchEvent() {}
  };
  const document = {
    readyState: "loading",
    addEventListener() {},
    querySelectorAll() { return []; }
  };
  const context = vm.createContext({
    window: browserWindow,
    document,
    URL,
    URLSearchParams,
    Headers,
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    console,
    setTimeout,
    clearTimeout,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    }
  });
  vm.runInContext(sessionSource, context, { filename: "system/session.js" });
  return { api: browserWindow.KINGBOT_API, session: browserWindow.KINGBOT_SESSION, calls, get replacedUrl() { return replacedUrl; } };
}

test("production pages ignore attacker-controlled remote API query parameters", () => {
  const harness = createHarness(
    "https://botking-automation.github.io/KINGBOT-FINETECH/scanner.html?kb-api=https%3A%2F%2Fevil.example%2Fcollect"
  );
  assert.equal(harness.api.baseUrl, PRODUCTION_API);
});

test("production pages cannot switch to the local backend through a crafted link", () => {
  const harness = createHarness(
    "https://botking-automation.github.io/KINGBOT-FINETECH/scanner.html?kb-api=local"
  );
  assert.equal(harness.api.baseUrl, PRODUCTION_API);
});

test("localhost development can explicitly select the local backend", () => {
  const harness = createHarness("http://localhost:5500/scanner.html?kb-api=local");
  assert.equal(harness.api.baseUrl, "http://127.0.0.1:10000/api");
});

test("authenticated requests use the fixed API origin and never the query-string host", async () => {
  const harness = createHarness(
    "https://botking-automation.github.io/KINGBOT-FINETECH/scanner.html?kb-api=https%3A%2F%2Fevil.example"
  );
  await harness.api.request("/auth/session");
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].url, PRODUCTION_API + "/auth/session");
  assert.equal(harness.calls[0].options.headers.get("Authorization"), "Bearer " + FIREBASE_TOKEN);
});

test("KINGBOT_API refuses absolute or protocol-relative requests to an external origin", async () => {
  const harness = createHarness("https://botking-automation.github.io/KINGBOT-FINETECH/scanner.html");
  await assert.rejects(
    harness.api.request("https://evil.example/collect"),
    error => error?.message === "KINGBOT_API_ORIGIN_NOT_ALLOWED"
  );
  await assert.rejects(
    harness.api.request("//evil.example/collect"),
    error => error?.message === "KINGBOT_API_ORIGIN_NOT_ALLOWED"
  );
  assert.equal(harness.calls.length, 0, "no authenticated fetch may be sent to an external origin");
});


test("local API selection survives the protected sign-in redirect", () => {
  const harness = createHarness("http://localhost:5500/ai.html?kb-api=local");
  harness.session.redirectToSignIn();
  const redirect = new URL(harness.replacedUrl, "http://localhost:5500");
  assert.equal(redirect.pathname, "/access-stable.html");
  assert.equal(redirect.searchParams.get("kb-api"), "local");
  assert.equal(redirect.searchParams.get("return"), "/ai.html?kb-api=local");
});
