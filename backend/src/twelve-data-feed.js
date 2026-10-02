import WebSocket from "ws";

const DEFAULT_SYMBOLS = ["XAU/USD","EUR/USD","GBP/USD","USD/JPY","BTC/USD"];

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeSymbol(symbol) {
  const raw = String(symbol || "").trim().toUpperCase();
  const map = {
    XAUUSD: "XAU/USD",
    EURUSD: "EUR/USD",
    GBPUSD: "GBP/USD",
    USDJPY: "USD/JPY",
    BTCUSD: "BTC/USD"
  };
  return map[raw] || raw.replace(/_/g, "/");
}

function kingbotSymbol(symbol) {
  return normalizeSymbol(symbol).replace("/", "");
}

export class TwelveDataFeed {
  constructor({ symbols = DEFAULT_SYMBOLS } = {}) {
    this.apiKey = String(process.env.TWELVE_DATA_API_KEY || "").trim();
    this.symbols = [...new Set(symbols.map(normalizeSymbol))];
    this.ws = null;
    this.connected = false;
    this.last = new Map();
    this.lastMessageAt = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.started = false;
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  start() {
    if (!this.enabled || this.started) return;
    this.started = true;
    this.connect();
  }

  connect() {
    if (!this.enabled) return;
    if (this.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) return;

    const url = `wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(this.apiKey)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.connected = true;
      this.lastMessageAt = Date.now();
      ws.send(JSON.stringify({
        action: "subscribe",
        params: { symbols: this.symbols.join(",") }
      }));

      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: "heartbeat" }));
        }
      }, 10000);
    });

    ws.on("message", raw => {
      this.lastMessageAt = Date.now();
      let data;
      try { data = JSON.parse(String(raw)); } catch { return; }

      if (data?.event === "price" || data?.type === "price") {
        const symbol = normalizeSymbol(data?.symbol || data?.meta?.symbol);
        const price = finite(data?.price);
        if (price === null) return;

        this.last.set(symbol, {
          symbol: kingbotSymbol(symbol),
          twelveDataSymbol: symbol,
          price,
          bid: finite(data?.bid),
          ask: finite(data?.ask),
          volume: finite(data?.day_volume ?? data?.volume),
          timestamp: finite(data?.timestamp) ? Number(data.timestamp) * 1000 : Date.now(),
          source: "Twelve Data WebSocket"
        });
      }
    });

    ws.on("close", () => {
      this.connected = false;
      clearInterval(this.heartbeatTimer);
      this.scheduleReconnect();
    });

    ws.on("error", error => {
      console.error("[TWELVE DATA WS]", error?.message || error);
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer || !this.started) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  quotes(symbols) {
    return symbols.map(symbol => {
      const tdSymbol = normalizeSymbol(symbol);
      const quote = this.last.get(tdSymbol);
      if (!quote) return {
        symbol: kingbotSymbol(tdSymbol),
        twelveDataSymbol: tdSymbol,
        available: false,
        source: "Twelve Data WebSocket"
      };
      return { ...quote, available: true };
    });
  }

  status() {
    return {
      configured: this.enabled,
      connected: this.connected,
      source: "Twelve Data WebSocket",
      subscribedSymbols: this.symbols.map(kingbotSymbol),
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      quoteCount: this.last.size
    };
  }

  close() {
    this.started = false;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    if (this.ws) this.ws.close();
    this.ws = null;
    this.connected = false;
  }
}
