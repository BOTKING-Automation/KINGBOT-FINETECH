import crypto from "node:crypto";
import MetaApi from "metaapi.cloud-sdk/esm-node";
import { ExnessTraderClient } from "./exness-trader-client.js";
import { OandaTraderClient } from "./oanda-trader-client.js";
import { DerivTraderClient } from "./deriv-trader-client.js";

const ALGORITHM="aes-256-gcm";

function masterKey(){
  const raw=String(process.env.BROKER_CREDENTIALS_KEY||"").trim();
  if(!raw) throw new Error("BROKER_CREDENTIALS_KEY_NOT_CONFIGURED");
  if(raw.length < 32) throw new Error("BROKER_CREDENTIALS_KEY_TOO_SHORT");
  return crypto.createHash("sha256").update(raw,"utf8").digest();
}
function encryptSecret(value){
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv(ALGORITHM,masterKey(),iv);
  const ciphertext=Buffer.concat([cipher.update(String(value),"utf8"),cipher.final()]);
  return {ciphertext:ciphertext.toString("base64"),iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64")};
}
function qtyString(value){
  const n=Number(value);
  if(!Number.isFinite(n)||n<=0)throw new Error("INVALID_ORDER_VOLUME");
  return String(value);
}

function decryptSecret(row){
  const decipher=crypto.createDecipheriv(ALGORITHM,masterKey(),Buffer.from(row.credential_iv,"base64"));
  decipher.setAuthTag(Buffer.from(row.credential_tag,"base64"));
  return Buffer.concat([decipher.update(Buffer.from(row.credential_ciphertext,"base64")),decipher.final()]).toString("utf8");
}

export class UserBrokerManager {
  constructor({pool}={}) {
    this.pool=pool;
    this.connections=new Map();
  }

  async ensureSchema(){
    if(!this.pool)return;
    await this.pool.query("CREATE TABLE IF NOT EXISTS kingbot_broker_accounts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,provider TEXT NOT NULL,account_id TEXT NOT NULL,credential_ciphertext TEXT NOT NULL,credential_iv TEXT NOT NULL,credential_tag TEXT NOT NULL,execution_mode TEXT NOT NULL DEFAULT 'PAPER' CHECK(execution_mode IN ('PAPER','LIVE')),enabled BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(user_id,provider,account_id))");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS credential_ciphertext TEXT");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS credential_iv TEXT");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS credential_tag TEXT"); 
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS provider TEXT");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS account_id TEXT");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS execution_mode TEXT DEFAULT 'PAPER'");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()");
    await this.pool.query("CREATE TABLE IF NOT EXISTS kingbot_deriv_oauth_states (state TEXT PRIMARY KEY,user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,code_verifier TEXT NOT NULL,execution_mode TEXT NOT NULL DEFAULT 'PAPER',expires_at TIMESTAMPTZ NOT NULL)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS kingbot_deriv_oauth_states_expires_idx ON kingbot_deriv_oauth_states(expires_at)");
  }

  async createDerivOAuthState({userId,codeVerifier,executionMode="PAPER"}={}){
    if(!this.pool||!userId)throw new Error("USER_CONTEXT_REQUIRED");
    const state=crypto.randomBytes(32).toString("base64url");
    const mode=String(executionMode).toUpperCase();
    if(!["PAPER","LIVE"].includes(mode))throw new Error("INVALID_EXECUTION_MODE");
    await this.pool.query("DELETE FROM kingbot_deriv_oauth_states WHERE expires_at<NOW()");
    await this.pool.query("INSERT INTO kingbot_deriv_oauth_states(state,user_id,code_verifier,execution_mode,expires_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '10 minutes')",[state,userId,String(codeVerifier||""),mode]);
    return {state,executionMode:mode};
  }

  async consumeDerivOAuthState(state){
    if(!this.pool)return null;
    const q=await this.pool.query("DELETE FROM kingbot_deriv_oauth_states WHERE state=$1 AND expires_at>NOW() RETURNING user_id,code_verifier,execution_mode",[String(state||"")]);
    return q.rowCount?q.rows[0]:null;
  }

  async isConnected(userId){
    for(const [key] of this.connections){ if(key.startsWith(String(userId)+":")) return true; }
    return false;
  }

  async getStatus(userId){
    const mapping=await this.getMapping(userId);
    return {configured:Boolean(mapping),connected:await this.isConnected(userId),broker:mapping?.provider||null,accountId:mapping?.account_id||null,executionMode:mapping?.execution_mode||"NOT_CONNECTED"};
  }

  async getMapping(userId){
    if(!this.pool||!userId)return null;
    const q=await this.pool.query("SELECT id,user_id,provider,account_id,execution_mode,enabled,credential_ciphertext,credential_iv,credential_tag FROM kingbot_broker_accounts WHERE user_id=$1 AND enabled=TRUE AND credential_ciphertext IS NOT NULL AND credential_iv IS NOT NULL AND credential_tag IS NOT NULL ORDER BY updated_at DESC LIMIT 1",[userId]);
    return q.rowCount?q.rows[0]:null;
  }

  async saveMapping({userId,provider="metaapi",accountId,accountToken,executionMode="PAPER",apiKey,secretKey,baseUrl,derivAccountType}={}){
    if(!this.pool||!userId)return {ok:false,error:"USER_CONTEXT_REQUIRED"};
    const mode=String(executionMode).toUpperCase();
    if(!["PAPER","LIVE"].includes(mode))return {ok:false,error:"INVALID_EXECUTION_MODE"};
    const id=String(accountId||"").trim();
    const providerName=String(provider).toLowerCase();
    const isExness=providerName==="exness";
    let secretValue=String(accountToken||"").trim();
    if(isExness){
      const key=String(apiKey||"").trim();
      const secret=String(secretKey||"").trim();
      const host=String(baseUrl||"").trim();
      if(!key)return {ok:false,error:"EXNESS_API_KEY_REQUIRED"};
      if(!secret)return {ok:false,error:"EXNESS_PRIVATE_KEY_REQUIRED"};
      if(host && !/^https:\/\//i.test(host))return {ok:false,error:"EXNESS_BASE_URL_MUST_USE_HTTPS"};
      secretValue=JSON.stringify({apiKey:key,secretKey:secret,baseUrl:host||undefined});
    }else if(providerName==="oanda"){

      const token=String(accountToken||"").trim();
      if(!token)return {ok:false,error:"OANDA_API_TOKEN_REQUIRED"};
      const host=String(baseUrl||"").trim();
      if(host && !/^https:\/\//i.test(host))return {ok:false,error:"OANDA_BASE_URL_MUST_USE_HTTPS"};
      secretValue=JSON.stringify({apiToken:token,baseUrl:host||undefined});
    }else if(providerName==="deriv"){
      const token=String(accountToken||"").trim();
      if(!token)return {ok:false,error:"DERIV_OAUTH_TOKEN_REQUIRED"};
      let parsed={};
      try{parsed=JSON.parse(token);}catch{parsed={accessToken:token};}
      if(!parsed.accessToken)return {ok:false,error:"DERIV_ACCESS_TOKEN_REQUIRED"};
      secretValue=JSON.stringify({
        accessToken:parsed.accessToken,
        refreshToken:parsed.refreshToken||undefined,
        expiresAt:parsed.expiresAt||undefined,
        accountType:String(derivAccountType||parsed.accountType||"").toLowerCase()||undefined
      });
    }
    if(!id)return {ok:false,error:"BROKER_ACCOUNT_ID_REQUIRED"};
    if(!secretValue)return {ok:false,error:isExness?"EXNESS_CREDENTIALS_REQUIRED":providerName==="deriv"?"DERIV_CREDENTIALS_REQUIRED":"BROKER_ACCOUNT_TOKEN_REQUIRED"};
    if(secretValue.length>12000)return {ok:false,error:"BROKER_CREDENTIAL_TOO_LONG"};
    const encrypted=encryptSecret(secretValue);
    const q=await this.pool.query("INSERT INTO kingbot_broker_accounts(user_id,provider,account_id,credential_ciphertext,credential_iv,credential_tag,execution_mode,enabled,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,TRUE,NOW()) ON CONFLICT(user_id,provider,account_id) DO UPDATE SET credential_ciphertext=EXCLUDED.credential_ciphertext,credential_iv=EXCLUDED.credential_iv,credential_tag=EXCLUDED.credential_tag,execution_mode=EXCLUDED.execution_mode,enabled=TRUE,updated_at=NOW() RETURNING id,user_id,provider,account_id,execution_mode,enabled",[userId,String(provider).toLowerCase(),id,encrypted.ciphertext,encrypted.iv,encrypted.tag,mode]);
    await this.disconnect(userId);
    return {ok:true,account:q.rows[0]};
  }

  async connect(userId,executionMode="PAPER"){
    if(!userId)return {connected:false,mode:"NOT_CONNECTED",reason:"USER_CONTEXT_REQUIRED"};
    const mapping=await this.getMapping(userId);
    if(!mapping)return {connected:false,mode:"NOT_CONNECTED",reason:"BROKER_ACCOUNT_NOT_CONFIGURED"};
    const mode=String(executionMode||mapping.execution_mode).toUpperCase();
    if(!["PAPER","LIVE"].includes(mode))return {connected:false,mode:"NOT_CONNECTED",reason:"INVALID_EXECUTION_MODE"};
    let credential;
    try{credential=decryptSecret(mapping);}
    catch(error){return {connected:false,mode:"NOT_CONNECTED",reason:"BROKER_CREDENTIAL_DECRYPTION_FAILED"};}
    const key=userId+":"+mapping.provider+":"+mapping.account_id;
    let entry=this.connections.get(key);

    if(mapping.provider==="exness"){
      try{
        const parsed=JSON.parse(credential);
        if(!entry){
          const api=new ExnessTraderClient({
            apiKey:parsed.apiKey,
            secretKey:parsed.secretKey,
            accountId:mapping.account_id,
            baseUrl:parsed.baseUrl
          });
          await api.ensureReady();
          const accountInfo=await api.getAccountInformation();
          entry={api,accountInfo,accountId:mapping.account_id,executionMode:mode,provider:"exness",connectedAt:Date.now()};
          this.connections.set(key,entry);
        }else{
          entry.accountInfo=await entry.api.getAccountInformation();
        }
        const info=entry.accountInfo||{};
        if(info.trade_mode==="trading_disabled")return {connected:false,mode:"NOT_CONNECTED",reason:"EXNESS_TRADING_DISABLED"};
        if(mode==="LIVE"&&info.account_status==="close_only")return {connected:false,mode:"NOT_CONNECTED",reason:"EXNESS_ACCOUNT_CLOSE_ONLY"};
        entry.executionMode=mode;
        return {connected:true,mode,broker:"exness",accountId:mapping.account_id,account:info};
      }catch(error){
        console.error("[KINGBOT EXNESS] connect failed:",error?.message||error);
        return {connected:false,mode:"NOT_CONNECTED",reason:error?.message||"EXNESS_CONNECTION_FAILED"};
      }
    }

    if(mapping.provider==="deriv"){
      try{
        const parsed=JSON.parse(credential);
        if(!entry){
          const api=new DerivTraderClient({
            accessToken:parsed.accessToken,
            accountId:mapping.account_id,
            executionMode:mode
          });
          const result=await api.connect();
          entry={api,accountId:mapping.account_id,executionMode:mode,provider:"deriv",connectedAt:Date.now(),accountInfo:result.account};
          this.connections.set(key,entry);
        }else{
          entry.executionMode=mode;
          entry.api.executionMode=mode;
          entry.accountInfo=(await entry.api.getAccount()).data;
        }
        entry.executionMode=mode;
        return {connected:true,mode,broker:"deriv",accountId:mapping.account_id,account:entry.accountInfo};
      }catch(error){
        console.error("[KINGBOT DERIV] connect failed:",error?.message||error);
        return {connected:false,mode:"NOT_CONNECTED",reason:error?.message||"DERIV_CONNECTION_FAILED"};
      }
    }

    if(mapping.provider==="oanda"){
      try{
        const parsed=JSON.parse(credential);
        if(!entry){
          const api=new OandaTraderClient({
            apiToken:parsed.apiToken,
            accountId:mapping.account_id,
            executionMode:mode,
            baseUrl:parsed.baseUrl
          });
          const accountInfo=await api.ensureReady();
          entry={api,accountId:mapping.account_id,executionMode:mode,provider:"oanda",connectedAt:Date.now(),accountInfo};
          this.connections.set(key,entry);
        }else{
          entry.accountInfo=await entry.api.getAccountSummary();
        }
        entry.executionMode=mode;
        return {connected:true,mode,broker:"oanda",accountId:mapping.account_id,account:entry.accountInfo};
      }catch(error){
        console.error("[KINGBOT OANDA] connect failed:",error?.message||error);
        return {connected:false,mode:"NOT_CONNECTED",reason:error?.message||"OANDA_CONNECTION_FAILED"};
      }
    }

    const accountToken=credential;
    if(!entry){
      try{
        const api=new MetaApi(accountToken);
        const account=await api.metatraderAccountApi.getAccount(mapping.account_id);
        await account.waitConnected();
        const connection=account.getRPCConnection();
        await connection.connect();
        await connection.waitSynchronized();
        entry={api,account,connection,accountId:mapping.account_id,executionMode:mode,provider:mapping.provider};
        this.connections.set(key,entry);
      }catch(error){
        return {connected:false,mode:"NOT_CONNECTED",reason:"BROKER_CONNECTION_FAILED"};
      }
    }
    try{
      const accountInfo=await entry.connection.getAccountInformation();
      if(mode==="PAPER"&&accountInfo.type!=="ACCOUNT_TRADE_MODE_DEMO"){
        await entry.connection.close();
        this.connections.delete(key);
        return {connected:false,mode:"NOT_CONNECTED",reason:"PAPER_REQUIRES_DEMO_ACCOUNT"};
      }
      if(mode==="LIVE"&&accountInfo.type!=="ACCOUNT_TRADE_MODE_REAL"){
        await entry.connection.close();
        this.connections.delete(key);
        return {connected:false,mode:"NOT_CONNECTED",reason:"LIVE_REQUIRES_REAL_ACCOUNT"};
      }
    }catch(error){
      try{await entry.connection.close();}catch{}
      this.connections.delete(key);
      return {connected:false,mode:"NOT_CONNECTED",reason:"BROKER_ACCOUNT_VALIDATION_FAILED"};
    }
    entry.executionMode=mode;
    return {connected:true,mode,broker:mapping.provider,accountId:mapping.account_id};
  }

  async disconnect(userId){
    for(const [key,entry] of this.connections){
      if(key.startsWith(String(userId)+":")){
        try{
          if(entry.provider!=="exness" && entry.connection?.close)await entry.connection.close();
        }finally{this.connections.delete(key);}
      }
    }
    return {connected:false,mode:"NOT_CONNECTED"};
  }

  async connectionFor(userId){
    const mapping=await this.getMapping(userId);
    if(!mapping)throw new Error("BROKER_ACCOUNT_NOT_CONFIGURED");
    const key=userId+":"+mapping.provider+":"+mapping.account_id;
    const entry=this.connections.get(key);
    if(!entry)throw new Error("BROKER_NOT_CONNECTED");
    return entry;
  }

  async getAccount(userId){
    const entry=await this.connectionFor(userId);
    if(entry.provider==="exness"){
      const info=await entry.api.getAccountInformation();
      let state={};
      try{
        const snapshot=await entry.api.websocketSnapshot();
        state=snapshot?.payload?.account_state||snapshot?.account_state||{};
        if(!state && snapshot?.payload?.accountState)state=snapshot.payload.accountState;
      }catch{}
      return {
        connected:true,
        data:{
          ...info,
          balance:state.balance??info.balance,
          equity:state.equity??info.equity,
          margin:state.used_margin??info.margin,
          freeMargin:state.free_margin??info.free_margin,
          marginLevel:state.margin_level??info.margin_level,
          tradeAllowed:info.trade_mode==="enabled" && info.account_status==="active",
          provider:"exness"
        }
      };
    }
    if(entry.provider==="deriv"){
      const info=await entry.api.getAccount();
      return info;
    }
    if(entry.provider==="oanda"){
      const info=await entry.api.getAccountSummary();
      return {connected:true,data:{
        ...info,
        balance:info.balance,
        equity:info.NAV,
        margin:info.marginUsed,
        freeMargin:info.marginAvailable,
        marginLevel:Number(info.marginUsed)>0 ? Number(info.NAV)/Number(info.marginUsed)*100 : null,
        tradeAllowed:true,
        provider:"oanda"
      }};
    }
    return {connected:true,data:await entry.connection.getAccountInformation()};
  }

  async getPositions(userId){
    const entry=await this.connectionFor(userId);
    if(entry.provider==="exness")throw new Error("EXNESS_POSITIONS_USE_SERVER_EVENTS");
    if(entry.provider==="deriv")return await entry.api.getPositions();
    if(entry.provider==="oanda")return {connected:true,data:await entry.api.getPositions()};
    return {connected:true,data:await entry.connection.getPositions()};
  }

  async getOrders(userId){
    const entry=await this.connectionFor(userId);
    if(entry.provider==="exness")throw new Error("EXNESS_OPEN_ORDERS_USE_SERVER_EVENTS");
    if(entry.provider==="deriv")return await entry.api.getOrders();
    if(entry.provider==="oanda")return {connected:true,data:await entry.api.getOrders()};
    return {connected:true,data:await entry.connection.getOrders()};
  }

  async getTrades({startTime,endTime,userId}={}){
    const entry=await this.connectionFor(userId);
    const end=endTime?new Date(endTime):new Date();
    const start=startTime?new Date(startTime):new Date(end.getTime()-24*60*60*1000);
    if(entry.provider==="exness"){
      return {
        connected:true,
        data:{
          orders:await entry.api.getHistoricalOrders({from:start.toISOString(),to:end.toISOString(),limit:200}),
          deals:await entry.api.getHistoricalDeals({from:start.toISOString(),to:end.toISOString(),limit:200})
        }
      };
    }
    if(entry.provider==="deriv"){
      return await entry.api.getTrades({startTime,endTime});
    }
    if(entry.provider==="oanda"){
      return {connected:true,data:await entry.api.getTrades({state:"CLOSE"})};
    }
    const [orders,deals]=await Promise.all([entry.connection.getHistoryOrdersByTimeRange(start,end),entry.connection.getDealsByTimeRange(start,end)]);
    return {connected:true,data:{orders,deals}};
  }

  async getSymbolSpecification(symbol,userId){
    const entry=await this.connectionFor(userId);
    if(entry.provider==="exness")return {connected:true,data:await entry.api.getInstrumentConditions(String(symbol).trim().toUpperCase())};
    if(entry.provider==="deriv")return await entry.api.getSymbolSpecification(String(symbol).trim().toUpperCase());
    if(entry.provider==="oanda")return {connected:true,data:await entry.api.getInstrumentSpecification(String(symbol).trim().toUpperCase())};
    return {connected:true,data:await entry.connection.getSymbolSpecification(String(symbol).trim().toUpperCase())};
  }

  async getHistoricalCandles(symbol,timeframe,userId,limit=100){
    const entry=await this.connectionFor(userId);
    if(entry.provider==="exness")throw new Error("EXNESS_CANDLES_ADAPTER_PENDING");
    if(entry.provider==="deriv")return await entry.api.getHistoricalCandles(String(symbol).trim().toUpperCase(),String(timeframe),limit);
    if(entry.provider==="oanda")return {connected:true,data:await entry.api.getHistoricalCandles(String(symbol).trim().toUpperCase(),String(timeframe),limit)};
    const connection=entry.connection;
    const count=Math.max(10,Math.min(1000,Number(limit)||100));
    const end=new Date();
    const minutes={"1m":1,"2m":2,"3m":3,"4m":4,"5m":5,"6m":6,"10m":10,"12m":12,"15m":15,"20m":20,"30m":30,"1h":60,"2h":120,"3h":180,"4h":240,"6h":360,"8h":480,"12h":720,"1d":1440,"1w":10080,"1mn":43200};
    const mins=minutes[String(timeframe)]||1;
    const start=new Date(end.getTime()-count*mins*60000);
    return {connected:true,data:await connection.getHistoricalCandles(String(symbol).trim().toUpperCase(),String(timeframe),start,end,count)};
  }

  async getQuote(symbol,userId){
    const entry=await this.connectionFor(userId);
    if(entry.provider==="exness"){
      const quote=await entry.api.getQuote(String(symbol).trim().toUpperCase());
      return {connected:true,data:{...quote,time:quote.timestamp||quote.time||new Date().toISOString(),lossTickValue:quote.lossTickValue}};
    }
    if(entry.provider==="deriv"){
      return await entry.api.getQuote(String(symbol).trim().toUpperCase());
    }
    if(entry.provider==="oanda"){
      const quote=await entry.api.getQuote(String(symbol).trim().toUpperCase());
      return {connected:true,data:{...quote,lossTickValue:1}};
    }
    return {connected:true,data:await entry.connection.getSymbolPrice(String(symbol).trim().toUpperCase())};
  }

  async placeOrder({side,symbol,volume,stopLoss,takeProfit,comment,clientId,userId}){
    const entry=await this.connectionFor(userId);
    if(entry.provider==="deriv"){
      return await entry.api.placeOrder({side,symbol,volume,stopLoss,takeProfit,comment,clientId});
    }
    if(entry.provider==="oanda"){
      return await entry.api.placeOrder({side,symbol,volume,stopLoss,takeProfit,comment,clientId});
    }
    if(entry.provider==="exness"){
      return await entry.api.openPosition({
        instrument:symbol,
        side:String(side).toLowerCase(),
        volume:qtyString(volume),
        stopLossPrice:stopLoss,
        takeProfitPrice:takeProfit,
        comment,
        clientRequestId:clientId
      });
    }
    const connection=entry.connection;
    const qty=Number(volume);
    if(!Number.isFinite(qty)||qty<=0)throw new Error("INVALID_ORDER_VOLUME");
    const s=String(symbol||"").trim().toUpperCase();
    if(!/^[A-Z0-9._-]{3,30}$/.test(s))throw new Error("INVALID_SYMBOL");
    const options={};
    if(comment)options.comment=String(comment).slice(0,100);
    if(clientId)options.clientId=String(clientId).slice(0,100);
    if(String(side).toUpperCase()==="BUY")return await connection.createMarketBuyOrder(s,qty,stopLoss,takeProfit,options);
    if(String(side).toUpperCase()==="SELL")return await connection.createMarketSellOrder(s,qty,stopLoss,takeProfit,options);
    throw new Error("INVALID_ORDER_SIDE");
  }
}
