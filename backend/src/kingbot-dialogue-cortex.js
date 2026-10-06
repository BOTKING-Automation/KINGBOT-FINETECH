/*
 * KINGBOT DIALOGUE CORTEX v2
 * Proprietary deterministic language-understanding layer.
 *
 * The module does not generate language with a foundation model.
 * It builds a semantic frame from the user's words + recent conversation:
 * speech act, question type, domain, entities, references, topic continuity,
 * ambiguity and a resolved query for downstream intelligence.
 */

import { normalizeUserLanguage, languageUnderstanding } from "./kingbot-language-understanding.js";

const NORMALIZE = value => normalizeUserLanguage(value).text;
const WORDS = value => NORMALIZE(value).toLowerCase();
const TOKENS = value => WORDS(value).match(/[a-z0-9_+-]+/g) || [];
const unique = xs => [...new Set(xs)];

const DOMAIN_LEXICON = Object.freeze({
  MARKET: ["xauusd","gold","forex","eurusd","gbpusd","usdjpy","btcusd","bitcoin","crypto","market","price","quote","chart","candle","candles","trend","signal","entry","setup","trade","trading","buy","sell","long","short","spread","volatility","liquidity","fvg","order block","market structure"],
  BOT: ["bot","bots","strategy","strategies","engine","flipper","breakout","smc","ladder","runtime","algorithm","automation","backtest"],
  PLATFORM: ["kingbot","platform","dashboard","fintech","page","website","feature","system","app","subscription","pricing","payment","plan","license","api"],
  ACCOUNT: ["account","balance","equity","margin","position","positions","portfolio","broker","connection","connected","mt5","deriv","exness","oanda","wallet"],
  RISK: ["risk","drawdown","exposure","stop","stoploss","sl","take","takeprofit","tp","loss","losses","kill","limit","margin","leverage"],
  RESEARCH: ["research","search","google","news","latest","current","today","headline","source","sources","internet","online","paper","study","documentation"],
  PROGRAMMING: ["code","coding","program","programming","javascript","python","html","css","node","api","database","sql","bug","compile","compiler","deploy","deployment","github","vercel","render"],
  GENERAL: []
});

const ENTITY_PATTERNS = Object.freeze([
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
  ["LADDER_FLIP", /\bladder\b|\bflipper\b/i],
  ["GITHUB", /\bgithub\b/i],
  ["VERCEL", /\bvercel\b/i],
  ["RENDER", /\brender\b/i],
  ["FIREBASE", /\bfirebase\b/i],
  ["SUPABASE", /\bsupabase\b/i],
  ["JAVASCRIPT", /\bjavascript\b|\bjs\b/i],
  ["PYTHON", /\bpython\b/i]
]);

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
  TONE_FEEDBACK: /\b(you are|you're|youre|that was|this is|you sound|you seem)\s+(so )?(rude|cold|harsh|dismissive|unfriendly|impolite|dry|robotic|formal|blunt|mean|short)\b|\b(too rude|too cold|too formal|too robotic|not friendly|not helpful|unhelpful|bad attitude|terrible attitude)\b/i,
  HELP: /\b(i need help|help me|can you help me|i need your help|i don't understand|i dont understand|i'm confused|im confused|can you explain|show me how)\b/i,
  META_FEEDBACK: /^(that makes sense|i understand|i understood|got it|makes sense|i see|exactly|right|okay|ok|alright|sure|yes|yep|yeah|no|nah|hmm|hm)[!.? ]*$/i
});

const REFERENCE_WORDS = /\b(it|this|that|these|those|there|then|now|one|ones|they|them|he|she|its|the same|the previous|that one|this one)\b/i;
const CONTEXT_ONLY = /^(and|but|so|then|now|what about|how about|why|how|which|where|when|what|tell me|explain|continue|go on|what next|next|more|again)[\s!?.,-]*(please)?$/i;

function recentMessages(conversation = []) {
  return (Array.isArray(conversation) ? conversation : [])
    .filter(x => x && ["user","assistant"].includes(String(x.role || "").toLowerCase()))
    .slice(-10)
    .map(x => ({
      role:String(x.role || "user").toLowerCase(),
      content:NORMALIZE(x.content)
    }))
    .filter(x => x.content);
}

function recentUserMessages(conversation = []) {
  return recentMessages(conversation)
    .filter(x => x.role === "user")
    .slice(-6)
    .map(x => x.content);
}

function recentAssistantMessages(conversation = []) {
  return recentMessages(conversation)
    .filter(x => x.role === "assistant")
    .slice(-4)
    .map(x => x.content);
}

function escapedWord(word) {
  return String(word).replace(/[.*+?^()|[\]\\]/g, "\\$&");
}

function domainScores(text) {
  const t=WORDS(text);
  const scores=Object.fromEntries(Object.keys(DOMAIN_LEXICON).map(k=>[k,0]));
  for(const [domain,words] of Object.entries(DOMAIN_LEXICON)){
    for(const word of words){
      if(new RegExp("\\b"+escapedWord(word)+"\\b","i").test(t)){
        scores[domain]+=word.includes(" ") ? 2 : (word.length>5 ? 2 : 1);
      }
    }
  }
  return scores;
}

function rankedDomains(text) {
  return Object.entries(domainScores(text)).sort((a,b)=>b[1]-a[1]);
}

function topCurrentDomain(text) {
  const ranked=rankedDomains(text);
  return ranked[0]?.[1]>0 ? ranked[0][0] : "GENERAL";
}

function topicFromConversation(text,conversation=[]) {
  const currentRanked=rankedDomains(text);
  if(currentRanked[0]?.[1]>0) return currentRanked[0][0];
  const recent=recentUserMessages(conversation);
  const ranked=rankedDomains(recent.join(" "));
  return ranked[0]?.[1]>0 ? ranked[0][0] : "GENERAL";
}

function extractEntities(text,conversation=[]) {
  const combined=[text,...recentUserMessages(conversation).slice(-3)].join(" ");
  return unique(ENTITY_PATTERNS.filter(([,re])=>re.test(combined)).map(([name])=>name));
}

function speechAct(text) {
  const t=WORDS(text);
  for(const [name,re] of Object.entries(SPEECH_ACTS)) if(re.test(t)) return name;
  return null;
}

function questionType(text) {
  const t=WORDS(text);
  if(/\b(why|how come|what caused|reason)\b/i.test(t)) return "WHY";
  if(/\b(how|how do i|how can i|how does)\b/i.test(t)) return "HOW";
  if(/\b(compare|versus|vs\.?|difference|different|which is|which one|pros and cons)\b/i.test(t)) return "COMPARE";
  if(/\b(what|who|where|when|which|explain|define|meaning)\b/i.test(t)) return "WHAT";
  if(/\b(can|could|would|should|is|are|do|does|will|has|have)\b/i.test(t)) return "YES_NO";
  return "STATEMENT";
}

function shortCasual(text) {
  const t=WORDS(text);
  const w=TOKENS(t);
  return w.length<=9 && /^(ok|okay|alright|right|sure|yep|yeah|yes|no|nah|hmm|hm|nice|cool|wow|really|exactly|understood|got it|i see|go on|continue|next|more|again)[!.? ]*$/i.test(t);
}

function needsContext(text) {
  const t=WORDS(text);
  return !t || REFERENCE_WORDS.test(t) || CONTEXT_ONLY.test(t) || TOKENS(t).length<=2;
}

function contextAnchor(conversation=[]) {
  const msgs=recentMessages(conversation);
  const users=msgs.filter(x=>x.role==="user");
  const assistants=msgs.filter(x=>x.role==="assistant");
  const latestUser=users.at(-1)?.content || "";
  const latestAssistant=assistants.at(-1)?.content || "";
  const combined=[latestUser,latestAssistant].join(" ");
  return {
    latestUser,
    latestAssistant,
    domain:topicFromConversation(latestUser,conversation),
    entities:extractEntities(latestUser,conversation),
    conversationMessages:msgs.length,
    anchorText:combined
  };
}

function resolveReference(text,conversation=[]) {
  const original=NORMALIZE(text);
  const anchor=contextAnchor(conversation);
  if(!anchor.latestUser) return {question:original,resolved:false,source:null,domain:"GENERAL",entities:[]};

  const t=WORDS(original);
  if(!needsContext(original)) return {
    question:original,
    resolved:false,
    source:anchor.latestUser,
    domain:topCurrentDomain(original),
    entities:extractEntities(original,[])
  };

  const domain=anchor.domain;
  const entities=anchor.entities;
  const anchorLabel=entities.length ? entities.join(", ") : (domain!=="GENERAL" ? domain.toLowerCase() : "the previous topic");

  // A direct current-domain phrase must win over inherited context.
  const currentDomain=topCurrentDomain(original);
  const currentEntities=extractEntities(original,[]);
  const explicitCurrentDomain=currentDomain!=="GENERAL" && domain!==currentDomain;
  const prefix=explicitCurrentDomain
    ? ""
    : REFERENCE_WORDS.test(t) || CONTEXT_ONLY.test(t) || TOKENS(t).length<=2
      ? "Regarding " + anchorLabel + ", "
      : "";

  return {
    question:prefix ? prefix+original : original,
    resolved:Boolean(prefix),
    source:anchor.latestUser,
    domain:currentDomain!=="GENERAL" && !prefix ? currentDomain : domain,
    entities:currentEntities.length ? currentEntities : entities,
    overlap:TOKENS(original).filter(x=>TOKENS(anchor.latestUser).includes(x))
  };
}

function classify(text,conversation=[]) {
  const t=WORDS(text);
  const direct=speechAct(t);
  const resolved=resolveReference(t,conversation);
  const effective=resolved.question || t;
  const currentRanked=rankedDomains(t);
  const currentDomain=currentRanked[0]?.[1]>0 ? currentRanked[0][0] : null;
  const domain=currentDomain || topicFromConversation(effective,conversation);
  const type=questionType(t);

  if(direct) return {
    act:direct,
    domain,
    questionType:type,
    score:1,
    effectiveQuestion:effective,
    resolved:resolved.resolved
  };

  const act = domain==="RESEARCH" ? "RESEARCH" :
    type==="WHY" || type==="HOW" || type==="WHAT" || type==="COMPARE" || type==="YES_NO" ? "QUESTION" :
    shortCasual(t) ? "CASUAL" : null;

  return {
    act,
    domain,
    questionType:type,
    score:Math.max(0.35,Math.min(0.98,(currentRanked[0]?.[1] || 0)/8)),
    effectiveQuestion:effective,
    resolved:resolved.resolved
  };
}

function routeIntent(text,conversation=[]) {
  const info=classify(text,conversation);
  const t=WORDS(info.effectiveQuestion || text);

  if(["GREETING","WELLBEING","WHAT_IS_UP","PRESENCE","THANKS","GOODBYE","IDENTITY","INTELLIGENCE","CAPABILITY","EMOTION_PROBE","TONE_FEEDBACK","HELP","META_FEEDBACK","CASUAL"].includes(info.act)) return info.act;
  if(info.act==="RESEARCH" || info.domain==="RESEARCH" || /\b(search|google|online research|latest news)\b/i.test(t)) return "RESEARCH";
  if(info.domain==="ACCOUNT") return /\b(broker|connection|connected|mt5|deriv|exness|oanda)\b/i.test(t) ? "CONNECTION" : "ACCOUNT";
  if(info.domain==="RISK") return "RISK";
  if(info.domain==="BOT") return "BOT";
  if(info.domain==="MARKET") return "MARKET";
  if(info.domain==="PROGRAMMING") return "PROGRAMMING";
  if(info.domain==="PLATFORM") return "PLATFORM";
  if(info.act==="QUESTION") return "GENERAL_KNOWLEDGE";
  return "GENERAL";
}

function variantIndex(question,conversation=[]) {
  const seed=(WORDS(question)+"|"+recentUserMessages(conversation).join("|")).split("").reduce((s,c)=>s+c.charCodeAt(0),0);
  return seed%3;
}

function responseBase(answer,nextAction="Tell me what you want to work on.",extra={}) {
  return {
    answer,
    facts:["KINGBOT is using the current request and relevant conversation context to keep the response on topic."],
    technicalAnalysis:[],
    setup:{signal:"NOT_APPLICABLE",entry:null,waitFor:"No market setup requested.",invalidation:"Not applicable."},
    riskFlags:[],
    nextAction,
    ...extra
  };
}

export function conversationalReply(question="",conversation=[]) {
  const understanding=languageUnderstanding(question);
  const info=classify(question,conversation);
  const mode=routeIntent(question,conversation);
  const i=variantIndex(question,conversation);
  const correctionNote=understanding.corrected ? {languageUnderstanding:understanding} : {};

  const respond=(answer,nextAction,extra={})=>responseBase(answer,nextAction,{...extra,...correctionNote});

  if(mode==="WHAT_IS_UP") return respond([
    "I’m online and working normally. 🤖 What do you want to tackle?",
    "All good here. KINGBOT is active. What are we working on?",
    "Nothing dramatic — I’m online and ready. Give me the next task."
  ][i],"Continue with your next question or task.");

  if(mode==="GREETING") return respond([
    "Hey! 👋 I'm here and fully online. What are we working on?",
    "Hello! 🤖 KINGBOT is online and ready. Tell me what you want to work through.",
    "Hey there. KINGBOT is active and listening. What should we tackle?"
  ][i],"Ask a question, describe a problem, or request live market analysis.");

  if(mode==="WELLBEING") return respond([
    "I'm good on the system side. 🤖 The KINGBOT core is active and ready for the next task.",
    "All good here. KINGBOT is online, and I'm ready to reason through whatever you want to solve.",
    "Yes — I'm operating normally and ready. I don't experience feelings like a person, but the intelligence services are online."
  ][i],"Send the next thing you want me to think through.");

  if(mode==="PRESENCE") return respond("Yes — I'm here and online. 🤖 Give me the next instruction and I'll work from there.","Continue the conversation.");

  if(mode==="THANKS") return respond(["You're welcome. 🤝","Glad to help. 🤖","Absolutely."][i],"Continue with the next question or task.");

  if(mode==="GOODBYE") return respond(["See you. 👋","Take care. 🤖","Understood. See you next time."][i],"Conversation ended normally.");

  if(mode==="IDENTITY" || mode==="INTELLIGENCE") return respond(
    "I'm KINGBOT — the platform's native intelligence layer. I understand ordinary language by building a semantic frame from your words and recent conversation, then route the request to the appropriate intelligence subsystem. I can work with verified platform state, supported live markets, strategy logic, risk data and research sources. The core reasoning remains proprietary and deterministic rather than another AI service.",
    "Ask me a normal question, a technical question, or a live market question."
  );

  if(mode==="CAPABILITY") return respond(
    "I can converse naturally, follow the recent topic, resolve references like “it”, “that”, and “now”, answer KINGBOT questions, inspect verified broker/account/runtime state, analyze supported live markets, compare strategies, reason through software problems, and research general or current information when the research service is configured. Chat itself does not authorize trades.",
    "Try “what about now?”, “why is my bot stopped?”, “explain this code”, or “analyze XAUUSD”."
  );

  if(mode==="EMOTION_PROBE") return respond(
    "I can understand questions about emotions, but I don't experience emotions the way a person does. I can still follow your context, keep the conversation coherent, and help you reason through what you want to solve.",
    "Tell me what's on your mind."
  );

  if(mode==="HELP") return respond(
    "Yes. Explain the problem in your own words. I’ll identify the subject, inspect the recent context, determine what kind of help you need, and route it to the relevant KINGBOT capability.",
    "Describe the problem naturally — you don't need a technical command."
  );

  if(mode==="TONE_FEEDBACK") return respond(
    [
      "You're right — that came across too blunt. Sorry about that. I'll keep the conversation more natural and respectful.",
      "I hear you. That response was too cold. Sorry. I'll be more conversational and helpful.",
      "Fair point. I sounded more like a system message than a real assistant. Sorry about that — I'll adjust my tone."
    ][i],
    "Tell me what you want to work on, and I'll meet you there."
  );

  if(mode==="CASUAL" || mode==="META_FEEDBACK") return respond(
    ["Got it — I'm following you.","Understood. I'm with you.","Yep, I follow. Go ahead."][i],
    "Continue with the next detail."
  );

  // Natural compound acknowledgements and open-ended daily check-ins should
  // remain conversational instead of being routed into technical subsystems.
  const casual = WORDS(question);
  if(/^(ok|okay|alright|sure|yes|yep|yeah|cool|nice|good|great)\s+(good|nice|great|then|now|bro|man)[!.? ]*$/i.test(casual)
    || /^(ok|okay|alright|sure|yes|yep|yeah)\s+(i('?m| am)|we('?re| are)|that('?s| is)|all)\b/i.test(casual)) {
    return respond(
      ["Good. 🤖 I'm with you. What's the next move?","Perfect — I'm following you. What should we work on next?","Got you. Let's keep going — what's next?"][i],
      "Continue with the next task."
    );
  }

  if(/^(now|so)\s+(what|whats|what's)\b/i.test(casual)
    || /\bwhat do you have (today|now)\b|\bwhat can we do (today|now)\b|\bwhat are we doing today\b/i.test(casual)) {
    return respond(
      "Today I can help you work through KINGBOT's live market intelligence, platform and broker-state verification, strategy/risk logic, technical-analysis learning, software/debugging tasks, and current research where verified sources are available. I won't invent live data, and chat never authorizes execution. Tell me which area you want to tackle first.",
      "Choose: live market analysis, platform, broker, strategy, risk, coding, or research."
    );
  }

  return null;
}

export function conversationSignals(question="",conversation=[]) {
  const understanding=languageUnderstanding(question);
  const info=classify(question,conversation);
  const route=routeIntent(question,conversation);
  const resolved=resolveReference(question,conversation);
  const anchor=contextAnchor(conversation);
  return {
    conversational:true,
    intent:route,
    dialogueIntent:info.act,
    domain:info.domain,
    questionType:info.questionType,
    confidence:info.score,
    resolvedQuestion:info.effectiveQuestion,
    contextResolved:resolved.resolved,
    recentUserMessages:recentUserMessages(conversation),
    recentAssistantMessages:recentAssistantMessages(conversation),
    entities:extractEntities(info.effectiveQuestion,conversation),
    topic:topicFromConversation(info.effectiveQuestion,conversation),
    languageUnderstanding:understanding,
    contextAnchor:{
      domain:anchor.domain,
      entities:anchor.entities,
      latestUser:anchor.latestUser,
      conversationMessages:anchor.conversationMessages
    }
  };
}

export function conversationFrame(question="",conversation=[]) {
  const signals=conversationSignals(question,conversation);
  const q=WORDS(signals.resolvedQuestion || question);
  const goals=[];
  if(/\b(what|who|where|when|which|define|meaning)\b/i.test(q)) goals.push("UNDERSTAND");
  if(/\b(how|how do i|how can i|steps|setup|configure|fix)\b/i.test(q)) goals.push("SOLVE");
  if(/\b(why|what caused|reason|problem|error|failed|broken)\b/i.test(q)) goals.push("DIAGNOSE");
  if(/\b(compare|versus|vs\.?|difference|which one)\b/i.test(q)) goals.push("COMPARE");
  if(/\b(should|best|choose|recommend|decision)\b/i.test(q)) goals.push("DECIDE");
  if(/\b(check|verify|confirm|real|actual|live|status)\b/i.test(q)) goals.push("VERIFY");
  if(/\b(latest|current|today|now|news|research|search)\b/i.test(q)) goals.push("RESEARCH");

  let responseMode="DIRECT";
  if(goals.includes("SOLVE") || goals.includes("DIAGNOSE")) responseMode="ACTIONABLE";
  else if(goals.includes("COMPARE")) responseMode="COMPARATIVE";
  else if(goals.includes("UNDERSTAND")) responseMode="EXPLANATORY";
  else if(goals.includes("VERIFY") || goals.includes("RESEARCH")) responseMode="EVIDENCE_FIRST";

  return {
    utterance:NORMALIZE(question),
    resolvedUtterance:signals.resolvedQuestion,
    intent:signals.intent,
    domain:signals.domain,
    questionType:signals.questionType,
    entities:signals.entities,
    topic:signals.topic,
    confidence:signals.confidence,
    contextResolved:signals.contextResolved,
    userGoals:[...new Set(goals)],
    responseMode,
    conversationContinuity:{
      priorTurns:signals.recentUserMessages.length + signals.recentAssistantMessages.length,
      priorTopic:signals.topic,
      referenceResolved:signals.contextResolved
    },
    historyDepth:signals.recentUserMessages.length + signals.recentAssistantMessages.length
  };
}
