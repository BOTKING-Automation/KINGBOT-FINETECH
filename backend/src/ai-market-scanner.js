import { isSyntheticSymbol } from "./synthetic-markets.js";
import "dotenv/config";
import { TwelveDataFeed } from "./twelve-data-feed.js";
import { getGoldPriceFeed } from "./gold-price-feed.js";
import { MarketDataFabric } from "./market-data-fabric.js";
import { getDerivMarketFeed } from "./deriv-market-feed.js";
import { predictPendingOrderZones } from "./pending-order-model.js";
import { technicalAnalysisBookContext } from "./technical-analysis-book.js";
import { WebSocketServer, WebSocket } from "ws";
import { getBotDefinitions } from "./bot-engines.js";
import { trainMlStrategyModel, mlSignalServiceStatus, probeMlSignalService } from "./ml-signal-client.js";

const DEFAULT_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD"];
const DEFAULT_TF = "5m";
const publicGoldPriceFeed = getGoldPriceFeed();
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
    atr14: atr,
    support,
    resistance,
    trend,
    bos,
    choch,
    liquiditySweep: liquidity,
    fvg,
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
export function deriveTechnicalFromBars(bars) {
  if(!Array.isArray(bars)||bars.length<80)return null;
  const clean=bars.map(b=>({
    open:finite(b.open),high:finite(b.high),low:finite(b.low),close:finite(b.close),
    volume:finite(b.volume),datetime:b.datetime||b.time||b.timestamp||null
  })).filter(b=>[b.open,b.high,b.low,b.close].every(Number.isFinite));
  if(clean.length<80)return null;

  const closes=clean.map(b=>b.close), highs=clean.map(b=>b.high), lows=clean.map(b=>b.low);
  const e20=emaSeries(closes,20), e50=emaSeries(closes,50);
  const ema20=e20.at(-1), ema50=e50.at(-1);
  const rsi=rsiValue(closes,14), atr=atrValue(clean,14), atr60=atrValue(clean,60);
  const fast=emaSeries(closes,12), slow=emaSeries(closes,26);
  const macdSeries=closes.map((_,i)=>fast[i]!=null&&slow[i]!=null?fast[i]-slow[i]:null).filter(v=>v!=null);
  const macdLine=macdSeries.at(-1), macdSignal=macdSeries.length>=9?sma(macdSeries.slice(-9),9):null;
  const last=clean.at(-1), prev=clean.at(-2);

  const window=20, lookback=5;
  const swingHighs=[], swingLows=[];
  for(let i=lookback;i<clean.length-lookback;i++){
    const h=clean[i].high,l=clean[i].low;
    const leftHigh=clean.slice(i-lookback,i).every(x=>x.high<h);
    const rightHigh=clean.slice(i+1,i+1+lookback).every(x=>x.high<h);
    const leftLow=clean.slice(i-lookback,i).every(x=>x.low>l);
    const rightLow=clean.slice(i+1,i+1+lookback).every(x=>x.low>l);
    if(leftHigh&&rightHigh)swingHighs.push({index:i,price:h});
    if(leftLow&&rightLow)swingLows.push({index:i,price:l});
  }
  const lastSwingHigh=swingHighs.at(-1)?.price??Math.max(...highs.slice(-window));
  const prevSwingHigh=swingHighs.at(-2)?.price??Math.max(...highs.slice(-window*2,-window));
  const lastSwingLow=swingLows.at(-1)?.price??Math.min(...lows.slice(-window));
  const prevSwingLow=swingLows.at(-2)?.price??Math.min(...lows.slice(-window*2,-window));

  const structure =
    last.close>lastSwingHigh && lastSwingLow>=prevSwingLow ? "bullish" :
    last.close<lastSwingLow && lastSwingHigh<=prevSwingHigh ? "bearish" :
    "range";
  const bos=last.close>lastSwingHigh?"BULLISH":last.close<lastSwingLow?"BEARISH":"NONE";
  const choch =
    last.close>lastSwingHigh && prev.close<=lastSwingHigh && lastSwingLow<prevSwingLow ? "BULLISH" :
    last.close<lastSwingLow && prev.close>=lastSwingLow && lastSwingHigh>prevSwingHigh ? "BEARISH" :
    "NONE";

  const recentHigh=Math.max(...highs.slice(-window,-1)), recentLow=Math.min(...lows.slice(-window,-1));
  const liquiditySweep =
    last.low<recentLow && last.close>recentLow ? "BULLISH" :
    last.high>recentHigh && last.close<recentHigh ? "BEARISH" : "NONE";

  const range=Math.max(last.high-last.low,1e-12);
  const body=Math.abs(last.close-last.open);
  const bodyRatio=body/range;
  const displacement=atr!=null && body>=atr*1.15 && bodyRatio>=0.65 &&
    (last.close-last.open)>0 ? "BULLISH" :
    atr!=null && body>=atr*1.15 && bodyRatio>=0.65 &&
    (last.close-last.open)<0 ? "BEARISH" : "NONE";

  const bullFvg=clean.length>=3 && clean.at(-1).low>clean.at(-3).high;
  const bearFvg=clean.length>=3 && clean.at(-1).high<clean.at(-3).low;
  const fvg=bullFvg||bearFvg;

  // Approximate order-block detection from the last opposite candle before displacement.
  let orderBlock=null;
  for(let i=clean.length-2;i>=Math.max(0,clean.length-12);i--){
    const b=clean[i], next=clean[i+1];
    if(displacement==="BULLISH" && b.close<b.open && next.close>b.high){orderBlock={direction:"BULLISH",high:b.high,low:b.low,index:i};break;}
    if(displacement==="BEARISH" && b.close>b.open && next.close<b.low){orderBlock={direction:"BEARISH",high:b.high,low:b.low,index:i};break;}
  }

  const trend=ema20>ema50&&last.close>ema20?"BULLISH":ema20<ema50&&last.close<ema20?"BEARISH":"NEUTRAL";
  const roc5=closes.length>=6?(last.close-closes.at(-6))/Math.max(Math.abs(closes.at(-6)),1e-12):0;
  const momentum=Math.max(-1,Math.min(1,(rsi==null?0:(rsi-50)/20)*0.65+Math.max(-1,Math.min(1,roc5/0.003))*0.35));
  const volatility=atr!=null&&atr60!=null&&atr60>0?Math.max(0,Math.min(1,(atr/atr60)/1.8)):0;

  return {
    close:last.close,price:last.close,ema20,ema50,rsi14:rsi,macd:macdLine,macdSignal,
    atr14:atr,support:lastSwingLow,resistance:lastSwingHigh,trend,structure,momentum,volatility,roc5,
    bos,choch,liquiditySweep,fvg,displacement,orderBlock,
    swingPoints:{highs:swingHighs.slice(-8),lows:swingLows.slice(-8)},
    marketStructure:{lastSwingHigh,lastSwingLow,prevSwingHigh,prevSwingLow},
    source:"KINGBOT raw OHLC perception engine",
    barTime:last.datetime||null,receivedAt:new Date().toISOString()
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
  const fabric=new MarketDataFabric({twelveData, goldFeed:publicGoldPriceFeed, derivFeed:publicDerivFeed});
  try {
    return await fabric.getQuotes(normalized);
  } catch {
    return normalized.map(symbol => ({
      symbol,
      available:false,
      verified:false,
      source:"KINGBOT market data fabric",
      provider:"KINGBOT_MARKET_DATA_FABRIC",
      error:"MARKET_DATA_FABRIC_UNAVAILABLE"
    }));
  }
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
      quoteAgeMs:Number(quote.ageMs??Math.max(0,Date.now()-Number(quote.timestamp||Date.now()))),
      quoteFreshnessMaxAgeMs:finite(quote.freshnessMaxAgeMs)
    };
  });
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

  if (!twelveData?.enabled && !pool && !publicGoldPriceFeed.enabled) {
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

  const quotes=directQuotes;
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
  technical = technical.map(item => ({ ...item, pendingOrderZones: predictPendingOrderZones(item) }));

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

  const ai = {
    provider:"KINGBOT_NATIVE",
    model:"KINGBOT-CORTEX-1",
    analysis:null,
    aiError:null
  };

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
    provider:"KINGBOT_NATIVE",
    model:"KINGBOT-CORTEX-1",
    executionAuthority:"NONE",
    source:technicalSource,
    liveQuoteSource:"KINGBOT Market Data Fabric: Gold API/Twelve Data/Binance/Massive/Deriv provider routing",
    scannerLatencyHint:"Quotes are served independently from AI analysis.",
    marketData:{
      engine:"KINGBOT_MARKET_DATA_FABRIC",
      model:"KMF-1",
      executionAuthority:"NONE",
      providers:new MarketDataFabric({twelveData, goldFeed:publicGoldPriceFeed, derivFeed:publicDerivFeed}).providerStatus(),
      quoteVerification:"source-aware freshness + explicit provider provenance"
    },
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
      freeDirectGold:Boolean(quotes.some(q => q.symbol==="XAUUSD" && q.source==="Gold API direct free XAU/USD price")),
      tradingView:Boolean(tv.length)
    },
    tradingViewCount:tv.length,
    technicalCount:technical.filter(x=>x.source!=="none").length,
    technicalSource,
    brokerRequired:false,
    marketTypes: {
      synthetic: technical.filter(item => isSyntheticSymbol({symbol:item.symbol})).map(item => item.symbol),
      traditional: technical.filter(item => !isSyntheticSymbol({symbol:item.symbol})).map(item => item.symbol)
    }
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


const AI_STRATEGY_BOTS = ["strategic","flipper","breakout","smc-pro","ladder-flip"];

async function trainAiStrategyModels(twelveData){
  const status=mlSignalServiceStatus();
  if(!status.configured)return {configured:false,trained:0,reason:"ML_SERVICE_NOT_CONFIGURED"};
  let trained=0;
  for(const botId of AI_STRATEGY_BOTS){
    const timeframe=String(getBotDefinitions()[botId]?.timeframeProfile?.execution||"5m").toLowerCase();
    const markets=[];
    for(const symbol of DEFAULT_SYMBOLS){
      try{
        const bars=twelveData?.enabled && typeof twelveData.historicalBars==="function"
          ? await twelveData.historicalBars(symbol,timeframe,{limit:240,maxAgeMs:10*60*1000})
          : await publicDerivFeed.getHistoricalCandles(symbol,{timeframe,limit:240,timeoutMs:12000});
        if(Array.isArray(bars)&&bars.length>=120)markets.push({symbol,bars});
      }catch(error){
        console.warn("[KINGBOT ML TRAIN]",botId,symbol,error?.message||error);
      }
    }
    if(markets.length){
      const result=await trainMlStrategyModel({botId,timeframe,markets});
      if(result?.ok)trained++;
      else console.warn("[KINGBOT ML TRAIN]",botId,result?.error||result?.status||"TRAINING_FAILED");
    }
  }
  return {configured:true,trained};
}

function startAiStrategyModelTraining(twelveData){
  if(!mlSignalServiceStatus().configured)return;
  const intervalMs=Math.max(5*60*1000,Number(process.env.KINGBOT_ML_RETRAIN_MS||30*60*1000));
  let running=false;
  const run=async()=>{
    if(running)return;
    running=true;
    try{
      const result=await trainAiStrategyModels(twelveData);
      console.log("[KINGBOT ML TRAIN] strategy models:",JSON.stringify(result));
    }catch(error){
      console.warn("[KINGBOT ML TRAIN] cycle failed:",error?.message||error);
    }finally{
      running=false;
    }
  };
  setTimeout(()=>void run(),Number(process.env.KINGBOT_ML_INITIAL_TRAIN_DELAY_MS||12000));
  setInterval(()=>void run(),intervalMs);
}

function scannerCanonicalSymbol(value) {
  const raw = String(value || "").trim().toUpperCase();
  return raw.startsWith("FRX") ? raw.slice(3) : raw.replace("/", "");
}

class AiMarketScannerStream {
  constructor({ server, pool, twelveData }) {
    this.server = server;
    this.pool = pool;
    this.twelveData = twelveData;
    this.publicDerivFeed = publicDerivFeed;
    this.clients = new Set();
    this.channels = new Map();
    this.derivBindings = new Map();
    this.startedAt = Date.now();
    this.scanIntervalMs = Math.max(
      2500,
      Math.min(30000, Number(process.env.AI_SCANNER_WS_SCAN_INTERVAL_MS || 5000))
    );
    this.maxClients = Math.max(
      10,
      Math.min(500, Number(process.env.AI_SCANNER_WS_MAX_CLIENTS || 100))
    );
    this.maxMessageBytes = 8192;
    this.upstreamQuoteUnsubscribe = this.twelveData?.onQuote?.((quote) => {
      this.broadcastQuote(quote);
    }) || null;

    if (!server) {
      throw new Error("AI_SCANNER_WEBSOCKET_SERVER_REQUIRED");
    }

    this.wss = new WebSocketServer({
      server,
      path: "/api/ai/market-scanner/ws",
      maxPayload: this.maxMessageBytes,
      perMessageDeflate: false
    });

    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    this.wss.on("error", (error) => {
      console.error("[KINGBOT SCANNER WS]", error?.message || error);
    });
  }

  send(ws, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  closeClient(client) {
    if (!client || client.closed) return;
    client.closed = true;
    clearInterval(client.heartbeatTimer);
    client.heartbeatTimer = null;
    for (const unsubscribe of client.derivUnsubs || []) {
      try { unsubscribe(); } catch {}
    }
    client.derivUnsubs = [];
    if (client.channel) {
      client.channel.clients.delete(client);
      this.cleanupChannel(client.channel);
    }
    this.clients.delete(client);
    try { client.ws.close(1000, "scanner client closed"); } catch {}
  }

  cleanupChannel(channel) {
    if (!channel || channel.clients.size || channel.running) return;
    if (channel.timer) clearInterval(channel.timer);
    this.channels.delete(channel.key);
  }

  async ensureDerivBindings(symbols) {
    if (!this.publicDerivFeed) return;
    const requested = [...new Set((symbols || []).map(scannerCanonicalSymbol).filter(Boolean))];
    const twelveSubscribed = new Set(
      this.twelveData?.status?.()?.subscribedSymbols?.map(scannerCanonicalSymbol) || []
    );

    for (const symbol of requested) {
      if (this.twelveData?.enabled && twelveSubscribed.has(symbol)) continue;
      if (this.derivBindings.has(symbol)) continue;

      try {
        const unsubscribe = await publicDerivFeed.onTick(symbol, (quote) => {
          this.broadcastQuote(quote);
        });
        this.derivBindings.set(symbol, { unsubscribe });
      } catch (error) {
        this.sendToSymbol(symbol, {
          type: "upstream_status",
          symbol,
          connected: false,
          error: String(error?.message || "DERIV_PUBLIC_FEED_UNAVAILABLE").slice(0, 160),
          at: new Date().toISOString()
        });
      }
    }
  }

  sendToSymbol(symbol, payload) {
    const target = scannerCanonicalSymbol(symbol);
    for (const client of this.clients) {
      if (client.closed || !client.symbols.includes(target)) continue;
      this.send(client.ws, payload);
    }
  }

  broadcastQuote(rawQuote) {
    const quote = rawQuote && typeof rawQuote === "object"
      ? { ...rawQuote, symbol: scannerCanonicalSymbol(rawQuote.symbol || rawQuote.twelveDataSymbol || rawQuote.brokerSymbol) }
      : null;
    if (!quote?.symbol || !Number.isFinite(Number(quote.price))) return;

    for (const client of this.clients) {
      if (client.closed || !client.symbols.includes(quote.symbol)) continue;
      client.lastQuoteAt = Date.now();
      this.send(client.ws, {
        type: "quote",
        quote,
        streamAt: new Date().toISOString()
      });
    }
  }

  channelFor(symbols, timeframe) {
    const clean = [...new Set(symbols.map(scannerCanonicalSymbol).filter(Boolean))].slice(0, 12);
    const tf = cleanTimeframe(timeframe);
    const key = clean.slice().sort().join(",") + "|" + tf;
    let channel = this.channels.get(key);

    if (!channel) {
      channel = {
        key,
        symbols: clean,
        timeframe: tf,
        clients: new Set(),
        timer: null,
        running: false,
        lastScanAt: null,
        lastScan: null,
        scanError: null
      };
      this.channels.set(key, channel);
      channel.timer = setInterval(() => {
        void this.scanChannel(channel);
      }, this.scanIntervalMs);
    }
    return channel;
  }

  async scanChannel(channel) {
    if (!channel || channel.running || !channel.clients.size) return;
    channel.running = true;

    try {
      await this.ensureDerivBindings(channel.symbols);
      const result = await standaloneMarketScan({
        pool: this.pool,
        twelveData: this.twelveData,
        symbols: channel.symbols,
        timeframe: channel.timeframe
      });

      channel.lastScanAt = Date.now();
      channel.lastScan = result;
      channel.scanError = null;

      for (const client of [...channel.clients]) {
        if (client.closed) continue;
        this.send(client.ws, {
          type: "scan",
          data: result,
          stream: {
            state: "LIVE",
            scanIntervalMs: this.scanIntervalMs,
            upstream: this.twelveData?.enabled
              ? (this.twelveData.status?.() || { source: "Twelve Data WebSocket" })
              : publicDerivFeed.status()
          }
        });
      }
    } catch (error) {
      channel.scanError = String(error?.message || "AI_MARKET_SCANNER_STREAM_FAILED").slice(0, 220);
      for (const client of [...channel.clients]) {
        if (client.closed) continue;
        this.send(client.ws, {
          type: "scanner_error",
          error: "AI_MARKET_SCANNER_STREAM_FAILED",
          reason: channel.scanError,
          at: new Date().toISOString()
        });
      }
    } finally {
      channel.running = false;
      this.cleanupChannel(channel);
    }
  }

  async subscribe(client, symbols, timeframe) {
    const clean = cleanSymbols(symbols).map(scannerCanonicalSymbol).filter(Boolean).slice(0, 12);
    const effectiveSymbols = clean.length ? clean : DEFAULT_SYMBOLS.map(scannerCanonicalSymbol);
    const effectiveTimeframe = cleanTimeframe(timeframe);

    if (client.channel) {
      client.channel.clients.delete(client);
      this.cleanupChannel(client.channel);
    }
    for (const unsubscribe of client.derivUnsubs || []) {
      try { unsubscribe(); } catch {}
    }
    client.derivUnsubs = [];

    const channel = this.channelFor(effectiveSymbols, effectiveTimeframe);
    channel.clients.add(client);
    client.channel = channel;
    client.symbols = channel.symbols;
    client.timeframe = channel.timeframe;

    await this.ensureDerivBindings(channel.symbols);

    this.send(client.ws, {
      type: "subscribed",
      symbols: channel.symbols,
      timeframe: channel.timeframe,
      scanIntervalMs: this.scanIntervalMs,
      source: this.twelveData?.enabled ? "Twelve Data WebSocket + Deriv fallback" : "Deriv public WebSocket",
      at: new Date().toISOString()
    });

    await this.scanChannel(channel);
  }

  handleConnection(ws, req) {
    if (this.clients.size >= this.maxClients) {
      try { ws.close(1013, "scanner capacity reached"); } catch {}
      return;
    }

    const client = {
      ws,
      symbols: DEFAULT_SYMBOLS.map(scannerCanonicalSymbol),
      timeframe: DEFAULT_TF,
      channel: null,
      derivUnsubs: [],
      closed: false,
      lastMessageAt: 0,
      lastQuoteAt: null,
      isAlive: true,
      heartbeatTimer: null
    };
    this.clients.add(client);

    this.send(ws, {
      type: "hello",
      scanner: "KINGBOT AI MARKET SCANNER",
      transport: "websocket",
      state: "CONNECTING",
      path: "/api/ai/market-scanner/ws",
      serverTime: new Date().toISOString(),
      scanIntervalMs: this.scanIntervalMs
    });

    let initialSymbols = DEFAULT_SYMBOLS;
    let initialTimeframe = DEFAULT_TF;
    try {
      const url = new URL(req.url || "", "http://kingbot-scanner.local");
      const rawSymbols = url.searchParams.get("symbols");
      const rawTimeframe = url.searchParams.get("timeframe");
      if (rawSymbols) initialSymbols = rawSymbols;
      if (rawTimeframe) initialTimeframe = rawTimeframe;
    } catch {}

    ws.on("pong", () => {
      client.isAlive = true;
    });

    client.heartbeatTimer = setInterval(() => {
      if (client.closed) {
        clearInterval(client.heartbeatTimer);
        return;
      }
      if (!client.isAlive) {
        try { ws.terminate(); } catch {}
        return;
      }
      client.isAlive = false;
      try { ws.ping(); } catch { this.closeClient(client); }
    }, 20000);

    ws.on("message", (raw) => {
      if (raw?.length > this.maxMessageBytes) {
        try { ws.close(1009, "scanner message too large"); } catch {}
        return;
      }
      if (Date.now() - client.lastMessageAt < 750) return;
      client.lastMessageAt = Date.now();

      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }

      if (String(message?.type || "").toLowerCase() === "subscribe") {
        void this.subscribe(
          client,
          message.symbols || DEFAULT_SYMBOLS,
          message.timeframe || DEFAULT_TF
        ).catch((error) => {
          this.send(ws, {
            type: "scanner_error",
            error: "SCANNER_SUBSCRIPTION_FAILED",
            reason: String(error?.message || "SCANNER_SUBSCRIPTION_FAILED").slice(0, 220),
            at: new Date().toISOString()
          });
        });
      }
    });

    ws.on("close", () => this.closeClient(client));
    ws.on("error", () => this.closeClient(client));

    void this.subscribe(client, initialSymbols, initialTimeframe).catch((error) => {
      this.send(ws, {
        type: "scanner_error",
        error: "SCANNER_SUBSCRIPTION_FAILED",
        reason: String(error?.message || "SCANNER_SUBSCRIPTION_FAILED").slice(0, 220),
        at: new Date().toISOString()
      });
    });
  }

  close() {
    for (const client of [...this.clients]) this.closeClient(client);
    for (const channel of [...this.channels.values()]) {
      if (channel.timer) clearInterval(channel.timer);
    }
    this.channels.clear();
    for (const { unsubscribe } of this.derivBindings.values()) {
      try { unsubscribe(); } catch {}
    }
    this.derivBindings.clear();
    this.upstreamQuoteUnsubscribe?.();
    try { this.wss.close(); } catch {}
  }
}

export function registerAiMarketScanner(app, { pool, rateLimit, twelveData, server }) {
  const stream = new AiMarketScannerStream({ server, pool, twelveData });
  startAiStrategyModelTraining(twelveData);
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
    let tvCount=0;
    try { const q=await pool.query("SELECT COUNT(*)::int AS count FROM kingbot_tradingview_snapshots WHERE received_at > NOW() - INTERVAL '10 minutes'"); tvCount=q.rows[0]?.count || 0; } catch {}
    const mlService = await probeMlSignalService();
    return res.json({
      ok:true, scanner:"KINGBOT AI MARKET SCANNER", aiReady:true, provider:"KINGBOT_NATIVE",
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
      model:"KINGBOT-CORTEX-1",
      aiStrategies:{
        stage:"AI_STRATEGIES",
        purpose:"ML_SIGNAL_GENERATION",
        modelService:mlService
      },
      tradingViewConnected:tvCount>0, tradingViewSnapshotsLast10m:tvCount, webhookConfigured:Boolean(process.env.TRADINGVIEW_WEBHOOK_SECRET),
      defaultSymbols:DEFAULT_SYMBOLS,
      websocket:{
        enabled:true,
        path:"/api/ai/market-scanner/ws",
        scanIntervalMs:stream.scanIntervalMs,
        clients:stream.clients.size,
        channels:stream.channels.size
      }
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
