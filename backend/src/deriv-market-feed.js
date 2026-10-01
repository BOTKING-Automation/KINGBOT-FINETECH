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
    this.requestWaiters = new Map();
    this.tickListeners = new Map();
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
    // Browser/broker catalog symbols such as frxXAUUSD become FRXXAUUSD
    // after upper-casing. Strip exactly one FRX prefix before alias lookup.
    const base = upper.startsWith("FRX") ? upper.slice(3) : upper;
    return aliases[base] || aliases[upper] || value;
  }

  async connect() {
    if (this.closed) this.closed = false;
    if (this.connected && this.ws) return {connected:true,endpoint:this.endpoint};
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async()=>{
      let lastError = null;
      for (const endpoint of [DERIV_NEW_WS, DERIV_LEGACY_WS]) {
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

      const reqId = finite(data?.req_id ?? data?.echo_req?.req_id);

      if (data?.error) {
        const symbol = String(data?.echo_req?.ticks||"").trim();
        const error = new Error(data.error.message||"DERIV_MARKET_API_ERROR");
        if (reqId !== null) this.rejectRequestWaiter(reqId,error);
        if (symbol) this.rejectWaiters(symbol,error);
        return;
      }

      if (data?.msg_type !== "tick" || !data?.tick) {
        if (reqId !== null && data?.msg_type) this.resolveRequestWaiter(reqId,data);
        return;
      }

      const rawSymbol = String(data.tick.symbol||data?.echo_req?.ticks||"").trim();
      const quote = finite(data.tick.quote);
      const epoch = finite(data.tick.epoch);
      if (!rawSymbol || quote === null) return;

      const symbol = this.normalize(rawSymbol);
      const tick = {
        symbol,
        brokerSymbol: rawSymbol,
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
      this.ticks.set(rawSymbol,tick);
      const listeners = this.tickListeners.get(symbol)||this.tickListeners.get(rawSymbol);
      if (listeners) {
        for (const listener of [...listeners]) {
          try { listener(tick); } catch {}
        }
      }
      const waiters = this.waiters.get(symbol)||this.waiters.get(rawSymbol);
      if (waiters) {
        this.waiters.delete(symbol);
        this.waiters.delete(rawSymbol);
        for (const waiter of waiters) waiter.resolve(tick);
      }
      if (reqId !== null) this.resolveRequestWaiter(reqId,tick);
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
    if (this.subscribed.has(s)) return s;
    const message = {ticks:s,subscribe:1,req_id:++this.reqId};
    try {
      this.ws.send(JSON.stringify(message));
      this.subscribed.add(s);
    } catch (error) {
      this.subscribed.delete(s);
      throw error;
    }
  }

  async onTick(symbol,listener) {
    const s = this.normalize(symbol);
    if (typeof listener !== "function") throw new Error("DERIV_TICK_LISTENER_REQUIRED");
    let listeners = this.tickListeners.get(s);
    if (!listeners) {
      listeners = new Set();
      this.tickListeners.set(s,listeners);
    }
    listeners.add(listener);
    try {
      await this.subscribe(s);
    } catch (error) {
      listeners.delete(listener);
      if (!listeners.size) this.tickListeners.delete(s);
      throw error;
    }
    return () => {
      const current = this.tickListeners.get(s);
      if (!current) return;
      current.delete(listener);
      if (!current.size) this.tickListeners.delete(s);
    };
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
    let normalized = symbol;
    try { normalized = this.normalize(symbol); } catch {}
    const waiters = this.waiters.get(normalized)||this.waiters.get(symbol);
    if (!waiters) return;
    this.waiters.delete(normalized);
    this.waiters.delete(symbol);
    for (const waiter of waiters) waiter.reject(error);
  }

  resolveRequestWaiter(reqId,value) {
    const waiter = this.requestWaiters.get(reqId);
    if (!waiter) return;
    this.requestWaiters.delete(reqId);
    waiter.resolve(value);
  }

  rejectRequestWaiter(reqId,error) {
    const waiter = this.requestWaiters.get(reqId);
    if (!waiter) return;
    this.requestWaiters.delete(reqId);
    waiter.reject(error);
  }

  nextReqId() {
    this.reqId += 1;
    return this.reqId;
  }

  send(message) {
    if (!this.ws || !this.connected) throw new Error("DERIV_MARKET_FEED_NOT_CONNECTED");
    this.ws.send(JSON.stringify(message));
  }

  async requestSnapshot(symbol,{timeoutMs=5000}={}) {
    const s = this.normalize(symbol);
    await this.connect();
    const reqId = this.nextReqId();

    return new Promise((resolve,reject)=>{
      const timer = setTimeout(()=>{
        this.requestWaiters.delete(reqId);
        reject(new Error("DERIV_MARKET_SNAPSHOT_TIMEOUT"));
      },Math.max(1500,Number(timeoutMs)||5000));

      this.requestWaiters.set(reqId,{
        resolve:(value)=>{
          clearTimeout(timer);
          this.requestWaiters.delete(reqId);
          if (value?.tick) {
            const quote = finite(value.tick.quote);
            const epoch = finite(value.tick.epoch);
            if (quote !== null) {
              const rawSymbol = String(value.tick.symbol||s).trim();
              const tick = {
                symbol:this.normalize(rawSymbol),
                brokerSymbol:rawSymbol,
                bid:finite(value.tick.bid) ?? quote,
                ask:finite(value.tick.ask) ?? quote,
                price:quote,
                epoch,
                time:epoch!==null?new Date(epoch*1000).toISOString():new Date().toISOString(),
                receivedAt:Date.now(),
                source:"deriv-one-shot-live-snapshot",
                endpoint:this.endpoint
              };
              this.ticks.set(this.normalize(rawSymbol),tick);
              this.ticks.set(rawSymbol,tick);
              resolve(tick);
              return;
            }
          }
          resolve(value);
        },
        reject:(error)=>{
          clearTimeout(timer);
          this.requestWaiters.delete(reqId);
          reject(error);
        }
      });

      try {
        this.send({ticks:s,req_id:reqId});
      } catch (error) {
        clearTimeout(timer);
        this.requestWaiters.delete(reqId);
        reject(error);
      }
    });
  }

  async forceReconnect() {
    if (this.closed) this.closed = false;
    this.destroySocket();
    return this.connect();
  }

  async getQuote(symbol,{maxAgeMs=this.maxAgeMs,timeoutMs=8000}={}) {
    const s = await this.subscribe(symbol);

    const cached = this.ticks.get(s);
    const age = cached ? Date.now()-cached.receivedAt : Infinity;
    if (cached && age <= maxAgeMs) return {...cached,ageMs:Math.max(0,age)};

    // A persistent subscription can remain connected while its stream becomes
    // stale. Request a fresh one-shot tick before failing the trading cycle.
    try {
      const snapshot = await this.requestSnapshot(s,{timeoutMs:Math.min(4500,timeoutMs)});
      if (snapshot?.price !== undefined) {
        return {...snapshot,ageMs:Math.max(0,Date.now()-snapshot.receivedAt)};
      }
    } catch {}

    // If the socket is unhealthy, rebuild it once and retry the snapshot.
    try {
      await this.forceReconnect();
      await this.subscribe(s);
      const snapshot = await this.requestSnapshot(s,{timeoutMs:Math.min(4500,timeoutMs)});
      if (snapshot?.price !== undefined) {
        return {...snapshot,ageMs:Math.max(0,Date.now()-snapshot.receivedAt)};
      }
    } catch {}

    return new Promise((resolve,reject)=>{
      const timer = setTimeout(()=>{
        const list = this.waiters.get(s)||[];
        this.waiters.set(s,list.filter(item=>item!==entry));
        reject(new Error("DERIV_MARKET_QUOTE_STALE"));
      },Math.max(2000,Number(timeoutMs)||8000));
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
    const requested = String(symbol||"").trim();
    let s = requested;
    try { s = requested ? this.normalize(requested) : ""; } catch {}
    const tick = s ? this.ticks.get(s) : null;
    return {
      connected:this.connected,
      endpoint:this.endpoint,
      symbol:requested||null,
      normalizedSymbol:s||null,
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
    this.requestWaiters.clear();
    this.tickListeners.clear();
  }
}

let sharedFeed = null;

export function getDerivMarketFeed() {
  if (!sharedFeed) sharedFeed = new DerivMarketFeed();
  return sharedFeed;
}
