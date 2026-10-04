import crypto from "node:crypto";

let tokenCache={token:"",expiresAt:0};

function config(){
  const env=String(process.env.MPESA_ENV||"sandbox").trim().toLowerCase()==="production" ? "production" : "sandbox";
  const baseUrl=String(process.env.MPESA_BASE_URL||(
    env==="production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke"
  )).replace(/\/+$/,"");
  return {
    env,
    baseUrl,
    consumerKey:String(process.env.MPESA_CONSUMER_KEY||"").trim(),
    consumerSecret:String(process.env.MPESA_CONSUMER_SECRET||"").trim(),
    shortCode:String(process.env.MPESA_SHORTCODE||"").trim(),
    passkey:String(process.env.MPESA_PASSKEY||"").trim(),
    callbackUrl:String(process.env.MPESA_CALLBACK_URL||"").trim()
  };
}

export function mpesaStatus(){
  const c=config();
  return {
    configured:Boolean(c.consumerKey&&c.consumerSecret&&c.shortCode&&c.passkey&&c.callbackUrl),
    environment:c.env,
    shortCode:c.shortCode||null,
    callbackUrlConfigured:Boolean(c.callbackUrl)
  };
}

export function normalizeMpesaPhone(value){
  let phone=String(value||"").replace(/[\\s()-]/g,"");
  if(phone.startsWith("+"))phone=phone.slice(1);
  if(/^07\\d{8}$/.test(phone)||/^01\\d{8}$/.test(phone))return "254"+phone.slice(1);
  if(/^[17]\\d{8}$/.test(phone))return "254"+phone;
  if(/^254[17]\\d{8}$/.test(phone))return phone;
  return "";
}

function darajaTimestamp(){
  const parts=new Intl.DateTimeFormat("en-GB",{
    timeZone:"Africa/Nairobi",
    year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",
    hourCycle:"h23"
  }).formatToParts(new Date());
  const get=name=>parts.find(x=>x.type===name)?.value||"00";
  return get("year")+get("month")+get("day")+get("hour")+get("minute")+get("second");
}

async function accessToken(){
  const c=config();
  if(!c.consumerKey||!c.consumerSecret)throw new Error("MPESA_API_NOT_CONFIGURED");
  if(tokenCache.token && tokenCache.expiresAt>Date.now()+30000)return tokenCache.token;

  const basic=Buffer.from(c.consumerKey+":"+c.consumerSecret).toString("base64");
  const response=await fetch(c.baseUrl+"/oauth/v1/generate?grant_type=client_credentials",{
    method:"GET",
    headers:{Authorization:"Basic "+basic,Accept:"application/json"}
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok || !body?.access_token){
    throw new Error(String(body?.error_description||body?.error||("MPESA_AUTH_FAILED_"+response.status)).slice(0,220));
  }
  const expiresIn=Number(body.expires_in||3600);
  tokenCache={token:String(body.access_token),expiresAt:Date.now()+Math.max(60,expiresIn-60)*1000};
  return tokenCache.token;
}

async function post(path,payload){
  const token=await accessToken();
  const c=config();
  const response=await fetch(c.baseUrl+path,{
    method:"POST",
    headers:{
      Authorization:"Bearer "+token,
      "Content-Type":"application/json",
      Accept:"application/json"
    },
    body:JSON.stringify(payload)
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok){
    throw new Error(String(
      body?.errorMessage||
      body?.error_description||
      body?.error||
      body?.ResponseDescription||
      body?.message||
      ("MPESA_REQUEST_FAILED_"+response.status)
    ).slice(0,260));
  }
  return body;
}

export async function initiateStkPush({amount,phone,accountReference,transactionDesc}){
  const c=config();
  if(!c.shortCode||!c.passkey||!c.callbackUrl)throw new Error("MPESA_STK_NOT_CONFIGURED");
  const normalized=normalizeMpesaPhone(phone);
  if(!normalized)throw new Error("INVALID_MPESA_PHONE");

  const numericAmount=Math.floor(Number(amount));
  if(!Number.isFinite(numericAmount)||numericAmount<1)throw new Error("INVALID_MPESA_AMOUNT");

  const timestamp=darajaTimestamp();
  const password=Buffer.from(c.shortCode+c.passkey+timestamp).toString("base64");
  const reference=String(accountReference||"KINGBOT").replace(/[^A-Za-z0-9_-]/g,"").slice(0,12)||"KINGBOT";
  const description=String(transactionDesc||"KINGBOT subscription").replace(/[^A-Za-z0-9 ._-]/g,"").slice(0,20)||"KINGBOT payment";

  const payload={
    BusinessShortCode:c.shortCode,
    Password:password,
    Timestamp:timestamp,
    TransactionType:String(process.env.MPESA_TRANSACTION_TYPE||"CustomerPayBillOnline"),
    Amount:numericAmount,
    PartyA:normalized,
    PartyB:c.shortCode,
    PhoneNumber:normalized,
    CallBackURL:c.callbackUrl,
    AccountReference:reference,
    TransactionDesc:description
  };

  const body=await post("/mpesa/stkpush/v1/processrequest",payload);
  return {
    responseCode:String(body?.ResponseCode??""),
    responseDescription:String(body?.ResponseDescription||""),
    customerMessage:String(body?.CustomerMessage||""),
    merchantRequestId:String(body?.MerchantRequestID||""),
    checkoutRequestId:String(body?.CheckoutRequestID||""),
    environment:c.env
  };
}

export async function queryStkPush(checkoutRequestId){
  const c=config();
  if(!c.shortCode||!c.passkey)throw new Error("MPESA_STK_NOT_CONFIGURED");
  const id=String(checkoutRequestId||"").trim();
  if(!id)throw new Error("CHECKOUT_REQUEST_ID_REQUIRED");

  const timestamp=darajaTimestamp();
  const password=Buffer.from(c.shortCode+c.passkey+timestamp).toString("base64");
  return post("/mpesa/stkpushquery/v1/query",{
    BusinessShortCode:c.shortCode,
    Password:password,
    Timestamp:timestamp,
    CheckoutRequestID:id
  });
}

export function createStkReference(paymentId){
  const raw=String(paymentId||"").replace(/[^A-Za-z0-9]/g,"").slice(0,8).toUpperCase();
  const nonce=crypto.randomBytes(3).toString("hex").toUpperCase();
  return ("STK"+raw+nonce).slice(0,30);
}
