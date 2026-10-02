import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { GoogleGenAI } from "@google/genai";
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
import { requireUser } from "./subscriptions.js";
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
import { evaluateKingbotBrain } from "./kingbot-brain.js";
import { createMt5HostingRouter, ensureMt5HostingSchema } from "./mt5-hosting.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 10000);
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const XAI_MODEL = process.env.XAI_MODEL || "grok-4.7";
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const XAI_BASE_URL = (process.env.XAI_API_BASE_URL || "https://api.x.ai/v1").replace(/\/$/, "");
const AI_PROVIDER = XAI_API_KEY ? "xai" : (GEMINI_API_KEY ? "gemini" : "none");
const DATABASE_URL = process.env.DATABASE_URL || "";
const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false } }) : null;
const broker = new UserBrokerManager({pool});
const twelveData = new TwelveDataFeed();
twelveData.start();
const partners = new PartnerManager({pool});

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));
const allowedOrigin = process.env.FRONTEND_ORIGIN?.trim();
app.use(cors({ origin: allowedOrigin || true, credentials: true, methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));

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
  const redirect=(params)=>{const url=new URL(frontend);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);res.redirect(302,url.toString());};
  try{
    const {clientId,redirectUri}=derivOauthConfig();
    const code=String(req.query?.code||"").trim(),state=String(req.query?.state||"").trim();
    const oauthError=String(req.query?.error_description||req.query?.error||"").trim();
    if(oauthError)throw new Error("DERIV_AUTHORIZATION_DENIED: "+oauthError);
    if(!code||!state)throw new Error("DERIV_OAUTH_CALLBACK_INVALID");
    const pending=await broker.consumeDerivOAuthState(state);
    if(!pending)throw new Error("DERIV_OAUTH_STATE_INVALID_OR_EXPIRED");
    const form=new URLSearchParams({grant_type:"authorization_code",client_id:clientId,code,code_verifier:pending.code_verifier,redirect_uri:redirectUri});
    const tokenPayload=await derivOauthJson("/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form.toString()});
    const response=await fetch("https://api.derivws.com/trading/v1/options/accounts",{headers:{Authorization:"Bearer "+String(tokenPayload?.access_token||"")}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(body?.errors?.[0]?.message||body?.message||("DERIV_ACCOUNT_LIST_FAILED_"+response.status));
    const accounts=Array.isArray(body?.data)?body.data:(body?.data?[body.data]:[]);
    const finalized=await broker.finalizeDerivOAuthState({state,tokenPayload,accounts});
    redirect({deriv_pending:finalized.pending_id,executionMode:finalized.execution_mode});
  }catch(error){redirect({deriv_error:String(error?.message||"DERIV_OAUTH_CALLBACK_FAILED")});}
});
app.get("/api/broker/deriv/oauth/pending",async(req,res)=>{
  try{
    const user=await requireUser(pool,req,res);if(!user)return;
    const pending=await broker.getDerivOAuthPending({userId:user.id,pendingId:req.query?.pendingId});
    if(!pending)return res.status(404).json({ok:false,error:"DERIV_OAUTH_PENDING_NOT_FOUND"});
    res.json({ok:true,pendingId:pending.pending_id,executionMode:pending.execution_mode,accounts:pending.accounts});
  }catch(error){res.status(503).json({ok:false,error:String(error?.message||"DERIV_OAUTH_PENDING_FAILED")});}
});
app.post("/api/broker/deriv/oauth/connect",async(req,res)=>{
  try{
    const user=await requireUser(pool,req,res);if(!user)return;
    const accountId=String(req.body?.accountId||"").trim(),accountType=String(req.body?.accountType||"").toLowerCase(),pendingId=String(req.body?.pendingId||req.body?.connection?.pendingId||"").trim();
    if(!accountId||!["demo","real"].includes(accountType)||!pendingId)return res.status(400).json({ok:false,error:"DERIV_ACCOUNT_SELECTION_REQUIRED"});
    const pending=await broker.consumeDerivOAuthPending({userId:user.id,pendingId});
    if(!pending)return res.status(409).json({ok:false,error:"DERIV_OAUTH_PENDING_NOT_FOUND"});
    const account=pending.accounts.find(item=>String(item?.account_id||item?.id||"")===accountId);
    if(!account)return res.status(403).json({ok:false,error:"DERIV_ACCOUNT_NOT_AUTHORIZED"});
    const actualType=String(account?.account_type||account?.accountType||"").toLowerCase();
    if(actualType&&actualType!==accountType)return res.status(409).json({ok:false,error:"DERIV_ACCOUNT_TYPE_MISMATCH"});
    const mode=accountType==="real"?"LIVE":"DEMO";
    if(pending.execution_mode!==mode)return res.status(409).json({ok:false,error:"DERIV_EXECUTION_MODE_ACCOUNT_MISMATCH"});
    const saved=await broker.saveMapping({userId:user.id,provider:"deriv",accountId,accountToken:JSON.stringify({...pending.token,accountType}),executionMode:mode,derivAccountType:accountType});
    if(!saved?.ok)return res.status(409).json(saved);
    const connected=await broker.connect(user.id,mode);
    if(!connected?.connected)return res.status(503).json({ok:false,error:"DERIV_CONNECTION_FAILED",reason:connected?.reason||"DERIV_CONNECTION_FAILED"});
    res.json({ok:true,...connected});
  }catch(error){res.status(503).json({ok:false,error:String(error?.message||"DERIV_OAUTH_CONNECT_FAILED")});}
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
registerAiMarketScanner(app, { requireUser, pool, broker, rateLimit, twelveData });
registerAiAgent(app, { requireUser, pool, broker, rateLimit, twelveData });
registerTerminalLive(app, { requireUser, pool, broker, firstFinite });
registerElevenLabsVoice(app, { requireUser, pool, rateLimit });
registerAiIntelligence(app, { requireUser, pool, broker });

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "KINGBOT Intelligence",
    aiReady: Boolean(XAI_API_KEY || GEMINI_API_KEY),
    aiProvider: AI_PROVIDER,
    aiModel: AI_PROVIDER === "xai" ? XAI_MODEL : (AI_PROVIDER === "gemini" ? GEMINI_MODEL : null),
    accountServiceReady: true,
    passwordRecoveryEmailReady: true,
    voiceReady: Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID),
    voiceProvider: "elevenlabs",
    voiceModel: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
    webResearch: webSearchStatus()
  });
});

app.use(express.static(path.resolve(__dirname, "../../")));
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Route not found." });
});

ensureAuthSchema(pool).then(() => ensureSubscriptionSchema(pool)).then(() => ensureBotEngineSchema(pool)).then(() => ensureBotRuntimeSchema(pool)).then(() => broker.ensureSchema()).then(() => ensureMt5BridgeSchema(pool)).then(() => ensureMt5HostingSchema(pool)).then(() => ensureAiMarketScannerSchema(pool)).then(() => partners.ensureSchema(pool)).then(() => {
  app.listen(PORT, () => {
    console.log(`KINGBOT FINTECH backend listening on port ${PORT}`);
    void startWorker().then(() => {}).catch((error) => console.error("[KINGBOT WORKER]", error?.message || error));
  });
}).catch((error) => {
  console.error("[KINGBOT] Startup initialization failed:", error?.message || error);
  process.exit(1);
});
