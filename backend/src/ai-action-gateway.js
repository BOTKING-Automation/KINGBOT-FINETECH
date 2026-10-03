import { Router } from "express";
import { normalizeRiskSettings, getBotDefinitions } from "./bot-engines.js";
import { isAdminEmail } from "./admin-access.js";

function clean(v,max=200){return String(v??"").trim().slice(0,max);}
function allowedAction(action){return ["PAUSE_BOT","RESUME_BOT","REDUCE_RISK"].includes(String(action||"").toUpperCase());}

export async function ensureAiActionSchema(pool){
  if(!pool)return;
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_ai_action_proposals(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    rationale TEXT,
    source TEXT NOT NULL DEFAULT 'KINGBOT_AI',
    status TEXT NOT NULL DEFAULT 'PENDING',
    proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW()+INTERVAL '10 minutes'),
    confirmed_at TIMESTAMPTZ,
    confirmed_by UUID REFERENCES kingbot_users(id) ON DELETE SET NULL,
    rejected_at TIMESTAMPTZ
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_ai_action_pending_idx ON kingbot_ai_action_proposals(user_id,status,proposed_at DESC)");
}

async function requireUser(pool,req,res,baseRequireUser){
  const u=await baseRequireUser(pool,req,res);return u||null;
}

export function createAiActionRouter({pool,requireUser}={}){
  const router=Router();
  router.get("/pending",async(req,res)=>{
    const u=await requireUser(pool,req,res,requireUser);if(!u)return;
    const q=await pool.query(`SELECT id,bot_id,action_type,payload,rationale,source,proposed_at,expires_at,status
      FROM kingbot_ai_action_proposals WHERE user_id=$1 AND status='PENDING' AND expires_at>NOW()
      ORDER BY proposed_at DESC LIMIT 50`,[u.id]);
    res.json({ok:true,actions:q.rows});
  });
  router.post("/propose",async(req,res)=>{
    const u=await requireUser(pool,req,res,requireUser);if(!u)return;
    const action=clean(req.body?.actionType,40).toUpperCase(),botId=clean(req.body?.botId,60);
    if(!allowedAction(action))return res.status(400).json({ok:false,error:"AI_ACTION_NOT_ALLOWED"});
    if(!getBotDefinitions()[botId])return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    const payload=req.body?.payload&&typeof req.body.payload==="object"?req.body.payload:{};
    if(action==="REDUCE_RISK"){
      const requested=normalizeRiskSettings(payload,{maxRiskPerTradePct:getBotDefinitions()[botId].risk.maxRiskPerTradePct,maxPositions:getBotDefinitions()[botId].risk.maxPositions});
      if(Number(requested.maxRiskPerTradePct)>Number(getBotDefinitions()[botId].risk.maxRiskPerTradePct))return res.status(400).json({ok:false,error:"AI_CANNOT_INCREASE_BOT_RISK_CEILING"});
      payload.dailyDrawdownPct=Math.min(Number(requested.dailyDrawdownPct),5);
      payload.totalDrawdownPct=Math.min(Number(requested.totalDrawdownPct),10);
      payload.maxRiskPerTradePct=Math.min(Number(requested.maxRiskPerTradePct),Number(getBotDefinitions()[botId].risk.maxRiskPerTradePct));
      payload.maxPositions=Math.max(1,Math.min(Number(requested.maxPositions),Number(getBotDefinitions()[botId].risk.maxPositions)));
    }
    const rationale=clean(req.body?.rationale,1000)||"KINGBOT AI proposed an operational action.";
    const q=await pool.query(`INSERT INTO kingbot_ai_action_proposals(user_id,bot_id,action_type,payload,rationale,source)
      VALUES($1,$2,$3,$4::jsonb,$5,$6) RETURNING id,bot_id,action_type,payload,rationale,source,proposed_at,expires_at,status`,
      [u.id,botId,action,JSON.stringify(payload),rationale,clean(req.body?.source,50)||"KINGBOT_AI"]);
    res.status(201).json({ok:true,action:q.rows[0],confirmationRequired:true,confirmationPhrase:"CONFIRM_KINGBOT_ACTION"});
  });
  router.post("/:id/confirm",async(req,res)=>{
    const u=await requireUser(pool,req,res,requireUser);if(!u)return;
    if(String(req.body?.confirmation||"")!=="CONFIRM_KINGBOT_ACTION")return res.status(400).json({ok:false,error:"EXPLICIT_CONFIRMATION_REQUIRED"});
    const q=await pool.query("SELECT * FROM kingbot_ai_action_proposals WHERE id=$1 AND user_id=$2 LIMIT 1",[req.params.id,u.id]);
    if(!q.rowCount)return res.status(404).json({ok:false,error:"AI_ACTION_NOT_FOUND"});
    const action=q.rows[0];
    if(action.status!=="PENDING"||new Date(action.expires_at).getTime()<=Date.now())return res.status(409).json({ok:false,error:"AI_ACTION_EXPIRED_OR_ALREADY_HANDLED"});
    const bot=getBotDefinitions()[action.bot_id];if(!bot)return res.status(404).json({ok:false,error:"BOT_NOT_FOUND"});
    const payload=action.payload&&typeof action.payload==="object"?action.payload:{};
    if(action.action_type==="PAUSE_BOT"){
      await pool.query("UPDATE kingbot_bot_runtime SET state='PAUSED',last_error='PAUSED_BY_CONFIRMED_AI_ACTION',updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[u.id,action.bot_id]);
    }else if(action.action_type==="RESUME_BOT"){
      const connected=await pool.query("SELECT 1 FROM kingbot_broker_accounts WHERE user_id=$1 AND enabled=TRUE LIMIT 1",[u.id]);
      if(!connected.rowCount)return res.status(409).json({ok:false,error:"BROKER_CONNECTION_REQUIRED"});
      await pool.query("UPDATE kingbot_bot_runtime SET state='RUNNING',last_error=NULL,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[u.id,action.bot_id]);
    }else if(action.action_type==="REDUCE_RISK"){
      const current=await pool.query("SELECT * FROM kingbot_bot_risk_settings WHERE user_id=$1 AND bot_id=$2",[u.id,action.bot_id]);
      const existing=current.rowCount?current.rows[0]:null;
      const next=normalizeRiskSettings(existing?{
        dailyDrawdownPct:Math.min(Number(existing.daily_drawdown_pct),Number(payload.dailyDrawdownPct||existing.daily_drawdown_pct)),
        totalDrawdownPct:Math.min(Number(existing.total_drawdown_pct),Number(payload.totalDrawdownPct||existing.total_drawdown_pct)),
        maxRiskPerTradePct:Math.min(Number(existing.max_risk_per_trade_pct),Number(payload.maxRiskPerTradePct||existing.max_risk_per_trade_pct)),
        maxPositions:Math.min(Number(existing.max_positions),Number(payload.maxPositions||existing.max_positions))
      }:{...payload},bot.risk);
      await pool.query(`INSERT INTO kingbot_bot_risk_settings(user_id,bot_id,daily_drawdown_pct,total_drawdown_pct,max_risk_per_trade_pct,max_positions,lot_size,max_spread_atr_ratio,stale_data_ms,max_consecutive_losses,auto_pause_on_loss_streak,execution_mode,kill_switch)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT(user_id,bot_id) DO UPDATE SET daily_drawdown_pct=EXCLUDED.daily_drawdown_pct,total_drawdown_pct=EXCLUDED.total_drawdown_pct,max_risk_per_trade_pct=EXCLUDED.max_risk_per_trade_pct,max_positions=EXCLUDED.max_positions,updated_at=NOW()`,
        [u.id,action.bot_id,next.dailyDrawdownPct,next.totalDrawdownPct,next.maxRiskPerTradePct,next.maxPositions,Number(existing?.lot_size||bot.risk.lotSize||0.01),Number(existing?.max_spread_atr_ratio||0.25),Number(existing?.stale_data_ms||5000),Number(existing?.max_consecutive_losses||3),Boolean(existing?.auto_pause_on_loss_streak??true),String(existing?.execution_mode||"DEMO"),Boolean(existing?.kill_switch)]);
    }
    const updated=await pool.query("UPDATE kingbot_ai_action_proposals SET status='CONFIRMED',confirmed_at=NOW(),confirmed_by=$2 WHERE id=$1 RETURNING *",[action.id,u.id]);
    await pool.query("INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,'AI_ACTION_CONFIRMED',$2::jsonb)",[u.id,JSON.stringify({actionId:action.id,botId:action.bot_id,actionType:action.action_type})]);
    res.json({ok:true,action:updated.rows[0],executed:true});
  });
  router.post("/:id/reject",async(req,res)=>{
    const u=await requireUser(pool,req,res,requireUser);if(!u)return;
    const q=await pool.query("UPDATE kingbot_ai_action_proposals SET status='REJECTED',rejected_at=NOW() WHERE id=$1 AND user_id=$2 AND status='PENDING' RETURNING id,status",[req.params.id,u.id]);
    if(!q.rowCount)return res.status(404).json({ok:false,error:"AI_ACTION_NOT_FOUND"});
    res.json({ok:true,action:q.rows[0]});
  });
  return router;
}
