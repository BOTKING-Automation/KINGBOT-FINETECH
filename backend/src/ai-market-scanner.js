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
import { calculateMarketIndicators } from "./worker-market-perception.js";
import { CORTEX_MTF_TIMEFRAMES, evaluateCortexMultiTimeframeEntry } from "./cortex-mtf-entry-engine.js";

const DEFAULT_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD"];
const DEFAULT_TF = "5m";
const publicGoldPriceFeed = getGoldPriceFeed();
const publicDerivFeed = getDerivMarketFeed();
const publicDerivTechnicalCache = new Map();
const cortexMtfHistoryCache = new Map();
const CORTEX_MTF_HISTORY_CACHE_MS = Math.max(5000, Number(process.env.KINGBOT_CORTEX_MTF_CACHE_MS || 15000));
const PUBLIC_TECHNICAL_CACHE_MS = Math.max(5000, Number(process.env.KINGBOT_SCANNER_TECHNICAL_CACHE_MS || 15000));

function cleanSymbols(value) {
  const input = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(input.map(s => String(s || "").trim().toUpperCase()).filter(s => /^[A-Z0-9._:-]{3,40}$/.test(s)))].slice(0, 12);
}

export function symbolsMissingTechnicalData(symbols, technical) {
  const normalized = cleanSymbols(symbols);
  const covered = new Set(
    (Array.isArray(technical) ? technical : [])
      .filter(item => item?.symbol && item.source !== "none")
      .map(item => String(item.symbol).trim().toUpperCase())
  );
  return normalized.filter(symbol => !covered.has(symbol));
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
    signal: "WAIT",
    bias: "DATA_INSUFFICIENT",
    score: 0,
    entryEligible: false,
    entry: null,
    sl: null,
    tp1: null,
    tp2: null,
    waitFor: "A fresh verified OHLC snapshot is required.",
    reason: "Single-timeframe data is insufficient for an entry decision. CORTEX requires the full 1d/4h/1h/15m/5m evidence stack.",
    technicalAnalysis: [],
    invalidation: "No valid technical market data."
  };

  const price = finite(snapshot.close ?? snapshot.price);
  const ema20 = finite(snapshot.ema20);
  const ema50 = finite(snapshot.ema50);
  const rsi = finite(snapshot.rsi14 ?? snapshot.rsi);
  const macd = finite(snapshot.macd);
  const macdSignal = finite(snapshot.macdSignal ?? snapshot.macd_signal);
  const trend = String(snapshot.trend || "").toUpperCase();
  const structure = String(snapshot.structure || "").toUpperCase();
  const bos = String(snapshot.bos || snapshot.bosDirection || "").toUpperCase();
  const choch = String(snapshot.choch || "").toUpperCase();
  const liquidity = String(snapshot.liquiditySweepDirection || snapshot.liquiditySweep || "").toUpperCase();
  const displacement = String(snapshot.displacementDirection || "").toUpperCase();
  const fvg = String(snapshot.fairValueGapDirection || "").toUpperCase();

  const longEvidence = [
    trend === "BULLISH",
    structure === "BULLISH",
    bos === "BULLISH",
    choch === "BULLISH",
    liquidity === "BULLISH",
    displacement === "BULLISH",
    fvg === "BULLISH",
    ema20 !== null && ema50 !== null && ema20 > ema50,
    rsi !== null && rsi >= 50 && rsi <= 70,
    macd !== null && macdSignal !== null && macd > macdSignal
  ];
  const shortEvidence = [
    trend === "BEARISH",
    structure === "BEARISH",
    bos === "BEARISH",
    choch === "BEARISH",
    liquidity === "BEARISH",
    displacement === "BEARISH",
    fvg === "BEARISH",
    ema20 !== null && ema50 !== null && ema20 < ema50,
    rsi !== null && rsi >= 30 && rsi <= 50,
    macd !== null && macdSignal !== null && macd < macdSignal
  ];
  const longScore = longEvidence.filter(Boolean).length;
  const shortScore = shortEvidence.filter(Boolean).length;
  const bias = longScore - shortScore >= 2 ? "BULLISH"
    : shortScore - longScore >= 2 ? "BEARISH" : "NEUTRAL";
  const score = Math.round(Math.max(longScore, shortScore) / 10 * 100);

  const analysis = [];
  if (trend) analysis.push("Trend: " + trend);
  if (structure) analysis.push("Market structure: " + structure);
  if (bos && bos !== "NONE") analysis.push("BOS: " + bos);
  if (choch && choch !== "NONE") analysis.push("CHoCH: " + choch);
  if (liquidity && liquidity !== "NONE") analysis.push("Liquidity sweep: " + liquidity);
  if (displacement && displacement !== "NONE") analysis.push("Displacement: " + displacement);
  if (fvg && fvg !== "NONE") analysis.push("FVG: " + fvg);
  if (ema20 !== null && ema50 !== null) analysis.push("EMA20/EMA50: " + (ema20 > ema50 ? "bullish alignment" : "bearish alignment"));
  if (rsi !== null) analysis.push("RSI(14): " + rsi.toFixed(2));
  if (macd !== null && macdSignal !== null) analysis.push("MACD: " + (macd > macdSignal ? "bullish" : "bearish"));

  return {
    signal: "WAIT",
    bias,
    score,
    entryEligible: false,
    singleTimeframeOnly: true,
    entry: null,
    sl: null,
    tp1: null,
    tp2: null,
    waitFor: "Wait for 1d/4h/1h/15m trend and structure alignment plus a completed 5m trigger, fresh bid/ask and acceptable spread.",
    atr14: finite(snapshot.atr14 ?? snapshot.atr),
    support: finite(snapshot.support),
    resistance: finite(snapshot.resistance),
    trend,
    structure,
    bos,
    choch,
    liquiditySweep: liquidity,
    displacement,
    fairValueGapDirection: fvg,
    reason: (analysis.length ? analysis.join(" · ") + " · " : "") +
      "Single-timeframe bias is descriptive only; it cannot qualify an entry.",
    technicalAnalysis: analysis,
    invalidation: "No entry or stop is issued by a single-timeframe snapshot."
  };
}


const CORTEX_TIMEFRAME_SECONDS = {
  "1m":60,"3m":180,"5m":300,"15m":900,"30m":1800,
  "1h":3600,"2h":7200,"4h":14400,"1d":86400,"1w":604800
};

function buildCortexTimeframeFrame(rows, timeframe, nowMs = Date.now()) {
  const interval = CORTEX_TIMEFRAME_SECONDS[cleanTimeframe(timeframe)] || 300;
  const byTime = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const time = chartEpochSeconds(row?.time ?? row?.datetime ?? row?.timestamp);
    const open = finite(row?.open), high = finite(row?.high);
    const low = finite(row?.low), close = finite(row?.close);
    if (!Number.isSafeInteger(time) || time <= 0 ||
      ![open, high, low, close].every(Number.isFinite) ||
      open <= 0 || low <= 0 || high < low ||
      high < Math.max(open, close) || low > Math.min(open, close)) continue;
    byTime.set(time, {
      time, open, high, low, close,
      volume: finite(row?.volume ?? row?.tick_count) ?? 0
    });
  }
  const normalized = [...byTime.values()].sort((a,b)=>a.time-b.time);
  const closedBars = normalized.filter(bar => (bar.time + interval) * 1000 <= nowMs).slice(-240);
  const lastClosedBar = closedBars.at(-1) || null;
  if (closedBars.length < 80 || !lastClosedBar) {
    return {
      ok:false,fresh:false,timeframe,barCount:closedBars.length,lastClosedBar:null,
      lastClosedBarTime:null,ageSinceCloseMs:null,freshnessLimitMs:interval*2000,
      reason:"INSUFFICIENT_COMPLETED_CANDLES"
    };
  }
  const technical = deriveTechnicalFromBars(closedBars.map(bar=>({
    ...bar,datetime:new Date(bar.time*1000).toISOString()
  })));
  const lastBarCloseMs=(lastClosedBar.time+interval)*1000;
  const ageSinceCloseMs=Math.max(0,nowMs-lastBarCloseMs);
  const freshnessLimitMs=Math.max(interval*2000,10*60*1000);
  const fresh=Boolean(technical)&&ageSinceCloseMs<=freshnessLimitMs;
  return {
    ok:Boolean(technical),fresh,timeframe,barCount:closedBars.length,
    lastClosedBar,lastClosedBarTime:new Date(lastClosedBar.time*1000).toISOString(),
    lastBarCloseTime:new Date(lastBarCloseMs).toISOString(),
    ageSinceCloseMs,freshnessLimitMs,technical,
    reason:technical?null:"TECHNICAL_ANALYSIS_UNAVAILABLE"
  };
}

async function fetchCachedCortexHistory(symbol,timeframe) {
  const key=String(symbol).toUpperCase()+":"+String(timeframe).toLowerCase();
  const cached=cortexMtfHistoryCache.get(key);
  const age=cached?Date.now()-Number(cached.cachedAt||0):Infinity;
  if(cached?.bars&&age<=CORTEX_MTF_HISTORY_CACHE_MS) return cached.bars;
  const bars=await publicDerivFeed.getHistoricalCandles(symbol,{
    timeframe,limit:180,timeoutMs:8000
  });
  if(!Array.isArray(bars)||bars.length<80) throw new Error("INSUFFICIENT_HISTORICAL_CANDLES");
  cortexMtfHistoryCache.set(key,{bars,cachedAt:Date.now()});
  if(cortexMtfHistoryCache.size>240){
    const firstKey=cortexMtfHistoryCache.keys().next().value;
    if(firstKey)cortexMtfHistoryCache.delete(firstKey);
  }
  return bars;
}

async function getCortexDerivQuote(symbol) {
  try {
    const quote=await publicDerivFeed.getQuote(symbol,{maxAgeMs:2500,timeoutMs:2500});
    const epoch=finite(quote?.epoch);
    const ageMs=finite(quote?.ageMs) ?? (epoch!==null?Math.max(0,Date.now()-epoch*1000):null);
    return {
      symbol,available:finite(quote?.price)!==null&&Number(quote.price)>0,
      price:finite(quote?.price),bid:finite(quote?.bid),ask:finite(quote?.ask),
      spread:finite(quote?.spread) ?? (finite(quote?.bid)!==null&&finite(quote?.ask)!==null?Number(quote.ask)-Number(quote.bid):null),
      ageMs,epoch,source:quote?.source||"Deriv public live feed"
    };
  } catch(error) {
    return {symbol,available:false,price:null,bid:null,ask:null,spread:null,ageMs:null,error:String(error?.message||"DERIV_QUOTE_UNAVAILABLE").slice(0,120)};
  }
}

async function buildCortexMultiTimeframeForSymbol(symbol,{
  quote=null,reuseTimeframe=null,reuseBars=null,nowMs=Date.now()
}={}) {
  const frames={};
  const results=await Promise.all(CORTEX_MTF_TIMEFRAMES.map(async timeframe=>{
    try {
      const bars=String(reuseTimeframe||"").toLowerCase()===timeframe&&Array.isArray(reuseBars)
        ?reuseBars
        :await fetchCachedCortexHistory(symbol,timeframe);
      return [timeframe,buildCortexTimeframeFrame(bars,timeframe,nowMs)];
    } catch(error) {
      return [timeframe,{
        ok:false,fresh:false,timeframe,barCount:0,lastClosedBar:null,
        lastClosedBarTime:null,ageSinceCloseMs:null,freshnessLimitMs:null,
        reason:String(error?.message||"TIMEFRAME_DATA_UNAVAILABLE").slice(0,120)
      }];
    }
  }));
  for(const [timeframe,frame] of results)frames[timeframe]=frame;
  const marketQuote=quote||await getCortexDerivQuote(symbol);
  const entryDecision=evaluateCortexMultiTimeframeEntry({frames,quote:marketQuote});
  return {
    ok:true,symbol,timeframes:CORTEX_MTF_TIMEFRAMES,
    executionTimeframe:"5m",
    generatedAt:new Date(nowMs).toISOString(),
    frames,
    quote:marketQuote,
    entryDecision,
    analysisPolicy:"Closed candles only; top-down 1d/4h/1h/15m alignment; 5m execution trigger; fresh two-sided quote; spread and structural risk gates."
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
  const enhanced=calculateMarketIndicators(clean);

  return {
    close:last.close,price:last.close,ema20:enhanced.emaFast??ema20,ema50:enhanced.emaSlow??ema50,
    emaFast:enhanced.emaFast??ema20,emaSlow:enhanced.emaSlow??ema50,
    rsi14:enhanced.rsi??rsi,adx14:enhanced.adx,adx:enhanced.adx,
    macd:macdLine,macdSignal,atr14:enhanced.atr??atr,atr:enhanced.atr??atr,
    support:lastSwingLow,resistance:lastSwingHigh,trend,trendScore:enhanced.trend,
    structure,momentum:enhanced.momentum,volatility:enhanced.volatility,roc5,
    bos,choch,liquiditySweep:enhanced.liquiditySweepDirection,
    liquiditySweepDirection:enhanced.liquiditySweepDirection,
    bosDirection:enhanced.bosDirection,
    fvg:enhanced.fairValueGap,fairValueGapDirection:enhanced.fairValueGapDirection,
    displacement:enhanced.displacementDirection,displacementDirection:enhanced.displacementDirection,
    orderBlock:enhanced.orderBlock,
    breakout:enhanced.breakout,breakoutDirection:enhanced.breakoutDirection,
    retest:enhanced.retest,retestDirection:enhanced.retestDirection,
    volume:enhanced.volume,velocityScore:enhanced.velocityScore,candleCount:enhanced.candleCount,
    swingPoints:{highs:swingHighs.slice(-8),lows:swingLows.slice(-8)},
    marketStructure:{lastSwingHigh,lastSwingLow,prevSwingHigh,prevSwingLow},
    source:"KINGBOT raw OHLC perception engine",
    barTime:last.datetime||null,receivedAt:new Date().toISOString()
  };
}

function chartEpochSeconds(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric > 1e12) return Math.floor(numeric / 1000);
    if (numeric > 1e9) return Math.floor(numeric);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : null;
}

export function buildScannerChartPayload(rows, { symbol, timeframe = DEFAULT_TF, source = "Deriv public historical candles" } = {}) {
  const byTime = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const time = chartEpochSeconds(row?.time ?? row?.datetime ?? row?.timestamp);
    const open = Number(row?.open);
    const high = Number(row?.high);
    const low = Number(row?.low);
    const close = Number(row?.close);
    const volume = Number(row?.volume ?? row?.tick_count ?? 0);
    if (
      !Number.isSafeInteger(time) || time <= 0 ||
      ![open, high, low, close].every(Number.isFinite) ||
      open <= 0 || low <= 0 ||
      high < Math.max(open, close) ||
      low > Math.min(open, close) ||
      high < low
    ) continue;
    byTime.set(time, {
      time,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) && volume >= 0 ? volume : 0
    });
  }

  const bars = [...byTime.values()].sort((a, b) => a.time - b.time).slice(-500);
  if (bars.length < 80) throw new Error("INSUFFICIENT_HISTORICAL_CANDLES");

  const technical = deriveTechnicalFromBars(
    bars.map(bar => ({ ...bar, datetime: new Date(bar.time * 1000).toISOString() }))
  );
  if (!technical) throw new Error("CHART_TECHNICAL_ANALYSIS_UNAVAILABLE");

  const nativeSignal = technicalEngine(technical);
  const signalContext = {
    ...technical,
    ...nativeSignal,
    symbol: String(symbol || "").trim().toUpperCase(),
    timeframe: cleanTimeframe(timeframe),
    price: technical.price,
    technicalVerified: true
  };
  const pendingOrderZones = predictPendingOrderZones(signalContext);

  const intervalSeconds = ({
    "1m":60,"3m":180,"5m":300,"15m":900,"30m":1800,
    "1h":3600,"2h":7200,"4h":14400,"1d":86400,"1w":604800
  })[cleanTimeframe(timeframe)] || 300;
  const lastBar = bars[bars.length - 1];
  const lastBarCloseMs = (lastBar.time + intervalSeconds) * 1000;
  const ageSinceCloseMs = Math.max(0, Date.now() - lastBarCloseMs);
  const freshnessLimitMs = Math.max(2 * intervalSeconds * 1000, 10 * 60 * 1000);
  const candleFresh = ageSinceCloseMs <= freshnessLimitMs;

  return {
    ok: true,
    scanner: "KINGBOT AI MARKET SCANNER",
    mode: "chart",
    symbol: signalContext.symbol,
    timeframe: signalContext.timeframe,
    source: String(source || "Deriv public historical candles"),
    executionAuthority: "NONE",
    brokerRequired: false,
    generatedAt: new Date().toISOString(),
    bars,
    technical,
    signal: {
      ...nativeSignal,
      pendingOrderZones
    },
    metadata: {
      barsCount: bars.length,
      lastBarTime: new Date(lastBar.time * 1000).toISOString(),
      lastBarCloseTime: new Date(lastBarCloseMs).toISOString(),
      ageSinceCloseMs,
      freshnessLimitMs,
      candleFresh,
      verifiedOhlc: true,
      provider: "deriv-public"
    }
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
async function standaloneMarketScan({ pool, twelveData, symbols, timeframe, cortexRunner = null, focusSymbol = null }) {
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

  // Twelve Data stays primary for technical OHLC. When it returns no usable
  // technical snapshot for a symbol, fall through to the free public Deriv
  // candle feed so quotes and technical analysis do not become disconnected.
  const missingTechnical = twelveData?.enabled
    ? symbolsMissingTechnicalData(normalizedSymbols, tdTechnical)
    : [];
  const derivFallbackData = missingTechnical.length
    ? await fetchPublicDerivData(missingTechnical, normalizedTimeframe)
    : [];

  const quotes=directQuotes;
  const combinedTechnical=[
    ...tdTechnical,
    ...derivData.map(x=>x.technical).filter(Boolean),
    ...derivFallbackData.map(x=>x.technical).filter(Boolean)
  ];
  const technicalBySymbol=new Map();
  for(const item of combinedTechnical) if(!technicalBySymbol.has(item.symbol)) technicalBySymbol.set(item.symbol,item);
  const tdMap = Object.fromEntries([...technicalBySymbol.entries()].map(([k,v]) => [k,v]));
  // Technical decisions must come from verified OHLC telemetry only.
  // TradingView remains a visualization/context surface and can never satisfy
  // the scanner's technical-data gate on its own.
  let technical = normalizedSymbols.map(symbol => {
    const snapshot = tdMap[symbol] || null;
    return snapshot
      ? {
          symbol,
          ...technicalEngine(snapshot),
          timeframe: normalizedTimeframe,
          source: snapshot.source || "KINGBOT native OHLC",
          barTime: snapshot.barTime,
          dataFreshness: snapshot.receivedAt || snapshot.barTime,
          technicalCacheAgeMs: finite(snapshot.cacheAgeMs),
          technicalVerified: true
        }
      : {
          symbol,
          ...technicalEngine(null),
          timeframe: normalizedTimeframe,
          source:"none",
          technicalVerified:false
        };
  });
  technical = overlayLiveQuotes(technical, directQuotes);
  technical = technical.map(item => ({ ...item, pendingOrderZones: predictPendingOrderZones(item) }));

  const focus = scannerCanonicalSymbol(focusSymbol || normalizedSymbols[0] || "");
  let focusMultiTimeframe = null;
  if (focus && normalizedSymbols.includes(focus)) {
    const focusRow = technical.find(item => item.symbol === focus);
    const focusQuote = quotes.find(item => item.symbol === focus && item.available);
    try {
      focusMultiTimeframe = await buildCortexMultiTimeframeForSymbol(focus,{
        quote:focusQuote?{
          ...focusQuote,
          ageMs:finite(focusQuote.ageMs ?? focusQuote.quoteAgeMs)
        }:null
      });
      technical = technical.map(item => item.symbol === focus ? {
        ...item,
        ...focusMultiTimeframe.entryDecision,
        signal:focusMultiTimeframe.entryDecision.signal,
        entryDecision:focusMultiTimeframe.entryDecision,
        multiTimeframe:focusMultiTimeframe.frames,
        multiTimeframeVerified:Object.values(focusMultiTimeframe.frames).every(frame=>frame?.ok&&frame?.fresh)
      } : item);
    } catch(error) {
      focusMultiTimeframe = {
        ok:false,
        symbol:focus,
        entryDecision:{
          signal:"WAIT",bias:"NEUTRAL",entryEligible:false,entry:null,sl:null,tp1:null,tp2:null,
          reason:"Multi-timeframe analysis unavailable; no entry can be qualified.",
          blockedReasons:[String(error?.message||"MULTI_TIMEFRAME_ANALYSIS_UNAVAILABLE").slice(0,160)]
        }
      };
    }
  }

  const tvMap = Object.fromEntries(tv.map(x => [x.symbol, x]));
  const nativeTechnicalCount = technical.filter(item => item.technicalVerified).length;
  const hasTwelveDataTechnical = tdTechnical.length > 0;
  const hasDerivTechnical = derivData.some(x => x.technical) || derivFallbackData.some(x => x.technical);
  const technicalSource = nativeTechnicalCount
    ? hasTwelveDataTechnical && hasDerivTechnical
      ? "KINGBOT native OHLC: Twelve Data primary + Deriv fallback"
      : hasTwelveDataTechnical
        ? "KINGBOT native OHLC: Twelve Data"
        : "KINGBOT native OHLC: Deriv public candles"
    : "no verified OHLC";

  let cortex = null;
  let cortexError = null;
  if (cortexRunner && focus && normalizedSymbols.includes(focus)) {
    const focusTechnical = technical.find(item => item.symbol === focus && item.source !== "none");
    const focusQuote = quotes.find(item => item.symbol === focus && item.available);
    if (focusTechnical || focusQuote) {
      const quoteTimestamp = focusQuote?.timestamp
        ? new Date(focusQuote.timestamp).toISOString()
        : null;
      const receivedAt = focusTechnical?.receivedAt || focusTechnical?.dataFreshness || focusQuote?.receivedAt || null;
      const cortexMarket = {
        ...(focusTechnical || {}),
        ...(focusQuote || {}),
        symbol: focus,
        timeframe: normalizedTimeframe,
        timestamp: quoteTimestamp || receivedAt || focusTechnical?.barTime || null,
        quoteTimestamp,
        receivedAt: receivedAt || quoteTimestamp || null,
        quoteFreshnessMaxAgeMs: finite(focusQuote?.freshnessMaxAgeMs),
        freshnessMaxAgeMs: finite(focusQuote?.freshnessMaxAgeMs),
        verifiedQuote: Boolean(focusQuote?.verified),
        scannerSource: technicalSource,
        multiTimeframeAnalysis:focusMultiTimeframe,
        entryDecision:focusMultiTimeframe?.entryDecision||null
      };
      try {
        cortex = await cortexRunner(cortexMarket);
      } catch (error) {
        cortexError = String(error?.message || "CORTEX_UNAVAILABLE").slice(0, 220);
      }
    } else {
      cortexError = "FOCUS_SYMBOL_TECHNICAL_DATA_UNAVAILABLE";
    }
  }

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
    cortex,
    multiTimeframeAnalysis:focusMultiTimeframe,
    entryDecision:focusMultiTimeframe?.entryDecision||null,
    cortexFocusSymbol: focus || null,
    cortexError,
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
    technicalCount:technical.filter(x=>x.technicalVerified).length,
    technicalDataQuality:{
      verifiedSymbols:technical.filter(x=>x.technicalVerified).length,
      missingSymbols:technical.filter(x=>!x.technicalVerified).map(x=>x.symbol),
      nativeOnly:true,
      tradingViewCanProvideContextOnly:true
    },
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
      timeframe:req.query?.timeframe || req.body?.timeframe,
      cortexRunner,
      focusSymbol:req.query?.focusSymbol || req.body?.focusSymbol || null
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
const TRAINING_SYMBOLS = DEFAULT_SYMBOLS;
const TRAINING_HISTORY_LIMIT = Math.max(360,Math.min(1000,Number(process.env.KINGBOT_ML_HISTORY_LIMIT||1000)));
const TRAINING_HISTORY_CACHE_MS = Math.max(5*60*1000,Number(process.env.KINGBOT_ML_HISTORY_CACHE_MS||6*60*60*1000));
const TRAIN_REQUEST_SPACING_MS = Math.max(1000,Math.min(10000,Number(process.env.KINGBOT_ML_TRAIN_SPACING_MS||2500)));
const trainingHistoryCache = new Map();
let lastMlTrainingRequestAt = 0;

async function paceMlTrainingRequest(){
  const waitMs = Math.max(0,lastMlTrainingRequestAt+TRAIN_REQUEST_SPACING_MS-Date.now());
  if(waitMs) await new Promise(resolve=>setTimeout(resolve,waitMs));
  lastMlTrainingRequestAt = Date.now();
}

function trainingTimeframes(botId){
  const profile=getBotDefinitions()[botId]?.timeframeProfile||{};
  return [...new Set([
    String(profile.regime||"4h").toLowerCase(),
    String(profile.setup||"15m").toLowerCase(),
    String(profile.execution||"5m").toLowerCase()
  ])];
}

function binanceInterval(timeframe){
  const map={"1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m","1h":"1h","2h":"2h","4h":"4h","6h":"6h","8h":"8h","12h":"12h","1d":"1d","1w":"1w"};
  return map[String(timeframe||"5m").toLowerCase()]||"5m";
}

async function getBinanceTrainingBars(symbol,timeframe,limit=TRAINING_HISTORY_LIMIT){
  if(String(symbol).toUpperCase()!=="BTCUSD")throw new Error("BINANCE_SYMBOL_NOT_SUPPORTED");
  const interval=binanceInterval(timeframe);
  const count=Math.max(120,Math.min(1000,Number(limit)||1000));
  const url="https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval="+encodeURIComponent(interval)+"&limit="+count;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch(url,{signal:controller.signal,headers:{Accept:"application/json"},cache:"no-store"});
    const rows=await response.json().catch(()=>[]);
    if(!response.ok||!Array.isArray(rows))throw new Error("BINANCE_HISTORICAL_REQUEST_FAILED");
    const bars=rows.map(row=>({
      datetime:new Date(Number(row?.[0])).toISOString(),
      open:Number(row?.[1]),
      high:Number(row?.[2]),
      low:Number(row?.[3]),
      close:Number(row?.[4]),
      volume:Number(row?.[5])
    })).filter(x=>[x.open,x.high,x.low,x.close].every(Number.isFinite)&&x.open>0&&x.high>0&&x.low>0&&x.close>0);
    if(bars.length<120)throw new Error("BINANCE_HISTORICAL_BARS_INSUFFICIENT");
    return bars;
  }finally{
    clearTimeout(timer);
  }
}

async function getKrakenTrainingBars(symbol,timeframe,limit=TRAINING_HISTORY_LIMIT){
  if(String(symbol).toUpperCase()!=="BTCUSD")throw new Error("KRAKEN_SYMBOL_NOT_SUPPORTED");
  const intervalMap={"1m":1,"5m":5,"15m":15,"30m":30,"1h":60,"4h":240,"1d":1440,"1w":10080};
  const interval=intervalMap[String(timeframe||"5m").toLowerCase()];
  if(!interval)throw new Error("KRAKEN_TIMEFRAME_UNSUPPORTED");
  const count=Math.max(120,Math.min(720,Number(limit)||720));
  const since=Math.floor(Date.now()/1000)-interval*60*count;
  const url="https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval="+interval+"&since="+since;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch(url,{signal:controller.signal,headers:{Accept:"application/json"},cache:"no-store"});
    const payload=await response.json().catch(()=>null);
    if(!response.ok||!payload||!Array.isArray(payload?.error)||payload.error.length||!payload?.result)throw new Error("KRAKEN_HISTORICAL_REQUEST_FAILED");
    const resultKey=Object.keys(payload.result).find(key=>key!=="last");
    const rows=Array.isArray(payload.result?.[resultKey])?payload.result[resultKey]:[];
    const bars=rows.map(row=>({
      datetime:new Date(Number(row?.[0])*1000).toISOString(),
      open:Number(row?.[1]),
      high:Number(row?.[2]),
      low:Number(row?.[3]),
      close:Number(row?.[4]),
      volume:Number(row?.[6])
    })).filter(x=>[x.open,x.high,x.low,x.close].every(Number.isFinite)&&x.open>0&&x.high>0&&x.low>0&&x.close>0);
    if(bars.length<120)throw new Error("KRAKEN_HISTORICAL_BARS_INSUFFICIENT");
    return bars.slice(-count);
  }finally{
    clearTimeout(timer);
  }
}

async function getTrainingBars(symbol,timeframe,twelveData){
  const clean=String(symbol||"").trim().toUpperCase();
  const tf=String(timeframe||"5m").trim().toLowerCase();
  const cacheKey=clean+":"+tf;
  const cached=trainingHistoryCache.get(cacheKey);
  if(cached&&Date.now()-cached.at<TRAINING_HISTORY_CACHE_MS&&Array.isArray(cached.bars)&&cached.bars.length>=120){
    return cached.bars;
  }

  const errors=[];
  if(clean==="BTCUSD"){
    try{
      const bars=await getBinanceTrainingBars(clean,tf);
      trainingHistoryCache.set(cacheKey,{at:Date.now(),bars});
      return bars;
    }catch(error){
      errors.push("BINANCE:"+(error?.message||"UNAVAILABLE"));
    }
    try{
      const bars=await getKrakenTrainingBars(clean,tf);
      trainingHistoryCache.set(cacheKey,{at:Date.now(),bars});
      return bars;
    }catch(error){
      errors.push("KRAKEN:"+(error?.message||"UNAVAILABLE"));
    }
  }
  if(twelveData?.enabled && typeof twelveData.historicalBars==="function"){
    try{
      const bars=await twelveData.historicalBars(clean,tf,{limit:TRAINING_HISTORY_LIMIT,maxAgeMs:10*60*1000});
      if(Array.isArray(bars)&&bars.length>=120){
        trainingHistoryCache.set(cacheKey,{at:Date.now(),bars});
        return bars;
      }
      errors.push("TWELVE_DATA:INSUFFICIENT_HISTORY");
    }catch(error){
      errors.push("TWELVE_DATA:"+(error?.message||"UNAVAILABLE"));
    }
  }
  try{
    const bars=await publicDerivFeed.getHistoricalCandles(clean,{timeframe:tf,limit:TRAINING_HISTORY_LIMIT,timeoutMs:15000});
    if(Array.isArray(bars)&&bars.length>=120){
      trainingHistoryCache.set(cacheKey,{at:Date.now(),bars});
      return bars;
    }
    errors.push("DERIV:INSUFFICIENT_HISTORY");
  }catch(error){
    errors.push("DERIV:"+(error?.message||"UNAVAILABLE"));
  }
  throw new Error(errors.join(" | ").slice(0,500)||"TRAINING_HISTORY_UNAVAILABLE");
}

async function trainAiStrategyModels(twelveData){
  const status=mlSignalServiceStatus();
  if(!status.configured)return {configured:false,trained:0,reason:"ML_SERVICE_NOT_CONFIGURED"};
  let trained=0;
  let botsReady=0;
  const reports=[];
  for(const botId of AI_STRATEGY_BOTS){
    const timeframes=trainingTimeframes(botId);
    const botReports=[];
    let botTrained=0;
    for(const timeframe of timeframes){
      const fetched=await Promise.all(TRAINING_SYMBOLS.map(async symbol=>{
        try{
          const bars=await getTrainingBars(symbol,timeframe,twelveData);
          return Array.isArray(bars)&&bars.length>=120
            ? {ok:true,symbol,bars}
            : {ok:false,symbol,error:"INSUFFICIENT_HISTORY"};
        }catch(error){
          return {ok:false,symbol,error:String(error?.message||"HISTORY_UNAVAILABLE").slice(0,500)};
        }
      }));
      const markets=fetched.filter(x=>x.ok).map(x=>({symbol:x.symbol,bars:x.bars}));
      for(const failure of fetched.filter(x=>!x.ok)){
        const report={botId,symbol:failure.symbol,timeframe,ok:false,error:failure.error};
        reports.push(report);
        botReports.push(report);
        console.warn("[KINGBOT ML TRAIN]",botId,timeframe,failure.symbol,failure.error);
      }
      if(!markets.length){
        const failure={botId,timeframe,ok:false,error:"NO_VALID_TRAINING_MARKETS"};
        reports.push(failure);
        botReports.push(failure);
        continue;
      }
      try{
        await paceMlTrainingRequest();
        const result=await trainMlStrategyModel({botId,timeframe,markets});
        if(result?.ok){
          trained++;
          botTrained++;
          const ready={botId,timeframe,ok:true,markets:markets.map(x=>({symbol:x.symbol,bars:x.bars.length})),model:result};
          reports.push(ready);
          botReports.push(ready);
          console.log("[KINGBOT ML TRAIN] READY",JSON.stringify({botId,timeframe,markets:markets.length,samples:result?.dataset?.samples||null}));
        }else{
          const failure={botId,timeframe,ok:false,error:result?.error||result?.status||"TRAINING_FAILED"};
          reports.push(failure);
          botReports.push(failure);
          console.warn("[KINGBOT ML TRAIN]",botId,timeframe,failure.error);
        }
      }catch(error){
        const failure={botId,timeframe,ok:false,error:String(error?.message||"TRAINING_FAILED").slice(0,500)};
        reports.push(failure);
        botReports.push(failure);
        console.warn("[KINGBOT ML TRAIN]",botId,timeframe,failure.error);
      }
    }
    if(botTrained===timeframes.length)botsReady++;
  }
  return {
    configured:true,
    trained,
    targetModels:AI_STRATEGY_BOTS.reduce((n,botId)=>n+trainingTimeframes(botId).length,0),
    botsReady,
    reports,
    historyLimit:TRAINING_HISTORY_LIMIT,
    trainingMode:"STRATEGY_SPECIFIC_MULTI_TIMEFRAME"
  };
}

function startAiStrategyModelTraining(twelveData){
  if(!mlSignalServiceStatus().configured)return;
  const intervalMs=Math.max(5*60*1000,Number(process.env.KINGBOT_ML_RETRAIN_MS||30*60*1000));
  const retryMs=Math.max(60*1000,Number(process.env.KINGBOT_ML_RETRY_MS||5*60*1000));
  let running=false;
  let lastTrainingResult=null;
  const run=async()=>{
    if(running)return;
    running=true;
    try{
      const result=await trainAiStrategyModels(twelveData);
      lastTrainingResult=result;
      console.log("[KINGBOT ML TRAIN] strategy models:",JSON.stringify(result));
    }catch(error){
      lastTrainingResult={configured:true,trained:0,reason:String(error?.message||"TRAINING_CYCLE_FAILED").slice(0,180)};
      console.warn("[KINGBOT ML TRAIN] cycle failed:",error?.message||error);
    }finally{
      running=false;
    }
    // A restarted/free-tier ML service can be unavailable during the first
    // training cycle. Retry quickly when no strategy model was trained instead
    // of leaving AI execution blocked until the normal 30-minute retrain.
    const trained = Number(lastTrainingResult?.trained||0);
    const target = Number(lastTrainingResult?.targetModels||0);
    if(target>0 && trained<target){
      const hasRateLimit = (lastTrainingResult?.reports||[]).some(item=>/HTTP_429/.test(String(item?.error||"")));
      const retryDelay = hasRateLimit
        ? Math.max(retryMs,Number(process.env.KINGBOT_ML_429_RETRY_MS||10*60*1000))
        : retryMs;
      setTimeout(()=>void run(),retryDelay);
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
  constructor({ server, pool, twelveData, cortexRunner = null }) {
    this.server = server;
    this.pool = pool;
    this.twelveData = twelveData;
    this.cortexRunner = typeof cortexRunner === "function" ? cortexRunner : null;
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
        timeframe: channel.timeframe,
        cortexRunner: this.cortexRunner,
        focusSymbol: channel.symbols?.[0] || null
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


export function buildScannerChartStreamQuote(symbol, quote, nowMs = Date.now()) {
  const price = finite(quote?.price);
  const epoch = finite(quote?.epoch);
  const receivedAt = finite(quote?.receivedAt) ?? nowMs;
  const exchangeAgeMs = epoch !== null ? Math.max(0, nowMs - epoch * 1000) : null;
  const transportAgeMs = Math.max(0, nowMs - receivedAt);
  return {
    symbol: scannerCanonicalSymbol(symbol || quote?.symbol || quote?.brokerSymbol || ""),
    price,
    bid: finite(quote?.bid),
    ask: finite(quote?.ask),
    epoch,
    time: quote?.time || null,
    timestamp: epoch !== null ? epoch * 1000 : null,
    exchangeAgeMs,
    transportAgeMs,
    ageMs: transportAgeMs,
    receivedAt,
    source: String(quote?.source || "deriv-shared-live-feed")
  };
}

function registerPublicDerivChartStream(server) {
  const maxClients = Math.max(1, Math.min(50, Number(process.env.AI_SCANNER_CHART_WS_MAX_CLIENTS || 30)));
  const clients = new Set();
  const wss = new WebSocketServer({
    server,
    path: "/api/ai/market-scanner/chart/ws",
    maxPayload: 2048,
    perMessageDeflate: false
  });

  const send = (client, payload) => {
    if (!client || client.closed || client.ws.readyState !== WebSocket.OPEN) return false;
    try {
      client.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  };

  const unsubscribe = client => {
    if (!client) return;
    const stop = client.unsubscribe;
    client.unsubscribe = null;
    if (typeof stop === "function") {
      try { stop(); } catch {}
    }
  };

  wss.on("connection", ws => {
    if (clients.size >= maxClients) {
      try {
        ws.send(JSON.stringify({ type: "chart_error", error: "CHART_STREAM_CAPACITY_REACHED" }));
        ws.close(1013, "Chart stream capacity reached");
      } catch {}
      return;
    }

    const client = {
      ws, symbol: null, pendingSymbol: null, unsubscribe: null,
      subscriptionGeneration: 0, closed: false, isAlive: true
    };
    clients.add(client);
    send(client, {
      type: "hello",
      stream: "KINGBOT DERIV CHART TICKS",
      provider: "Deriv public market feed",
      brokerRequired: false,
      executionAuthority: "NONE"
    });

    const cleanup = () => {
      if (client.closed) return;
      client.closed = true;
      client.subscriptionGeneration += 1;
      client.pendingSymbol = null;
      clearInterval(client.heartbeat);
      unsubscribe(client);
      clients.delete(client);
    };

    ws.on("pong", () => { client.isAlive = true; });
    client.heartbeat = setInterval(() => {
      if (client.closed) return clearInterval(client.heartbeat);
      if (!client.isAlive) {
        try { ws.terminate(); } catch {}
        cleanup();
        return;
      }
      client.isAlive = false;
      try { ws.ping(); } catch { cleanup(); }
    }, 30000);

    ws.on("message", raw => {
      let message;
      try { message = JSON.parse(String(raw || "")); }
      catch {
        send(client, { type: "chart_error", error: "INVALID_CHART_STREAM_MESSAGE" });
        return;
      }
      const type = String(message?.type || "").toLowerCase();
      if (type !== "subscribe") {
        send(client, { type: "chart_error", error: "CHART_STREAM_SUBSCRIBE_REQUIRED" });
        return;
      }

      const symbol = scannerCanonicalSymbol(message.symbol || "");
      const allowed = cleanSymbols(symbol);
      if (!symbol || !allowed.includes(symbol)) {
        send(client, { type: "chart_error", error: "CHART_SYMBOL_INVALID" });
        return;
      }
      if (client.symbol === symbol && (
        client.pendingSymbol === symbol || typeof client.unsubscribe === "function"
      )) {
        send(client, { type: "subscribed", symbol, provider: "Deriv public market feed", pending:client.pendingSymbol===symbol });
        return;
      }

      unsubscribe(client);
      client.symbol = symbol;
      client.pendingSymbol = symbol;
      const subscriptionGeneration = ++client.subscriptionGeneration;
      // Compare the raw Deriv identifiers against the exact symbol that the
      // same feed normalized for history/tick subscription. Keep the browser
      // market label canonical so FRX-prefixed and broker aliases stay aligned.
      const expectedDerivSymbol = String(publicDerivFeed.normalize(symbol) || "").trim().toUpperCase();
      void publicDerivFeed.onTick(symbol, quote => {
        const rawSymbol = String(quote?.symbol || "").trim().toUpperCase();
        const brokerSymbol = String(quote?.brokerSymbol || "").trim().toUpperCase();
        const canonicalSymbol = scannerCanonicalSymbol(rawSymbol || brokerSymbol);
        const matchesFeedSymbol = Boolean(expectedDerivSymbol) && (
          rawSymbol === expectedDerivSymbol ||
          brokerSymbol === expectedDerivSymbol ||
          canonicalSymbol === symbol
        );
        const price = finite(quote?.price);
        if (
          client.closed ||
          client.symbol !== symbol ||
          client.subscriptionGeneration !== subscriptionGeneration ||
          !matchesFeedSymbol ||
          price === null ||
          price <= 0
        ) return;
        send(client, {
          type: "quote",
          quote: buildScannerChartStreamQuote(symbol, quote),
          streamAt: new Date().toISOString()
        });
      }).then(stop => {
        if (
          client.closed ||
          client.symbol !== symbol ||
          client.subscriptionGeneration !== subscriptionGeneration
        ) {
          try { stop(); } catch {}
          return;
        }
        client.pendingSymbol = null;
        client.unsubscribe = stop;
        send(client, {
          type: "subscribed",
          symbol,
          provider: "Deriv public market feed",
          brokerIndependent: true
        });
      }).catch(error => {
        if (client.closed || client.subscriptionGeneration !== subscriptionGeneration) return;
        client.pendingSymbol = null;
        send(client, {
          type: "chart_error",
          symbol,
          error: String(error?.message || "DERIV_PUBLIC_CHART_STREAM_UNAVAILABLE").slice(0, 160)
        });
      });
    });

    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });

  wss.on("error", error => {
    console.error("[KINGBOT CHART WS]", error?.message || error);
  });

  return { wss, clients };
}

export function registerAiMarketScanner(app, { pool, rateLimit, twelveData, server, cortexRunner = null }) {
  const stream = new AiMarketScannerStream({ server, pool, twelveData, cortexRunner });
  const chartStream = registerPublicDerivChartStream(server);
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
        chartClients:chartStream.clients.size,
        chartPath:"/api/ai/market-scanner/chart/ws",
        channels:stream.channels.size
      }
    });
  });


  const chartLimiter = rateLimit({
    windowMs:60*1000,
    limit:Number(process.env.AI_SCANNER_CHART_REQUESTS_PER_MINUTE || 24),
    standardHeaders:"draft-8",
    legacyHeaders:false,
    message:{ok:false,error:"Chart history request limit reached. Wait a moment and retry."}
  });

  const chartHandler=async(req,res)=>{
    const requestedSymbol=String(req.query?.symbol || "").trim().toUpperCase();
    const symbol=cleanSymbols(requestedSymbol)[0];
    if(!requestedSymbol || !symbol){
      return res.status(400).json({ok:false,error:"CHART_SYMBOL_REQUIRED",executionAuthority:"NONE"});
    }
    const timeframe=cleanTimeframe(req.query?.timeframe || DEFAULT_TF);
    const limit=Math.max(120,Math.min(500,Math.floor(Number(req.query?.limit) || 300)));
    try{
      // This chart endpoint deliberately uses the existing free Deriv public
      // candle feed only. It does not require customer broker credentials,
      // TradingView webhooks, or a paid market-data subscription.
      const bars=await publicDerivFeed.getHistoricalCandles(symbol,{
        timeframe,
        limit,
        timeoutMs:10000
      });
      const payload=buildScannerChartPayload(bars,{
        symbol,
        timeframe,
        source:"Deriv public historical candles"
      });
      const [quote,multiTimeframe]=await Promise.all([
        getCortexDerivQuote(symbol),
        buildCortexMultiTimeframeForSymbol(symbol,{reuseTimeframe:timeframe,reuseBars:bars})
      ]);
      payload.entryDecision=multiTimeframe.entryDecision;
      payload.multiTimeframe={
        timeframes:multiTimeframe.timeframes,
        executionTimeframe:multiTimeframe.executionTimeframe,
        generatedAt:multiTimeframe.generatedAt,
        frames:multiTimeframe.frames,
        analysisPolicy:multiTimeframe.analysisPolicy
      };
      payload.quoteDiagnostics={
        available:Boolean(quote.available),
        ageMs:quote.ageMs,
        spread:quote.spread,
        source:quote.source||null
      };
      payload.signal={
        ...payload.signal,
        ...multiTimeframe.entryDecision,
        pendingOrderZones:payload.signal?.pendingOrderZones||null
      };
      payload.metadata={
        ...payload.metadata,
        multiTimeframeReady:Object.values(multiTimeframe.frames).every(frame=>frame?.ok&&frame?.fresh),
        entryEligible:Boolean(multiTimeframe.entryDecision?.entryEligible),
        executionTimeframe:multiTimeframe.executionTimeframe
      };
      const feedStatus=publicDerivFeed.status(symbol);
      return res.json({
        ...payload,
        marketData:{
          provider:"Deriv public market feed",
          connected:Boolean(feedStatus.connected),
          brokerIndependent:true
        }
      });
    }catch(error){
      const reason=String(error?.message || "DERIV_PUBLIC_CHART_DATA_UNAVAILABLE").slice(0,160);
      console.warn("[KINGBOT SCANNER CHART]",symbol,timeframe,reason);
      return res.status(503).json({
        ok:false,
        error:"SCANNER_CHART_DATA_UNAVAILABLE",
        reason,
        symbol,
        timeframe,
        executionAuthority:"NONE",
        brokerRequired:false
      });
    }
  };

  app.get("/api/ai/market-scanner/chart",chartLimiter,chartHandler);
  app.get("/api/market-scanner/chart",chartLimiter,chartHandler);

  const scanHandler=async(req,res)=>{ await runMarketScan({pool,twelveData,req,res}); };
  app.get("/api/ai/market-scanner",limiter,scanHandler);
  app.post("/api/ai/market-scanner",limiter,scanHandler);
  app.get("/api/market-scanner",limiter,scanHandler);
  app.post("/api/market-scanner",limiter,scanHandler);
  app.get("/api/ai/scan",limiter,scanHandler);
  app.post("/api/ai/scan",limiter,scanHandler);
}
