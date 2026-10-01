import crypto from "node:crypto";
import WebSocket from "ws";

const DEFAULT_BASE_URL = "https://api.exness.com";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function b64url(buffer){
  return Buffer.from(buffer).toString("base64")
    .replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
}

function decodeKeyMaterial(value){
  const raw=String(value||"").trim();
  if(!raw)throw new Error("EXNESS_PRIVATE_KEY_REQUIRED");
  if(raw.includes("BEGIN PRIVATE KEY")){
    return crypto.createPrivateKey({key:raw,format:"pem"});
  }

  const compact=raw.replace(/\s+/g,"");
  let bytes;
  if(/^[0-9a-fA-F]+$/.test(compact)&&compact.length%2===0){
    bytes=Buffer.from(compact,"hex");
  }else{
    try{
      bytes=Buffer.from(compact.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((compact.length+3)%4),"base64");
    }catch{
      throw new Error("EXNESS_PRIVATE_KEY_FORMAT_INVALID");
    }
  }

  if(bytes.length===32){
    return crypto.createPrivateKey({
      key:Buffer.concat([PKCS8_ED25519_PREFIX,bytes]),
      format:"der",
      type:"pkcs8"
    });
  }

  try{
    return crypto.createPrivateKey({key:bytes,format:"der",type:"pkcs8"});
  }catch{
    throw new Error("EXNESS_PRIVATE_KEY_FORMAT_INVALID");
  }
}

function normalizeBaseUrl(value){
  const raw=String(value||"").trim()||DEFAULT_BASE_URL;
  const url=new URL(raw);
  if(url.protocol!=="https:")throw new Error("EXNESS_BASE_URL_MUST_USE_HTTPS");
  return url.origin;
}

function validateAccountId(value){
  const id=String(value||"").trim();
  if(!/^[0-9]{1,20}$/.test(id))throw new Error("INVALID_EXNESS_ACCOUNT_ID");
  return id;
}

export class ExnessTraderClient{
  constructor({apiKey,secretKey,accountId,baseUrl}={}){
    this.apiKey=String(apiKey||"").trim();
    if(!this.apiKey)throw new Error("EXNESS_API_KEY_REQUIRED");
    this.accountId=validateAccountId(accountId);
    this.privateKey=decodeKeyMaterial(secretKey);
    this.baseUrl=normalizeBaseUrl(baseUrl);
    this.accessPoint=null;
    this.limits=null;
  }

  buildHeaders(method,path,body="",idempotencyKey=""){
    const timestamp=Date.now().toString();
    const upper=String(method).toUpperCase();
    const payload={
      api_key:this.apiKey,
      idempotency_key:idempotencyKey,
      timestamp:Number(timestamp),
      sign_version:1,
      method:upper,
      path,
      body_hash:crypto.createHash("sha256").update(String(body),"utf8").digest("base64url")
    };
    const data=Buffer.from(JSON.stringify(payload),"utf8");
    const signature=crypto.sign(null,data,this.privateKey);
    return {
      "Accept":"application/json",
      "Content-Type":"application/json",
      "EXN-API-KEY":this.apiKey,
      "EXN-IDEMPOTENCY-KEY":idempotencyKey,
      "EXN-TIMESTAMP":timestamp,
      "EXN-SIGN-VERSION":"1",
      "EXN-DATA":b64url(data),
      "EXN-SIGN":b64url(signature)
    };
  }

  async request(method,path,bodyObj=null,{baseUrl=this.baseUrl,idempotencyKey}={}){
    const body=bodyObj===null ? "" : JSON.stringify(bodyObj);
    const key=idempotencyKey || (String(method).toUpperCase()==="GET" ? "" : crypto.randomUUID().replace(/-/g,""));
    const headers=this.buildHeaders(method,path,body,key);
    const response=await fetch(normalizeBaseUrl(baseUrl)+path,{method:String(method).toUpperCase(),headers,body:body||undefined});
    const text=await response.text();
    let data={};
    try{data=text?JSON.parse(text):{};}catch{data={raw:text};}
    if(!response.ok){
      const message=data?.error_message || data?.error?.message || ("EXNESS_HTTP_"+response.status);
      const error=new Error(String(message));
      error.status=response.status;
      error.code=data?.code;
      error.payload=data;
      throw error;
    }
    return data;
  }

  async discoverAccessPoint(){
    const id=validateAccountId(this.accountId);
    const path="/v1/trading/access-point?account_id="+encodeURIComponent(id);
    const data=await this.request("GET",path,null,{baseUrl:this.baseUrl});
    const host=String(data?.access_point||data?.host||"").trim();
    if(!host)throw new Error("EXNESS_ACCESS_POINT_MISSING");
    const normalized=host.startsWith("http")?host:"https://"+host;
    this.accessPoint=normalizeBaseUrl(normalized);
    return {accessPoint:this.accessPoint,accountId:id};
  }

  async ensureReady(){
    if(!this.accessPoint)await this.discoverAccessPoint();
    if(!this.limits){
      const path="/v1/configuration/accounts/"+this.accountId+"/limits";
      this.limits=await this.request("GET",path,null,{baseUrl:this.accessPoint});
    }
    return {accessPoint:this.accessPoint,limits:this.limits};
  }

  async getAccountInformation(){
    await this.ensureReady();
    return this.request("GET","/v1/configuration/accounts/"+this.accountId+"/account");
  }


  async websocketSnapshot(){
    await this.ensureReady();
    const path="/v1/server-events/accounts/"+this.accountId+"/ws/events";
    const wsUrl=this.accessPoint.replace(/^https:/i,"wss:")+path;
    const headers=this.buildHeaders("GET",path,"","");
    return new Promise((resolve,reject)=>{
      const ws=new WebSocket(wsUrl,{headers,handshakeTimeout:10000});
      let settled=false;
      const finish=(error,value)=>{
        if(settled)return;
        settled=true;
        try{ws.close();}catch{}
        if(error)reject(error);else resolve(value);
      };
      const timeout=setTimeout(()=>finish(new Error("EXNESS_SERVER_EVENTS_TIMEOUT")),12000);
      ws.on("open",()=>{
        ws.send(JSON.stringify({
          id:"kingbot-snapshot-"+crypto.randomUUID(),
          subscribe:{event:"transactions"}
        }));
      });
      ws.on("message",buffer=>{
        let message;
        try{message=JSON.parse(buffer.toString("utf8"));}catch{return;}
        if(message?.error_message) return finish(new Error(String(message.error_message)));
        if(message?.event==="trading_state_snapshot" || message?.type==="trading_state_snapshot"){
          clearTimeout(timeout);
          finish(null,message);
        }
      });
      ws.on("error",error=>{
        clearTimeout(timeout);
        finish(new Error(error?.message||"EXNESS_SERVER_EVENTS_FAILED"));
      });
      ws.on("close",()=>{
        clearTimeout(timeout);
        if(!settled)finish(new Error("EXNESS_SERVER_EVENTS_CLOSED"));
      });
    });
  }

  async getQuoteViaWebSocket(instrument){
    await this.ensureReady();
    const symbol=String(instrument||"").trim().toUpperCase();
    if(!/^[A-Z0-9._-]{1,11}$/.test(symbol))throw new Error("INVALID_EXNESS_INSTRUMENT");
    const path="/v1/server-events/accounts/"+this.accountId+"/ws/ticks";
    const wsUrl=this.accessPoint.replace(/^https:/i,"wss:")+path;
    const headers=this.buildHeaders("GET",path,"","");
    return new Promise((resolve,reject)=>{
      const ws=new WebSocket(wsUrl,{headers,handshakeTimeout:10000});
      let settled=false;
      const finish=(error,value)=>{
        if(settled)return;
        settled=true;
        try{ws.close();}catch{}
        if(error)reject(error);else resolve(value);
      };
      const timeout=setTimeout(()=>finish(new Error("EXNESS_TICK_TIMEOUT")),10000);
      ws.on("open",()=>{
        ws.send(JSON.stringify({
          id:"kingbot-tick-"+crypto.randomUUID(),
          subscribe:{event:"ticks",instruments:[symbol]}
        }));
      });
      ws.on("message",buffer=>{
        let message;
        try{message=JSON.parse(buffer.toString("utf8"));}catch{return;}
        if(message?.error_message)return finish(new Error(String(message.error_message)));
        if(String(message?.instrument||"").toUpperCase()===symbol && Number.isFinite(Number(message?.bid)) && Number.isFinite(Number(message?.ask))){
          clearTimeout(timeout);
          finish(null,{instrument:symbol,bid:Number(message.bid),ask:Number(message.ask),timestamp:message.timestamp||new Date().toISOString()});
        }
      });
      ws.on("error",error=>{
        clearTimeout(timeout);
        finish(new Error(error?.message||"EXNESS_TICK_STREAM_FAILED"));
      });
      ws.on("close",()=>{
        clearTimeout(timeout);
        if(!settled)finish(new Error("EXNESS_TICK_STREAM_CLOSED"));
      });
    });
  }

  async getPositions(){
    const snapshot=await this.websocketSnapshot();
    return snapshot?.payload?.positions || snapshot?.positions || [];
  }

  async getOrders(){
    const snapshot=await this.websocketSnapshot();
    return snapshot?.payload?.orders || snapshot?.orders || [];
  }

  async getHistoricalOrders({from,to,cursor,limit=100}={}){
    await this.ensureReady();
    const params=new URLSearchParams();
    if(cursor)params.set("cursor",String(cursor));
    else{
      if(!from)throw new Error("EXNESS_HISTORY_FROM_REQUIRED");
      params.set("from",String(from));
      if(to)params.set("to",String(to));
    }
    params.set("limit",String(Math.max(1,Math.min(200,Number(limit)||100))));
    const path="/v1/history/accounts/"+this.accountId+"/orders?"+params.toString();
    return this.request("GET",path);
  }

  async getHistoricalDeals({from,to,cursor,limit=100}={}){
    await this.ensureReady();
    const params=new URLSearchParams();
    if(cursor)params.set("cursor",String(cursor));
    else{
      if(!from)throw new Error("EXNESS_HISTORY_FROM_REQUIRED");
      params.set("from",String(from));
      if(to)params.set("to",String(to));
    }
    params.set("limit",String(Math.max(1,Math.min(200,Number(limit)||100))));
    const path="/v1/history/accounts/"+this.accountId+"/deals?"+params.toString();
    return this.request("GET",path);
  }

  async getMarkets(){
    await this.ensureReady();
    const data=await this.request("GET","/v1/configuration/accounts/"+this.accountId+"/instruments");
    const raw=Array.isArray(data?.instruments)?data.instruments:(Array.isArray(data?.data?.instruments)?data.data.instruments:(Array.isArray(data?.data)?data.data:[]));
    return raw.map(item=>{
      if(typeof item==="string")return {symbol:item.trim().toUpperCase(),name:item.trim().toUpperCase(),category:"",submarket:"",tradeable:true,source:"broker"};
      const symbol=String(item?.instrument||item?.symbol||item?.name||"").trim().toUpperCase();
      return {symbol,name:String(item?.display_name||item?.displayName||item?.name||symbol).trim(),category:String(item?.type||item?.category||"").trim(),submarket:String(item?.group||item?.subgroup||"").trim(),tradeable:item?.tradeable!==false,source:"broker"};
    }).filter(x=>x.symbol);
  }

  async getInstrumentConditions(instrument){
    await this.ensureReady();
    const symbol=String(instrument||"").trim().toUpperCase();
    if(!/^[A-Z0-9._-]{1,11}$/.test(symbol))throw new Error("INVALID_EXNESS_INSTRUMENT");
    return this.request("GET","/v1/configuration/accounts/"+this.accountId+"/instruments/"+encodeURIComponent(symbol)+"/conditions");
  }

  async openPosition({instrument,side,volume,price,deviation,stopLossPrice,takeProfitPrice,comment,clientRequestId}={}){
    await this.ensureReady();
    const symbol=String(instrument||"").trim().toUpperCase();
    if(!/^[A-Z0-9._-]{1,11}$/.test(symbol))throw new Error("INVALID_EXNESS_INSTRUMENT");
    const normalizedSide=String(side||"").toLowerCase();
    if(!["buy","sell"].includes(normalizedSide))throw new Error("INVALID_EXNESS_SIDE");
    const payload={instrument:symbol,side:normalizedSide,volume:String(volume)};
    if(price!==undefined&&price!==null&&price!=="")payload.price=String(price);
    if(deviation!==undefined&&deviation!==null&&deviation!=="")payload.deviation=String(deviation);
    if(stopLossPrice!==undefined&&stopLossPrice!==null&&stopLossPrice!=="")payload.stop_loss_price=String(stopLossPrice);
    if(takeProfitPrice!==undefined&&takeProfitPrice!==null&&takeProfitPrice!=="")payload.take_profit_price=String(takeProfitPrice);
    if(comment)payload.comment=String(comment).slice(0,100);
    return this.request("POST","/v1/trading/accounts/"+this.accountId+"/positions",payload,{idempotencyKey:clientRequestId||crypto.randomUUID().replace(/-/g,"")});
  }

  async modifyPositionStops({positionId,stopLoss,takeProfit}={}){
    await this.ensureReady();
    const id=String(positionId||"").trim();
    if(!id)throw new Error("EXNESS_POSITION_ID_REQUIRED");
    const payload={};
    if(stopLoss!==undefined)payload.stop_loss_price=stopLoss===null?null:String(stopLoss);
    if(takeProfit!==undefined)payload.take_profit_price=takeProfit===null?null:String(takeProfit);
    if(!Object.keys(payload).length)throw new Error("EXNESS_POSITION_STOP_UPDATE_REQUIRED");
    return this.request("PUT","/v1/trading/accounts/"+this.accountId+"/positions/"+encodeURIComponent(id),payload,{idempotencyKey:crypto.randomUUID().replace(/-/g,"")});
  }

  async modifyOrder(orderId,patch={}){
    await this.ensureReady();
    const id=String(orderId||"").trim();
    if(!id)throw new Error("EXNESS_ORDER_ID_REQUIRED");
    return this.request("PATCH","/v1/trading/accounts/"+this.accountId+"/orders/"+encodeURIComponent(id),patch,{idempotencyKey:crypto.randomUUID().replace(/-/g,"")});
  }

  async getOperation(operationId){
    await this.ensureReady();
    const id=String(operationId||"").trim();
    if(!id)throw new Error("EXNESS_OPERATION_ID_REQUIRED");
    return this.request("GET","/v1/trading/accounts/"+this.accountId+"/operations/"+encodeURIComponent(id));
  }

  async getQuote(instrument){
    return this.getQuoteViaWebSocket(instrument);
  }
}
