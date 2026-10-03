import { getBotDefinitions } from "./bot-engines.js";
import { resolveFirebaseUser } from "./auth.js";
import { isAdminEmail } from "./admin-access.js";
import { getGlobalRiskState } from "./global-risk.js";

async function safe(fn,fallback=null){try{return await fn()}catch{return fallback}}

export function registerCommandPlane(app,{pool,broker,twelveData,eventBus}={}){
  if(!app)return;
  app.get("/api/command/snapshot",async(req,res)=>{
    if(!pool||!broker)return res.status(503).json({ok:false,error:"COMMAND_PLANE_UNAVAILABLE"});
    const user=await resolveFirebaseUser(pool,req);
    if(!user||user.admin_blocked)return res.status(401).json({ok:false,error:"AUTHENTICATION_REQUIRED"});
    if(!user.email_verified)return res.status(403).json({ok:false,error:"EMAIL_VERIFICATION_REQUIRED"});
    const startedAt=Date.now();

    const botsPromise=(async()=>{
      const defs=getBotDefinitions();
      const [runtimeRows,selectionRows]=await Promise.all([
        pool.query("SELECT bot_id,state,symbol,timeframe,last_signal,last_run_at,last_error,updated_at FROM kingbot_bot_runtime WHERE user_id=$1",[user.id]),
        pool.query("SELECT selected_bot_id,updated_at FROM kingbot_user_bot_selection WHERE user_id=$1",[user.id])
      ]);
      const runtimeById=new Map(runtimeRows.rows.map(row=>[row.bot_id,row]));
      const selectedId=selectionRows.rows[0]?.selected_bot_id||null;
      return {
        selectedBotId:selectedId,
        selectedAt:selectionRows.rows[0]?.updated_at||null,
        bots:Object.values(defs).map(def=>{
          const row=runtimeById.get(def.id);
          return {botId:def.id,name:def.name,state:row?.state||"STOPPED",symbol:row?.symbol||null,timeframe:row?.timeframe||def.timeframeProfile?.execution||"5m",lastSignal:row?.last_signal||null,lastRunAt:row?.last_run_at||null,lastError:row?.last_error||null,strategies:def.strategies,signalThreshold:def.signalThreshold};
        })
      };
    })();

    const data=await Promise.all([
      safe(()=>broker.getStatus(user.id),{configured:false,connected:false}),
      safe(()=>broker.getAccount(user.id),null),
      safe(()=>broker.getPositions(user.id),{data:[]}),
      safe(()=>pool.query("SELECT plan_id,status,expires_at FROM kingbot_subscriptions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",[user.id]).then(q=>q.rows[0]||null),null),
      safe(()=>getGlobalRiskState(pool),{tradingPaused:false,globalKillSwitch:false,reason:null,updatedAt:null}),
      safe(()=>botsPromise,{selectedBotId:null,bots:[]}),
      safe(()=>twelveData?.latestQuotes?.(["XAUUSD","EURUSD","GBPUSD","BTCUSD"]),[]),
    ]);

    const [brokerStatus,accountResult,positionsResult,subscription,risk,bots,quotes]=data;
    const raw=accountResult?.data||accountResult||null;
    const positions=Array.isArray(positionsResult?.data)?positionsResult.data:Array.isArray(positionsResult)?positionsResult:[];
    const balance=Number(raw?.balance),equity=Number(raw?.equity);
    const eventState=eventBus?.status?.()||null;
    res.json({
      ok:true,
      generatedAt:new Date().toISOString(),
      latencyMs:Math.max(0,Date.now()-startedAt),
      user:{id:user.id,email:user.email,name:[user.first_name,user.last_name].filter(Boolean).join(" ")||"KINGBOT User",admin:isAdminEmail(user.email)},
      broker:brokerStatus,
      account:raw?{accountId:raw.accountId||raw.login||null,currency:raw.currency||null,balance:Number.isFinite(balance)?balance:null,equity:Number.isFinite(equity)?equity:null,positionCount:positions.length,tradingEnabled:raw.tradeAllowed!==false&&raw.tradingEnabled!==false}:null,
      positionsCount:positions.length,
      subscription,
      risk:{
        tradingPaused:Boolean(risk?.tradingPaused),
        globalKillSwitch:Boolean(risk?.globalKillSwitch),
        newOrdersAuthorized:!risk?.tradingPaused&&!risk?.globalKillSwitch,
        reason:risk?.reason||null,
        updatedAt:risk?.updatedAt||null
      },
      bots,
      marketQuotes:Array.isArray(quotes)?quotes.slice(0,8):[],
      eventBus:eventState
    });
  });
}
