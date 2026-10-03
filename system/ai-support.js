/*
 KINGBOT INTELLIGENCE — LIVE FRONTEND CLIENT
 The browser talks only to the secured KINGBOT backend.
 No provider names, API keys, broker credentials, or fake telemetry
 are exposed to the browser.
*/

(function (window) {
  "use strict";

  const API_BASE = "https://kingbot-fintech-api-etfv.onrender.com/api";
  const state = {
    context: null,
    health: null,
    busy: false,
    contextBusy: false,
    lastQueryAt: null,
    messages: [],
    storageKey: "KINGBOT_AI_CHAT_V2",
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const el = byId(id);
    if (el) el.textContent = value;
  }

  function setStateClass(id, className, on) {
    const el = byId(id);
    if (el) el.classList.toggle(className, Boolean(on));
  }

  function showToast(message, tone = "") {
    const toast = byId("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function loadChatSession() {
    try {
      const raw = sessionStorage.getItem(state.storageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        state.messages = parsed
          .filter(item => item && (item.role === "user" || item.role === "assistant"))
          .slice(-12)
          .map(item => ({
            role: item.role,
            content: String(item.content || "").slice(0, 4000),
            at: item.at || Date.now()
          }));
      }
    } catch {
      state.messages = [];
    }
    renderChat();
  }

  function saveChatSession() {
    try {
      sessionStorage.setItem(state.storageKey, JSON.stringify(state.messages.slice(-12)));
    } catch {}
  }

  function escapeText(value) {
    return String(value || "");
  }

  function renderChat() {
    const container = byId("chatScroll");
    if (!container) return;
    container.innerHTML = "";

    if (!state.messages.length) {
      const empty = document.createElement("div");
      empty.id = "chatEmpty";
      empty.className = "chat-empty";
      empty.innerHTML = "KINGBOT INTELLIGENCE IS READY.<br>Ask your first question.";
      container.appendChild(empty);
      return;
    }

    state.messages.forEach(item => {
      const row = document.createElement("div");
      row.className = "chat-message " + item.role;

      const bubble = document.createElement("div");
      bubble.className = "chat-bubble";

      const role = document.createElement("div");
      role.className = "chat-role";
      role.textContent = item.role === "user"
        ? "YOU · " + new Date(item.at || Date.now()).toLocaleTimeString()
        : "KINGBOT INTELLIGENCE · " + new Date(item.at || Date.now()).toLocaleTimeString();

      const body = document.createElement("div");
      body.className = "chat-body";
      body.textContent = escapeText(item.content);

      bubble.append(role, body);
      row.appendChild(bubble);
      container.appendChild(row);
    });

    container.scrollTop = container.scrollHeight;
  }

  function setChatState(value) {
    const el = byId("chatState");
    if (el) el.textContent = value;
  }

  function showTyping() {
    const container = byId("chatScroll");
    if (!container) return;
    const row = document.createElement("div");
    row.id = "chatTyping";
    row.className = "chat-message assistant";
    row.innerHTML = '<div class="chat-bubble"><div class="chat-role">KINGBOT INTELLIGENCE · DEEP COGNITIVE PASS</div><div class="chat-typing"><i></i><i></i><i></i></div><div style="margin-top:8px;font:700 7px JetBrains Mono;color:var(--muted);letter-spacing:.08em">IDENTIFY → OBSERVE → CORRELATE → CHALLENGE → ADAPT → VERIFY</div></div>';
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  }

  function hideTyping() {
    byId("chatTyping")?.remove();
  }

  function formatMoney(value, currency = "") {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    const prefix = currency ? currency + " " : "";
    return prefix + n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function formatCompactNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function formatPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
  }

  function formatTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString();
  }

  async function getToken(forceRefresh = false) {
    // The shared session manager is the authoritative browser auth state.
    // Wait for it to restore Firebase persistence before touching currentUser.
    if (window.KINGBOT_SESSION?.check) {
      const session = await window.KINGBOT_SESSION.check({ force: forceRefresh });
      if (!session?.authenticated) {
        throw new Error("Please sign in to use KINGBOT Intelligence.");
      }
      if (!session?.user?.verified) {
        throw new Error("Verify your email before using KINGBOT Intelligence.");
      }
    }

    const user = window.KINGBOT_FIREBASE?.auth?.currentUser;
    if (!user) {
      throw new Error("Please sign in to use KINGBOT Intelligence.");
    }
    if (!user.emailVerified) {
      throw new Error("Verify your email before using KINGBOT Intelligence.");
    }

    // A forced refresh prevents an expired/stale ID token from being sent
    // immediately after Firebase restores a persisted session.
    return user.getIdToken(Boolean(forceRefresh));
  }

  async function requestJson(url, options = {}, auth = true) {
    const makeRequest = async (forceRefresh = false) => {
      const headers = {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      };
      if (auth) headers.Authorization = "Bearer " + await getToken(forceRefresh);
      return fetch(url, {
        ...options,
        headers,
        credentials: "omit",
        cache: "no-store"
      });
    };

    let response = await makeRequest(false);
    if (auth && response.status === 401) response = await makeRequest(true);

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      const message = data.error || data.message || ("Request failed (HTTP " + response.status + ").");
      throw new Error(message);
    }
    return data;
  }

  function setTelemetry(id, value, tone = "") {
    const el = byId(id);
    if (!el) return;
    el.textContent = value;
    el.className = "telemetry-value" + (tone ? " " + tone : "");
  }

  function renderIdentity(data = {}) {
    const identity = data?.identity || {};
    const cognition = data?.cognition || {};
    const plan = data?.cognitivePlan || cognition?.plan || {};
    const intelligence = data?.reply?.intelligence || {};
    const mode = intelligence.mode || plan.mode || "STANDBY";
    const capabilities = Array.isArray(intelligence.capabilities) ? intelligence.capabilities : (Array.isArray(cognition?.capabilities) ? cognition.capabilities : []);
    const loop = Array.isArray(identity.cognitiveLoop) ? identity.cognitiveLoop : [];
    const mission = String(identity.mission || "Observe verified state, reason, challenge, adapt, verify and explain.");
    const identityState = byId("identityState");
    if (identityState) identityState.textContent = data?.ok === false ? "CORE DEGRADED" : "CORE ACTIVE";
    setText("identityName", identity.name || "KINGBOT");
    setText("identityRole", identity.role || "Persistent intelligence operating layer.");
    setText("identityMission", mission);
    setText("identityAuthority", identity.authority || "ANALYSIS AND COORDINATION ONLY");
    setText("identityVersion", identity.version || "3.0.0");
    setText("identityMode", mode.replaceAll("_", " "));
    setText("identityCapabilities", capabilities.length ? capabilities.join(" · ") : "PERCEPTION · REASONING · VERIFICATION");
    const loopEl = byId("identityLoop");
    if (loopEl && loop.length) {
      loopEl.innerHTML = "";
      loop.forEach((step, index) => {
        const cell = document.createElement("div");
        cell.className = "orch-plan-cell";
        const n = document.createElement("span");
        n.textContent = String(index + 1).padStart(2, "0");
        const strong = document.createElement("strong");
        strong.textContent = String(step).replaceAll("_", " ");
        cell.append(n, strong);
        loopEl.appendChild(cell);
      });
    }
  }

  function renderHealth() {
    const h = state.health;
    if (!h) return;
    const aiReady = Boolean(h.nativeReady || h.aiReady || h.ok);
    const apiReady = Boolean(h.ok);
    const dbReady = Boolean(h.accountServiceReady);
    const provider = String(h.externalProvider || h.aiProvider || "native").toLowerCase();
    const googleReady = Boolean(h.webResearch?.configured);
    const model = String(h.aiModel || h.model || "KINGBOT-CORE-1");

    setTelemetry(
      "aiCoreStatus",
      aiReady ? "KINGBOT NATIVE" : "OFFLINE",
      aiReady ? "good" : "bad"
    );
    setTelemetry("apiStatus", apiReady ? "LIVE" : "OFFLINE", apiReady ? "good" : "bad");
    setTelemetry("dataServiceStatus", dbReady ? "READY" : "WAITING", dbReady ? "good" : "warn");

    setText(
      "coreStateLabel",
      aiReady ? "KINGBOT NATIVE AI ONLINE" : "AI CORE UNAVAILABLE"
    );
    setText(
      "coreStateSub",
      aiReady
        ? "Native KINGBOT intelligence is active through the secured backend" + (model ? " · " + model : "") + (googleReady ? " · GOOGLE RESEARCH READY" : "") + "."
        : "Server AI is not configured or is unavailable."
    );
  }

  function renderContext(data) {
    state.context = data;
    const broker = data?.broker || {};
    const account = data?.account || null;
    const quote = data?.marketQuote || null;
    const runtime = Array.isArray(data?.runtime) ? data.runtime : [];
    const risk = Array.isArray(data?.risk) ? data.risk : [];
    const positions = Array.isArray(data?.positions) ? data.positions : [];

    const connected = Boolean(broker.connected);
    setTelemetry("brokerStatus", connected ? "CONNECTED" : "NOT CONNECTED", connected ? "good" : "muted");
    setTelemetry("accountStatus", account?.available ? "VERIFIED" : "UNAVAILABLE", account?.available ? "good" : "warn");
    const positionStatus = byId("positionStatus");
    if (positionStatus) {
      positionStatus.textContent = "POSITIONS: " + (account?.available ? String(positions.length) : "—");
      positionStatus.className = "status-tag";
    }
    setTelemetry("contextStatus", data?.generatedAt ? "SYNCED" : "WAITING", data?.generatedAt ? "good" : "muted");

    setText("brokerMode", connected ? String(broker.executionMode || "CONNECTED") : "—");
    setText("brokerName", connected ? String(broker.broker || "Broker") : "Awaiting verified broker connection");
    setText("accountBalance", account?.available ? formatMoney(account.balance, account.currency) : "—");
    setText("accountEquity", account?.available ? formatMoney(account.equity, account.currency) : "—");
    setText("accountMargin", account?.available ? formatMoney(account.margin, account.currency) : "—");
    setText("accountFreeMargin", account?.available ? formatMoney(account.freeMargin, account.currency) : "—");
    setText("openPositions", account?.available ? String(positions.length) : "—");
    setText("contextTimestamp", data?.generatedAt ? formatTime(data.generatedAt) : "—");

    const selectedSymbol = byId("symbolSelect")?.value || "";
    const visibleQuote = quote && (!selectedSymbol || quote.symbol === selectedSymbol) ? quote : null;
    setText("quoteSymbol", visibleQuote?.symbol || selectedSymbol || "—");
    setText("quoteBid", visibleQuote ? formatCompactNumber(visibleQuote.bid) : "—");
    setText("quoteAsk", visibleQuote ? formatCompactNumber(visibleQuote.ask) : "—");
    setText("quoteSpread", visibleQuote ? formatCompactNumber(visibleQuote.spread) : "—");
    setText("quoteTime", visibleQuote?.time ? formatTime(visibleQuote.time) : "—");

    const daily = risk.find(r => Number.isFinite(Number(r.daily_drawdown_pct)));
    const total = risk.find(r => Number.isFinite(Number(r.total_drawdown_pct)));
    setText("riskDaily", daily ? Number(daily.daily_drawdown_pct).toFixed(2) + "%" : "5% policy");
    setText("riskTotal", total ? Number(total.total_drawdown_pct).toFixed(2) + "%" : "10% policy");

    const botList = byId("botRuntimeList");
    if (botList) {
      botList.innerHTML = "";
      const botLabels = {
        strategic: ["STRATEGIC", "Multi-Strategy"],
        flipper: ["FLIPPER", "High-Speed Flipping"],
        breakout: ["BREAKOUT", "Breakout & Momentum"],
        "smc-pro": ["SMC PRO", "Smart Money Concepts"],
        "ladder-flip": ["LADDER V8", "Advanced Ladder System"]
      };
      Object.keys(botLabels).forEach(botId => {
        const bot = runtime.find(item => item.bot_id === botId);
        const [code, label] = botLabels[botId];
        const stateName = String(bot?.state || "STOPPED");
        const row = document.createElement("div");
        row.className = "runtime-row";
        row.innerHTML = '<div><span class="runtime-code">' + code + '</span><span class="runtime-name">' + label + '</span></div><div class="runtime-state">' + stateName + '</div>';
        botList.appendChild(row);
      });
    }

    const positionsList = byId("positionsList");
    if (positionsList) {
      positionsList.innerHTML = "";
      if (!positions.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = account?.available ? "No open positions reported by the broker." : "Connect a verified broker to load positions.";
        positionsList.appendChild(empty);
      } else {
        positions.slice(0, 12).forEach(position => {
          const row = document.createElement("div");
          row.className = "position-row";
          const symbol = String(position.symbol || "—");
          const type = String(position.type || position.side || "POSITION");
          const left=document.createElement("div");
          const strong=document.createElement("strong");
          strong.textContent=symbol;
          const meta=document.createElement("span");
          meta.textContent=type + " · " + formatCompactNumber(position.volume);
          left.append(strong,meta);
          const profit=document.createElement("div");
          profit.className="position-profit";
          profit.textContent=formatMoney(position.profit, account?.currency || "");
          row.append(left,profit);
          positionsList.appendChild(row);
        });
      }
    }

    const contextNote = byId("contextNote");
    if (contextNote) {
      if (connected && quote) {
        contextNote.textContent = "AI queries can use the verified broker quote, account telemetry, positions, runtime state and risk controls shown above.";
      } else if (connected) {
        contextNote.textContent = "Broker is connected. Select a symbol configured by the broker to load a verified quote.";
      } else {
        contextNote.textContent = "AI remains available for product, strategy and risk education. Live account-specific analysis requires a verified broker connection.";
      }
    }
  }

  async function loadHealth() {
    try {
      state.health = await requestJson(API_BASE + "/health", {}, false);
      renderHealth();
      loadAgentStatus();
    } catch (error) {
      state.health = { ok: false, aiReady: false, accountServiceReady: false };
      renderHealth();
    }
  }

  async function loadAgentStatus() {
    try {
      const data = await requestJson(API_BASE + "/ai/agent/status");
      renderIdentity(data);
    } catch {}
  }

  async function runBackendAgent(clean, conversation) {
    const symbol = byId("symbolSelect")?.value || "XAUUSD";
    const data = await requestJson(API_BASE + "/ai/agent", {
      method: "POST",
      body: JSON.stringify({ message: clean, symbol, conversation: conversation.slice(-4) })
    });
    const reply = data?.reply || {};
    renderIdentity(data);
    let answer = String(reply.answer || data?.message || "KINGBOT AI returned no answer.");

    const reasoning = [];
    if (Array.isArray(reply.reasoningSummary) && reply.reasoningSummary.length) {
      reasoning.push("COGNITIVE SYNTHESIS\n" + reply.reasoningSummary.slice(0,6).map(x => "• " + String(x)).join("\n"));
    }
    if (Array.isArray(reply.evidenceFor) && reply.evidenceFor.length) {
      reasoning.push("EVIDENCE FOR\n" + reply.evidenceFor.slice(0,6).map(x => "• " + String(x)).join("\n"));
    }
    if (Array.isArray(reply.evidenceAgainst) && reply.evidenceAgainst.length) {
      reasoning.push("COUNTER-EVIDENCE\n" + reply.evidenceAgainst.slice(0,6).map(x => "• " + String(x)).join("\n"));
    }
    if (Array.isArray(reply.uncertainties) && reply.uncertainties.length) {
      reasoning.push("UNCERTAINTIES\n" + reply.uncertainties.slice(0,6).map(x => "• " + String(x)).join("\n"));
    }
    if (Array.isArray(reply.alternativeHypotheses) && reply.alternativeHypotheses.length) {
      reasoning.push("ALTERNATIVE HYPOTHESES\n" + reply.alternativeHypotheses.slice(0,5).map(x => "• " + String(x)).join("\n"));
    }
    if (Array.isArray(reply.validationSteps) && reply.validationSteps.length) {
      reasoning.push("VALIDATION STEPS\n" + reply.validationSteps.slice(0,5).map(x => "• " + String(x)).join("\n"));
    }
    if (reasoning.length) answer += "\n\n" + reasoning.join("\n\n");

    const sources = Array.isArray(data?.sources) ? data.sources.slice(0,6) : [];
    if(sources.length){
      answer += "\n\nSOURCES\n" + sources.map((s,i) => (i+1)+". "+String(s.title||"Source")+" — "+String(s.url||"")).join("\n");
    }
    return { answer, data };
  }

  async function loadContext() {
    if (state.contextBusy) return;
    state.contextBusy = true;
    const button = byId("refreshContext");
    if (button) button.disabled = true;
    try {
      const symbol = byId("symbolSelect")?.value || "XAUUSD";
      const query = symbol ? "?symbol=" + encodeURIComponent(symbol) : "";
      const data = await requestJson(API_BASE + "/intelligence/context" + query);
      renderContext(data);
      showToast("Verified intelligence context synchronized.", "good");
    } catch (error) {
      setTelemetry("contextStatus", "ERROR", "bad");
      showToast(error?.message || "Unable to load intelligence context.", "bad");
    } finally {
      state.contextBusy = false;
      if (button) button.disabled = false;
    }
  }

  function addHistory(role, message) {
    state.messages.push({
      role,
      content: String(message || ""),
      at: Date.now()
    });
    state.messages = state.messages.slice(-12);
    saveChatSession();
    renderChat();
  }

  async function runQuery(message) {
    if (state.busy) return;
    const clean = String(message || "").trim();
    if (!clean) return;

    state.busy = true;
    const input = byId("commandInput");
    const button = byId("runQuery");

    if (input) input.disabled = true;
    if (button) button.disabled = true;
    setChatState("KINGBOT AI · THINKING");
    addHistory("user", clean);
    showTyping();

    try {
      if (!state.context) void loadContext();

      const conversation = state.messages
        .slice(0, -1)
        .slice(-4)
        .map(item => ({
          role: item.role,
          content: String(item.content || "").slice(0, 1800)
        }));

      const result = await runBackendAgent(clean, conversation);

      hideTyping();
      addHistory("assistant", result.answer);
      window.dispatchEvent(new CustomEvent("kingbot:ai-response", { detail: result }));

      state.lastQueryAt = new Date();
      setText("lastQuery", state.lastQueryAt.toLocaleTimeString());
      setChatState("NATIVE AI ONLINE");
      showToast("KINGBOT Native AI responded.", "good");
    } catch (error) {
      hideTyping();
      const messageText = error?.message || "KINGBOT AI is temporarily unavailable.";
      addHistory("assistant", messageText);
      setChatState("ERROR");
      showToast(messageText, "bad");
    } finally {
      state.busy = false;
      if (input) input.disabled = false;
      if (button) button.disabled = false;
      if (input) {
        input.value = "";
        input.focus();
      }
    }
  }

  function focusCommand() {
    const input = byId("commandInput");
    if (!input) return;
    input.focus();
    input.scrollIntoView({ behavior: "auto", block: "center" });
  }

  function clearHistory() {
    state.messages = [];
    saveChatSession();
    renderChat();

    const history = byId("history");
    if (history) {
      history.innerHTML = '<div class="history-empty">NO AI SESSION DATA YET</div>';
    }

    setChatState("READY");
    showToast("AI session cleared.", "good");
  }

  function applyPrompt(text) {
    const input = byId("commandInput");
    if (!input) return;
    input.value = text;
    focusCommand();
  }

  function wire() {
    const form = byId("commandForm");
    const input = byId("commandInput");
    const button = byId("runQuery");
    const refresh = byId("refreshContext");
    const clear = byId("clearHistory");
    const symbol = byId("symbolSelect");
    const focus = byId("openConsole");
    const mobileToggle = byId("mobileToggle");
    const nav = byId("nav");

    form?.addEventListener("submit", event => {
      event.preventDefault();
      runQuery(input?.value || "");
    });

    document.querySelectorAll("[data-prompt]").forEach(card => {
      card.addEventListener("click", () => applyPrompt(card.dataset.prompt || ""));
      card.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          applyPrompt(card.dataset.prompt || "");
        }
      });
    });

    refresh?.addEventListener("click", loadContext);
    clear?.addEventListener("click", clearHistory);
    symbol?.addEventListener("change", loadContext);
    focus?.addEventListener("click", focusCommand);

    mobileToggle?.addEventListener("click", () => {
      nav?.classList.toggle("mobile-open");
    });

    input?.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form?.requestSubmit();
      }
    });

    loadChatSession();
    setChatState("READY");
    setInterval(loadContext, 20000);
    loadHealth();
    /* Native KINGBOT AI is the production chat path. No browser AI provider is loaded. */
    setTelemetry("aiCoreStatus", "KINGBOT NATIVE", "good");
    setText("coreStateLabel", "KINGBOT NATIVE AI ONLINE");
    setText("coreStateSub", "Native KINGBOT intelligence is active. External browser AI providers are not required.");
    window.setTimeout(() => {
      loadAgentStatus();
      loadContext();
    }, 700);
    window.addEventListener("kingbot:session-change", () => {
      loadAgentStatus();
      loadContext();
    });
    window.addEventListener("kingbot:access-ready", () => loadContext(), { once: true });
  }

  function init() {
    if (window.__KINGBOT_AI_INITIALIZED) return;
    window.__KINGBOT_AI_INITIALIZED = true;
    wire();
  }

  window.KINGBOT_AI = {
    runQuery,
    refreshContext: loadContext,
    focusCommand,
    clearHistory,
    getState: () => ({ ...state })
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})(window);
