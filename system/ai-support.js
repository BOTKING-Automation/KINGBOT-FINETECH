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
    lastQueryAt: null
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
    if (!window.KINGBOT_FIREBASE?.auth?.currentUser) {
      throw new Error("Please sign in to use KINGBOT Intelligence.");
    }
    const user = window.KINGBOT_FIREBASE.auth.currentUser;
    if (!user.emailVerified) {
      throw new Error("Verify your email before using KINGBOT Intelligence.");
    }
    return user.getIdToken(forceRefresh);
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

  function renderHealth() {
    const h = state.health;
    if (!h) return;
    const aiReady = Boolean(h.aiReady);
    const apiReady = Boolean(h.ok);
    const dbReady = Boolean(h.accountServiceReady);

    setTelemetry("aiCoreStatus", aiReady ? "ONLINE" : "OFFLINE", aiReady ? "good" : "bad");
    setTelemetry("apiStatus", apiReady ? "LIVE" : "OFFLINE", apiReady ? "good" : "bad");
    setTelemetry("dataServiceStatus", dbReady ? "READY" : "WAITING", dbReady ? "good" : "warn");

    setText("coreStateLabel", aiReady ? "AI CORE ONLINE" : "AI CORE UNAVAILABLE");
    setText("coreStateSub", aiReady
      ? "Secure intelligence endpoint is responding."
      : "Server AI is not configured or is unavailable.");
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
    } catch (error) {
      state.health = { ok: false, aiReady: false, accountServiceReady: false };
      renderHealth();
    }
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
    const history = byId("history");
    if (!history) return;
    const empty = history.querySelector(".history-empty");
    if (empty) empty.remove();

    const item = document.createElement("article");
    item.className = "history-item " + role;

    const head = document.createElement("div");
    head.className = "history-head";
    head.textContent = (role === "user" ? "YOU" : "KINGBOT INTELLIGENCE") + " · " + new Date().toLocaleTimeString();

    const body = document.createElement("div");
    body.className = "history-body";
    body.textContent = message;

    item.append(head, body);
    history.prepend(item);
  }

  async function runQuery(message) {
    if (state.busy) return;
    const clean = String(message || "").trim();
    if (!clean) return;

    state.busy = true;
    const input = byId("commandInput");
    const button = byId("runQuery");
    const responseEl = byId("consoleResponse");
    if (input) input.disabled = true;
    if (button) button.disabled = true;
    if (responseEl) responseEl.textContent = "SECURE REQUEST → ANALYZING VERIFIED KINGBOT CONTEXT…";
    addHistory("user", clean);

    try {
      if (!state.context) {
        await loadContext();
      }
      const response = await requestJson(API_BASE + "/ai/query", {
        method: "POST",
        body: JSON.stringify({ message: clean })
      });
      const answer = String(response.answer || "").trim();
      if (!answer) throw new Error("KINGBOT Intelligence returned no analysis.");
      if (responseEl) responseEl.textContent = answer;
      addHistory("assistant", answer);
      state.lastQueryAt = new Date();
      setText("lastQuery", state.lastQueryAt.toLocaleTimeString());
      showToast("Analysis complete.", "good");
    } catch (error) {
      const messageText = error?.message || "KINGBOT Intelligence is temporarily unavailable.";
      if (responseEl) responseEl.textContent = messageText;
      addHistory("assistant", messageText);
      showToast(messageText, "bad");
    } finally {
      state.busy = false;
      if (input) input.disabled = false;
      if (button) button.disabled = false;
      if (input) input.value = "";
      if (input) input.focus();
    }
  }

  function focusCommand() {
    const input = byId("commandInput");
    if (!input) return;
    input.focus();
    input.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function clearHistory() {
    const history = byId("history");
    if (!history) return;
    history.innerHTML = '<div class="history-empty">NO AI SESSION DATA YET</div>';
    setText("consoleResponse", "awaiting your command...");
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

    button?.addEventListener("click", () => runQuery(input?.value || ""));
    setInterval(loadContext, 20000);
    loadHealth();
    window.setTimeout(loadContext, 700);
    window.addEventListener("kingbot:session-change", () => loadContext());
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
