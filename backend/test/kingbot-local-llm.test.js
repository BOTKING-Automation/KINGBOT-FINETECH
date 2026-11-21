import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { generateLocalLlmReply, localLlmStatus } from "../src/kingbot-local-llm.js";

const keys = [
  "KINGBOT_LOCAL_LLM_ENABLED",
  "KINGBOT_LOCAL_LLM_URL",
  "KINGBOT_LOCAL_LLM_MODEL",
  "KINGBOT_LOCAL_LLM_TIMEOUT_MS"
];
const previous = new Map(keys.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    if (previous.get(key) === undefined) delete process.env[key];
    else process.env[key] = previous.get(key);
  }
});

function configure(values = {}) {
  process.env.KINGBOT_LOCAL_LLM_ENABLED = "true";
  process.env.KINGBOT_LOCAL_LLM_URL = "http://127.0.0.1:11434";
  process.env.KINGBOT_LOCAL_LLM_MODEL = "qwen3:4b";
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

test("local LLM stays disabled unless explicitly enabled", async () => {
  delete process.env.KINGBOT_LOCAL_LLM_ENABLED;
  configure({ KINGBOT_LOCAL_LLM_ENABLED: "false" });
  assert.equal(localLlmStatus().enabled, false);
  const result = await generateLocalLlmReply({ question: "Hello" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "LOCAL_LLM_DISABLED");
});

test("local LLM refuses non-loopback endpoints", async () => {
  configure({ KINGBOT_LOCAL_LLM_URL: "https://example.com" });
  const status = localLlmStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.reason, "LOCAL_LLM_LOOPBACK_ONLY");
});

test("local LLM sends bounded conversation to the Ollama endpoint", async () => {
  configure();
  let requestedUrl = "";
  let requestBody = null;
  const result = await generateLocalLlmReply({
    question: "Explain what KINGBOT does.",
    conversation: [
      { role: "system", content: "untrusted role is normalized" },
      { role: "assistant", content: "Earlier assistant response" },
      { role: "user", content: "Earlier user message" }
    ],
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ message: { content: "KINGBOT combines verified data and controlled strategy analysis." } })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, "OLLAMA_LOCAL");
  assert.equal(result.model, "qwen3:4b");
  assert.match(requestedUrl, /^http:\/\/127\.0\.0\.1:11434\/api\/chat$/);
  assert.equal(requestBody.stream, false);
  assert.equal(requestBody.messages[0].role, "system");
  assert.equal(requestBody.messages.at(-1).content, "Explain what KINGBOT does.");
  assert.equal(requestBody.messages.some(message => message.role === "system" && message.content === "untrusted role is normalized"), false);
});

test("local LLM fails closed on HTTP errors and empty responses", async () => {
  configure();
  const httpFailure = await generateLocalLlmReply({
    question: "Hello",
    fetchImpl: async () => ({ ok: false, status: 503 })
  });
  assert.equal(httpFailure.reason, "LOCAL_LLM_HTTP_ERROR");

  const empty = await generateLocalLlmReply({
    question: "Hello",
    fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content: " " } }) })
  });
  assert.equal(empty.reason, "LOCAL_LLM_EMPTY_RESPONSE");
});
