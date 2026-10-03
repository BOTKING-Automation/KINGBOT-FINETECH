/*
 * KINGBOT DIALOGUE CORTEX
 * Native conversational reasoning layer.
 *
 * Design:
 * 1. Parse the current message.
 * 2. Inspect recent conversation for continuity.
 * 3. Resolve implicit references ("it", "that", "this", "there", "now").
 * 4. Infer topic + speech act + domain before platform routing.
 * 5. Answer ordinary conversation naturally without an external model.
 *
 * This is a deterministic cognitive component, not a claim of consciousness.
 */

const NORMALIZE = value => String(value || "").replace(/\s+/g, " ").trim();
const WORDS = value => NORMALIZE(value).toLowerCase();
const TOKENS = value => WORDS(value).match(/[a-z0-9_+-]+/g) || [];
const unique = xs => [...new Set(xs)];

const DOMAIN_LEXICON = Object.freeze({
  MARKET: ["xauusd","gold","forex","eurusd","gbpusd","usdjpy","btcusd","bitcoin","market","price","quote","chart","candle","candles","trend","signal","entry","setup","trade","trading","buy","sell","long","short","spread","volatility"],
  BOT: ["bot","bots","strategy","engine","flipper","breakout","smc","ladder","runtime","algorithm","automation","ea","expert advisor"],
  PLATFORM: ["kingbot","platform","dashboard","fintech","page","website","feature","system","app","subscription","pricing","payment","plan"],
  ACCOUNT: ["account","balance","equity","margin","position","portfolio","broker","connection","connected","mt5","deriv","exness","oanda"],
  RISK: ["risk","drawdown","exposure","stop","stoploss","sl","take","takeprofit","tp","loss","kill","limit","margin"],
  RESEARCH: ["research","search","google","news","latest","current","today","headline","source","internet","online"]
});

const SPEECH_ACTS = Object.freeze({
  GREETING: /^(hi|hello|hey|hey there|yo|hiya|howdy|greetings|good morning|good afternoon|good evening)[!. ,]*$/i,
  WELLBEING: /^(how are you|how are u|how are things|how is it going|how's it going|are you good|are you okay|are you ok|you good|you okay|you ok|everything good|doing good|doing well|you doing good|you doing well|are things good|all good|u good)[?! .]*$/i,
  PRESENCE: /^(you there|are you there|you online|are you online|are you awake|you awake|can you hear me|can you see me|are you active|still there|still online)[?! .]*$/i,
  THANKS: /^(thanks|thank you|thank u|much appreciated|appreciate it)[!. ,]*$/i,
  GOODBYE: /^(bye|goodbye|see you|see ya|talk later|catch you later|good night|have a good night)[!. ,]*$/i,
  WHAT_IS_UP: /^(what.?s up|sup|how goes it)[?! .]*$/i,
  IDENTITY: /\b(who are you|what are you|what is your name|tell me about yourself|introduce yourself)\b/i,
  INTELLIGENCE: /\b(are you smart|are you intelligent|how intelligent are you|how smart are you|are you an ai|are you artificial intelligence)\b/i,
  CAPABILITY: /\b(what can you do|what do you do|what are you capable of|your capabilities|what can you help with|how can you help me|what can you help me with)\b/i,
  EMOTION_PROBE: /\b(do you feel|do you have feelings|are you happy|are you sad|do you get tired|do you get bored|do you love|do you care)\b/i,
  HELP: /\b(i need help|help me|can you help me|i need your help|i don't understand|i dont understand|i'm confused|im confused|can you explain)\b/i,
  META_FEEDBACK: /\b(that makes sense|i understand|i understood|got it|makes sense|i see|exactly|right|okay|ok|alright|sure|yes|yep|yeah|no|nah|hmm)\b/i
});

const REFERENCE_WORDS = /\b(it|this|that|these|those|there|then|now|one|ones|they|them|he|she|its|the same)\b/i;
const OMITTED_SUBJECT = /^(and|but|so|then|now|what about|how about|why|how|which|where|when|what|tell me|explain|continue|go on|what next|next)[\s!?.,-]*(please)?$/i;

function recentMessages(conversation = []) {
  return (Array.isArray(conversation) ? conversation : [])
    .filter(x => x && ["user","assistant"].includes(String(x.role || "").toLowerCase()))
    .slice(-8)
    .map(x => ({
      role: String(x.role || "user").toLowerCase(),
      content: NORMALIZE(x.content),
    }))
    .filter(x => x.content);
}

function recentUserMessages(conversation = []) {
  return recentMessages(conversation)
    .filter(x => x.role === "user")
    .slice(-5)
    .map(x => x.content);
}

function escapedWord(word) {
  return String(word).replace(/[.*+?^()|[\]\\]/g, "\\$&");
}

function domainScores(text) {
  const t = WORDS(text);
  const scores = Object.fromEntries(Object.keys(DOMAIN_LEXICON).map(k => [k, 0]));
  for (const [domain, words] of Object.entries(DOMAIN_LEXICON)) {
    for (const word of words) {
      if (new RegExp("\\b" + escapedWord(word) + "\\b", "i").test(t)) {
        scores[domain] += word.length > 5 ? 2 : 1;
      }
    }
  }
  return scores;
}

function topDomain(text, conversation = []) {
  const combined = [text, ...recentUserMessages(conversation).slice(-3)].join(" ");
  const scores = domainScores(combined);
  const ranked = Object.entries(scores).sort((a,b) => b[1] - a[1]);
  return ranked[0]?.[1] > 0 ? ranked[0][0] : "GENERAL";
}

function extractEntities(text, conversation = []) {
  const combined = [text, ...recentUserMessages(conversation).slice(-3)].join(" ");
  const t = WORDS(combined);
  const entities = [];
  const map = [
    ["XAUUSD", /\bxauusd\b|\bgold\b/i],
    ["EURUSD", /\beurusd\b|\beuro\b/i],
    ["GBPUSD", /\bgbpusd\b|\bpound\b/i],
    ["USDJPY", /\busdjpy\b|\byen\b/i],
    ["BTCUSD", /\bbtcusd\b|\bbitcoin\b/i],
    ["DERIV", /\bderiv\b/i],
    ["MT5", /\bmt5\b/i],
    ["EXNESS", /\bexness\b/i],
    ["KINGBOT", /\bkingbot\b/i],
    ["SMC_PRO", /\bsmc\b/i],
    ["LADDER_FLIP", /\bladder\b|\bflipper\b/i]
  ];
  for (const [name, re] of map) if (re.test(t)) entities.push(name);
  return unique(entities);
}

function speechAct(text) {
  const t = WORDS(text);
  for (const [name, re] of Object.entries(SPEECH_ACTS)) {
    if (re.test(t)) return name;
  }
  return null;
}

function isShortCasual(text) {
  const t = WORDS(text);
  const words = TOKENS(t);
  if (words.length > 9) return false;
  return /^(ok|okay|alright|right|sure|yep|yeah|yes|no|nah|hmm|hm|nice|cool|wow|really|exactly|understood|got it|i see|go on|continue|next)[!.? ]*$/i.test(t);
}

function likelyNeedsContext(text) {
  const t = WORDS(text);
  if (!t) return true;
  return REFERENCE_WORDS.test(t) || OMITTED_SUBJECT.test(t) || TOKENS(t).length <= 3;
}

function resolveReference(text, conversation = []) {
  const t = NORMALIZE(text);
  const users = recentUserMessages(conversation);
  const lastMeaningful = users.at(-1) || "";
  if (!lastMeaningful) return { question:t, resolved:false, source:null, domain:"GENERAL", entities:[] };

  const contextSensitive = likelyNeedsContext(t);
  if (!contextSensitive) return { question:t, resolved:false, source:lastMeaningful };

  const currentTokens = new Set(TOKENS(t).filter(x => x.length > 2));
  const contextDomain = topDomain(lastMeaningful, []);
  const contextEntities = extractEntities(lastMeaningful, []);
  const contextWords = contextEntities.length
    ? contextEntities.join(", ")
    : contextDomain !== "GENERAL" ? contextDomain.toLowerCase() : "the previous topic";

  const hasExplicitReference = REFERENCE_WORDS.test(t);
  const prefix = hasExplicitReference
    ? "Regarding " + contextWords + ", "
    : contextSensitive && contextDomain !== "GENERAL"
      ? "Regarding " + contextWords + ", "
      : "";

  return {
    question: prefix ? prefix + t : t,
    resolved: Boolean(prefix),
    source:lastMeaningful,
    domain:contextDomain,
    entities:contextEntities,
    overlap:[...currentTokens].filter(x => TOKENS(lastMeaningful).includes(x))
  };
}

function classify(text, conversation = []) {
  const t = WORDS(text);
  const direct = speechAct(t);
  const resolved = resolveReference(t, conversation);
  const effective = resolved.question || t;
  const currentScores = domainScores(t);
  const currentRanked = Object.entries(currentScores).sort((a,b) => b[1] - a[1]);
  const currentDomain = currentRanked[0]?.[1] > 0 ? currentRanked[0][0] : null;
  const scores = domainScores(effective);
  const rankedDomains = Object.entries(scores).sort((a,b) => b[1] - a[1]);
  const domain = currentDomain || (rankedDomains[0]?.[1] > 0 ? rankedDomains[0][0] : topDomain(t, conversation));

  if (direct) return { act:direct, domain, score:1, effectiveQuestion:effective, resolved:resolved.resolved };

  const questionType =
    /\b(why|how come)\b/i.test(t) ? "WHY" :
    /\b(how)\b/i.test(t) ? "HOW" :
    /\b(what|who|which)\b/i.test(t) ? "WHAT" :
    /\b(can|could|would|should|is|are|do|does)\b/i.test(t) ? "YES_NO" :
    /\b(compare|versus|vs\.?|difference|better)\b/i.test(t) ? "COMPARE" :
    /\b(latest|current|today|now|news|research)\b/i.test(t) ? "RESEARCH" :
    "STATEMENT";

  const act =
    domain === "RESEARCH" ? "RESEARCH" :
    questionType === "WHY" || questionType === "HOW" || questionType === "WHAT" || questionType === "COMPARE" || questionType === "YES_NO"
      ? "QUESTION"
      : isShortCasual(t) ? "CASUAL" : null;

  return {
    act,
    domain,
    questionType,
    score: Math.max(0.35, Math.min(0.98, (rankedDomains[0]?.[1] || 0) / 8)),
    effectiveQuestion:effective,
    resolved:resolved.resolved
  };
}

function routeIntent(text, conversation = []) {
  const info = classify(text, conversation);
  const t = WORDS(info.effectiveQuestion || text);

  if (info.act === "GREETING" || info.act === "WELLBEING" || info.act === "WHAT_IS_UP" || info.act === "PRESENCE" ||
      info.act === "THANKS" || info.act === "GOODBYE" || info.act === "IDENTITY" ||
      info.act === "INTELLIGENCE" || info.act === "CAPABILITY" || info.act === "EMOTION_PROBE" ||
      info.act === "HELP" || info.act === "META_FEEDBACK" || info.act === "CASUAL") return info.act;

  if (info.domain === "RESEARCH" || /\b(search|google|online research|latest news)\b/i.test(t)) return "RESEARCH";
  if (info.domain === "ACCOUNT") return /\b(broker|connection|connected|mt5|deriv)\b/i.test(t) ? "CONNECTION" : "ACCOUNT";
  if (info.domain === "RISK") return "RISK";
  if (info.domain === "BOT") return "BOT";
  if (info.domain === "MARKET") return "MARKET";
  if (info.domain === "PLATFORM") return "PLATFORM";
  return "GENERAL";
}

function variantIndex(question, conversation = []) {
  const seed = (WORDS(question) + "|" + recentUserMessages(conversation).join("|")).split("").reduce((s,c) => s + c.charCodeAt(0), 0);
  return seed % 3;
}

function responseBase(answer, nextAction = "Tell me what you want to work on.") {
  return {
    answer,
    facts:["Native KINGBOT Dialogue Cortex interpreted the request using current text plus available conversation context; no external language model was used."],
    technicalAnalysis:[],
    setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"No market setup requested.",invalidation:"Not applicable."},
    riskFlags:[],
    nextAction
  };
}

export function conversationalReply(question = "", conversation = []) {
  const info = classify(question, conversation);
  const mode = routeIntent(question, conversation);
  const i = variantIndex(question, conversation);

  if (mode === "WHAT_IS_UP") {
    return responseBase([
      "I’m online and working normally. 🤖 What do you want to tackle?",
      "All good here. KINGBOT is active. What are we working on?",
      "Nothing dramatic — I’m online and ready. Give me the next task."
    ][i], "Continue with your next question or task.");
  }

  if (mode === "GREETING") {
    return responseBase([
      "Hey! 👋 I'm here and fully online. What are we working on?",
      "Hello! 🤖 KINGBOT is online and ready. Tell me what you want to work through.",
      "Hey there. KINGBOT is active and listening. What should we tackle?"
    ][i], "Ask a question, describe a problem, or request live market analysis.");
  }

  if (mode === "WELLBEING") {
    return responseBase([
      "I'm good on the system side. 🤖 The KINGBOT core is active and ready for the next task.",
      "All good here. KINGBOT is online, and I'm ready to reason through whatever you want to solve.",
      "Yes — I'm operating normally and ready. I don't experience feelings like a person, but the intelligence services are online."
    ][i], "Send the next thing you want me to think through.");
  }

  if (mode === "PRESENCE") {
    return responseBase("Yes — I'm here and online. 🤖 Give me the next instruction and I'll work from there.", "Continue the conversation.");
  }

  if (mode === "THANKS") {
    return responseBase(["You're welcome. 🤝","Glad to help. 🤖","Absolutely."][i], "Continue with the next question or task.");
  }

  if (mode === "GOODBYE") {
    return responseBase(["See you. 👋","Take care. 🤖","Understood. See you next time."][i], "Conversation ended normally.");
  }

  if (mode === "IDENTITY" || mode === "INTELLIGENCE") {
    return responseBase(
      "I'm KINGBOT — the platform's native intelligence layer. I can understand ordinary conversation, use recent context, reason over verified platform state, work with live market data when available, investigate system conditions, explain strategy logic, and research information when the backend research service is configured. My reasoning core is proprietary and deterministic rather than another AI service.",
      "Ask me a normal question, a technical question, or a live market question."
    );
  }

  if (mode === "CAPABILITY") {
    return responseBase(
      "I can converse naturally, keep track of the recent topic, inspect verified broker/account/runtime state, analyze supported live markets, compare strategy logic, reason through errors, run native multi-pass deliberation, and use web research when configured. Chat itself does not authorize broker execution.",
      "Try “analyze XAUUSD”, “why is my bot stopped?”, or “explain SMC PRO”."
    );
  }

  if (mode === "EMOTION_PROBE") {
    return responseBase(
      "I can understand questions about emotions, but I don't experience emotions the way a person does. I can still stay consistent, remember the recent conversational context, and help you work through what you want to solve.",
      "Tell me what's on your mind."
    );
  }

  if (mode === "HELP") {
    return responseBase(
      "Yes. Tell me what is confusing or not working. I’ll first identify the subject, use the recent conversation context, and then route the problem to the relevant KINGBOT subsystem.",
      "Describe the problem in your own words — you don't need to use technical commands."
    );
  }

  if (mode === "CASUAL" || mode === "META_FEEDBACK") {
    return responseBase(["Got it — I'm following you.","Understood. I'm with you.","Yep, I follow. Go ahead."][i], "Continue with the next detail.");
  }

  return null;
}

export function conversationSignals(question = "", conversation = []) {
  const info = classify(question, conversation);
  const route = routeIntent(question, conversation);
  const resolved = resolveReference(question, conversation);
  return {
    conversational:true,
    intent:route,
    dialogueIntent:info.act,
    domain:info.domain,
    questionType:info.questionType || null,
    confidence:info.score,
    resolvedQuestion:info.effectiveQuestion,
    contextResolved:resolved.resolved,
    recentUserMessages:recentUserMessages(conversation),
    entities:extractEntities(info.effectiveQuestion, conversation),
    topic:topDomain(info.effectiveQuestion, conversation)
  };
}
