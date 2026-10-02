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

function sma(values, period){ if(!Array.isArray(values)||values.length<period)return null; const s=values.slice(-period); return s.reduce((a,b)=>a+b,0)/period; }
function emaSeries(values,period){ if(values.length<period)return []; const k=2/(period+1); let prev=sma(values.slice(0,period),period); const out=Array(period-1).fill(null); out.push(prev); for(let i=period;i<values.length;i++){prev=values[i]*k+prev*(1-k);out.push(prev);} return out; }
function rsiValue(values,period=14){if(values.length<=period)return null;let g=0,l=0;for(let i=1;i<=period;i++){const d=values[i]-values[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);}let ag=g/period,al=l/period;for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];ag=(ag*(period-1)+Math.max(d,0))/period;al=(al*(period-1)+Math.max(-d,0))/period;}return al===0?100:100-100/(1+ag/al);}
function atrValue(bars,period=14){if(bars.length<=period)return null;const t=[];for(let i=1;i<bars.length;i++){const h=bars[i].high,l=bars[i].low,p=bars[i-1].close;t.push(Math.max(h-l,Math.abs(h-p),Math.abs(l-p)));}return sma(t,period);}
function deriveTechnicalFromBars(bars){if(bars.length<60)return null;const c=bars.map(x=>x.close),h=bars.map(x=>x.high),l=bars.map(x=>x.low),e20=emaSeries(c,20),e50=emaSeries(c,50),f=emaSeries(c,12),s=emaSeries(c,26),macdSeries=c.map((_,i)=>f[i]!=null&&s[i]!=null?f[i]-s[i]:null).filter(v=>v!=null),macd=macdSeries.at(-1),macdSignal=sma(macdSeries,9),rsi=rsiValue(c),atr=atrValue(bars),last=bars.at(-1),prev=bars.at(-2),rh=Math.max(...h.slice(-20,-1)),rl=Math.min(...l.slice(-20,-1)),ph=Math.max(...h.slice(-40,-20)),pl=Math.min(...l.slice(-40,-20)),ema20=e20.at(-1),ema50=e50.at(-1);const trend=ema20>ema50&&last.close>ema20?"BULLISH":ema20<ema50&&last.close<ema20?"BEARISH":"NEUTRAL";const bos=last.close>rh?"BULLISH":last.close<rl?"BEARISH":"NONE";const choch=prev.close<=ph&&last.close>ph?"BULLISH":prev.close>=pl&&last.close<pl?"BEARISH":"NONE";const liquiditySweep=last.low<rl&&last.close>rl?"BULLISH":last.high>rh&&last.close<rh?"BEARISH":"NONE";const fvg=bars.at(-1).low>bars.at(-3).high||bars.at(-1).high<bars.at(-3).low;return {close:last.close,price:last.close,ema20,ema50,rsi14:rsi,macd,macdSignal,atr14:atr,support:rl,resistance:rh,trend,bos,choch,liquiditySweep,fvg,barTime:last.datetime,receivedAt:new Date().toISOString()};}

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

  async technicalSnapshot(symbol, timeframe="5m") {
    if(!this.enabled) return null;
    const intervalMap={ "1m":"1min","3m":"3min","5m":"5min","15m":"15min","30m":"30min","1h":"1h","2h":"2h","4h":"4h","1d":"1day","1w":"1week" };
    const interval=intervalMap[String(timeframe).toLowerCase()]||"5min";
    const tdSymbol=normalizeSymbol(symbol);
    const url="https://api.twelvedata.com/time_series?symbol="+encodeURIComponent(tdSymbol)+"&interval="+encodeURIComponent(interval)+"&outputsize=120&order=ASC&apikey="+encodeURIComponent(this.apiKey);
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),9000);
    try {
      const res=await fetch(url,{signal:controller.signal,headers:{Accept:"application/json"}});
      const data=await res.json().catch(()=>({}));
      if(!res.ok || data?.status==="error" || !Array.isArray(data?.values)) throw new Error(data?.message||"TWELVE_DATA_TIME_SERIES_FAILED");
      const bars=data.values.map(x=>({datetime:x.datetime,open:finite(x.open),high:finite(x.high),low:finite(x.low),close:finite(x.close),volume:finite(x.volume)})).filter(x=>[x.open,x.high,x.low,x.close].every(Number.isFinite));
      if(bars.length<60) throw new Error("INSUFFICIENT_OHLC_DATA");
      return { ...deriveTechnicalFromBars(bars), symbol:kingbotSymbol(tdSymbol), twelveDataSymbol:tdSymbol, timeframe, barsUsed:bars.length, source:"Twelve Data REST time_series" };
    } finally { clearTimeout(timer); }
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
