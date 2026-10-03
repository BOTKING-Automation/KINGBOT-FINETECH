import { Router } from "express";
import { getBotDefinitions } from "./bot-engines.js";
import { isAdminEmail } from "./admin-access.js";

const STAGES=new Set(["BACKTEST","WALK_FORWARD","OUT_OF_SAMPLE","MONTE_CARLO","DEMO","LIVE_SMALL","LIVE_SCALE"]);
const STATUSES=new Set(["PENDING","QUALIFIED","REJECTED"]);

function clean(v,max=500){return String(v??"").trim().slice(0,max);}

export async function ensureStrategyValidationSchema(pool){
  if(!pool)return;
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_strategy_validation_runs(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '1.0.0',
    stage TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    symbol TEXT,
    timeframe TEXT,
    sample_start TIMESTAMPTZ,
    sample_end TIMESTAMPTZ,
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
    methodology TEXT,
    notes TEXT,
    created_by UUID REFERENCES kingbot_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES kingbot_users(id) ON DELETE SET NULL
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_validation_lookup_idx ON kingbot_strategy_validation_runs(bot_id,version,stage,status,created_at DESC)");
}

export async function getValidationState(pool,{botId,version="1.0.0"}={}){
  if(!pool)return {ready:false,enforcement:false,stages:{}};
  const q=await pool.query("SELECT stage,status,metrics,evidence,reviewed_at FROM kingbot_strategy_validation_runs WHERE bot_id=$1 AND version=$2 ORDER BY created_at DESC",[botId,version]);
  const stages={};
  for(const stage of STAGES){
    const row=q.rows.find(x=>String(x.stage)===stage&&String(x.status)==="QUALIFIED");
    stages[stage]=Boolean(row);
  }
  const enforcement=String(process.env.KINGBOT_VALIDATION_ENFORCEMENT||"0")==="1";
  const liveReady=stages.BACKTEST&&stages.WALK_FORWARD&&stages.OUT_OF_SAMPLE&&stages.MONTE_CARLO&&stages.DEMO;
  return {ready:liveReady,enforcement,stages};
}

export function createStrategyValidationRouter({pool,requireUser}={}){
  const router=Router();
  const admin=async(req,res)=>{const u=await requireUser(pool,req,res);if(!u)return null;if(!isAdminEmail(u.email)){res.status(403).json({ok:false,error:"Administrator access required."});return null;}return u;};

  router.get("/runs",async(req,res)=>{
    const u=await requireUser(pool,req,res);if(!u)return;
    const botId=clean(req.query?.botId,80),version=clean(req.query?.version,30)||"1.0.0";
    const q=botId?await pool.query("SELECT * FROM kingbot_strategy_validation_runs WHERE bot_id=$1 AND version=$2 ORDER BY created_at DESC LIMIT 300",[botId,version])
      :await pool.query("SELECT * FROM kingbot_strategy_validation_runs ORDER BY created_at DESC LIMIT 300");
    res.json({ok:true,runs:q.rows});
  });

  router.get("/state/:botId",async(req,res)=>{
    const u=await requireUser(pool,req,res);if(!u)return;
    const version=clean(req.query?.version,30)||"1.0.0";
    if(!getBotDefinitions()[req.params.botId])return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    res.json({ok:true,botId:req.params.botId,version,state:await getValidationState(pool,{botId:req.params.botId,version})});
  });

  router.post("/runs",async(req,res)=>{
    const u=await requireUser(pool,req,res);if(!u)return;
    const botId=clean(req.body?.botId,80),version=clean(req.body?.version,30)||"1.0.0",stage=clean(req.body?.stage,30).toUpperCase();
    if(!getBotDefinitions()[botId])return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    if(!STAGES.has(stage))return res.status(400).json({ok:false,error:"INVALID_VALIDATION_STAGE"});
    const metrics=req.body?.metrics&&typeof req.body.metrics==="object"?req.body.metrics:{};
    const evidence=Array.isArray(req.body?.evidence)?req.body.evidence.slice(0,20):[];
    const q=await pool.query(`INSERT INTO kingbot_strategy_validation_runs(bot_id,version,stage,status,symbol,timeframe,sample_start,sample_end,metrics,evidence,methodology,notes,created_by)
      VALUES($1,$2,$3,'PENDING',$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12) RETURNING *`,
      [botId,version,stage,clean(req.body?.symbol,40)||null,clean(req.body?.timeframe,20)||null,req.body?.sampleStart||null,req.body?.sampleEnd||null,JSON.stringify(metrics),JSON.stringify(evidence),clean(req.body?.methodology,1600),clean(req.body?.notes,1600),u.id]);
    res.status(201).json({ok:true,run:q.rows[0]});
  });

  router.post("/runs/:id/review",async(req,res)=>{
    const a=await admin(req,res);if(!a)return;
    const status=clean(req.body?.status,20).toUpperCase();
    if(!STATUSES.has(status))return res.status(400).json({ok:false,error:"INVALID_VALIDATION_STATUS"});
    const q=await pool.query("UPDATE kingbot_strategy_validation_runs SET status=$2,reviewed_at=NOW(),reviewed_by=$3 WHERE id=$1 RETURNING *",[req.params.id,status,a.id]);
    if(!q.rowCount)return res.status(404).json({ok:false,error:"VALIDATION_RUN_NOT_FOUND"});
    res.json({ok:true,run:q.rows[0]});
  });

  return router;
}
