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
import { registerAiMarketScanner } from "./ai-market-scanner.js";
import { registerTerminalLive } from "./terminal-live.js";
import { registerElevenLabsVoice } from "./elevenlabs-voice.js";
import { registerAiIntelligence } from "./ai-intelligence.js";

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

function firstFinite(...values){
  for(const value of values){
    const n=Number(value);
    if(Number.isFinite(n)) return n;
  }
  return null;
}

registerTerminalSnapshot(app, { requireUser, pool, broker, firstFinite });
registerAiMarketScanner(app, { requireUser, pool, broker, rateLimit });
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
    voiceModel: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5"
  });
});

app.use(express.static(path.resolve(__dirname, "../../")));
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Route not found." });
});

ensureAuthSchema(pool).then(() => ensureSubscriptionSchema(pool)).then(() => ensureBotEngineSchema(pool)).then(() => ensureBotRuntimeSchema(pool)).then(() => broker.ensureSchema()).then(() => ensureMt5BridgeSchema(pool)).then(() => partners.ensureSchema()).then(() => {
  app.listen(PORT, () => {
    console.log(`KINGBOT FINTECH backend listening on port ${PORT}`);
    void startWorker().then(() => {}).catch((error) => console.error("[KINGBOT WORKER]", error?.message || error));
  });
}).catch((error) => {
  console.error("[KINGBOT] Startup initialization failed:", error?.message || error);
  process.exit(1);
});
