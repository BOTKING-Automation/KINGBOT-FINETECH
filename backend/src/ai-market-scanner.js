import "dotenv/config";
import { TwelveDataFeed } from "./twelve-data-feed.js";
import { getDerivMarketFeed } from "./deriv-market-feed.js";

const DEFAULT_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD"];
const DEFAULT_TF = "5m";
const publicDerivFeed = getDerivMarketFeed();
const publicDerivTechnicalCache = new Map();
const PUBLIC_TECHNICAL_CACHE_MS = Math.max(5000, Number(process.env.KINGBOT_SCANNER_TECHNICAL_CACHE_MS || 15000));

function cleanSymbols(value) {
  const input = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(input.map(s => String(s || "").trim().toUpperCase()).filter(s => /^[A-Z0-9._:-]{3,40}$/.test(s)))].slice(0, 12);
}
function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function cleanTimeframe(value) {
  const v = String(value || DEFAULT_TF).trim().toLowerCase();
  return /^(1m|3m|5m|15m|30m|1h|2h|4h|1d|1w)$/.test(v) ? v : DEFAULT_TF;
}
function bool(v) {
  if (typeof v === "boolean") return v;
  return ["true","1","yes","bullish","confirmed"].includes(String(v || "").toLowerCase());
}

function technicalEngine(snapshot) {
  if (!snapshot) return {
    signal: "DATA_INSUFFICIENT",
    bias: "DATA_INSUFFICIENT",
    score: 0,
    waitFor: "TradingView snapshot is not available yet.",
    reason: "KINGBOT requires a verified TradingView market snapshot before technical analysis.",
    technicalAnalysis: [],
    invalidation: "No valid market data.",
  };

  const price = finite(snapshot.close ?? snapshot.price);
  const ema20 = finite(snapshot.ema20);
  const ema50 = finite(snapshot.ema50);
  const rsi = finite(snapshot.rsi14 ?? snapshot.rsi);
  const macd = finite(snapshot.macd);
  const macdSignal = finite(snapshot.macdSignal ?? snapshot.macd_signal);
  const atr = finite(snapshot.atr14 ?? snapshot.atr);
  const support = finite(snapshot.support);
  const resistance = finite(snapshot.resistance);
  const trend = String(snapshot.trend || "").toUpperCase();
  const bos = String(snapshot.bos || "").toUpperCase();
  const choch = String(snapshot.choch || "").toUpperCase();
  const liquidity = String(snapshot.liquiditySweep || snapshot.liquidity_sweep || "").toUpperCase();
  const fvg = bool(snapshot.fvg);
  const longEvidence = [
    trend === "BULLISH", bos === "BULLISH", choch === "BULLISH", liquidity === "BULLISH",
    ema20 !== null && ema50 !== null && ema20 > ema50,
    rsi !== null && rsi >= 50 && rsi <= 70,
    macd !== null && macdSignal !== null && macd > macdSignal,
    fvg
  ];
  const shortEvidence = [
    trend === "BEARISH", bos === "BEARISH", choch === "BEARISH", liquidity === "BEARISH",
    ema20 !== null && ema50 !== null && ema20 < ema50,
    rsi !== null && rsi < 50 && rsi >= 30,
    macd !== null && macdSignal !== null && macd < macdSignal,
    fvg
  ];
  const longScore = longEvidence.filter(Boolean).length;
  const shortScore = shortEvidence.filter(Boolean).length;
  const bias = longScore === shortScore ? "NEUTRAL" : longScore > shortScore ? "BULLISH" : "BEARISH";
  const score = Math.round(Math.max(longScore, shortScore) / 8 * 100);

  const analysis = [];
  if (trend) analysis.push(`Trend: ${trend}`);
  if (bos) analysis.push(`BOS: ${bos}`);
  if (choch) analysis.push(`CHOCH: ${choch}`);
  if (liquidity) analysis.push(`Liquidity sweep: ${liquidity}`);
  if (ema20 !== null && ema50 !== null) analysis.push(`EMA20/EMA50: ${ema20 > ema50 ? "bullish alignment" : "bearish alignment"}`);
  if (rsi !== null) analysis.push(`RSI(14): ${rsi.toFixed(2)}`);
  if (macd !== null && macdSignal !== null) analysis.push(`MACD: ${macd > macdSignal ? "bullish" : "bearish"}`);
  if (fvg) analysis.push("FVG: detected");

  let signal = "WAIT";
  let waitFor = bias === "BULLISH"
    ? "Wait for bullish confirmation/close above the trigger level."
    : bias === "BEARISH"
      ? "Wait for bearish confirmation/close below the trigger level."
      : "Wait for structure and momentum to align.";
  if (score >= 75 && bias !== "NEUTRAL") signal = "ENTRY_CONFIRMING";
  if (score < 50) signal = "NO_TRADE";

  let entry = price;
  let sl = null;
  let tp1 = null;
  let tp2 = null;
  if (price !== null && atr !== null) {
    const risk = atr * 1.25;
    if (bias === "BULLISH") {
      sl = price - risk; tp1 = price + risk * 1.5; tp2 = price + risk * 2.5;
    } else if (bias === "BEARISH") {
      sl = price + risk; tp1 = price - risk * 1.5; tp2 = price - risk * 2.5;
    }
  }
  if (support !== null && resistance !== null && price !== null) {
    if (bias === "BULLISH" && price <= support) waitFor = "Wait for reclaim/confirmation above support.";
    if (bias === "BEARISH" && price >= resistance) waitFor = "Wait for rejection/confirmation below resistance.";
  }

  return {
    signal, bias, score, entry, sl, tp1, tp2, waitFor,
    reason: analysis.length ? analysis.join(" · ") : "Insufficient technical fields.",
    technicalAnalysis: analysis,
    invalidation: bias === "BULLISH"
      ? "Invalidate if price closes below the identified bullish structure/support."
      : bias === "BEARISH"
        ? "Invalidate if price closes above the identified bearish structure/resistance."
        : "Invalidate when a directional structure is established against the setup."
  };
}

async function ensureScannerSchema(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kingbot_tradingview_snapshots (
      id BIGSERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      bar_time TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(symbol, timeframe, bar_time)
    );
    CREATE INDEX IF NOT EXISTS idx_kingbot_tv_latest
      ON kingbot_tradingview_snapshots(symbol, timeframe, bar_time DESC);
  `);
}

async function saveTradingViewSnapshot(pool, body) {
  const symbol = String(body?.symbol || body?.ticker || "").trim().toUpperCase();
  const timeframe = cleanTimeframe(body?.timeframe || body?.interval);
  const barTime = new Date(body?.barTime || body?.time || Date.now());
  if (!symbol || !/^[A-Z0-9._:-]{3,40}$/.test(symbol) || Number.isNaN(barTime.getTime())) {
    throw new Error("TRADINGVIEW_PAYLOAD_INVALID");
  }
  await pool.query(
    `INSERT INTO kingbot_tradingview_snapshots(symbol,timeframe,bar_time,payload)
     VALUES($1,$2,$3,$4::jsonb)
     ON CONFLICT(symbol,timeframe,bar_time) DO UPDATE SET payload=EXCLUDED.payload,received_at=NOW()`,
    [symbol, timeframe, barTime.toISOString(), JSON.stringify(body)]
  );
  return { symbol, timeframe, barTime: barTime.toISOString() };
}

async function latestTradingView(pool, symbols, timeframe) {
  if (!pool) return [];
  try {
    const q = await pool.query(
      `SELECT DISTINCT ON (symbol) symbol,timeframe,bar_time,payload,received_at
         FROM kingbot_tradingview_snapshots
        WHERE symbol = ANY($1) AND timeframe=$2
        ORDER BY symbol,bar_time DESC`,
      [symbols, timeframe]
    );
    return q.rows.map(r => ({ ...r.payload, symbol: r.symbol, timeframe: r.timeframe, barTime: r.bar_time, receivedAt: r.received_at }));
  } catch (error) {
    console.warn("[KINGBOT TV]", error?.message || error);
    return [];
  }
}


function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a,b)=>a+b,0) / period;
}
function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const k=2/(period+1);
  let prev=sma(values.slice(0,period),period);
  const out=Array(period-1).fill(null);
  out.push(prev);
  for(let i=period;i<values.length;i++){ prev=values[i]*k+prev*(1-k); out.push(prev); }
  return out;
}
function rsiValue(values, period=14) {
  if(values.length<=period)return null;
  let gain=0,loss=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];gain+=Math.max(d,0);loss+=Math.max(-d,0);}
  let avgGain=gain/period, avgLoss=loss/period;
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];avgGain=(avgGain*(period-1)+Math.max(d,0))/period;avgLoss=(avgLoss*(period-1)+Math.max(-d,0))/period;}
  if(avgLoss===0)return 100;
  return 100-(100/(1+avgGain/avgLoss));
}
function atrValue(bars, period=14) {
  if(bars.length<=period)return null;
  const trs=[];
  for(let i=1;i<bars.length;i++){const h=bars[i].high,l=bars[i].low,pc=bars[i-1].close;trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));}
  return sma(trs,period);
}
function deriveTechnicalFromBars(bars) {
  if(!Array.isArray(bars)||bars.length<60)return null;
  const closes=bars.map(b=>b.close), highs=bars.map(b=>b.high), lows=bars.map(b=>b.low);
  const e20=emaSeries(closes,20), e50=emaSeries(closes,50);
  const ema20=e20.at(-1), ema50=e50.at(-1), rsi=rsiValue(closes,14), atr=atrValue(bars,14);
  const fast=emaSeries(closes,12), slow=emaSeries(closes,26);
  const macdSeries=closes.map((_,i)=>fast[i]!=null&&slow[i]!=null?fast[i]-slow[i]:null).filter(v=>v!=null);
  const macd=sma(macdSeries.slice(-9),9), macdLine=macdSeries.at(-1);
  const last=bars.at(-1), prev=bars.at(-2), recentHigh=Math.max(...highs.slice(-20,-1)), recentLow=Math.min(...lows.slice(-20,-1));
  const priorHigh=Math.max(...highs.slice(-40,-20)), priorLow=Math.min(...lows.slice(-40,-20));
  const trend=ema20>ema50&&last.close>ema20?"BULLISH":ema20<ema50&&last.close<ema20?"BEARISH":"NEUTRAL";
  const bos=last.close>recentHigh?"BULLISH":last.close<recentLow?"BEARISH":"NONE";
  const choch=(prev.close<=priorHigh&&last.close>priorHigh)?"BULLISH":(prev.close>=priorLow&&last.close<priorLow)?"BEARISH":"NONE";
  const liquiditySweep=(last.low<recentLow&&last.close>recentLow)?"BULLISH":(last.high>recentHigh&&last.close<recentHigh)?"BEARISH":"NONE";
  const fvg=bars.length>=4 && (bars.at(-1).low>bars.at(-3).high || bars.at(-1).high<bars.at(-3).low);
  return {
    close:last.close, price:last.close, ema20, ema50, rsi14:rsi, macd:macdLine, macdSignal:macd,
    atr14:atr, support:recentLow, resistance:recentHigh, trend, bos, choch,
    liquiditySweep, fvg, source:"Twelve Data OHLC + KINGBOT technical engine",
    barTime:last.datetime||last.timestamp||null, receivedAt:new Date().toISOString()
  };
}
async function fetchTwelveDataTechnical(twelveData, symbols, timeframe) {
  if(!twelveData?.enabled)return [];
  return Promise.all(symbols.map(async symbol=>{
    try {
      const snapshot=await twelveData.technicalSnapshot(symbol,timeframe,{maxAgeMs:15000});
      return snapshot?{symbol,...snapshot}:null;
    } catch(error) {
      return {symbol,technicalError:String(error?.message||"TECHNICAL_DATA_UNAVAILABLE").slice(0,120)};
    }
  })).then(rows=>rows.filter(Boolean));
}

async function fetchPublicDerivQuotes(symbols) {
  const requested=cleanSymbols(symbols);
  if(!requested.length)return [];
  const rows=await Promise.all(requested.map(async symbol=>{
    try{
      const quote=await publicDerivFeed.getQuote(symbol,{maxAgeMs:3000,timeoutMs:2500});
      return {
        symbol,
        brokerSymbol:quote.brokerSymbol||null,
        price:quote.price,
        bid:quote.bid,
        ask:quote.ask,
        spread:quote.bid!=null&&quote.ask!=null?quote.ask-quote.bid:null,
        time:quote.time||null,
        timestamp:quote.epoch!=null?Number(quote.epoch)*1000:Date.now(),
        available:true,
        ageMs:Number(quote.ageMs||0),
        source:quote.source||"Deriv public live feed"
      };
    }catch(error){
      return {
        symbol,
        available:false,
        source:"Deriv public live feed",
        error:String(error?.message||"DERIV_PUBLIC_QUOTE_UNAVAILABLE").slice(0,120)
      };
    }
  }));
  return rows;
}

async function getFastStandaloneQuotes({ twelveData, symbols }) {
  const normalized=cleanSymbols(symbols).length ? cleanSymbols(symbols) : DEFAULT_SYMBOLS;
  if(twelveData?.enabled){
    const tdQuotes=await twelveData.latestQuotes(normalized,{allowRestFallback:false});
    const missing=tdQuotes.filter(q=>!q.available).map(q=>q.symbol);
    if(!missing.length)return tdQuotes;
    const deriv=await fetchPublicDerivQuotes(missing);
    const derivMap=Object.fromEntries(deriv.map(q=>[q.symbol,q]));
    return tdQuotes.map(q=>q.available?q:(derivMap[q.symbol]||q));
  }
  return fetchPublicDerivQuotes(normalized);
}

function overlayLiveQuotes(technical, quotes) {
  const quoteMap=Object.fromEntries((quotes||[]).filter(q=>q?.available).map(q=>[q.symbol,q]));
  return technical.map(item=>{
    const quote=quoteMap[item.symbol];
    if(!quote)return item;
    return {
      ...item,
      price:finite(quote.price) ?? item.price,
      close:finite(quote.price) ?? item.close,
      bid:finite(quote.bid),
      ask:finite(quote.ask),
      spread:finite(quote.spread),
      quoteTimestamp:quote.timestamp||null,
      quoteAgeMs:Number(quote.ageMs??Math.max(0,Date.now()-Number(quote.timestamp||Date.now())))
    };
  });
}

async function askGrok({ technical, quotes, timeframe }) {
  const apiKey = String(process.env.XAI_API_KEY || "").trim();
  if (!apiKey) return { provider: "none", model: null, analysis: null };

  const model = String(process.env.XAI_MODEL || "grok-4.7").trim();
  const baseUrl = String(process.env.XAI_API_BASE_URL || "https://api.x.ai/v1").trim().replace(/\/$/, "");
  const prompt = [
    "You are KINGBOT AI, a market-intelligence reasoning layer.",
    "Use ONLY the supplied verified market data. Do not invent prices, candles, levels, news, or signals.",
    "The deterministic KINGBOT engine is authoritative for the calculated technical fields.",
    "Synthesize the evidence into a disciplined market-intelligence report.",
    "For each symbol, explain trend, momentum, structure, liquidity/FVG evidence, setup state, entry condition, invalidation and risk flags.",
    "Do not promise profit or certainty. A score below 75 must not be described as an entry confirmation.",
    "TIMEFRAME: " + timeframe,
    "TECHNICAL ENGINE OUTPUT: " + JSON.stringify(technical),
    "VERIFIED LIVE QUOTES: " + JSON.stringify(quotes)
  ].join("\n");

  const response = await fetch(baseUrl + "/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: "KINGBOT AI market intelligence. Return structured JSON only." },
        { role: "user", content: prompt }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "kingbot_market_scan",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              market_regime: { type: "string" },
              ranked_symbols: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    symbol: { type: "string" },
                    bias: { type: "string" },
                    signal: { type: "string" },
                    score: { type: "number" },
                    entry: { type: ["number", "null"] },
                    sl: { type: ["number", "null"] },
                    tp1: { type: ["number", "null"] },
                    tp2: { type: ["number", "null"] },
                    waitFor: { type: "string" },
                    reason: { type: "string" },
                    technicalAnalysis: { type: "array", items: { type: "string" } },
                    invalidation: { type: "string" },
                    riskFlags: { type: "array", items: { type: "string" } }
                  },
                  required: ["symbol","bias","signal","score","entry","sl","tp1","tp2","waitFor","reason","technicalAnalysis","invalidation","riskFlags"]
                }
              },
              risk_flags: { type: "array", items: { type: "string" } },
              summary: { type: "string" }
            },
            required: ["market_regime","ranked_symbols","risk_flags","summary"]
          }
        }
      },
      max_output_tokens: 2200,
      store: false
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || "XAI_MARKET_SCAN_FAILED");
  }

  let analysis = String(data?.output_text || "").trim();
  if (!analysis && Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (item?.type !== "message" || !Array.isArray(item.content)) continue;
      const part = item.content.find(x => x?.type === "output_text" && typeof x.text === "string");
      if (part?.text) { analysis = part.text.trim(); break; }
    }
  }
  if (!analysis) throw new Error("XAI_MARKET_SCAN_EMPTY");
  JSON.parse(analysis);
  return { provider: "xai", model, analysis };
}

async function fetchCachedPublicDerivTechnical(symbol, timeframe) {
  const key=String(symbol).toUpperCase()+":"+String(timeframe).toLowerCase();
  const cached=publicDerivTechnicalCache.get(key);
  const age=cached ? Date.now()-Number(cached.cachedAt||0) : Infinity;
  if(cached?.technical && age<=PUBLIC_TECHNICAL_CACHE_MS) {
    return {...cached.technical, technicalCacheAgeMs:Math.max(0,age)};
  }
  const bars=await publicDerivFeed.getHistoricalCandles(symbol,{timeframe,limit:120,timeoutMs:5000});
  const technical=deriveTechnicalFromBars((Array.isArray(bars)?bars:[]).map(b=>({...b,datetime:b.time})));
  if(!technical) throw new Error("INSUFFICIENT_HISTORICAL_CANDLES");
  const snapshot={...technical,symbol,timeframe,source:"Deriv public live OHLC",barTime:technical.barTime||bars.at(-1)?.time||null,receivedAt:new Date().toISOString()};
  publicDerivTechnicalCache.set(key,{technical:snapshot,cachedAt:Date.now()});
  return {...snapshot,technicalCacheAgeMs:0};
}

async function fetchPublicDerivData(symbols, timeframe) {
  const rows = await Promise.all(symbols.map(async symbol => {
    let quote = null;
    let technical = null;
    let quoteError = null;
    let technicalError = null;
    try {
      quote = await publicDerivFeed.getQuote(symbol,{maxAgeMs:3000,timeoutMs:2000});
    } catch(error) {
      quoteError = String(error?.message||"DERIV_PUBLIC_QUOTE_UNAVAILABLE").slice(0,140);
    }
    try {
      technical = await fetchCachedPublicDerivTechnical(symbol,timeframe);
    } catch(error) {
      technicalError = String(error?.message||"DERIV_PUBLIC_OHLC_UNAVAILABLE").slice(0,140);
    }
    return {symbol,quote,technical,quoteError,technicalError};
  }));
  return rows;
}
async function standaloneMarketScan({ pool, twelveData, symbols, timeframe }) {
  const normalizedSymbols = cleanSymbols(symbols).length ? cleanSymbols(symbols) : DEFAULT_SYMBOLS;
  const normalizedTimeframe = cleanTimeframe(timeframe);

  if (!twelveData?.enabled && !pool) {
    return {
      ok:false,
      error:"MARKET_DATA_ENGINE_NOT_CONFIGURED",
      code:"MARKET_DATA_ENGINE_NOT_CONFIGURED",
      message:"KINGBOT AI Scanner requires a configured live market-data engine."
    };
  }

  const quotePromise = getFastStandaloneQuotes({ twelveData, symbols: normalizedSymbols });
  const derivDataPromise = twelveData?.enabled
    ? Promise.resolve([])
    : fetchPublicDerivData(normalizedSymbols,normalizedTimeframe);
  const technicalPromise = fetchTwelveDataTechnical(twelveData, normalizedSymbols, normalizedTimeframe);
  const tvPromise = latestTradingView(pool, normalizedSymbols, normalizedTimeframe);

  const [directQuotes, derivData, tdTechnical, tv] = await Promise.all([
    quotePromise,
    derivDataPromise,
    technicalPromise,
    tvPromise
  ]);

  const derivQuotes = derivData.map(x => {
    if(!x.quote) return {symbol:x.symbol,available:false,source:"Deriv public live feed",error:x.quoteError||"DERIV_PUBLIC_QUOTE_UNAVAILABLE"};
    return {
      symbol:x.symbol,
      brokerSymbol:x.quote.brokerSymbol||null,
      price:x.quote.price,
      bid:x.quote.bid,
      ask:x.quote.ask,
      spread:x.quote.bid!=null&&x.quote.ask!=null?x.quote.ask-x.quote.bid:null,
      time:x.quote.time||null,
      timestamp:x.quote.epoch!=null?Number(x.quote.epoch)*1000:Date.now(),
      available:true,
      source:"Deriv public live feed"
    };
  });
  const quotes=directQuotes.some(q=>q.available)
    ? directQuotes
    : derivQuotes;
  const combinedTechnical=[...tdTechnical,...derivData.map(x=>x.technical).filter(Boolean)];
  const technicalBySymbol=new Map();
  for(const item of combinedTechnical) if(!technicalBySymbol.has(item.symbol)) technicalBySymbol.set(item.symbol,item);
  const tdMap = Object.fromEntries([...technicalBySymbol.entries()].map(([k,v]) => [k,v]));
  let technical = normalizedSymbols.map(symbol => {
    const snapshot = tdMap[symbol] || tv.find(x => x.symbol === symbol);
    return snapshot
      ? {
          symbol,
          ...technicalEngine(snapshot),
          timeframe: normalizedTimeframe,
          source: tdMap[symbol]?.source || (tv.find(x => x.symbol === symbol) ? "TradingView" : "live OHLC"),
          barTime: snapshot.barTime,
          dataFreshness: snapshot.receivedAt || snapshot.barTime,
          technicalCacheAgeMs: finite(snapshot.cacheAgeMs)
        }
      : {
          symbol,
          ...technicalEngine(null),
          timeframe: normalizedTimeframe,
          source:"none"
        };
  });
  technical = overlayLiveQuotes(technical, directQuotes);

  const tvMap = Object.fromEntries(tv.map(x => [x.symbol, x]));
  const technicalSource = tdTechnical.length
    ? "Twelve Data live OHLC + live quote feed"
    : (derivData.some(x=>x.technical)
      ? "Deriv public live OHLC + live quote feed"
      : (tv.length ? "TradingView snapshots" : "live quotes only"));

  if (!technical.some(x => x.source !== "none") && !directQuotes.some(q => q.available)) {
    return {
      ok:false,
      error:"LIVE_MARKET_DATA_UNAVAILABLE",
      code:"LIVE_MARKET_DATA_UNAVAILABLE",
      scanner:"KINGBOT AI MARKET SCANNER",
      message:"The standalone scanner has no fresh verified market data. Check the live market-data feed configuration."
    };
  }

  let ai = null;
  try {
    ai = await askGrok({ technical, quotes, timeframe: normalizedTimeframe });
  } catch (error) {
    ai = {
      provider:"none",
      model:null,
      analysis:null,
      aiError:String(error?.message || "AI_FAILED").slice(0,200)
    };
  }

  const fallbackAnalysis = {
    market_regime: (() => {
      const scored = technical.filter(x => x.source !== "none" && Number.isFinite(Number(x.score)));
      if (!scored.length) return "MIXED";
      const bull = scored.reduce((sum,x) => sum + (x.bias === "BULLISH" ? Number(x.score) : 0), 0);
      const bear = scored.reduce((sum,x) => sum + (x.bias === "BEARISH" ? Number(x.score) : 0), 0);
      if (Math.abs(bull - bear) < 10) return "MIXED";
      return bull > bear ? "BULLISH" : "BEARISH";
    })(),
    ranked_symbols: technical.map(x => ({symbol:x.symbol,...x})),
    risk_flags:[
      ...(ai?.aiError ? ["AI_EXPLANATION_UNAVAILABLE"] : []),
      "BROKER_CONNECTION_NOT_REQUIRED_FOR_MARKET_SCAN"
    ],
    summary:"KINGBOT standalone market engine analyzed live verified market data. Broker connectivity is not part of market scanning."
  };

  return {
    ok:true,
    scanner:"KINGBOT AI MARKET SCANNER",
    provider:ai.provider,
    model:ai.model,
    executionAuthority:"NONE",
    source:technicalSource,
    liveQuoteSource:twelveData?.enabled ? "Twelve Data WebSocket + public fallback" : "Deriv public live feed",
    scannerLatencyHint:"Quotes are served independently from AI analysis.",
    marketData:twelveData?.status ? twelveData.status() : {configured:false},
    symbols:normalizedSymbols,
    timeframe:normalizedTimeframe,
    quotes,
    technical,
    tradingViewSnapshots:tvMap,
    analysis:ai.analysis || JSON.stringify(fallbackAnalysis),
    aiError:ai.aiError || null,
    generatedAt:new Date().toISOString(),
    quoteCount:quotes.filter(q=>q.available).length,
    marketDataSources:{
      brokerIndependent:true,
      derivPublic:true,
      twelveData:Boolean(twelveData?.enabled),
      tradingView:Boolean(tv.length)
    },
    tradingViewCount:tv.length,
    technicalCount:technical.filter(x=>x.source!=="none").length,
    technicalSource,
    brokerRequired:false
  };
}

export async function runStandaloneMarketScan({ pool, twelveData, symbols, timeframe } = {}) {
  return standaloneMarketScan({ pool, twelveData, symbols, timeframe });
}

async function runMarketScan({ pool, twelveData, req, res }) {
  try {
    const result = await standaloneMarketScan({
      pool,
      twelveData,
      symbols:req.query?.symbols || req.body?.symbols,
      timeframe:req.query?.timeframe || req.body?.timeframe
    });
    if (!result.ok) return res.status(503).json(result);
    return res.json(result);
  } catch (error) {
    console.error("[KINGBOT MARKET SCANNER]", error?.message || error);
    return res.status(502).json({
      ok:false,
      error:"AI_MARKET_SCANNER_UNAVAILABLE",
      code:"AI_MARKET_SCANNER_UNAVAILABLE",
      reason:String(error?.message || "AI_MARKET_SCANNER_UNAVAILABLE").slice(0,220)
    });
  }
}

export async function ensureAiMarketScannerSchema(pool) {
  await ensureScannerSchema(pool);
}

export function registerAiMarketScanner(app, { pool, rateLimit, twelveData }) {
  void ensureScannerSchema(pool).catch(e => console.error("[KINGBOT TV SCHEMA]", e?.message || e));

  const limiter = rateLimit({
    windowMs:60*1000, limit:Number(process.env.AI_SCANNER_MAX_REQUESTS_PER_MINUTE || 6),
    standardHeaders:"draft-8", legacyHeaders:false,
    message:{ok:false,error:"AI scanner rate limit reached. Wait a moment and retry."}
  });

  app.post("/api/webhooks/tradingview", async (req,res) => {
    try {
      const secret = String(process.env.TRADINGVIEW_WEBHOOK_SECRET || "").trim();
      if (!secret || String(req.headers["x-kingbot-webhook-secret"] || req.query?.secret || req.body?.secret || "") !== secret) {
        return res.status(401).json({ok:false,error:"TRADINGVIEW_WEBHOOK_UNAUTHORIZED"});
      }
      const saved = await saveTradingViewSnapshot(pool, req.body || {});
      return res.status(202).json({ok:true,source:"TradingView",...saved});
    } catch (error) {
      return res.status(400).json({ok:false,error:String(error?.message || "TRADINGVIEW_WEBHOOK_FAILED")});
    }
  });

  const quoteLimiter = rateLimit({
    windowMs:60*1000, limit:Number(process.env.AI_SCANNER_QUOTE_REQUESTS_PER_MINUTE || 30),
    standardHeaders:"draft-8", legacyHeaders:false,
    message:{ok:false,error:"AI scanner quote rate limit reached. Wait a moment and retry."}
  });

  const quoteHandler=async(req,res)=>{
    const startedAt=Date.now();
    try{
      const symbols=req.query?.symbols || req.body?.symbols;
      const quotes=await getFastStandaloneQuotes({twelveData,symbols});
      const availableQuotes=quotes.filter(q=>q.available);
      return res.json({
        ok:true,
        scanner:"KINGBOT AI MARKET SCANNER",
        mode:"quotes",
        executionAuthority:"NONE",
        quotes,
        quoteCount:availableQuotes.length,
        generatedAt:new Date().toISOString(),
        latencyMs:Date.now()-startedAt,
        source:twelveData?.enabled ? "Twelve Data WebSocket + public fallback" : "Deriv public live feed",
        brokerRequired:false
      });
    }catch(error){
      console.error("[KINGBOT MARKET QUOTES]",error?.message||error);
      return res.status(503).json({
        ok:false,
        error:"LIVE_MARKET_QUOTES_UNAVAILABLE",
        reason:String(error?.message||"LIVE_MARKET_QUOTES_UNAVAILABLE").slice(0,180)
      });
    }
  };

  app.get("/api/ai/market-scanner/quotes",quoteLimiter,quoteHandler);
  app.get("/api/market-scanner/quotes",quoteLimiter,quoteHandler);

  app.get("/api/ai/market-scanner/status", async (_req,res) => {
    const apiKey = String(process.env.XAI_API_KEY || "").trim();
    let tvCount=0;
    try { const q=await pool.query("SELECT COUNT(*)::int AS count FROM kingbot_tradingview_snapshots WHERE received_at > NOW() - INTERVAL '10 minutes'"); tvCount=q.rows[0]?.count || 0; } catch {}
    return res.json({
      ok:true, scanner:"KINGBOT AI MARKET SCANNER", aiReady:Boolean(apiKey), provider:apiKey?"xai":"none",
      marketData:{
        twelveData:twelveData.status(),
        derivPublic:{
          ...publicDerivFeed.status(),
          standalone:true,
          source:"Deriv public live market feed"
        }
      },
      scannerStandalone:true,
      brokerRequired:false,
      model:apiKey?String(process.env.XAI_MODEL || "grok-4.7"):null,
      tradingViewConnected:tvCount>0, tradingViewSnapshotsLast10m:tvCount, webhookConfigured:Boolean(process.env.TRADINGVIEW_WEBHOOK_SECRET),
      defaultSymbols:DEFAULT_SYMBOLS
    });
  });

  const scanHandler=async(req,res)=>{ await runMarketScan({pool,twelveData,req,res}); };
  app.get("/api/ai/market-scanner",limiter,scanHandler);
  app.post("/api/ai/market-scanner",limiter,scanHandler);
  app.get("/api/market-scanner",limiter,scanHandler);
  app.post("/api/market-scanner",limiter,scanHandler);
  app.get("/api/ai/scan",limiter,scanHandler);
  app.post("/api/ai/scan",limiter,scanHandler);
}
