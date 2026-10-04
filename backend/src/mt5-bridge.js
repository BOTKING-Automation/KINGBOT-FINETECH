import crypto from "node:crypto";

const LIVE_WINDOW_MS=6500;
const COMMAND_TIMEOUT_MS=12000;
export const TOKEN_TTL_DAYS=90;

function hashToken(token){
  return crypto.createHash("sha256").update(String(token||""),"utf8").digest("hex");
}
function clean(value,max=200){return String(value??"").trim().slice(0,max);}
function modeOf(value){const mode=String(value||"DEMO").toUpperCase();return mode==="LIVE"?"LIVE":"DEMO";}
function displayMode(value){return modeOf(value)==="LIVE"?"LIVE":"DEMO";}
function terminalTypeOf(value){
  const raw=String(value||"").toUpperCase();
  if(raw==="REAL"||raw==="ACCOUNT_TRADE_MODE_REAL")return "REAL";
  return "DEMO";
}
function timeMs(value){
  const n=Number(value);
  if(Number.isFinite(n))return n>10000000000?n:n*1000;
  const d=new Date(String(value||""));
  return Number.isFinite(d.getTime())?d.getTime():null;
}

export class Mt5BridgeRegistry{
  constructor({pool}={}){this.pool=pool;this.sessions=new Map();this.pending=new Map();this.completed=new Map();}
  async ensureSchema(pool=this.pool){
    if(pool)this.pool=pool;
    if(!this.pool)return;
    await this.pool.query(`CREATE TABLE IF NOT EXISTS kingbot_mt5_bridge_tokens(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT 'KINGBOT MT5 Bridge',
      expected_mode TEXT NOT NULL DEFAULT 'DEMO' CHECK(expected_mode IN ('DEMO','LIVE')),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ,
      mt5_login TEXT,
      mt5_server TEXT,
      account_type TEXT,
      last_state JSONB,
      last_state_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await this.pool.query("ALTER TABLE kingbot_mt5_bridge_tokens DROP CONSTRAINT IF EXISTS kingbot_mt5_bridge_tokens_expected_mode_check");
    await this.pool.query("UPDATE kingbot_mt5_bridge_tokens SET expected_mode='DEMO' WHERE expected_mode='PAPER'");
    await this.pool.query("ALTER TABLE kingbot_mt5_bridge_tokens ADD CONSTRAINT kingbot_mt5_bridge_tokens_expected_mode_check CHECK(expected_mode IN ('DEMO','LIVE'))");
    await this.pool.query("ALTER TABLE kingbot_mt5_bridge_tokens DROP CONSTRAINT IF EXISTS kingbot_mt5_bridge_tokens_expected_mode_check");
    await this.pool.query("ALTER TABLE kingbot_mt5_bridge_tokens ADD CONSTRAINT kingbot_mt5_bridge_tokens_expected_mode_check CHECK(expected_mode IN ('DEMO','LIVE'))");
    await this.pool.query("CREATE INDEX IF NOT EXISTS kingbot_mt5_bridge_tokens_user_idx ON kingbot_mt5_bridge_tokens(user_id,revoked,expires_at)");
    await this.pool.query("ALTER TABLE kingbot_mt5_bridge_tokens ADD COLUMN IF NOT EXISTS last_state JSONB");
    await this.pool.query("ALTER TABLE kingbot_mt5_bridge_tokens ADD COLUMN IF NOT EXISTS last_state_at TIMESTAMPTZ");
    await this.pool.query("CREATE INDEX IF NOT EXISTS kingbot_mt5_bridge_tokens_seen_idx ON kingbot_mt5_bridge_tokens(last_seen_at)");
  }
  async issueToken({userId,mode="DEMO",label="KINGBOT MT5 Bridge"}={}){
    if(!this.pool||!userId)throw new Error("USER_CONTEXT_REQUIRED");
    const expected=modeOf(mode);
    const active=await this.pool.query("SELECT provider FROM kingbot_broker_accounts WHERE user_id=$1 AND enabled=TRUE ORDER BY updated_at DESC LIMIT 1",[userId]);
    if(active.rowCount&&String(active.rows[0].provider).toLowerCase()!=="mt5-bridge")throw new Error("BROKER_ALREADY_CONNECTED");
    await this.pool.query("UPDATE kingbot_mt5_bridge_tokens SET revoked=TRUE,updated_at=NOW() WHERE user_id=$1 AND revoked=FALSE",[userId]);
    const token=crypto.randomBytes(32).toString("base64url");
    const q=await this.pool.query(
      "INSERT INTO kingbot_mt5_bridge_tokens(user_id,token_hash,label,expected_mode,expires_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '"+TOKEN_TTL_DAYS+" days') RETURNING id,expected_mode,expires_at",
      [userId,hashToken(token),clean(label,100),expected]
    );
    return {ok:true,token,tokenId:q.rows[0].id,expectedMode:expected,displayMode:displayMode(expected),expiresAt:q.rows[0].expires_at,
      endpoint:(String(process.env.PUBLIC_API_ORIGIN||"").replace(/\/$/,"")||null)};
  }
  async revokeUserTokens(userId){
    if(!this.pool||!userId)return;
    await this.pool.query("UPDATE kingbot_mt5_bridge_tokens SET revoked=TRUE,updated_at=NOW() WHERE user_id=$1 AND revoked=FALSE",[userId]);
    for(const [key,s] of this.sessions){if(s.userId===userId)this.sessions.delete(key);}
  }
  async revokeToken({userId,tokenId}={}){
    if(!this.pool||!userId)return {ok:false,error:"USER_CONTEXT_REQUIRED"};
    const q=await this.pool.query(
      "UPDATE kingbot_mt5_bridge_tokens SET revoked=TRUE,updated_at=NOW() WHERE user_id=$1 AND ($2::text='' OR id::text=$2) AND revoked=FALSE RETURNING id",
      [userId,String(tokenId||"")]
    );
    if(q.rowCount)for(const [key,s] of this.sessions){if(s.userId===userId)this.sessions.delete(key);}
    return {ok:true,revoked:q.rowCount>0};
  }
  async authenticate(token){
    const raw=String(token||"").trim();
    if(!this.pool||raw.length<24)return null;
    const q=await this.pool.query(
      "SELECT id,user_id,token_hash,label,expected_mode,expires_at,revoked,mt5_login,mt5_server,account_type,last_state,last_state_at FROM kingbot_mt5_bridge_tokens WHERE token_hash=$1 LIMIT 1",
      [hashToken(raw)]
    );
    if(!q.rowCount)return null;
    const row=q.rows[0];
    if(row.revoked||new Date(row.expires_at).getTime()<=Date.now())return null;
    return row;
  }
  isSessionLive(session){return Boolean(session&&session.lastSeenAt&&Date.now()-session.lastSeenAt<LIVE_WINDOW_MS);}
  getSessionByUser(userId){
    let latest=null;
    for(const s of this.sessions.values())if(s.userId===userId&&(!latest||s.lastSeenAt>latest.lastSeenAt))latest=s;
    return latest;
  }
  getState(userId){const s=this.getSessionByUser(userId);return s&&this.isSessionLive(s)?s:null;}
  async restoreSessionFromDb(userId){
    if(!this.pool||!userId)return null;
    const q=await this.pool.query(
      "SELECT id,user_id,token_hash,expected_mode,expires_at,revoked,mt5_login,mt5_server,account_type,last_seen_at,last_state,last_state_at FROM kingbot_mt5_bridge_tokens WHERE user_id=$1 AND revoked=FALSE AND expires_at>NOW() AND last_seen_at IS NOT NULL AND last_seen_at>=NOW()-INTERVAL '7 seconds' ORDER BY last_seen_at DESC LIMIT 1",
      [userId]
    );
    if(!q.rowCount)return null;
    const row=q.rows[0],lastSeen= new Date(row.last_seen_at).getTime();
    if(!Number.isFinite(lastSeen)||Date.now()-lastSeen>=LIVE_WINDOW_MS||!row.last_state)return null;
    let state={};
    try{state=typeof row.last_state==="string"?JSON.parse(row.last_state):row.last_state||{};}catch{return null;}
    const session={
      tokenHash:row.token_hash,userId:row.user_id,tokenId:row.id,
      login:clean(row.mt5_login,64),server:clean(row.mt5_server,120),
      accountType:terminalTypeOf(row.account_type),mode:modeOf(row.expected_mode),
      state,lastSeenAt:lastSeen,connectedAt:lastSeen,restoredAt:Date.now()
    };
    this.sessions.set(row.token_hash,session);
    return session;
  }
  async getStateAsync(userId){
    const current=this.getState(userId);
    if(current)return current;
    return await this.restoreSessionFromDb(userId);
  }
  async waitConnected(userId,timeoutMs=5000){
    const deadline=Date.now()+timeoutMs;
    do{
      const s=await this.getStateAsync(userId);
      if(s)return true;
      if(Date.now()>=deadline)break;
      await new Promise(r=>setTimeout(r,250));
    }while(Date.now()<deadline);
    return Boolean(await this.getStateAsync(userId));
  }

  async acceptPoll({token,login,server,accountType,state}={}){
    const row=await this.authenticate(token);
    if(!row)return {ok:false,status:401,error:"MT5_BRIDGE_TOKEN_INVALID_OR_EXPIRED"};
    const terminalMode=terminalTypeOf(accountType),expected=modeOf(row.expected_mode);
    if((expected==="LIVE"&&terminalMode!=="REAL")||(expected==="DEMO"&&terminalMode!=="DEMO"))
      return {ok:false,status:409,error:"MT5_ACCOUNT_MODE_MISMATCH",expectedMode:expected,terminalAccountType:terminalMode};
    const mt5Login=clean(login,64),mt5Server=clean(server,120);
    if(!/^\d+$/.test(mt5Login))return {ok:false,status:400,error:"MT5_LOGIN_REQUIRED"};
    const active=await this.pool.query("SELECT provider,account_id,execution_mode FROM kingbot_broker_accounts WHERE user_id=$1 AND enabled=TRUE ORDER BY updated_at DESC LIMIT 1",[row.user_id]);
    const activeProvider=active.rowCount?String(active.rows[0].provider||"").toLowerCase():"";
    const legacyDerivSwitch=activeProvider==="deriv";
    if(active.rowCount&&activeProvider!=="mt5-bridge"&&activeProvider!=="deriv")
      return {ok:false,status:409,error:"BROKER_ALREADY_CONNECTED"};
    if(active.rowCount&&String(active.rows[0].account_id)!==mt5Login)
      return {ok:false,status:409,error:"MT5_BRIDGE_ACCOUNT_MISMATCH"};
    const key=row.token_hash;
    const previous=this.sessions.get(key)||{};
    const incomingState=state&&typeof state==="object"?state:{};
    let mergedState={...(previous.state||{}),...incomingState};
    if(incomingState.history && previous.state?.history){
      const incomingHasDeals=Array.isArray(incomingState.history.deals)&&incomingState.history.deals.length>0;
      const incomingHasOrders=Array.isArray(incomingState.history.orders)&&incomingState.history.orders.length>0;
      if(!incomingHasDeals&&!incomingHasOrders) mergedState.history=previous.state.history;
    }
    const session={...previous,tokenHash:key,userId:row.user_id,tokenId:row.id,login:mt5Login,server:mt5Server,
      accountType:terminalMode,mode:expected,state:mergedState,lastSeenAt:Date.now(),connectedAt:previous.connectedAt||Date.now()};
    this.sessions.set(key,session);
    const persistedState={
      account:incomingState.account&&typeof incomingState.account==="object"?incomingState.account:null,
      positions:Array.isArray(incomingState.positions)?incomingState.positions:[],
      orders:Array.isArray(incomingState.orders)?incomingState.orders:[],
      quotes:incomingState.quotes&&typeof incomingState.quotes==="object"?incomingState.quotes:{},
      specs:incomingState.specs&&typeof incomingState.specs==="object"?incomingState.specs:{},
      symbols:Array.isArray(incomingState.symbols)?incomingState.symbols:[]
    };
    const shouldPersistState=!row.last_state_at || Date.now()-new Date(row.last_state_at).getTime()>=3000;
    if(shouldPersistState){
      await this.pool.query(
        "UPDATE kingbot_mt5_bridge_tokens SET last_seen_at=NOW(),mt5_login=$2,mt5_server=$3,account_type=$4,last_state=$5::jsonb,last_state_at=NOW(),updated_at=NOW() WHERE id=$1",
        [row.id,mt5Login,mt5Server,terminalMode,JSON.stringify(persistedState)]
      );
    }else{
      await this.pool.query(
        "UPDATE kingbot_mt5_bridge_tokens SET last_seen_at=NOW(),mt5_login=$2,mt5_server=$3,account_type=$4 WHERE id=$1",
        [row.id,mt5Login,mt5Server,terminalMode]
      );
    }
    if(!active.rowCount){
      return {ok:true,needsMapping:true,userId:row.user_id,tokenId:row.id,login:mt5Login,server:mt5Server,accountType:terminalMode,mode:expected,displayMode:displayMode(expected),connected:true};
    }
    const response={ok:true,userId:row.user_id,tokenId:row.id,login:mt5Login,server:mt5Server,accountType:terminalMode,mode:expected,displayMode:displayMode(expected),connected:true};
    if(legacyDerivSwitch)response.migrateFrom="deriv";
    return response;
  }

  async queueCommand({userId,command}={}){
    const session=await this.getStateAsync(userId);
    if(!session)throw new Error("MT5_BRIDGE_OFFLINE");
    const commandId=clean(command?.commandId||crypto.randomUUID(),100);
    const existing=this.pending.get(commandId)||this.completed.get(commandId);
    if(existing)return existing.promise||Promise.resolve(existing.result);
    const item={commandId,userId:session.userId,tokenHash:session.tokenHash,command:{...command,commandId},createdAt:Date.now(),expiresAt:Date.now()+COMMAND_TIMEOUT_MS,resolved:false,result:null};
    item.promise=new Promise((resolve,reject)=>{item.resolve=resolve;item.reject=reject;});
    this.pending.set(commandId,item);
    return item.promise;
  }
  getCommandForToken(tokenHash){
    for(const item of this.pending.values())if(item.tokenHash===tokenHash&&!item.resolved&&item.expiresAt>Date.now())return item;
    for(const [id,item] of this.pending.entries())if(item.expiresAt<=Date.now()&&!item.resolved)this.failCommand(id,"MT5_BRIDGE_COMMAND_TIMEOUT");
    return null;
  }
  resolveCommand(commandId,result){
    const id=clean(commandId,100),item=this.pending.get(id);
    if(!item)return {ok:false,error:"MT5_BRIDGE_COMMAND_NOT_FOUND"};
    item.resolved=true;item.result=result;this.pending.delete(id);this.completed.set(id,{result,completedAt:Date.now()});
    if(this.completed.size>500)this.completed.delete(this.completed.keys().next().value);
    if(result?.status==="REJECTED")item.reject(new Error(String(result?.message||"MT5_BRIDGE_ORDER_REJECTED")));else item.resolve(result);
    return {ok:true,result};
  }
  failCommand(commandId,message){
    const id=clean(commandId,100),item=this.pending.get(id);if(!item)return;
    item.resolved=true;item.result={status:"REJECTED",commandId:id,message:clean(message,300)};this.pending.delete(id);item.reject(new Error(item.result.message));
  }
  async poll({token,login,server,accountType,state}={}){
    const auth=await this.authenticate(token);
    if(!auth)return {ok:false,status:401,error:"MT5_BRIDGE_TOKEN_INVALID_OR_EXPIRED"};
    const accepted=await this.acceptPoll({token,login,server,accountType,state});
    if(!accepted.ok)return accepted;
    const session=this.sessions.get(auth.token_hash),command=this.getCommandForToken(auth.token_hash);
    return {ok:true,connected:true,serverTime:new Date().toISOString(),session:{login:session.login,server:session.server,accountType:session.accountType,mode:session.mode,displayMode:displayMode(session.mode)},command:command?.command||null};
  }
  async ack({token,commandId,status,result,message}={}){
    const auth=await this.authenticate(token);
    if(!auth)return {ok:false,status:401,error:"MT5_BRIDGE_TOKEN_INVALID_OR_EXPIRED"};
    const item=this.pending.get(clean(commandId,100));
    if(!item||item.tokenHash!==auth.token_hash)return {ok:false,status:404,error:"MT5_BRIDGE_COMMAND_NOT_FOUND"};
    return this.resolveCommand(item.commandId,{commandId:item.commandId,status:String(status||"REJECTED").toUpperCase()==="FILLED"?"FILLED":"REJECTED",
      message:clean(message||result?.message||"",300),result:result&&typeof result==="object"?result:{},acknowledgedAt:new Date().toISOString()});
  }
  async statusForUser(userId){
    const session=await this.getStateAsync(userId);
    if(!session)return {connected:false,configured:false,broker:"mt5-bridge",reason:"MT5_BRIDGE_OFFLINE"};
    const mapping=await this.pool.query("SELECT account_id,execution_mode FROM kingbot_broker_accounts WHERE user_id=$1 AND enabled=TRUE AND provider='mt5-bridge' ORDER BY updated_at DESC LIMIT 1",[userId]);
    const state=session.state||{};
    return {connected:true,configured:mapping.rowCount>0,broker:"mt5-bridge",accountId:mapping.rows[0]?.account_id||session.login,
      executionMode:mapping.rows[0]?.execution_mode||session.mode,displayExecutionMode:displayMode(mapping.rows[0]?.execution_mode||session.mode),accountType:session.accountType,login:session.login,server:session.server,
      lastSeenAt:new Date(session.lastSeenAt).toISOString(),latencyMs:Math.max(0,Date.now()-session.lastSeenAt),
      account:state.account||null,positions:Array.isArray(state.positions)?state.positions:[],orders:Array.isArray(state.orders)?state.orders:[],
      quotes:state.quotes&&typeof state.quotes==="object"?state.quotes:{},specs:state.specs&&typeof state.specs==="object"?state.specs:{},
      history:state.history&&typeof state.history==="object"?state.history:{}};
  }
}

export class Mt5BridgeConnection{
  constructor({registry,token,userId}={}){this.registry=registry;this.token=String(token||"").trim();this.userId=userId;this.provider="mt5-bridge";this.ownerUserId=userId;}
  get connected(){return Boolean(this.registry.getState(this.userId));}
  async waitConnected(timeoutMs=5000){return await this.registry.waitConnected(this.userId,timeoutMs);}
  async close(){return true;}
  async getAccountInformation(){const s=await this.registry.getStateAsync(this.userId);if(!s)throw new Error("MT5_BRIDGE_OFFLINE");return s.state.account||{};}
  async getPositions(){return (await this.registry.getStateAsync(this.userId))?.state?.positions||[];}
  async getOrders(){return (await this.registry.getStateAsync(this.userId))?.state?.orders||[];}
  async getHistoryOrdersByTimeRange(start,end){const rows=(await this.registry.getStateAsync(this.userId))?.state?.history?.orders||[];return rows.filter(r=>{const t=timeMs(r?.time||r?.timestamp);return !t||(t>=start.getTime()&&t<=end.getTime());});}
  async getDealsByTimeRange(start,end){const rows=(await this.registry.getStateAsync(this.userId))?.state?.history?.deals||[];return rows.filter(r=>{const t=timeMs(r?.time||r?.timestamp);return !t||(t>=start.getTime()&&t<=end.getTime());});}
  async getSymbolPrice(symbol){
    const s=await this.registry.getStateAsync(this.userId);if(!s)throw new Error("MT5_BRIDGE_OFFLINE");
    const wanted=String(symbol||"").toUpperCase(),quotes=s.state.quotes||{};
    for(const [key,value] of Object.entries(quotes))if(String(key).toUpperCase()===wanted)return value;
    if(s.state.quote&&String(s.state.quote.symbol||"").toUpperCase()===wanted)return s.state.quote;
    throw new Error("MT5_QUOTE_UNAVAILABLE:"+wanted);
  }
  async getSymbols(){const s=await this.registry.getStateAsync(this.userId);return Array.isArray(s?.state?.symbols)?s.state.symbols:[];}
  async getMarketCatalog(){
    const session=await this.registry.getStateAsync(this.userId);
    if(!session)throw new Error("MT5_BRIDGE_OFFLINE");
    const state=session.state||{},out=[],seen=new Set();
    const add=(rawSymbol,meta={})=>{
      const symbol=String(rawSymbol||"").trim().toUpperCase();
      if(!symbol||seen.has(symbol))return;
      seen.add(symbol);
      const spec=state.specs&&typeof state.specs==="object"
        ? Object.entries(state.specs).find(([key])=>String(key).toUpperCase()===symbol)?.[1]
        : null;
      const quote=state.quotes&&typeof state.quotes==="object"
        ? Object.entries(state.quotes).find(([key])=>String(key).toUpperCase()===symbol)?.[1]
        : null;
      const m=meta&&typeof meta==="object"?meta:{};
      const tradeMode=m.tradeMode!==undefined?Number(m.tradeMode):spec?.tradeMode;
      const tradeable=typeof m.tradeable==="boolean"
        ? m.tradeable
        : typeof spec?.tradeable==="boolean"
          ? spec.tradeable
          : tradeMode!==undefined&&Number.isFinite(tradeMode)
            ? tradeMode!==0
            : null;
      out.push({...m,symbol,name:String(m.name||spec?.name||spec?.description||quote?.symbol||symbol).trim(),
        description:String(m.description||spec?.description||"").trim(),
        category:String(m.category||"CFD"),submarket:String(m.submarket||m.path||"").trim(),
        tradeable,minVolume:Number(m.minVolume??spec?.minVolume)||null,maxVolume:Number(m.maxVolume??spec?.maxVolume)||null,
        volumeStep:Number(m.volumeStep??spec?.volumeStep)||null,digits:Number(m.digits??spec?.digits)||null,
        point:Number(m.point??spec?.point)||null,tickSize:Number(m.tickSize??spec?.tickSize)||null,
        tickValue:Number(m.tickValue??spec?.tickValue)||null,stopsLevel:Number(m.stopsLevel??spec?.stopsLevel)||0,
        contractSize:Number(m.contractSize??spec?.contractSize)||null,source:String(m.source||"mt5-ea-bridge")});
    };
    const symbols=Array.isArray(state.symbols)?state.symbols:[];
    for(const item of symbols){if(typeof item==="string")add(item);else add(item?.symbol,item||{});}
    if(state.specs&&typeof state.specs==="object")for(const [symbol,spec] of Object.entries(state.specs))add(symbol,spec&&typeof spec==="object"?spec:{});
    if(state.quotes&&typeof state.quotes==="object")for(const [symbol,quote] of Object.entries(state.quotes))add(symbol,{...(quote&&typeof quote==="object"?quote:{}),name:String(quote?.symbol||symbol),source:"mt5-ea-bridge-quote"});
    return out;
  }
  async getSymbolSpecification(symbol){
    const s=await this.registry.getStateAsync(this.userId);if(!s)throw new Error("MT5_BRIDGE_OFFLINE");
    const wanted=String(symbol||"").toUpperCase(),specs=s.state.specs||{};
    for(const [key,value] of Object.entries(specs))if(String(key).toUpperCase()===wanted)return value;
    throw new Error("MT5_SYMBOL_NOT_AVAILABLE:"+wanted);
  }
  async getHistoricalCandles(symbol,timeframe,limit=100){
    const result=await this.registry.queueCommand({
      userId:this.userId,
      command:{type:"GET_CANDLES",symbol:String(symbol||"").toUpperCase(),timeframe:String(timeframe||"5m"),limit:Math.max(10,Math.min(1000,Number(limit)||100))}
    });
    if(result?.status!=="FILLED")throw new Error(String(result?.message||"MT5_CANDLE_REQUEST_REJECTED"));
    return Array.isArray(result?.result?.candles)?result.result.candles:[];
  }
  async modifyPosition(id,stopLoss,takeProfit){return this.registry.queueCommand({userId:this.userId,command:{type:"MODIFY_POSITION",positionId:String(id),stopLoss:Number(stopLoss)||0,takeProfit:Number(takeProfit)||0}});}
  async closePosition(id){return this.registry.queueCommand({userId:this.userId,command:{type:"CLOSE_POSITION",positionId:String(id)}});}
  async createMarketBuyOrder(symbol,volume,stopLoss,takeProfit,options={}){return this.registry.queueCommand({userId:this.userId,command:{type:"OPEN_POSITION",side:"BUY",symbol:String(symbol).toUpperCase(),volume:Number(volume),stopLoss:Number(stopLoss)||0,takeProfit:Number(takeProfit)||0,comment:clean(options?.comment||"KINGBOT",100),clientId:clean(options?.clientId||crypto.randomUUID(),100)}});}
  async createMarketSellOrder(symbol,volume,stopLoss,takeProfit,options={}){return this.registry.queueCommand({userId:this.userId,command:{type:"OPEN_POSITION",side:"SELL",symbol:String(symbol).toUpperCase(),volume:Number(volume),stopLoss:Number(stopLoss)||0,takeProfit:Number(takeProfit)||0,comment:clean(options?.comment||"KINGBOT",100),clientId:clean(options?.clientId||crypto.randomUUID(),100)}});}
  async getAccount(){return {connected:true,data:await this.getAccountInformation()};}
  async getLivePositions(){return {connected:true,data:await this.getPositions()};}
  async getQuote(symbol){return {connected:true,data:await this.getSymbolPrice(symbol)};}
}

export const mt5BridgeRegistry=new Mt5BridgeRegistry();
