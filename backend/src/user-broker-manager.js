import crypto from "node:crypto";
import MetaApi from "metaapi.cloud-sdk/esm-node";

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

  async saveMapping({userId,provider="metaapi",accountId,accountToken,executionMode="PAPER"}={}){
    if(!this.pool||!userId)return {ok:false,error:"USER_CONTEXT_REQUIRED"};
    const mode=String(executionMode).toUpperCase();
    if(!["PAPER","LIVE"].includes(mode))return {ok:false,error:"INVALID_EXECUTION_MODE"};
    const id=String(accountId||"").trim();
    const token=String(accountToken||"").trim();
    if(!id)return {ok:false,error:"BROKER_ACCOUNT_ID_REQUIRED"};
    if(!token)return {ok:false,error:"BROKER_ACCOUNT_TOKEN_REQUIRED"};
    if(token.length>4096)return {ok:false,error:"BROKER_ACCOUNT_TOKEN_TOO_LONG"};
    const encrypted=encryptSecret(token);
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
    let accountToken;
    try{accountToken=decryptSecret(mapping);}
    catch(error){return {connected:false,mode:"NOT_CONNECTED",reason:"BROKER_CREDENTIAL_DECRYPTION_FAILED"};}
    const key=userId+":"+mapping.provider+":"+mapping.account_id;
    let entry=this.connections.get(key);
    if(!entry){
      try{
        const api=new MetaApi(accountToken);
        const account=await api.metatraderAccountApi.getAccount(mapping.account_id);
        await account.waitConnected();
        const connection=account.getRPCConnection();
        await connection.connect();
        await connection.waitSynchronized();
        entry={api,account,connection,accountId:mapping.account_id,executionMode:mode};
        this.connections.set(key,entry);
      }catch(error){
        return {connected:false,mode:"NOT_CONNECTED",reason:"BROKER_CONNECTION_FAILED"};
      }
    }
    entry.executionMode=mode;
    return {connected:true,mode,broker:mapping.provider,accountId:mapping.account_id};
  }

  async disconnect(userId){
    for(const [key,entry] of this.connections){
      if(key.startsWith(String(userId)+":")){
        try{await entry.connection.close();}finally{this.connections.delete(key);}
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
    return entry.connection;
  }

  async getAccount(userId){return {connected:true,data:await (await this.connectionFor(userId)).getAccountInformation()};}
  async getPositions(userId){return {connected:true,data:await (await this.connectionFor(userId)).getPositions()};}
  async getOrders(userId){return {connected:true,data:await (await this.connectionFor(userId)).getOrders()};}

  async getTrades({startTime,endTime,userId}={}){
    const connection=await this.connectionFor(userId);
    const end=endTime?new Date(endTime):new Date();
    const start=startTime?new Date(startTime):new Date(end.getTime()-24*60*60*1000);
    const [orders,deals]=await Promise.all([connection.getHistoryOrdersByTimeRange(start,end),connection.getDealsByTimeRange(start,end)]);
    return {connected:true,data:{orders,deals}};
  }

  async getSymbolSpecification(symbol,userId){
    const connection=await this.connectionFor(userId);
    return {connected:true,data:await connection.getSymbolSpecification(String(symbol).trim().toUpperCase())};
  }

  async getHistoricalCandles(symbol,timeframe,userId,limit=100){
    const connection=await this.connectionFor(userId);
    const count=Math.max(10,Math.min(1000,Number(limit)||100));
    const end=new Date();
    const minutes={"1m":1,"2m":2,"3m":3,"4m":4,"5m":5,"6m":6,"10m":10,"12m":12,"15m":15,"20m":20,"30m":30,"1h":60,"2h":120,"3h":180,"4h":240,"6h":360,"8h":480,"12h":720,"1d":1440,"1w":10080,"1mn":43200};
    const mins=minutes[String(timeframe)]||1;
    const start=new Date(end.getTime()-count*mins*60000);
    return {connected:true,data:await connection.getHistoricalCandles(String(symbol).trim().toUpperCase(),String(timeframe),start,end,count)};
  }

  async getQuote(symbol,userId){
    const connection=await this.connectionFor(userId);
    return {connected:true,data:await connection.getSymbolPrice(String(symbol).trim().toUpperCase())};
  }

  async placeOrder({side,symbol,volume,stopLoss,takeProfit,comment,clientId,userId}){
    const connection=await this.connectionFor(userId);
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
