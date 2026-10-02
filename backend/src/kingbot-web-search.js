const PROVIDER=String(process.env.KINGBOT_WEB_SEARCH_PROVIDER||"google").trim().toLowerCase();
const API_KEY=String(process.env.GOOGLE_SEARCH_API_KEY||"").trim();
const CX=String(process.env.GOOGLE_SEARCH_CX||"").trim();
const DEFAULT_DAYS=Math.max(0,Number(process.env.GOOGLE_SEARCH_DEFAULT_FRESHNESS_DAYS||0));
const GOOGLE_COUNTRY=String(process.env.GOOGLE_SEARCH_COUNTRY||"ke").trim().toLowerCase();
const GOOGLE_LANGUAGE=String(process.env.GOOGLE_SEARCH_LANGUAGE||"lang_en").trim();
const GOOGLE_SAFE=String(process.env.GOOGLE_SEARCH_SAFE||"active").trim().toLowerCase();

const clean=(v,n=900)=>String(v??"").trim().slice(0,n);
const number=(v,fallback=0)=>Number.isFinite(Number(v))?Number(v):fallback;

function extractDate(item){
 const tags=Array.isArray(item?.pagemap?.metatags)?item.pagemap.metatags:[];
 const meta=tags[0]||{};
 const candidates=[meta["article:published_time"],meta.datePublished,meta.date,meta["og:updated_time"],meta["article:modified_time"]].filter(Boolean);
 const parsed=candidates.map(x=>new Date(x)).find(d=>Number.isFinite(d.getTime()));
 return parsed?parsed.toISOString():null;
}

export function webSearchStatus(){
 return {provider:PROVIDER,configured:PROVIDER==="google"&&Boolean(API_KEY&&CX),engineConfigured:Boolean(CX),apiCredentialConfigured:Boolean(API_KEY),country:GOOGLE_COUNTRY,language:GOOGLE_LANGUAGE,safeSearch:GOOGLE_SAFE};
}

export async function searchWeb(query,{limit=6,freshnessDays=DEFAULT_DAYS,country=GOOGLE_COUNTRY,language=GOOGLE_LANGUAGE,safe=GOOGLE_SAFE}={}){
 const q=clean(query);
 if(!q)return {ok:false,error:"SEARCH_QUERY_REQUIRED",results:[]};
 if(PROVIDER!=="google")return {ok:false,error:"WEB_SEARCH_PROVIDER_UNSUPPORTED",results:[]};
 if(!API_KEY||!CX)return {ok:false,error:"GOOGLE_SEARCH_NOT_CONFIGURED",results:[],setup:"Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX on the backend."};
 const url=new URL("https://www.googleapis.com/customsearch/v1");
 url.searchParams.set("key",API_KEY);
 url.searchParams.set("cx",CX);
 url.searchParams.set("q",q);
 url.searchParams.set("num",String(Math.min(Math.max(Number(limit)||6,1),10)));
 url.searchParams.set("safe",safe==="off"?"off":"active");
 if(country)url.searchParams.set("gl",String(country).slice(0,8));
 if(language)url.searchParams.set("lr",String(language).slice(0,24));
 const days=Math.max(0,Number(freshnessDays)||0);
 if(days>0)url.searchParams.set("dateRestrict","d"+Math.min(days,3650));
 try{
  const r=await fetch(url,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(9000)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)return {ok:false,error:"GOOGLE_SEARCH_FAILED",details:clean(d?.error?.message||r.statusText,300),results:[]};
  const results=Array.isArray(d.items)?d.items.map((x,index)=>({rank:index+1,title:clean(x.title,240),url:clean(x.link,1200),snippet:clean(x.snippet,900),displayUrl:clean(x.displayLink,240),publishedAt:extractDate(x)})):[];
  return {ok:true,provider:"google",query:q,total:number(d.searchInformation?.totalResults,results.length),searchTime:clean(d.searchInformation?.searchTime,40),freshnessDays:days,results};
 }catch(error){
  return {ok:false,error:"GOOGLE_SEARCH_UNAVAILABLE",details:clean(error?.message||"Search unavailable",240),results:[]};
 }
}
