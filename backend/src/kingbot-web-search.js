const PROVIDER=String(process.env.KINGBOT_WEB_SEARCH_PROVIDER||"google").trim().toLowerCase();
const API_KEY=String(process.env.GOOGLE_SEARCH_API_KEY||"").trim();
const CX=String(process.env.GOOGLE_SEARCH_CX||"").trim();
const clean=(v,n=600)=>String(v||"").trim().slice(0,n);
export function webSearchStatus(){return {provider:PROVIDER,configured:PROVIDER==="google"&&Boolean(API_KEY&&CX)};}
export async function searchWeb(query,{limit=6}={}){
 const q=clean(query); if(!q)return {ok:false,error:"SEARCH_QUERY_REQUIRED",results:[]};
 if(PROVIDER!=="google")return {ok:false,error:"WEB_SEARCH_PROVIDER_UNSUPPORTED",results:[]};
 if(!API_KEY||!CX)return {ok:false,error:"GOOGLE_SEARCH_NOT_CONFIGURED",results:[],setup:"Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX on the backend."};
 const url=new URL("https://www.googleapis.com/customsearch/v1"); url.searchParams.set("key",API_KEY); url.searchParams.set("cx",CX); url.searchParams.set("q",q); url.searchParams.set("num",String(Math.min(Math.max(Number(limit)||6,1),10)));
 try{ const r=await fetch(url,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(8000)}); const d=await r.json().catch(()=>({})); if(!r.ok)return {ok:false,error:"GOOGLE_SEARCH_FAILED",details:clean(d?.error?.message||r.statusText,220),results:[]}; const results=Array.isArray(d.items)?d.items.map(x=>({title:clean(x.title,240),url:clean(x.link,1000),snippet:clean(x.snippet,700),displayUrl:clean(x.displayLink,240)})):[]; return {ok:true,provider:"google",query:q,total:Number(d.searchInformation?.totalResults||results.length),results}; }
 catch(e){return {ok:false,error:"GOOGLE_SEARCH_UNAVAILABLE",details:clean(e?.message||"Search unavailable",220),results:[]};}
}