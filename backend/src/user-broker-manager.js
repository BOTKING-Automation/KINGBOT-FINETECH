import MetaApi from "metaapi.cloud-sdk";

export class UserBrokerManager {
  constructor({pool}={}) {
    this.pool=pool;
    this.token=String(process.env.METAAPI_TOKEN||"").trim();
    this.connections=new Map();
  }

  async ensureSchema(){
    if(!this.pool)return;
    await this.pool.query("CREATE TABLE IF NOT EXISTS kingbot_broker_accounts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,provider TEXT NOT NULL,account_id TEXT NOT NULL,execution_mode TEXT NOT NULL DEFAULT 'PAPER' CHECK(execution_mode IN ('PAPER','LIVE')),enabled BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(user_id,provider,account_id))");
  }

  async getMapping(userId){
    if(!this.pool||!userId)return null;
    const q=await this.pool.query("SELECT id,user_id,provider,account_id,execution_mode,enabled FROM kingbot_broker_accounts WHERE user_id=$1 AND enabled=TRUE ORDER BY updated_at DESC LIMIT 1",[userId]);
    return q.rowCount?q.rows[0]:null;
  }

  async saveMapping({userId,provider="metaapi",accountId,executionMode="PAPER"}={}){
    if(!this.pool||!userId)return {ok:false,error:"USER_CONTEXT_REQUIRED"};
    const mode=String(executionMode).toUpperCase();
    if(!["PAPER","LIVE"].includes(mode))return {ok:false,error:"INVALID_EXECUTION_MODE"};
    const id=String(accountId||"").trim();
    if(!id)return {ok:false,error:"BROKER_ACCOUNT_ID_REQUIRED"};
    const q=await this.pool.query("INSERT INTO kingbot_broker_accounts(user_id,provider,account_id,execution_mode,enabled,updated_at) VALUES($1,$2,$3,$4,TRUE,NOW()) ON CONFLICT(user_id,provider,account_id) DO UPDATE SET execution_mode=EXCLUDED.execution_mode,enabled=TRUE,updated_at=NOW() RETURNING id,user_id,provider,account_id,execution_mode,enabled",[userId,String(provider).toLowerCase(),id,mode]);
    return {ok:true,account:q.rows[0]};
  }

  async connect(userId,executionMode="PAPER"){
    if(!userId)return {connected:false,mode:"NOT_CONNECTED",reason:"USER_CONTEXT_REQUIRED"};
    if(!this.token)return {connected:false,mode:"NOT_CONNECTED",reason:"METAAPI_NOT_CONFIGURED"};
    const mapping=await this.getMapping(userId);
    if(!mapping)return {connected:false,mode:"NOT_CONNECTED",reason:"BROKER_ACCOUNT_NOT_MAPPED"};
    const mode=String(executionMode||mapping.execution_mode).toUpperCase();
    if(!["PAPER","LIVE"].includes(mode))return {connected:false,mode:"NOT_CONNECTED",reason:"INVALID_EXECUTION_MODE"};
    const key=userId+":"+mapping.provider+":"+mapping.account_id;
    let entry=this.connections.get(key);
    if(!entry){
      const api=new MetaApi(this.token);
      const account=await api.metatraderAccountApi.getAccount(mapping.account_id);
      await account.waitConnected();
      const connection=account.getRPCConnection();
      await connection.connect();
      await connection.waitSynchronized();
      entry={api,account,connection,accountId:mapping.account_id,executionMode:mode};
      this.connections.set(key,entry);
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
    if(!mapping)throw new Error("BROKER_ACCOUNT_NOT_MAPPED");
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
