import MetaApi from "metaapi.cloud-sdk";

export class MetaApiBroker {
  constructor({token=process.env.METAAPI_TOKEN,accountId=process.env.METAAPI_ACCOUNT_ID}={}) {
    this.id="metaapi";
    this.token=String(token||"").trim();
    this.accountId=String(accountId||"").trim();
    this.api=null;
    this.account=null;
    this.connection=null;
    this.connected=false;
    this.executionMode="NOT_CONNECTED";
  }
  configured(){return Boolean(this.token&&this.accountId);}
  async connect({executionMode="PAPER"}={}) {
    if(!this.configured()) return {connected:false,mode:"NOT_CONNECTED",reason:"METAAPI_NOT_CONFIGURED"};
    if(!["PAPER","LIVE"].includes(executionMode)) return {connected:false,mode:"NOT_CONNECTED",reason:"INVALID_EXECUTION_MODE"};
    this.api=new MetaApi(this.token);
    this.account=await this.api.metatraderAccountApi.getAccount(this.accountId);
    await this.account.waitConnected();
    this.connection=this.account.getRPCConnection();
    await this.connection.connect();
    await this.connection.waitSynchronized();
    this.connected=true;
    this.executionMode=executionMode;
    return {connected:true,mode:executionMode,broker:"metaapi",accountId:this.accountId};
  }
  async disconnect(){
    try{if(this.connection)await this.connection.close();}finally{this.connected=false;this.connection=null;this.account=null;this.api=null;this.executionMode="NOT_CONNECTED";}
    return {connected:false,mode:"NOT_CONNECTED"};
  }
  ensure(){if(!this.connected||!this.connection)throw new Error("BROKER_NOT_CONNECTED");}
  async getAccount(){this.ensure();return {connected:true,data:await this.connection.getAccountInformation()};}
  async getPositions(){this.ensure();return {connected:true,data:await this.connection.getPositions()};}
  async getOrders(){this.ensure();return {connected:true,data:await this.connection.getOrders()};}
  async getTrades({startTime,endTime}={}){
    this.ensure();
    const end=endTime?new Date(endTime):new Date();
    const start=startTime?new Date(startTime):new Date(end.getTime()-24*60*60*1000);
    const [orders,deals]=await Promise.all([
      this.connection.getHistoryOrdersByTimeRange(start,end),
      this.connection.getDealsByTimeRange(start,end)
    ]);
    return {connected:true,data:{orders,deals}};
  }
  async getQuote(symbol){this.ensure();return {connected:true,data:await this.connection.getSymbolPrice(symbol)};}
  async placeOrder({side,symbol,volume,stopLoss,takeProfit,comment,clientId}){
    this.ensure();
    const qty=Number(volume);
    if(!Number.isFinite(qty)||qty<=0)throw new Error("INVALID_ORDER_VOLUME");
    const s=String(symbol||"").trim().toUpperCase();
    if(!/^[A-Z0-9._-]{3,30}$/.test(s))throw new Error("INVALID_SYMBOL");
    const options={};
    if(comment)options.comment=String(comment).slice(0,100);
    if(clientId)options.clientId=String(clientId).slice(0,100);
    if(String(side).toUpperCase()==="BUY")return await this.connection.createMarketBuyOrder(s,qty,stopLoss,takeProfit,options);
    if(String(side).toUpperCase()==="SELL")return await this.connection.createMarketSellOrder(s,qty,stopLoss,takeProfit,options);
    throw new Error("INVALID_ORDER_SIDE");
  }
}

export function createBroker(){
  if(process.env.METAAPI_TOKEN&&process.env.METAAPI_ACCOUNT_ID)return new MetaApiBroker();
  return new NoopBroker();
}

export class NoopBroker {
  constructor(){this.id="noop";this.connected=false;this.executionMode="NOT_CONNECTED";}
  async connect(){return {connected:false,mode:"NOT_CONNECTED",reason:"BROKER_NOT_CONFIGURED"};}
  async disconnect(){this.connected=false;return {connected:false};}
  async getAccount(){return {connected:false,data:null};}
  async getPositions(){return {connected:false,data:[]};}
  async getOrders(){return {connected:false,data:[]};}
  async getTrades(){return {connected:false,data:{orders:[],deals:[]}};}
  async placeOrder(){throw new Error("BROKER_NOT_CONNECTED");}
}
