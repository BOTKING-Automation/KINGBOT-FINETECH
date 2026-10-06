/*
 * KINGBOT LANGUAGE UNDERSTANDING v1
 * Lightweight, deterministic normalization for support conversations.
 *
 * Goal: understand common spelling mistakes, omitted vowels, repeated letters,
 * chat shorthand and KINGBOT-specific terminology without rewriting the user's
 * visible message or pretending to perform general-purpose spell checking.
 */

const DIRECT = Object.freeze({
  helo:"hello", helllo:"hello", hlelo:"hello", hllo:"hello",
  plese:"please", ples:"please", thx:"thanks", thnx:"thanks",
  wat:"what", wht:"what", wha:"what", hwo:"how", hw:"how",
  whr:"where", wen:"when", y:"why", wy:"why",
  u:"you", ur:"your", yr:"your", r:"are", im:"i'm", ive:"i've",
  cant:"can't", dont:"don't", doesnt:"doesn't", isnt:"isn't",
  wont:"won't", didnt:"didn't", idk:"i don't know",
  conect:"connect", connet:"connect", connct:"connect", conected:"connected",
  disconect:"disconnect", disconected:"disconnected",
  borker:"broker", brokr:"broker", brker:"broker",
  dashbord:"dashboard", dashboad:"dashboard", dashbordd:"dashboard",
  acount:"account", accunt:"account", accout:"account",
  passwrd:"password", pasword:"password", paswordd:"password",
  tradding:"trading", tradng:"trading", tradin:"trading", tradig:"trading",
  tradde:"trade", trde:"trade", trdes:"trades",
  bot:"bot", bots:"bots", stratgy:"strategy", strtegy:"strategy",
  strategys:"strategies", strategey:"strategy",
  signl:"signal", singal:"signal", sigal:"signal", siganl:"signal",
  maket:"market", mrket:"market", marcket:"market",
  analyis:"analysis", analisis:"analysis", anlysis:"analysis",
  techniqal:"technical", tehnical:"technical",
  suport:"support", suppport:"support", suportt:"support",
  problm:"problem", probelm:"problem", prolem:"problem",
  eror:"error", erro:"error", erorr:"error",
  paymnt:"payment", paymet:"payment", pament:"payment",
  subscrption:"subscription", subsription:"subscription", subscribtion:"subscription",
  conecting:"connecting", connnecting:"connecting",
  explane:"explain", explan:"explain", expalin:"explain",
  workng:"working", wokring:"working", wrking:"working",
  runing:"running", runnng:"running", stoped:"stopped",
  instal:"install", inatall:"install", setup:"setup",
  prce:"price", pirce:"price", quoute:"quote", qoute:"quote",
  signal:"signal", entry:"entry", sl:"sl", tp:"tp",
  gold:"gold", xau:"xau", xauusd:"xauusd", eurusd:"eurusd",
  gbpusd:"gbpusd", usdjpy:"usdjpy", btcusd:"btcusd",
  kingbot:"kingbot", fintech:"fintech"
});

const VOCABULARY = Object.freeze([
  "hello","please","thanks","what","how","where","when","why","you","your",
  "connect","connected","disconnect","disconnected","broker","dashboard",
  "account","password","trading","trade","trades","strategy","strategies",
  "signal","market","analysis","technical","support","problem","error",
  "payment","subscription","connecting","explain","working","running",
  "stopped","install","setup","price","quote","gold","xauusd","eurusd",
  "gbpusd","usdjpy","btcusd","kingbot","fintech","bot","bots","help",
  "login","signup","withdraw","deposit","risk","drawdown","execution",
  "scanner","entry","reason","wait","waitfor","platform","website"
]);

function distance(a,b){
  const x=String(a), y=String(b);
  if(x===y) return 0;
  if(!x.length) return y.length;
  if(!y.length) return x.length;
  let prev=Array.from({length:y.length+1},(_,i)=>i);
  for(let i=1;i<=x.length;i++){
    const cur=[i];
    for(let j=1;j<=y.length;j++){
      const cost=x[i-1]===y[j-1]?0:1;
      cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+cost);
    }
    prev=cur;
  }
  return prev[y.length];
}

function fuzzyCandidate(token){
  const word=String(token||"").toLowerCase();
  if(word.length<4 || word.length>18) return null;
  let best=null;
  for(const candidate of VOCABULARY){
    if(Math.abs(candidate.length-word.length)>2) continue;
    const d=distance(word,candidate);
    const maxDistance=word.length<=5?1:2;
    if(d<=maxDistance && (!best || d<best.distance || (d===best.distance && candidate.length<best.candidate.length))){
      best={candidate,distance:d};
    }
  }
  return best;
}

function preserveCase(original,replacement){
  if(original===original.toUpperCase()) return replacement.toUpperCase();
  if(original[0]===original[0]?.toUpperCase()) return replacement.charAt(0).toUpperCase()+replacement.slice(1);
  return replacement;
}

export function normalizeUserLanguage(input=""){
  const original=String(input??"").replace(/\s+/g," ").trim();
  const corrections=[];
  const normalized=original.replace(/\b[A-Za-z][A-Za-z0-9_'-]*\b/g, token=>{
    const lower=token.toLowerCase();
    const direct=DIRECT[lower];
    if(direct){
      const replacement=preserveCase(token,direct);
      if(replacement.toLowerCase()!==lower) corrections.push({from:token,to:replacement,method:"dictionary"});
      return replacement;
    }
    const fuzzy=fuzzyCandidate(lower);
    if(!fuzzy || fuzzy.candidate===lower) return token;
    // Only apply fuzzy correction when it is a high-confidence short edit.
    // This deliberately avoids aggressive rewriting of unknown names, code and symbols.
    const confidence=1-(fuzzy.distance/Math.max(lower.length,fuzzy.candidate.length));
    if(confidence<0.72) return token;
    const replacement=preserveCase(token,fuzzy.candidate);
    corrections.push({from:token,to:replacement,method:"fuzzy",confidence:Number(confidence.toFixed(2))});
    return replacement;
  });
  return {
    original,
    text:normalized,
    changed:normalized!==original,
    corrections,
    confidence:corrections.length
      ? Number((corrections.reduce((sum,c)=>sum+Number(c.confidence||0.99),0)/corrections.length).toFixed(2))
      : 1
  };
}

export function languageUnderstanding(input=""){
  const result=normalizeUserLanguage(input);
  return {
    understoodText:result.text,
    originalText:result.original,
    corrected:result.changed,
    correctionCount:result.corrections.length,
    corrections:result.corrections.slice(0,12),
    confidence:result.confidence
  };
}
