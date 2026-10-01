import WebSocket from "ws";

const DERIV_LEGACY_WS = "wss://ws.binaryws.com/websockets/v3";
const DERIV_NEW_WS = "wss://api.derivws.com/trading/v1/options/ws/public";

const finite = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export class DerivMarketFeed {
  constructor({maxAgeMs=5000,connectTimeoutMs=10000}={}) {
    this.maxAgeMs = Math.max(1000, Number(maxAgeMs)||5000);
    this.connectTimeoutMs = Math.max(3000, Number(connectTimeoutMs)||10000);
    this.ws = null;
    this.endpoint = null;
    this.connected = false;
    this.closed = false;
    this.reqId = 0;
    this.subscribed = new Set();
    this.desired = new Set();
    this.ticks = new Map();
    this.waiters = new Map();
    this.connectPromise = null;
    this.reconnectTimer = null;
    this.retryDelayMs = 1000;
    this.maxRetryDelayMs = 15000;
  }

  normalize(symbol) {
    const value = String(symbol||"").trim();
    if (!value) throw new Error("DERIV_SYMBOL_REQUIRED");
    const upper = value.toUpperCase();
    const aliases = {
      XAUUSD:"frxXAUUSD",
      XAGUSD:"frxXAGUSD",
      EURUSD:"frxEURUSD",
      GBPUSD:"frxGBPUSD",
      USDJPY:"frxUSDJPY",
      AUDUSD:"frxAUDUSD",
      USDCAD:"frxUSDCAD",
      USDCHF:"frxUSDCHF",
      NZDUSD:"frxNZDUSD"
    };
    return aliases[upper] || value;
  }

  async connect() {
    if (this.closed) this.closed = false;
    if (this.connected && this.ws) return {connected:true,endpoint:this.endpoint};
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async()=>{
      let lastError = null;
      for (const endpoint of [DERIV_LEGACY_WS, DERIV_NEW_WS]) {
        try {
          await this.openEndpoint(endpoint);
          this.retryDelayMs = 1000;
          this.resubscribeAll();
          return {connected:true,endpoint};
        } catch (error) {
          lastError = error;
          this.destroySocket();
        }
      }
      throw lastError || new Error("DERIV_MARKET_FEED_UNAVAILABLE");
    })().finally(()=>{this.connectPromise=null;});

    return this.connectPromise;
  }

  async openEndpoint(endpoint) {
    await new Promise((resolve,reject)=>{
      const ws = new WebSocket(endpoint);
      let settled = false;
      const timer = setTimeout(()=>{
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error("DERIV_MARKET_FEED_CONNECT_TIMEOUT"));
      }, this.connectTimeoutMs);

      const fail = (error)=>{
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      ws.once("open",()=>{
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        this.endpoint = endpoint;
        this.connected = true;
        this.subscribed.clear();
        this.attach(ws);
        resolve();
      });
      ws.once("error",fail);
      ws.once("close",()=>fail(new Error("DERIV_PUBLIC_WEBSOCKET_CLOSED_DURING_CONNECT")));
    });
  }

  attach(ws) {
    ws.on("message",(raw)=>{
      let data;
      try { data = JSON.parse(String(raw)); } catch { return; }

      if (data?.error) {
        const symbol = String(data?.echo_req?.ticks||"").trim();
        if (symbol) this.rejectWaiters(symbol,new Error(data.error.message||"DERIV_MARKET_API_ERROR"));
        return;
      }

      if (data?.msg_type !== "tick" || !data?.tick) return;

      const symbol = String(data.tick.symbol||data?.echo_req?.ticks||"").trim();
      const quote = finite(data.tick.quote);
      const epoch = finite(data.tick.epoch);
      if (!symbol || quote === null) return;

      const tick = {
        symbol,
        bid: finite(data.tick.bid) ?? quote,
        ask: finite(data.tick.ask) ?? quote,
        price: quote,
        epoch,
        time: epoch !== null ? new Date(epoch*1000).toISOString() : new Date().toISOString(),
        receivedAt: Date.now(),
        source: "deriv-shared-live-feed",
        endpoint: this.endpoint
      };
      this.ticks.set(symbol,tick);
      const waiters = this.waiters.get(symbol);
      if (waiters) {
        this.waiters.delete(symbol);
        for (const waiter of waiters) waiter.resolve(tick);
      }
    });

    ws.on("close",()=>{
      if (this.ws !== ws) return;
      this.connected = false;
      this.ws = null;
      this.subscribed.clear();
      for (const [symbol,waiters] of this.waiters.entries()) {
        this.waiters.delete(symbol);
        for (const waiter of waiters) waiter.reject(new Error("DERIV_PUBLIC_WEBSOCKET_CLOSED"));
      }
      if (!this.closed) this.scheduleReconnect();
    });

    ws.on("error",()=>{});
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.closed || this.desired.size===0) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.maxRetryDelayMs, this.retryDelayMs*2);
    this.reconnectTimer = setTimeout(async()=>{
      this.reconnectTimer = null;
      try { await this.connect(); } catch { this.scheduleReconnect(); }
    },delay);
  }

  destroySocket() {
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    this.subscribed.clear();
    if (ws) {
      try { ws.removeAllListeners(); } catch {}
      try { ws.close(); } catch {}
    }
  }

  async subscribe(symbol) {
    const s = this.normalize(symbol);
    this.desired.add(s);
    await this.connect();
    if (!this.ws || !this.connected) throw new Error("DERIV_MARKET_FEED_NOT_CONNECTED");
    if (this.subscribed.has(s)) return;
    const message = {ticks:s,subscribe:1,req_id:++this.reqId};
    try {
      this.ws.send(JSON.stringify(message));
      this.subscribed.add(s);
    } catch (error) {
      this.subscribed.delete(s);
      throw error;
    }
  }

  resubscribeAll() {
    if (!this.ws || !this.connected) return;
    for (const symbol of this.desired) {
      if (this.subscribed.has(symbol)) continue;
      try {
        this.ws.send(JSON.stringify({ticks:symbol,subscribe:1,req_id:++this.reqId}));
        this.subscribed.add(symbol);
      } catch {}
    }
  }

  rejectWaiters(symbol,error) {
    const waiters = this.waiters.get(symbol);
    if (!waiters) return;
    this.waiters.delete(symbol);
    for (const waiter of waiters) waiter.reject(error);
  }

  async getQuote(symbol,{maxAgeMs=this.maxAgeMs,timeoutMs=8000}={}) {
    const s = await this.subscribe(symbol);
    const cached = this.ticks.get(s);
    const age = cached ? Date.now()-cached.receivedAt : Infinity;
    if (cached && age <= maxAgeMs) return {...cached,ageMs:Math.max(0,age)};

    return new Promise((resolve,reject)=>{
      const timer = setTimeout(()=>{
        const list = this.waiters.get(s)||[];
        this.waiters.set(s,list.filter(item=>item!==entry));
        reject(new Error("DERIV_MARKET_QUOTE_STALE"));
      },timeoutMs);
      const entry = {
        resolve:(tick)=>{clearTimeout(timer);resolve({...tick,ageMs:Math.max(0,Date.now()-tick.receivedAt)});},
        reject:(error)=>{clearTimeout(timer);reject(error);}
      };
      const list = this.waiters.get(s)||[];
      list.push(entry);
      this.waiters.set(s,list);
    });
  }

  status(symbol="") {
    const s = String(symbol||"").trim();
    const tick = s ? this.ticks.get(s) : null;
    return {
      connected:this.connected,
      endpoint:this.endpoint,
      symbol:s||null,
      subscribed:s ? this.subscribed.has(s) : this.subscribed.size,
      desired:s ? this.desired.has(s) : this.desired.size,
      price:tick?.price??null,
      epoch:tick?.epoch??null,
      ageMs:tick ? Math.max(0,Date.now()-tick.receivedAt) : null,
      fresh:Boolean(tick && Date.now()-tick.receivedAt <= this.maxAgeMs)
    };
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.destroySocket();
    this.desired.clear();
    this.ticks.clear();
  }
}

let sharedFeed = null;

export function getDerivMarketFeed() {
  if (!sharedFeed) sharedFeed = new DerivMarketFeed();
  return sharedFeed;
}
