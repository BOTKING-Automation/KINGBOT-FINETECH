import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import crypto from "node:crypto";
import { createAuthRouter, ensureAuthSchema } from "./auth.js";
import { createSubscriptionRouter, ensureSubscriptionSchema } from "./subscriptions.js";
import { createBotEngineRouter, ensureBotEngineSchema } from "./bot-engines.js";
import { UserBrokerManager } from "./user-broker-manager.js";
import { DerivTraderClient } from "./deriv-trader-client.js";
import { getDerivMarketFeed } from "./deriv-market-feed.js";
import { PartnerManager } from "./partner-manager.js";
import { requireUser, requireRecentAuth } from "./subscriptions.js";
import { isAdminEmail } from "./admin-access.js";
import { createBotRuntimeRouter, ensureBotRuntimeSchema } from "./bot-runtime.js";
import { startWorker } from "./worker.js";
import { createMt5BridgeRouter, ensureMt5BridgeSchema } from "./mt5-bridge-router.js";
import { mt5BridgeRegistry } from "./mt5-bridge.js";
import { registerTerminalSnapshot } from "./terminal-snapshot.js";
import { registerAiMarketScanner, ensureAiMarketScannerSchema } from "./ai-market-scanner.js";
import { registerTerminalLive } from "./terminal-live.js";
import { registerElevenLabsVoice } from "./elevenlabs-voice.js";
import { registerAiIntelligence } from "./ai-intelligence.js";
import { webSearchStatus } from "./kingbot-web-search.js";
import { registerAiAgent } from "./ai-agent.js";
import { TwelveDataFeed } from "./twelve-data-feed.js";
import { getMarketPageSnapshot, marketPageSymbols } from "./market-page-feed.js";
import { evaluateKingbotBrain } from "./kingbot-brain.js";
import { createMt5HostingRouter, ensureMt5HostingSchema } from "./mt5-hosting.js";
import { createFintechOpsRouter, ensureFintechOpsSchema } from "./fintech-operations.js";
import { ensureGlobalRiskSchema, getGlobalRiskState } from "./global-risk.js";
import { registerGoldSignals, ensureGoldSignalsSchema } from "./gold-signals.js";
import { syntheticCatalog, CORE_SYNTHETIC_FAMILIES } from "./synthetic-markets.js";
import { registerIntelligenceOrchestrator, ensureIntelligenceOrchestratorSchema } from "./intelligence-orchestrator.js";
import { KingbotEventBus, registerKingbotEventRoutes } from "./kingbot-event-bus.js";
import { ensureCommercialLedgerSchema, registerCommercialLedgerRoutes } from "./commercial-ledger.js";
import { ensureUserMemorySchema } from "./kingbot-user-memory.js";
import { registerCommandPlane } from "./command-plane.js";
import { requestSecurity, corsOptions, createApiLimiter, createWriteLimiter } from "./security.js";
import { ensureAuditIntegritySchema, verifyAuditChain } from "./audit-integrity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 10000);
const AI_PROVIDER = "kingbot-native";
const DATABASE_URL = process.env.DATABASE_URL || "";
const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false } }) : null;
const broker = new UserBrokerManager({pool});
const twelveData = new TwelveDataFeed();
twelveData.start();
const partners = new PartnerManager({pool});
const eventBus = new KingbotEventBus({pool,name:"kingbot-api"});

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(requestSecurity);
app.use(express.json({ limit: "512kb", strict: true }));
app.use(cors(corsOptions()));
app.use("/api", createApiLimiter());
app.use("/api/broker", createWriteLimiter());
app.use("/api/runtime", createWriteLimiter());
app.use("/api/mt5", createWriteLimiter());
app.use("/api/subscription", createWriteLimiter());

const authLimiter = rateLimit({ windowMs: 15*60*1000, limit: 12, standardHeaders: "draft-8", legacyHeaders: false });
app.use("/api/auth", createAuthRouter({ pool, sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 24), limiter: authLimiter }));
app.use("/api/subscription", createSubscriptionRouter({ pool, broker }));
app.get("/api/subscription/status", async (req,res)=>{
  try{
    const user=await requireUser(pool,req,res); if(!user)return;
    const q=await pool.query("SELECT plan_id,status,expires_at,created_at FROM kingbot_subscriptions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5",[user.id]);
    const active=q.rows.find(r=>r.status==='active'&&(!r.expires_at||new Date(r.expires_at)>new Date()))||null;
    res.json({ok:true,subscription:active,plans:q.rows,source:"subscription-status-alias"});
  }catch(e){res.status(503).json({ok:false,error:"SUBSCRIPTION_STATUS_UNAVAILABLE"});}
});
app.use("/api/bots", createBotEngineRouter({ pool }));
app.use("/api/runtime", createBotRuntimeRouter({ pool, broker }));
app.use("/api/mt5/bridge", createMt5BridgeRouter({ pool, broker }));
app.use("/api/mt5/hosting", createMt5HostingRouter({ pool, requireUser }));
app.use("/api/finops", createFintechOpsRouter({ pool }));
registerGoldSignals(app,{pool,rateLimit,twelveData});

// Generic broker connection API used by Broker Connect, Terminal and account-aware pages.
app.post("/api/broker/account", async (req,res)=>{
  const user=await requireUser(pool,req,res); if(!user)return;
  const provider=String(req.body?.provider||"metaapi").trim().toLowerCase();
  const accountId=String(req.body?.accountId||"").trim();
  const executionMode=String(req.body?.executionMode||"DEMO").toUpperCase();
  if(!accountId)return res.status(400).json({ok:false,error:"BROKER_ACCOUNT_ID_REQUIRED"});
  if(!["DEMO","LIVE"].includes(executionMode))return res.status(400).json({ok:false,error:"INVALID_EXECUTION_MODE"});

  try{
    if(provider==="deriv"||provider==="derivmt5"||provider==="mt5-bridge"){
      return res.status(400).json({ok:false,error:"USE_NATIVE_DERIV_OR_MT5_BRIDGE_FLOW"});
    }

    if(provider==="exness"){
      if(!/^[0-9]{1,20}$/.test(accountId))return res.status(400).json({ok:false,error:"INVALID_EXNESS_ACCOUNT_ID"});
      const apiKey=String(req.body?.apiKey||"").trim();
      const secretKey=String(req.body?.secretKey||"").trim();
      const baseUrl=String(req.body?.baseUrl||"").trim();
      if(!apiKey)return res.status(400).json({ok:false,error:"EXNESS_API_KEY_REQUIRED"});
      if(!secretKey)return res.status(400).json({ok:false,error:"EXNESS_SECRET_KEY_REQUIRED"});
      if(baseUrl && !/^https:\/\//i.test(baseUrl))return res.status(400).json({ok:false,error:"EXNESS_BASE_URL_MUST_USE_HTTPS"});
      const saved=await broker.saveMapping({userId:user.id,provider:"exness",accountId,executionMode,apiKey,secretKey,baseUrl});
      if(saved?.ok===false)return res.status(saved.error==="BROKER_ALREADY_CONNECTED"?409:400).json(saved);
      return res.status(201).json(saved);
    }

    if(provider==="oanda"){
      const token=String(req.body?.accountToken||"").trim();
      const baseUrl=String(req.body?.baseUrl||"").trim();
      if(!token)return res.status(400).json({ok:false,error:"OANDA_API_TOKEN_REQUIRED"});
      if(baseUrl && !/^https:\/\//i.test(baseUrl))return res.status(400).json({ok:false,error:"OANDA_BASE_URL_MUST_USE_HTTPS"});
      const saved=await broker.saveMapping({userId:user.id,provider:"oanda",accountId,executionMode,accountToken:token,baseUrl});
      if(saved?.ok===false)return res.status(saved.error==="BROKER_ALREADY_CONNECTED"?409:400).json(saved);
      return res.status(201).json(saved);
    }

    const accountToken=String(req.body?.accountToken||"").trim();
    if(!accountToken)return res.status(400).json({ok:false,error:"BROKER_ACCOUNT_TOKEN_REQUIRED"});
    if(!/^[A-Za-z0-9._:-]{3,100}$/.test(accountId))return res.status(400).json({ok:false,error:"INVALID_BROKER_ACCOUNT_ID"});
    const saved=await broker.saveMapping({
      userId:user.id,
      provider:provider||"metaapi",
      accountId,
      accountToken,
      executionMode,
      baseUrl:String(req.body?.baseUrl||"").trim()
    });
    if(saved?.ok===false)return res.status(saved.error==="BROKER_ALREADY_CONNECTED"?409:400).json(saved);
    return res.status(201).json(saved);
  }catch(error){
    console.error("[KINGBOT BROKER] account mapping failed:",error?.message||error);
    return res.status(500).json({
      ok:false,
      error:"BROKER_ACCOUNT_MAPPING_FAILED",
      reason:String(error?.message||"BROKER_ACCOUNT_MAPPING_FAILED").slice(0,220)
    });
  }
});

app.get("/api/broker/markets", async (req,res)=>{
  const user=await requireUser(pool,req,res);
  if(!user)return;
  try{
    const mapping=await broker.getMapping(user.id);
    const result=await broker.getMarkets(user.id);
    const markets=Array.isArray(result?.data)?result.data:[];
    return res.json({
      ok:true,
      connected:Boolean(result?.connected!==false),
      broker:String(mapping?.provider||result?.broker||"").toLowerCase()||undefined,
      markets,
      count:markets.length,
      generatedAt:new Date().toISOString(),
      source:"connected-broker-catalog"
    });
  }catch(error){
    const message=String(error?.message||"BROKER_MARKETS_UNAVAILABLE");
    return res.status(503).json({
      ok:false,
      error:"BROKER_MARKETS_UNAVAILABLE",
      reason:message.slice(0,240),
      message:"The connected broker did not return an authoritative market catalog. No market was selected."
    });
  }
});

app.get("/api/broker/identity", async (req,res)=>{
  const user=await requireUser(pool,req,res); if(!user)return;
  try{
    const identity=await broker.getStoredIdentity(user.id);
    res.json({ok:true,...identity});
  }catch(error){
    console.error("[KINGBOT BROKER] stored identity lookup failed:",error?.message||error);
    res.status(503).json({ok:false,error:"BROKER_IDENTITY_UNAVAILABLE",reason:String(error?.message||"BROKER_IDENTITY_UNAVAILABLE").slice(0,220)});
  }
});

app.get("/api/markets/live", async (req,res)=>{
  try{
    const includeSynthetics=String(req.query?.synthetics ?? "true").toLowerCase() !== "false";
    const snapshot=await getMarketPageSnapshot({twelveData,includeSynthetics});
    res.json({
      ...snapshot,
      endpoint:"/api/markets/live",
      trackedSymbols:marketPageSymbols({includeSynthetics})
    });
  }catch(error){
    console.error("[KINGBOT SHARED MARKET FEED]",error?.message||error);
    res.status(503).json({
      ok:false,
      provider:"KINGBOT_SHARED_MARKET_FEED",
      error:"SHARED_MARKET_FEED_UNAVAILABLE",
      reason:String(error?.message||"SHARED_MARKET_FEED_UNAVAILABLE").slice(0,220)
    });
  }
});

let syntheticCatalogCache={at:0,items:[]};
app.get("/api/markets/synthetics", async (_req,res)=>{
  try{
    if(syntheticCatalogCache.items.length && Date.now()-syntheticCatalogCache.at<30000){
      return res.json({ok:true,marketType:"SYNTHETIC",families:CORE_SYNTHETIC_FAMILIES,markets:syntheticCatalogCache.items,cached:true});
    }
    const rows=await getDerivMarketFeed().getActiveSymbols({timeoutMs:7000});
    const markets=syntheticCatalog(rows);
    syntheticCatalogCache={at:Date.now(),items:markets};
    res.json({ok:true,marketType:"SYNTHETIC",families:CORE_SYNTHETIC_FAMILIES,markets,generatedAt:new Date().toISOString()});
  }catch(error){
    res.status(503).json({ok:false,error:"SYNTHETIC_MARKETS_UNAVAILABLE",reason:String(error?.message||"SYNTHETIC_MARKETS_UNAVAILABLE").slice(0,180)});
  }
});

app.get("/api/markets/synthetics/quotes", async (req,res)=>{
  try{
    const raw=String(req.query?.symbols||"").split(",").map(x=>x.trim().toUpperCase()).filter(Boolean).slice(0,30);
    if(!raw.length)return res.status(400).json({ok:false,error:"SYNTHETIC_SYMBOLS_REQUIRED"});
    const feed=getDerivMarketFeed();
    const quotes=await Promise.all(raw.map(async symbol=>{
      try{
        const quote=await feed.getQuote(symbol,{maxAgeMs:3000,timeoutMs:5000});
        return {symbol,brokerSymbol:quote.brokerSymbol||symbol,price:quote.price,bid:quote.bid,ask:quote.ask,time:quote.time,epoch:quote.epoch,ageMs:quote.ageMs||0,available:true,source:"deriv-public-live"};
      }catch(error){
        return {symbol,available:false,error:String(error?.message||"SYNTHETIC_QUOTE_UNAVAILABLE").slice(0,120)};
      }
    }));
    res.json({ok:true,marketType:"SYNTHETIC",quotes,generatedAt:new Date().toISOString()});
  }catch(error){
    res.status(503).json({ok:false,error:"SYNTHETIC_QUOTES_UNAVAILABLE",reason:String(error?.message||"SYNTHETIC_QUOTES_UNAVAILABLE").slice(0,180)});
  }
});

app.post("/api/terminal/positions/:positionId/close", async (req,res)=>{
  const user=await requireUser(pool,req,res); if(!user)return;
  const positionId=String(req.params.positionId||"").trim();
  if(!positionId)return res.status(400).json({ok:false,error:"POSITION_ID_REQUIRED"});
  try{
    const result=await broker.closePosition({userId:user.id,positionId});
    await pool.query(
      "INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,'TERMINAL_POSITION_CLOSED',$2::jsonb)",
      [user.id,JSON.stringify({positionId})]
    );
    res.json({ok:true,positionId,...result});
  }catch(error){
    const message=String(error?.message||"BROKER_POSITION_CLOSE_FAILED").slice(0,220);
    const status=/UNSUPPORTED|NOT_CONNECTED|OWNER_MISMATCH|USER_CONTEXT/.test(message)?409:500;
    res.status(status).json({ok:false,error:message});
  }
});

app.get("/api/connection", async (req,res)=>{
  const user=await requireUser(pool,req,res); if(!user)return;
  try{
    const status=await broker.getStatus(user.id);
    res.json({ok:true,...status});
  }catch(error){
    console.error("[KINGBOT BROKER] connection status failed:",error?.message||error);
    res.status(503).json({ok:false,error:"BROKER_CONNECTION_STATUS_UNAVAILABLE",reason:String(error?.message||"BROKER_CONNECTION_STATUS_UNAVAILABLE").slice(0,220)});
  }
});

app.post("/api/broker/connect", async (req,res)=>{
  const user=await requireUser(pool,req,res); if(!user)return;
  const requestedMode=String(req.body?.executionMode||"DEMO").toUpperCase();
  const mode=requestedMode==="PAPER"?"DEMO":requestedMode;
  if(!["DEMO","LIVE"].includes(mode))return res.status(400).json({ok:false,error:"INVALID_EXECUTION_MODE"});
  try{
    const result=await broker.connect(user.id,mode);
    if(!result?.connected)return res.status(503).json({ok:false,...result});
    const provider=String(result?.broker||"").toLowerCase();
    const partnerSlug=provider==="mt5-bridge"?"deriv":provider;
    if(partnerSlug)await partners.recordActiveConnection({
      userId:user.id,
      brokerSlug:partnerSlug,
      metadata:{accountId:result?.accountId||null,executionMode:result?.mode||mode,bridge:provider==="mt5-bridge"}
    }).catch(error=>console.warn("[KINGBOT PARTNER] active attribution failed:",error?.message||error));
    await eventBus.publish({eventType:"BROKER_CONNECTED",aggregateType:"BROKER",aggregateId:result?.accountId||null,userId:user.id,source:"server.broker.connect",payload:{provider:result?.broker||provider,executionMode:result?.mode||mode,accountId:result?.accountId||null}}).catch(error=>console.warn("[KINGBOT EVENT BUS] broker connect event failed:",error?.message||error));
    res.json({ok:true,...result});
  }catch(error){
    console.error("[KINGBOT BROKER] connect failed:",error?.message||error);
    res.status(502).json({ok:false,error:"BROKER_CONNECTION_FAILED",reason:String(error?.message||"BROKER_CONNECTION_FAILED").slice(0,220)});
  }
});

app.post("/api/broker/disconnect", async (req,res)=>{
  const user=await requireUser(pool,req,res); if(!user)return;
  try{
    const result=await broker.disconnect(user.id);
    await mt5BridgeRegistry.revokeUserTokens(user.id).catch(()=>{});
    if(pool){
      await pool.query("UPDATE kingbot_bot_runtime SET state='STOPPED',last_error=$2,updated_at=NOW() WHERE user_id=$1 AND state='RUNNING'",[user.id,"BROKER_DISCONNECTED"]);
      await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,'BROKER_DISCONNECTED',$2::jsonb)",[user.id,JSON.stringify({stoppedRunningBots:true})]);
    }
    await eventBus.publish({eventType:"BROKER_DISCONNECTED",aggregateType:"BROKER",aggregateId:null,userId:user.id,source:"server.broker.disconnect",severity:"WARN",payload:{stoppedRunningBots:true}}).catch(error=>console.warn("[KINGBOT EVENT BUS] broker disconnect event failed:",error?.message||error));
    res.json({ok:true,...result,stoppedRunningBots:true});
  }catch(error){
    console.error("[KINGBOT BROKER] disconnect failed:",error?.message||error);
    res.status(502).json({ok:false,error:"BROKER_DISCONNECT_FAILED",reason:String(error?.message||"BROKER_DISCONNECT_FAILED").slice(0,220)});
  }
});

app.post("/api/ai/brain", async (req,res)=>{
  try{
    const user=await requireUser(pool,req,res); if(!user)return;
    const market=req.body?.market||req.body||{};
    const result=evaluateKingbotBrain(market,{maxAgeMs:Number(process.env.KINGBOT_BRAIN_MAX_DATA_AGE_MS||5000)});
    res.json(result);
  }catch(error){
    console.error("[KINGBOT BRAIN]",error?.message||error);
    res.status(500).json({ok:false,error:"KINGBOT_BRAIN_FAILED",message:String(error?.message||"Brain evaluation failed").slice(0,220)});
  }
});

function base64Url(buffer){return Buffer.from(buffer).toString("base64url");}
function derivOauthConfig(){
  const clientId=String(process.env.DERIV_OAUTH_CLIENT_ID||"").trim();
  const redirectUri=String(process.env.DERIV_OAUTH_REDIRECT_URI||"").trim();
  const frontendReturn=String(process.env.DERIV_FRONTEND_RETURN_URL||"").trim();
  if(!clientId||!redirectUri)throw new Error("DERIV_OAUTH_NOT_CONFIGURED");
  return {clientId,redirectUri,frontendReturn};
}
async function derivOauthJson(path,options={}){
  const response=await fetch("https://auth.deriv.com"+path,options);
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(body?.error_description||body?.error||body?.message||("DERIV_OAUTH_REQUEST_FAILED_"+response.status));
  return body;
}
app.get("/api/broker/deriv/oauth/start",async(req,res)=>{
  return res.status(410).json({ok:false,error:"DERIV_OPTIONS_ROUTE_DISABLED",message:"KINGBOT Deriv connection is CFD/MT5 only. Connect the Deriv MT5 CFD account through the KINGBOT MT5 Bridge."});
  try{
    const user=await requireUser(pool,req,res);if(!user)return;
    const {clientId,redirectUri,frontendReturn}=derivOauthConfig();
    const mode=String(req.query?.executionMode||"DEMO").toUpperCase();
    if(!["DEMO","LIVE"].includes(mode))return res.status(400).json({ok:false,error:"INVALID_EXECUTION_MODE"});
    const verifier=base64Url(crypto.randomBytes(64));
    const challenge=base64Url(crypto.createHash("sha256").update(verifier).digest());
    const saved=await broker.createDerivOAuthState({userId:user.id,codeVerifier:verifier,executionMode:mode});
    const params=new URLSearchParams({response_type:"code",client_id:clientId,redirect_uri:redirectUri,scope:"trade",state:saved.state,code_challenge:challenge,code_challenge_method:"S256"});
    res.json({ok:true,authorizationUrl:"https://auth.deriv.com/oauth2/auth?"+params.toString(),executionMode:mode,returnUrl:frontendReturn||null});
  }catch(error){res.status(503).json({ok:false,error:String(error?.message||"DERIV_OAUTH_START_FAILED")});}
});
app.get("/api/broker/deriv/oauth/callback",async(req,res)=>{
  const frontend=String(process.env.DERIV_FRONTEND_RETURN_URL||"").trim()||"https://botking-automation.github.io/KINGBOT-FINETECH/broker-connect.html";
  const url=new URL(frontend);
  url.searchParams.set("deriv_error","DERIV_OPTIONS_ROUTE_DISABLED_USE_MT5_CFD_BRIDGE");
  return res.redirect(302,url.toString());
});
app.get("/api/broker/deriv/oauth/pending",async(req,res)=>{
  return res.status(410).json({ok:false,error:"DERIV_OPTIONS_ROUTE_DISABLED",message:"Use the Deriv CFD/MT5 connection flow."});
});
app.post("/api/broker/deriv/oauth/connect",async(req,res)=>{
  return res.status(410).json({ok:false,error:"DERIV_OPTIONS_ROUTE_DISABLED",message:"Options accounts are not supported by KINGBOT CFD execution. Use the Deriv MT5 CFD bridge."});
});
app.get("/api/broker/live-authorization", async (req,res)=>{
  try{
    const user=await requireUser(pool,req,res); if(!user)return;
    const authorization=await broker.getLiveAuthorization(user.id);
    res.json({ok:true,...authorization});
  }catch(error){
    res.status(503).json({ok:false,error:String(error?.message||"LIVE_AUTHORIZATION_STATUS_UNAVAILABLE")});
  }
});

app.post("/api/broker/live-authorization", async (req,res)=>{
  try{
    const user=await requireUser(pool,req,res); if(!user)return;
    const requested=Boolean(req.body?.authorized);
    if(requested && String(req.body?.confirmation||"")!=="ENABLE_LIVE_TRADING"){
      return res.status(400).json({ok:false,error:"LIVE_CONFIRMATION_REQUIRED",message:"Explicit confirmation ENABLE_LIVE_TRADING is required to authorize live execution."});
    }
    const authorization=await broker.setLiveAuthorization(user.id,requested);
    await pool.query(
      "INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,$2,$3::jsonb)",
      [user.id,requested?"LIVE_EXECUTION_AUTHORIZED":"LIVE_EXECUTION_REVOKED",JSON.stringify({provider:authorization.provider,accountId:authorization.accountId,authorizedAt:authorization.authorizedAt})]
    );
    res.json({ok:true,...authorization});
  }catch(error){
    const message=String(error?.message||"LIVE_AUTHORIZATION_UPDATE_FAILED");
    const status=/REQUIRES_REAL|EXECUTION_MODE_REQUIRED|TRADING_DISABLED|NOT_CONFIGURED/.test(message)?409:400;
    res.status(status).json({ok:false,error:message});
  }
});

function firstFinite(...values){
  for(const value of values){
    const n=Number(value);
    if(Number.isFinite(n)) return n;
  }
  return null;
}

registerTerminalSnapshot(app, { requireUser, pool, broker, firstFinite });
registerAiMarketScanner(app, { pool, rateLimit, twelveData });
registerAiAgent(app, { requireUser, pool, broker, rateLimit, twelveData, eventBus });
registerTerminalLive(app, { requireUser, pool, broker, firstFinite });
registerElevenLabsVoice(app, { requireUser, pool, rateLimit });
registerAiIntelligence(app, { requireUser, pool, broker });
registerIntelligenceOrchestrator(app, { requireUser, pool, twelveData });
registerKingbotEventRoutes(app, { requireUser, pool, eventBus });
registerCommercialLedgerRoutes(app,{pool});
registerCommandPlane(app,{pool,broker,twelveData,eventBus});

app.get("/api/admin/security/audit-integrity", async (req,res)=>{
  const a=await requireUser(pool,req,res); if(!a)return;
  if(!isAdminEmail(a.email))return res.status(403).json({ok:false,error:"Administrator access required."});
  try{
    const result=await verifyAuditChain(pool,{limit:Math.min(5000,Number(req.query?.limit)||1000)});
    res.json({ok:result.ok,integrity:result});
  }catch(error){
    res.status(503).json({ok:false,error:"AUDIT_INTEGRITY_CHECK_FAILED"});
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "KINGBOT Intelligence",
    aiReady: true,
    eventBus: eventBus.status(),
    nativeReady: true,
    aiProvider: AI_PROVIDER,
    aiModel: "KINGBOT-CORTEX-1",
    deepReasoningReady: true,
    deepReasoningModel: "KINGBOT-CORTEX-1",
    deepReasoningLevel: "PROPRIETARY_MULTI_PASS",
    accountServiceReady: true,
    passwordRecoveryEmailReady: true,
    voiceReady: Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID),
    voiceProvider: "elevenlabs",
    voiceModel: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
    webResearch: webSearchStatus(),
    fintechOperations: true,
    customerWallet: false,
    internalLedger: true,
    centralizedRiskControl: true,
    workerHeartbeatMonitoring: true,
    brokerReconciliation: true,
    adaptiveIntelligence: true,
    adaptiveOutcomeLearning: true,
    unifiedCommandPlane: true,
    commercialRevenueLedger: true
  });
});

app.get("/api/execution-control", async (req,res)=>{
  const user=await requireUser(pool,req,res);if(!user)return;
  try{
    const state=await getGlobalRiskState(pool);
    res.json({ok:true,executionControl:{
      newOrdersAuthorized:!state.tradingPaused&&!state.globalKillSwitch,
      tradingPaused:state.tradingPaused,
      globalKillSwitch:state.globalKillSwitch,
      reason:state.reason,
      updatedAt:state.updatedAt
    }});
  }catch(error){
    res.status(503).json({ok:false,error:"EXECUTION_CONTROL_UNAVAILABLE"});
  }
});

app.use(express.static(path.resolve(__dirname, "../../")));
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Route not found." });
});

ensureAuthSchema(pool).then(() => ensureAuditIntegritySchema(pool)).then(() => ensureSubscriptionSchema(pool)).then(() => ensureBotEngineSchema(pool)).then(() => ensureBotRuntimeSchema(pool)).then(() => broker.ensureSchema()).then(() => ensureMt5BridgeSchema(pool)).then(() => ensureMt5HostingSchema(pool)).then(() => ensureFintechOpsSchema(pool)).then(() => ensureGlobalRiskSchema(pool)).then(() => ensureGoldSignalsSchema(pool)).then(() => ensureAiMarketScannerSchema(pool)).then(() => ensureIntelligenceOrchestratorSchema(pool)).then(() => partners.ensureSchema()).then(() => eventBus.ensureSchema()).then(() => ensureUserMemorySchema(pool)).then(() => ensureCommercialLedgerSchema(pool)).then(() => {
  eventBus.start().catch(error => console.warn("[KINGBOT EVENT BUS] startup deferred:",error?.message||error));
  app.listen(PORT, () => {
    console.log(`KINGBOT FINTECH backend listening on port ${PORT}`);
    void startWorker({eventBus}).then(() => {}).catch((error) => console.error("[KINGBOT WORKER]", error?.message || error));
  });
}).catch((error) => {
  console.error("[KINGBOT] Startup initialization failed:", error?.message || error);
  process.exit(1);
});
