/*
 * KINGBOT DIALOGUE CORTEX
 * Native conversational reasoning layer.
 *
 * Purpose:
 * - Understand ordinary human conversation before platform/market routing.
 * - Resolve short follow-ups from recent conversation context.
 * - Respond naturally without an external language model.
 * - Never claim human feelings or capabilities it does not have.
 */

const WORDS = (value) => String(value || "").toLowerCase().trim().replace(/\s+/g, " ");
const lastUserMessages = (conversation=[]) =>
  (Array.isArray(conversation) ? conversation : [])
    .filter(x => String(x?.role || "").toLowerCase() === "user")
    .slice(-4)
    .map(x => WORDS(x?.content))
    .filter(Boolean);

const SOCIAL_PATTERNS = {
  greeting: /^(hi|hello|hey|hey there|yo|hiya|good morning|good afternoon|good evening|howdy|greetings)[!. ,]*$/i,
  wellbeing: /^(how are you|how are u|how are things|how is it going|how's it going|are you good|are you okay|are you ok|you good|you okay|you ok|everything good|doing good|doing well|you doing good|you doing well|are things good|all good|u good)[?! .]*$/i,
  presence: /^(you there|are you there|you online|are you online|are you awake|you awake|can you hear me|can you see me|are you active|still there|still online)[?! .]*$/i,
  appreciation: /^(thanks|thank you|thank u|much appreciated|appreciate it|nice|great|awesome|perfect|cool|good job)[!. ,]*$/i,
  goodbye: /^(bye|goodbye|see you|see ya|talk later|catch you later|good night|have a good night)[!. ,]*$/i,
  capability: /\b(what can you do|what do you do|what are you capable of|your capabilities|what can you help with|how can you help me|what can you help me with)\b/i,
  identity: /\b(who are you|what are you|what is your name|tell me about yourself|introduce yourself)\b/i,
  intelligence: /\b(are you smart|are you intelligent|how intelligent are you|how smart are you|are you an ai|are you artificial intelligence)\b/i,
  emotion_probe: /\b(do you feel|do you have feelings|are you happy|are you sad|do you get tired|do you get bored|do you love|do you care)\b/i
};

function scorePatternMap(text){
  const t=WORDS(text);
  const scores=[];
  for(const [name,re] of Object.entries(SOCIAL_PATTERNS)){
    if(re.test(t)) scores.push(name);
  }
  return scores;
}

function isShortCasual(text){
  const t=WORDS(text);
  const wordCount=t ? t.split(" ").filter(Boolean).length : 0;
  if(wordCount>10) return false;
  return /^(ok|okay|alright|right|sure|yep|yeah|yes|no|nah|hmm|hm|nice|cool|wow|really|exactly|understood|got it|i see|go on|continue)[!.? ]*$/i.test(t);
}

function dialogueIntent(question, conversation=[]){
  const t=WORDS(question);
  const direct=scorePatternMap(t);
  if(direct.length) return direct[0].toUpperCase();

  const history=lastUserMessages(conversation);
  const previous=history.at(-1) || "";
  if(/\b(are you|you|how|what|who)\b/.test(t) && /\b(hello|hi|hey|how are you|are you good|you good)\b/.test(previous)) return "FOLLOW_UP";
  if(isShortCasual(t)) return "CASUAL";
  if(/^\b(what's up|whats up|sup|how goes it)\b[?! .]*$/i.test(t)) return "WELLBEING";
  return null;
}

function chooseVariant(question, conversation=[]){
  const key=(WORDS(question)+"|"+lastUserMessages(conversation).join("|")).length % 3;
  return key;
}

function responseBase({answer,nextAction="Tell me what you want to work on."}={}){
  return {
    answer,
    facts:["Native KINGBOT dialogue cortex handled the request without an external language model."],
    technicalAnalysis:[],
    setup:{
      signal:"NOT_APPLICABLE",
      entry:null,
      waitFor:"No market setup requested.",
      invalidation:"Not applicable."
    },
    riskFlags:[],
    nextAction
  };
}

export function conversationalReply(question="",conversation=[]){
  const t=WORDS(question);
  const mode=dialogueIntent(t,conversation);
  const variant=chooseVariant(t,conversation);

  if(mode==="GREETING"){
    const variants=[
      "Hey! 👋 I'm here and fully online. What are we working on?",
      "Hello! 🤖 KINGBOT is online and ready. Ask me anything about the platform, markets, bots, or strategy.",
      "Hey there. KINGBOT is active. Give me a task and I'll work through it with you."
    ];
    return responseBase({answer:variants[variant],nextAction:"Ask a question, describe a problem, or request live market analysis."});
  }

  if(mode==="WELLBEING" || mode==="FOLLOW_UP"){
    const variants=[
      "Yes — I'm operating normally and ready. I don't experience feelings like a person, but my intelligence services are online and ready to reason through your request.",
      "I'm good on the system side. 🤖 The KINGBOT core is active, and I’m ready for the next question or task.",
      "All good here. KINGBOT is online, listening, and ready to work through whatever you want to solve."
    ];
    return responseBase({answer:variants[variant],nextAction:"Send the next thing you want me to think through."});
  }

  if(mode==="PRESENCE"){
    return responseBase({
      answer:"Yes — I'm here and online. 🤖 Give me the next instruction and I'll pick the appropriate KINGBOT capability.",
      nextAction:"Continue the conversation."
    });
  }

  if(mode==="APPRECIATION"){
    return responseBase({
      answer:["You're welcome. 🤝","Absolutely. 🤖","Glad to help."][variant],
      nextAction:"Keep going — send the next question when you're ready."
    });
  }

  if(mode==="GOODBYE"){
    return responseBase({
      answer:["See you. 👋 KINGBOT will be here when you return.","Take care. 🤖","Understood. See you next time."][variant],
      nextAction:"Conversation ended normally."
    });
  }

  if(mode==="IDENTITY" || mode==="INTELLIGENCE"){
    return responseBase({
      answer:"I'm KINGBOT — the platform's native intelligence layer. I can understand ordinary conversation, reason over verified platform state, work with live market data when available, investigate system conditions, explain strategy logic, and keep a conversation thread in context. My reasoning core is proprietary and deterministic; I do not depend on another AI model for the conversational brain.",
      nextAction:"Ask me a normal question, a technical question, or a live market question."
    });
  }

  if(mode==="CAPABILITY"){
    return responseBase({
      answer:"I can talk normally with you, explain KINGBOT, inspect verified broker/account/runtime state, analyze supported live markets, compare strategy logic, reason through errors, use native multi-pass deliberation, and use web research when that backend capability is configured. I keep execution authority outside chat.",
      nextAction:"Try “analyze XAUUSD”, “why is my bot stopped?”, or “explain SMC PRO”."
    });
  }

  if(mode==="EMOTION_PROBE"){
    return responseBase({
      answer:"I can understand questions about feelings, but I don't experience emotions the way a person does. What I can do is stay consistent, understand your context, and help you work through the problem or conversation.",
      nextAction:"Tell me what you're thinking about."
    });
  }

  if(mode==="CASUAL"){
    return responseBase({
      answer:["Got it. I'm with you.","Yep — I'm following.","Understood. Go ahead."][variant],
      nextAction:"Continue with the next detail."
    });
  }

  return null;
}

export function conversationSignals(question="",conversation=[]){
  return {
    intent: dialogueIntent(question,conversation),
    recentUserMessages:lastUserMessages(conversation),
    conversational:true
  };
}
