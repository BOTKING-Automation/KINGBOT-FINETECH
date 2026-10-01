import WebSocket from "ws";

const API_BASE = "https://api.derivws.com";

function finite(value){
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class DerivTraderClient {
  constructor({accessToken,accountId,executionMode="PAPER",accountType=""}={}){
    this.id="deriv";
    this.accessToken=String(accessToken||"").trim();
    this.accountId=String(accountId||"").trim();
    this.executionMode=String(executionMode||"PAPER").toUpperCase();
    this.accountType=String(accountType||"").toLowerCase();
    this.ws=null;
    this.connected=false;
    this.requestId=0;
    this.pending=new Map();
  }

  configured(){
    return Boolean(this.accessToken&&this.accountId&&["PAPER","LIVE"].includes(this.executionMode));
  }

  async rest(path,options={}){
    const headers={
      Authorization:"Bearer "+this.accessToken,
      "Content-Type":"application/json",
      ...(options.headers||{})
    };
    const response=await fetch(API_BASE+path,{...options,headers});
    const body=await response.json().catch(()=>({}));
    if(!response.ok){
      const message=body?.errors?.[0]?.message||body?.error?.message||body?.message||("Deriv REST request failed ("+response.status+")");
      throw new Error(message);
    }
    return body;
  }

  async connect(){
    if(!this.configured())throw new Error("DERIV_CREDENTIALS_NOT_CONFIGURED");
    const otp=await this.rest("/trading/v1/options/accounts/"+encodeURIComponent(this.accountId)+"/otp",{method:"POST"});
    const wsUrl=String(otp?.data?.url||"").trim();
    if(!wsUrl)throw new Error("DERIV_OTP_URL_MISSING");

    await new Promise((resolve,reject)=>{
      const ws=new WebSocket(wsUrl);
      let settled=false;
      const fail=(error)=>{if(settled)return;settled=true;try{ws.close();}catch{}reject(error instanceof Error?error:new Error(String(error)))};
      ws.once("open",()=>{if(settled)return;settled=true;this.ws=ws;this.connected=true;this.attach(ws);resolve();});
      ws.once("error",fail);
      ws.once("close",()=>{if(!settled)fail(new Error("DERIV_WEBSOCKET_CLOSED_DURING_CONNECT"));});
    });

    const account=await this.request({balance:1});
    const balance=account?.balance||{};
    const expectedDemo=this.executionMode==="PAPER";
    if(expectedDemo && this.accountTypeFromBalance(balance)!=="demo"){
      await this.disconnect();
      throw new Error("PAPER_REQUIRES_DERIV_DEMO_ACCOUNT");
    }
    if(!expectedDemo && this.accountTypeFromBalance(balance)==="demo"){
      await this.disconnect();
      throw new Error("LIVE_REQUIRES_DERIV_REAL_ACCOUNT");
    }
    return {
      connected:true,
      mode:this.executionMode,
      broker:"deriv",
      accountId:this.accountId,
      account:balance
    };
  }

  accountTypeFromBalance(balance){
    if(this.accountType==="demo"||this.accountType==="real")return this.accountType;
    const loginid=String(balance?.loginid||"");
    if(loginid.startsWith("VR"))return "demo";
    if(loginid.includes("_VRTC"))return "demo";
    return "real";
  }

  attach(ws){
    ws.on("message",raw=>{
      let data;
      try{data=JSON.parse(String(raw));}catch{return;}
      const reqId=data?.req_id;
      if(reqId && this.pending.has(reqId)){
        const item=this.pending.get(reqId);
        this.pending.delete(reqId);
        if(data.error)item.reject(new Error(data.error.message||"DERIV_API_ERROR"));
        else item.resolve(data);
      }
    });
    ws.on("close",()=>{
      this.connected=false;
      for(const item of this.pending.values())item.reject(new Error("DERIV_WEBSOCKET_CLOSED"));
      this.pending.clear();
      this.ws=null;
    });
    ws.on("error",()=>{});
  }

  async request(payload,{timeoutMs=12000}={}){
    if(!this.ws||!this.connected)throw new Error("DERIV_NOT_CONNECTED");
    const req_id=++this.requestId;
    const message={...payload,req_id};
    return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.pending.delete(req_id);
        reject(new Error("DERIV_REQUEST_TIMEOUT"));
      },timeoutMs);
      this.pending.set(req_id,{
        resolve:value=>{clearTimeout(timer);resolve(value);},
        reject:error=>{clearTimeout(timer);reject(error);}
      });
      try{this.ws.send(JSON.stringify(message));}
      catch(error){clearTimeout(timer);this.pending.delete(req_id);reject(error);}
    });
  }

  async disconnect(){
    try{if(this.ws)this.ws.close();}finally{
      this.ws=null;
      this.connected=false;
      for(const item of this.pending.values())item.reject(new Error("DERIV_DISCONNECTED"));
      this.pending.clear();
    }
    return {connected:false,mode:"NOT_CONNECTED"};
  }

  async getAccount(){
    const response=await this.request({balance:1});
    const balance=response?.balance||{};
    return {
      connected:true,
      data:{
        balance:finite(balance.balance),
        equity:finite(balance.balance),
        margin:null,
        freeMargin:null,
        marginLevel:null,
        currency:balance.currency||null,
        loginid:balance.loginid||this.accountId,
        tradeAllowed:true,
        provider:"deriv",
        accountType:this.accountTypeFromBalance(balance)
      }
    };
  }

  async getPositions(){
    const response=await this.request({portfolio:1});
    const contracts=Array.isArray(response?.portfolio?.contracts)?response.portfolio.contracts:[];
    return {
      connected:true,
      data:contracts.map(c=>({
        id:c.contract_id,
        contractId:c.contract_id,
        symbol:c.underlying_symbol||c.symbol||null,
        type:c.contract_type||c.type||null,
        side:(String(c.contract_type||"").toUpperCase().includes("DOWN")||String(c.contract_type||"").toUpperCase().includes("PUT")||String(c.contract_type||"").toUpperCase().includes("SHORT"))?"SELL":"BUY",
        contractType:c.contract_type||c.type||null,
        volume:finite(c.buy_price),
        stake:finite(c.buy_price),
        openPrice:finite(c.entry_spot||c.entry_tick),
        currentPrice:finite(c.current_spot||c.current_tick),
        profit:finite(c.profit),
        bidPrice:finite(c.bid_price),
        payout:finite(c.payout),
        multiplier:finite(c.multiplier),
        expiryTime:finite(c.date_expiry),
        status:c.status||"open"
      }))
    };
  }

  async getOrders(){
    return {connected:true,data:[]};
  }

  async getTrades({startTime,endTime}={}){
    const body={profit_table:1,limit:500,sort:"DESC"};
    if(startTime)body.date_from=Math.floor(new Date(startTime).getTime()/1000);
    if(endTime)body.date_to=Math.floor(new Date(endTime).getTime()/1000);
    const response=await this.request(body);
    const transactions=Array.isArray(response?.profit_table?.transactions)?response.profit_table.transactions:[];
    const deals=transactions.map(item=>{
      const buy=finite(item?.buy_price);
      const payout=finite(item?.payout);
      const sell=finite(item?.sell_price);
      const profit=buy!==null && payout!==null
        ? payout-buy
        : (buy!==null && sell!==null ? sell-buy : null);
      return {
        ...item,
        profit,
        realizedPnl:profit
      };
    });
    return {
      connected:true,
      data:{
        orders:[],
        deals
      }
    };
  }

  async getQuote(symbol){
    const s=String(symbol||"").trim();
    if(!/^[A-Za-z0-9._-]{2,30}$/.test(s))throw new Error("INVALID_DERIV_SYMBOL");
    const response=await this.request({ticks:s});
    const tick=response?.tick||{};
    const quote=finite(tick.quote);
    if(quote===null)throw new Error("DERIV_QUOTE_UNAVAILABLE");
    return {
      connected:true,
      data:{
        symbol:s,
        bid:quote,
        ask:quote,
        price:quote,
        time:tick.epoch?new Date(Number(tick.epoch)*1000).toISOString():new Date().toISOString()
      }
    };
  }

  async getMarkets(){
    const response=await this.request({active_symbols:"full"});
    const list=Array.isArray(response?.active_symbols)?response.active_symbols:[];
    return list.map(item=>({
      symbol:String(item?.underlying_symbol||item?.symbol||"").trim(),
      name:String(item?.underlying_symbol_name||item?.display_name||item?.underlying_symbol||item?.symbol||"").trim(),
      category:String(item?.market||item?.underlying_symbol_type||"").trim(),
      submarket:String(item?.submarket||item?.subgroup||"").trim(),
      pipSize:finite(item?.pip_size),
      tradeable:Number(item?.exchange_is_open)===0||Number(item?.is_trading_suspended)===1?false:true,
      source:"broker"
    })).filter(x=>x.symbol);
  }

  async getContractsFor(symbol){
    const s=String(symbol||"").trim();
    if(!/^[A-Za-z0-9._-]{2,30}$/.test(s))throw new Error("INVALID_DERIV_SYMBOL");
    const response=await this.request({contracts_for:s});
    return response?.contracts_for||response?.contracts||{};
  }

  async getProposal({symbol,contractType,stake,currency,multiplier,subscribe=0}={}){
    const s=String(symbol||"").trim();
    const type=String(contractType||"").trim().toUpperCase();
    if(!s||!type)throw new Error("DERIV_PROPOSAL_INPUT_REQUIRED");
    const payload={
      proposal:1,
      amount:Number(stake),
      basis:"stake",
      contract_type:type,
      currency:String(currency||"USD").trim().toUpperCase(),
      underlying_symbol:s,
      subscribe:subscribe?1:0
    };
    if(multiplier!==undefined&&multiplier!==null)payload.multiplier=Number(multiplier);
    const response=await this.request(payload,{timeoutMs:12000});
    const proposal=response?.proposal;
    if(!proposal?.id)throw new Error("DERIV_PROPOSAL_ID_MISSING");
    return {proposalId:String(proposal.id),askPrice:finite(proposal.ask_price),payout:finite(proposal.payout),spot:finite(proposal.spot),proposal};
  }

  async buyContract({proposalId,price,subscribe=0,reference=""}={}){
    const id=String(proposalId||"").trim();
    const maxPrice=Number(price);
    if(!id||!Number.isFinite(maxPrice)||maxPrice<0)throw new Error("DERIV_BUY_INPUT_INVALID");
    const response=await this.request({buy:id,price:maxPrice,subscribe:subscribe?1:0,passthrough:reference?{reference}:undefined});
    const buy=response?.buy;
    if(!buy?.contract_id)throw new Error("DERIV_CONTRACT_ID_MISSING");
    return {contractId:String(buy.contract_id),buy};
  }

  async getOpenContract(contractId){
    const id=String(contractId||"").trim();
    if(!id)throw new Error("DERIV_CONTRACT_ID_REQUIRED");
    const response=await this.request({proposal_open_contract:1,contract_id:Number(id),subscribe:0});
    const c=response?.proposal_open_contract;
    if(!c?.contract_id)throw new Error("DERIV_OPEN_CONTRACT_NOT_FOUND");
    return c;
  }

  async updateContract(contractId,{stopLoss,takeProfit}={}){
    const id=String(contractId||"").trim();
    if(!id)throw new Error("DERIV_CONTRACT_ID_REQUIRED");
    const limit_order={};
    if(stopLoss!==undefined)limit_order.stop_loss=Number(stopLoss);
    if(takeProfit!==undefined)limit_order.take_profit=Number(takeProfit);
    if(!Object.keys(limit_order).length)throw new Error("DERIV_LIMIT_ORDER_REQUIRED");
    return this.request({contract_update:1,contract_id:Number(id),limit_order});
  }

  async sellContract(contractId,price=0){
    const id=String(contractId||"").trim();
    const minimumPrice=Number(price);
    if(!id||!Number.isFinite(minimumPrice)||minimumPrice<0)throw new Error("DERIV_SELL_INPUT_INVALID");
    const response=await this.request({sell:Number(id),price:minimumPrice});
    if(!response?.sell?.contract_id)throw new Error("DERIV_SELL_FAILED");
    return response.sell;
  }

  async getSymbolSpecification(symbol){
    const s=String(symbol||"").trim();
    const markets=await this.getMarkets();
    const market=markets.find(x=>String(x.symbol).toUpperCase()===s.toUpperCase());
    const contracts=await this.getContractsFor(s);
    return {
      symbol:s,
      point:Number(market?.pipSize)||0.00001,
      tickSize:Number(market?.pipSize)||0.00001,
      tickValue:1,
      minVolume:0.35,
      maxVolume:100000,
      volumeStep:0.01,
      stopsLevel:0,
      pipSize:Number(market?.pipSize)||null,
      contractModel:"OPTIONS",
      availableContracts:contracts
    };
  }

  async getHistoricalCandles(symbol,timeframe="1m",limit=100){
    const s=String(symbol||"").trim();
    if(!/^[A-Za-z0-9._-]{2,30}$/.test(s))throw new Error("INVALID_DERIV_SYMBOL");
    const granularityMap={"1m":60,"2m":120,"3m":180,"4m":240,"5m":300,"6m":360,"10m":600,"12m":720,"15m":900,"20m":1200,"30m":1800,"1h":3600,"2h":7200,"3h":10800,"4h":14400,"6h":21600,"8h":28800,"12h":43200,"1d":86400,"1w":604800,"1mn":2592000};
    const granularity=granularityMap[String(timeframe||"1m")]||60;
    const count=Math.max(20,Math.min(1000,Number(limit)||100));
    const response=await this.request({ticks_history:s,end:"latest",count,style:"candles",granularity,adjust_start_time:1,subscribe:0},{timeoutMs:15000});
    const candles=Array.isArray(response?.candles)?response.candles:[];
    const rows=candles.map(c=>({time:c?.epoch?new Date(Number(c.epoch)*1000).toISOString():null,open:finite(c?.open),high:finite(c?.high),low:finite(c?.low),close:finite(c?.close),volume:finite(c?.tick_count)})).filter(c=>c.time&&[c.open,c.high,c.low,c.close].every(Number.isFinite));
    if(rows.length<20)throw new Error("INSUFFICIENT_HISTORICAL_CANDLES");
    return rows;
  }

  async placeOrder({side,symbol,volume,stopLoss,takeProfit,comment,clientId,userId,currency,multiplier=10,derivContractType}={}){
    const resolvedCurrency=String(currency||this.currency||"").trim().toUpperCase()||String((await this.getAccount()).data?.currency||"USD").toUpperCase();
    const s=String(symbol||"").trim();
    const direction=String(side||"").toUpperCase();
    const contractType=String(derivContractType||"").trim().toUpperCase()||(direction==="BUY"?"MULTUP":direction==="SELL"?"MULTDOWN":"");
    if(!contractType)throw new Error("INVALID_DERIV_SIDE");
    const proposal=await this.getProposal({symbol:s,contractType,stake:Number(volume),currency:resolvedCurrency,multiplier:Number(multiplier),subscribe:0});
    const bought=await this.buyContract({proposalId:proposal.proposalId,price:Number(proposal.askPrice||volume),subscribe:0,reference:clientId||comment||""});
    if(stopLoss!==undefined||takeProfit!==undefined){
      try{await this.updateContract(bought.contractId,{stopLoss,takeProfit});}catch{}
    }
    return {provider:"deriv",contractId:bought.contractId,proposalId:proposal.proposalId,contractType,stake:Number(volume),multiplier:Number(multiplier),comment:comment||"KINGBOT",buy:bought.buy};
  }
}
