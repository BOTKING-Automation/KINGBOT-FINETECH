const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const MAX_QUESTION_CHARS = 3000;
const MAX_CONVERSATION_ITEMS = 6;
const MAX_CONVERSATION_CHARS = 1200;
const MAX_REPLY_CHARS = 5000;

const SYSTEM_PROMPT = `You are KINGBOT's local conversational assistant.
Answer ordinary conversation and general questions clearly and helpfully.
You are not a market-data feed, trading signal engine, broker, account service, or trade executor.
Do not invent live prices, market conditions, indicators, broker state, balances, positions, trade outcomes, or platform capabilities.
Do not provide BUY/SELL/entry/exit instructions or claim predictive certainty.
If asked for live market analysis, account information, broker status, or an action, explain that the verified KINGBOT services handle those requests.
Never claim to have placed, modified, or closed a trade.
Do not reveal hidden reasoning. Return a concise natural-language answer only.`;

function readConfig() {
  const enabled = ENABLED_VALUES.has(String(process.env.KINGBOT_LOCAL_LLM_ENABLED || "").trim().toLowerCase());
  const model = String(process.env.KINGBOT_LOCAL_LLM_MODEL || "").trim().slice(0, 120);
  const rawUrl = String(process.env.KINGBOT_LOCAL_LLM_URL || "http://127.0.0.1:11434").trim();

  let url = null;
  let reason = null;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (parsed.protocol !== "http:" || !loopback || parsed.username || parsed.password ||
        parsed.pathname !== "/" || parsed.search || parsed.hash) {
      reason = "LOCAL_LLM_LOOPBACK_ONLY";
    } else {
      url = parsed.origin;
    }
  } catch {
    reason = "LOCAL_LLM_URL_INVALID";
  }

  if (!reason && !model) reason = "LOCAL_LLM_MODEL_REQUIRED";
  if (!enabled && !reason) reason = "LOCAL_LLM_DISABLED";

  return { enabled: enabled && Boolean(url) && Boolean(model) && !reason, model, url, reason };
}

export function localLlmStatus() {
  const config = readConfig();
  return {
    enabled: config.enabled,
    configured: Boolean(config.url && config.model),
    provider: "OLLAMA_LOCAL",
    model: config.model || null,
    endpoint: config.url ? config.url + "/api/chat" : null,
    reason: config.reason
  };
}

function cleanConversation(conversation) {
  return (Array.isArray(conversation) ? conversation : [])
    .slice(-MAX_CONVERSATION_ITEMS)
    .map(item => ({
      role: item?.role === "assistant" ? "assistant" : "user",
      content: String(item?.content || "").trim().slice(0, MAX_CONVERSATION_CHARS)
    }))
    .filter(item => item.content);
}

export async function generateLocalLlmReply({
  question,
  conversation = [],
  timeoutMs,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = readConfig();
  if (!config.enabled) return { ok: false, reason: config.reason || "LOCAL_LLM_DISABLED" };

  const prompt = String(question || "").trim().slice(0, MAX_QUESTION_CHARS);
  if (!prompt) return { ok: false, reason: "LOCAL_LLM_QUESTION_REQUIRED" };
  if (typeof fetchImpl !== "function") return { ok: false, reason: "LOCAL_LLM_FETCH_UNAVAILABLE" };

  const timeout = Math.max(1000, Math.min(60000,
    Number(timeoutMs || process.env.KINGBOT_LOCAL_LLM_TIMEOUT_MS || 12000) || 12000
  ));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...cleanConversation(conversation),
    { role: "user", content: prompt }
  ];

  try {
    const response = await fetchImpl(config.url + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: false,
        options: { temperature: 0.25, num_predict: 512 }
      }),
      signal: controller.signal
    });
    if (!response?.ok) {
      return { ok: false, reason: "LOCAL_LLM_HTTP_ERROR", status: Number(response?.status) || null };
    }
    const data = await response.json().catch(() => null);
    const answer = String(data?.message?.content || "").trim().slice(0, MAX_REPLY_CHARS);
    if (!answer) return { ok: false, reason: "LOCAL_LLM_EMPTY_RESPONSE" };
    return { ok: true, provider: "OLLAMA_LOCAL", model: config.model, answer };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? "LOCAL_LLM_TIMEOUT" : "LOCAL_LLM_UNAVAILABLE"
    };
  } finally {
    clearTimeout(timer);
  }
}
