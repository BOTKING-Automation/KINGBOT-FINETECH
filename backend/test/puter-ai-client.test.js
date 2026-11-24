import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../../system/puter-ai-client.js", import.meta.url), "utf8");

function loadClient(puter) {
  const window = { puter, setTimeout, clearTimeout };
  vm.runInNewContext(source, {
    window,
    AbortController,
    URL,
    Promise,
    Set,
    String,
    Array,
    Boolean,
    JSON,
    RegExp
  });
  return window.KINGBOT_PUTER_AI;
}

test("Puter adapter exposes the selected model and availability without making calls", () => {
  const client = loadClient({ ai: { chat: async () => ({ message: { content: "ok" } }) } });
  assert.equal(client.model, "openai/gpt-5.4-nano");
  assert.equal(client.isAvailable(), true);
});

test("ordinary conversation uses Puter with bounded, non-sensitive context", async () => {
  let capturedMessages;
  let capturedTestMode;
  let capturedOptions;
  const client = loadClient({
    ai: {
      chat: async (messages, testMode, options) => {
        capturedMessages = messages;
        capturedTestMode = testMode;
        capturedOptions = options;
        return { message: { content: "Hello from the generative layer." } };
      }
    }
  });
  const result = await client.complete({
    question: "Can you explain how language models work?",
    intent: "GENERAL_KNOWLEDGE",
    conversation: [
      { role: "user", content: "Hello there." },
      { role: "assistant", content: "Ready to help." },
      { role: "user", content: "My broker account balance is 500." }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, "PUTER");
  assert.match(result.answer, /generative layer/);
  assert.equal(capturedMessages.at(-1).role, "user");
  assert.match(capturedMessages.at(-1).content, /language models/);
  assert.equal(capturedMessages.some(message => /broker account balance/i.test(message.content)), false);
  assert.equal(capturedTestMode, false);
  assert.equal(capturedOptions.model, "openai/gpt-5.4-nano");
  assert.equal(capturedOptions.stream, false);
  assert.equal(capturedOptions.temperature, 0.2);
  assert.equal(capturedOptions.max_tokens, 900);
});

test("trading, account and runtime intents are never sent to Puter", async () => {
  let calls = 0;
  const client = loadClient({ ai: { chat: async () => { calls++; return { message: { content: "unsafe" } }; } } });
  for (const intent of ["MARKET_INTELLIGENCE", "ACCOUNT_INTELLIGENCE", "CONNECTION_INTELLIGENCE", "RUNTIME_INTELLIGENCE", "RISK_REVIEW", "BOT_INTELLIGENCE"]) {
    const result = await client.complete({ question: "Please check this.", intent });
    assert.equal(result.reason, "INTENT_NOT_ELIGIBLE");
  }
  assert.equal(calls, 0);
});

test("sensitive text is blocked even when the backend classified it as conversation", async () => {
  let calls = 0;
  const client = loadClient({ ai: { chat: async () => { calls++; return { message: { content: "unsafe" } }; } } });
  const result = await client.complete({
    question: "Check my broker account balance and current XAUUSD position.",
    intent: "CONVERSATION"
  });
  assert.equal(result.reason, "SENSITIVE_CONTEXT");
  assert.equal(calls, 0);
});

test("web research is synthesized only when native sources are supplied", async () => {
  let messages;
  const client = loadClient({
    ai: {
      chat: async (input, testMode, options) => {
        assert.equal(testMode, false);
        assert.equal(options.model, "openai/gpt-5.4-nano");
        messages = input;
        return { message: { content: "Source-backed summary [1]." } };
      }
    }
  });
  const blocked = await client.complete({ question: "Summarize the research.", intent: "WEB_RESEARCH" });
  assert.equal(blocked.reason, "RESEARCH_SOURCES_REQUIRED");

  const result = await client.complete({
    question: "Summarize the research.",
    intent: "WEB_RESEARCH",
    sources: [{ title: "Official research", url: "https://example.com/report", snippet: "A verified source excerpt." }]
  });
  assert.equal(result.ok, true);
  assert.match(messages.at(-1).content, /https:\/\/example.com\/report/);
});

test("Puter failures safely return a native-fallback reason", async () => {
  const client = loadClient({ ai: { chat: async () => { throw new Error("provider detail"); } } });
  const result = await client.complete({ question: "Hello.", intent: "CONVERSATION" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PUTER_REQUEST_FAILED");
});

test("the adapter fails closed when the Puter SDK is absent", async () => {
  const client = loadClient(null);
  assert.equal(client.isAvailable(), false);
  const result = await client.complete({ question: "Hello.", intent: "CONVERSATION" });
  assert.equal(result.reason, "PUTER_JS_UNAVAILABLE");
});
