const DEFAULT_PRACTICE_BASE="https://api-fxpractice.oanda.com";
const DEFAULT_LIVE_BASE="https://api-fxtrade.oanda.com";

const INSTRUMENT_MAP={
  XAUUSD:"XAU_USD",
  XAGUSD:"XAG_USD",
  EURUSD:"EUR_USD",
  GBPUSD:"GBP_USD",
  USDJPY:"USD_JPY",
  AUDUSD:"AUD_USD",
  USDCAD:"USD_CAD",
  USDCHF:"USD_CHF",
  NZDUSD:"NZD_USD",
  BTCUSD:"BTC_USD"
};
const GRANULARITY_MAP={
 "1m":"M1","2m":"M2","3m":"M3","4m":"M4","5m":"M5","10m":"M10","15m":"M15","30m":"M30",
 "1h":"H1","2h":"H2","4h":"H4","6h":"H6","8h":"H8","12h":"H12","1d":"D","1w":"W","1mn":"M"
};

async function readJson(response){
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const message=data?.errorMessage||data?.errorCode||data?.error||("OANDA API HTTP "+response.status);
    throw new Error(String(message));
  }
  return data;
}
function normalizeInstrument(symbol){
  const raw=String(symbol||"").trim().toUpperCase();
  return INSTRUMENT_MAP[raw]||raw;
}
function normalizeTf(tf){return GRANULARITY_MAP[String(tf||"1m")]||"M1";}

export class OandaTraderClient{
  constructor({apiToken,accountId,executionMode="PAPER",baseUrl}={}){
    this.apiToken=String(apiToken||"").trim();
    this.accountId=String(accountId||"").trim();
    this.executionMode=String(executionMode||"PAPER").toUpperCase();
    this.baseUrl=String(baseUrl||"").trim() || (this.executionMode==="LIVE"?DEFAULT_LIVE_BASE:DEFAULT_PRACTICE_BASE);
    if(!/^https:\/\//i.test(this.baseUrl))throw new Error("OANDA_BASE_URL_MUST_USE_HTTPS");
    this.baseUrl=this.baseUrl.replace(/\/+$/,"");
  }
  async request(path,options={}){
    const headers={Accept:"application/json","Authorization":"Bearer "+this.apiToken,...(options.headers||{})};
    if(options.body)headers["Content-Type"]="application/json";
    return readJson(await fetch(this.baseUrl+path,{...options,headers}));
  }
  async ensureReady(){
    if(!this.apiToken)throw new Error("OANDA_API_TOKEN_REQUIRED");
    if(!this.accountId)throw new Error("OANDA_ACCOUNT_ID_REQUIRED");
    const data=await this.request("/v3/accounts/"+encodeURIComponent(this.accountId)+"/summary");
    return data?.account||data;
  }
  async getAccounts(){return (await this.request("/v3/accounts")).accounts||[];}
  async getAccountSummary(){return (await this.request("/v3/accounts/"+encodeURIComponent(this.accountId)+"/summary")).account;}
  async getQuote(symbol){
    const instrument=normalizeInstrument(symbol);
    const data=await this.request("/v3/accounts/"+encodeURIComponent(this.accountId)+"/pricing?instruments="+encodeURIComponent(instrument));
    const p=data?.prices?.[0];
    if(!p)throw new Error("OANDA_PRICE_NOT_AVAILABLE");
    const bid=Number(p?.bids?.[0]?.price),ask=Number(p?.asks?.[0]?.price);
    if(!Number.isFinite(bid)||!Number.isFinite(ask))throw new Error("OANDA_INVALID_PRICE");
    return {symbol:String(symbol).toUpperCase(),instrument,bid,ask,time:p.time,tradeable:Boolean(p.tradeable)};
  }
  async getHistoricalCandles(symbol,timeframe="1m",limit=100){
    const instrument=normalizeInstrument(symbol);
    const granularity=normalizeTf(timeframe);
    const count=Math.max(10,Math.min(5000,Number(limit)||100));
    const data=await this.request("/v3/instruments/"+encodeURIComponent(instrument)+"/candles?granularity="+encodeURIComponent(granularity)+"&count="+count+"&price=M");
    return (data?.candles||[]).filter(c=>c.complete).map(c=>({
      time:c.time,
      open:Number(c.mid?.o),
      high:Number(c.mid?.h),
      low:Number(c.mid?.l),
      close:Number(c.mid?.c),
      volume:Number(c.volume||0)
    }));
  }
  async getPositions(){
    const data=await this.request("/v3/accounts/"+encodeURIComponent(this.accountId)+"/positions/open");
    const positions=[];
    for(const p of data?.positions||[]){
      for(const side of ["long","short"]){
        const leg=p?.[side];
        const units=Number(leg?.units);
        if(!Number.isFinite(units)||units===0)continue;
        positions.push({
          id:p.instrument+"_"+side,
          symbol:p.instrument,
          tradeIds:Array.isArray(leg?.tradeIDs)?leg.tradeIDs.map(String):[],
          type:side.toUpperCase(),
          side:side.toUpperCase(),
          volume:Math.abs(units),
          openPrice:Number(leg?.averagePrice),
          currentPrice:null,
          profit:Number(leg?.unrealizedPL||0)
        });
      }
    }
    return positions;
  }
  async getOrders(){return (await this.request("/v3/accounts/"+encodeURIComponent(this.accountId)+"/pendingOrders")).orders||[];}
  async getTrades({state="OPEN",instrument}={}){
    let q="state="+encodeURIComponent(state)+"&count=500";
    if(instrument)q+="&instrument="+encodeURIComponent(normalizeInstrument(instrument));
    const trades=(await this.request("/v3/accounts/"+encodeURIComponent(this.accountId)+"/trades?"+q)).trades||[];
    return {orders:[],deals:trades.map(t=>({
      ...t,
      id:String(t.id||""),
      tradeId:String(t.id||""),
      symbol:String(t.instrument||""),
      side:Number(t.currentUnits)>=0?"BUY":"SELL",
      volume:Math.abs(Number(t.currentUnits)||0),
      openPrice:Number(t.price),
      stopLoss:t.stopLossOrder?.price!=null?Number(t.stopLossOrder.price):null,
      takeProfit:t.takeProfitOrder?.price!=null?Number(t.takeProfitOrder.price):null,
      profit:Number(t.unrealizedPL||0)
    }))};
  }
  async getMarkets(){
    const data=await this.request("/v3/accounts/"+encodeURIComponent(this.accountId)+"/instruments");
    const list=Array.isArray(data?.instruments)?data.instruments:[];
    return list.map(item=>({
      symbol:String(item?.name||"").trim(),
      name:String(item?.displayName||item?.name||"").trim(),
      category:String(item?.type||"").trim(),
      submarket:"",
      tradeable:true,
      source:"broker",
      marginRate:item?.marginRate??null,
      displayPrecision:item?.displayPrecision??null
    })).filter(x=>x.symbol);
  }
  async getInstrumentSpecification(symbol){
    const instrument=normalizeInstrument(symbol);
    const data=await this.request("/v3/accounts/"+encodeURIComponent(this.accountId)+"/instruments?instruments="+encodeURIComponent(instrument));
    const x=data?.instruments?.[0];
    if(!x)throw new Error("OANDA_INSTRUMENT_NOT_AVAILABLE");
    const pipLocation=Number(x.pipLocation);
    const displayPrecision=Number(x.displayPrecision);
    return {
      symbol:instrument,
      minVolume:Number(x.minimumTradeSize||1),
      maxVolume:Number(x.maximumOrderUnits||0),
      volumeStep:Number(x.tradeUnitsPrecision>=0?Math.pow(10,-Number(x.tradeUnitsPrecision)):1),
      point:Number.isFinite(pipLocation)?Math.pow(10,pipLocation):Math.pow(10,-displayPrecision),
      tickSize:Number.isFinite(pipLocation)?Math.pow(10,pipLocation):Math.pow(10,-displayPrecision),
      tickValue:1,
      stopsLevel:0
    };
  }
  async modifyTradeStops(tradeId,{stopLoss,takeProfit}={}){
    const id=String(tradeId||"").trim();
    if(!id)throw new Error("OANDA_TRADE_ID_REQUIRED");
    const body={};
    if(stopLoss!==undefined&&stopLoss!==null)body.stopLoss={timeInForce:"GTC",price:Number(stopLoss).toFixed(10)};
    else if(stopLoss===null)body.stopLoss=null;
    if(takeProfit!==undefined&&takeProfit!==null)body.takeProfit={timeInForce:"GTC",price:Number(takeProfit).toFixed(10)};
    else if(takeProfit===null)body.takeProfit=null;
    return this.request("/v3/accounts/"+encodeURIComponent(this.accountId)+"/trades/"+encodeURIComponent(id)+"/orders",{method:"PUT",body:JSON.stringify(body)});
  }

  async placeOrder({side,symbol,volume,stopLoss,takeProfit,comment,clientId}={}){
    const instrument=normalizeInstrument(symbol);
    const units=(String(side).toUpperCase()==="BUY"?1:-1)*Number(volume);
    if(!Number.isFinite(units)||units===0)throw new Error("INVALID_ORDER_VOLUME");
    const order={
      type:"MARKET",
      instrument,
      units:String(units),
      positionFill:"DEFAULT"
    };
    if(stopLoss!=null)order.stopLossOnFill={price:Number(stopLoss).toFixed(10),timeInForce:"GTC"};
    if(takeProfit!=null)order.takeProfitOnFill={price:Number(takeProfit).toFixed(10),timeInForce:"GTC"};
    if(comment)order.clientExtensions={id:String(clientId||"kingbot").slice(0,20),tag:"KINGBOT",comment:String(comment).slice(0,100)};
    const data=await this.request("/v3/accounts/"+encodeURIComponent(this.accountId)+"/orders",{method:"POST",body:JSON.stringify({order})});
    return data;
  }
}
