export const TECHNICAL_ANALYSIS_AI_BOOK = {
  title: "KINGBOT Technical Analysis AI Book",
  version: "1.0",
  mission: "Teach and apply a disciplined, evidence-first framework for reading market structure, trend, momentum, volatility, liquidity and setup confirmation.",
  chapters: [
    {
      id: 1,
      title: "Market Structure",
      principles: [
        "Read swing highs and swing lows before interpreting indicators.",
        "Higher highs and higher lows describe bullish structure; lower highs and lower lows describe bearish structure.",
        "BOS is treated as structural continuation evidence; CHOCH is treated as a possible transition signal and requires confirmation.",
        "A single candle never overrides the broader structure without supporting evidence."
      ]
    },
    {
      id: 2,
      title: "Trend and Multi-Timeframe Context",
      principles: [
        "Use higher timeframes for context and lower timeframes for timing.",
        "EMA20 above EMA50 can support bullish alignment; EMA20 below EMA50 can support bearish alignment.",
        "When timeframes disagree, classify the condition as mixed rather than forcing a directional conclusion."
      ]
    },
    {
      id: 3,
      title: "Support and Resistance",
      principles: [
        "Treat support and resistance as areas, not exact magical prices.",
        "Prioritize levels that have repeated reactions, structural relevance or liquidity significance.",
        "A clean break is stronger when accompanied by momentum or a successful retest."
      ]
    },
    {
      id: 4,
      title: "Candles and Price Action",
      principles: [
        "Evaluate candle body, range, wick rejection and location within structure.",
        "Displacement means an unusually decisive move through a meaningful level; confirm it with context.",
        "Do not interpret an isolated candlestick pattern without location, structure and volatility context."
      ]
    },
    {
      id: 5,
      title: "Momentum: RSI and MACD",
      principles: [
        "RSI is a momentum context tool, not a standalone buy/sell trigger.",
        "RSI above 50 can support bullish momentum; RSI below 50 can support bearish momentum.",
        "MACD line relative to signal can confirm directional momentum but can lag price structure.",
        "Divergence or overextension is a warning to investigate, not an automatic reversal order."
      ]
    },
    {
      id: 6,
      title: "Volatility and ATR",
      principles: [
        "ATR estimates recent price-range volatility and helps scale buffers, stops and zones.",
        "Use volatility-adjusted distances rather than fixed pip distances across different instruments.",
        "High ATR means wider expected movement; it does not by itself predict direction."
      ]
    },
    {
      id: 7,
      title: "Liquidity, Sweeps and Fair Value Gaps",
      principles: [
        "Liquidity areas are inferred from visible swing highs, swing lows and obvious reaction points.",
        "A liquidity sweep is strongest when price briefly exceeds a visible level and then closes back through it.",
        "FVG is treated as a contextual imbalance area and should be combined with structure and price location.",
        "The engine must not claim to see hidden institutional orders unless the connected data source explicitly provides that information."
      ]
    },
    {
      id: 8,
      title: "Order Blocks and Displacement",
      principles: [
        "An order-block concept is used as a structural reaction zone, not proof of hidden orders.",
        "Combine displacement, BOS/CHOCH and location when evaluating a zone.",
        "Invalidation should be defined before any execution decision."
      ]
    },
    {
      id: 9,
      title: "Pending-Order Inference",
      principles: [
        "BUY LIMIT zones are inferred below current price around support and bullish structural confluence.",
        "SELL LIMIT zones are inferred above current price around resistance and bearish structural confluence.",
        "BUY STOP triggers are inferred above resistance with a volatility buffer.",
        "SELL STOP triggers are inferred below support with a volatility buffer.",
        "These are predicted entry/liquidity zones from observable data, not broker-confirmed pending orders."
      ]
    },
    {
      id: 10,
      title: "Setup Confirmation",
      principles: [
        "Separate observation from confirmation.",
        "A setup should specify bias, trigger, entry condition, invalidation and risk context.",
        "WAIT is a valid intelligence output when evidence is incomplete or conflicting.",
        "NO_TRADE is preferred when data quality, structure or risk conditions do not support a disciplined setup."
      ]
    },
    {
      id: 11,
      title: "Risk Architecture",
      principles: [
        "Technical analysis does not remove market risk.",
        "Stops, position sizing, exposure and drawdown limits belong to the risk layer.",
        "AI analysis never becomes execution authorization.",
        "A technically attractive setup can still be rejected by stale data, spread, drawdown, exposure or account controls."
      ]
    },
    {
      id: 12,
      title: "KINGBOT Scanner Method",
      principles: [
        "Verify live quote first.",
        "Build technical structure from available OHLC data.",
        "Cross-check trend, momentum, volatility, structure, liquidity and FVG evidence.",
        "Generate a deterministic technical state before optional AI explanation.",
        "Use AI to synthesize verified evidence, never to invent missing market data.",
        "Keep execution authority outside the conversational and scanner intelligence layers."
      ]
    }
  ],
  rules: [
    "Evidence before conclusion.",
    "Structure before indicator.",
    "Context before pattern.",
    "Volatility before fixed distances.",
    "Invalidation before execution.",
    "WAIT is better than fabricated certainty.",
    "Predicted zones are not confirmed broker orders.",
    "No profit guarantee."
  ]
};

export function technicalAnalysisBookContext(maxChapters=12) {
  return TECHNICAL_ANALYSIS_AI_BOOK.chapters
    .slice(0, Math.max(1, Math.min(maxChapters, TECHNICAL_ANALYSIS_AI_BOOK.chapters.length)))
    .map(chapter => `CHAPTER ${chapter.id}: ${chapter.title}\n${chapter.principles.map(p => "- "+p).join("\n")}`)
    .join("\n\n");
}

export function searchTechnicalAnalysisBook(query) {
  const q=String(query||"").toLowerCase();
  const results=[];
  for (const chapter of TECHNICAL_ANALYSIS_AI_BOOK.chapters) {
    const hay=(chapter.title+" "+chapter.principles.join(" ")).toLowerCase();
    if (q.split(/\\s+/).filter(Boolean).some(token => hay.includes(token))) {
      results.push(chapter);
    }
  }
  return results.length ? results : TECHNICAL_ANALYSIS_AI_BOOK.chapters.slice(0,3);
}
