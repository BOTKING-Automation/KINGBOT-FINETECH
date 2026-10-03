import "dotenv/config";
import { Router } from "express";
import { requireUser } from "./subscriptions.js";
import { isAdminEmail } from "./admin-access.js";
import { getDerivMarketFeed } from "./deriv-market-feed.js";

const publicDerivFeed = getDerivMarketFeed();

const SIGNAL_STATES = ["DRAFT","PUBLISHED","CLOSED","CANCELLED"];
const DIRECTIONS = ["BUY","SELL","WAIT"];
const LIFECYCLES = ["WAITING","ENTRY_ZONE_REACHED","TP1_REACHED","TP2_REACHED","TP3_REACHED","SL_REACHED","CLOSED"];
const MAX_EVIDENCE_ITEMS = 5;
const MAX_EVIDENCE_BYTES = 700 * 1024;
const MAX_TOTAL_EVIDENCE_BYTES = 1500 * 1024;
const quoteCache = { at:0, data:null };

function clean(value,max=700){
  return String(value ?? "").trim().replace(/[\\u0000-\\u001f\\u007f]/g,"").slice(0,max);
}
function finite(value){
  const n=Number(value);
  return Number.isFinite(n)?n:null;
}
function validUuid(value){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value||""));
}
async function requireAdmin(pool,req,res){
  const user=await requireUser(pool,req,res);
  if(!user)return null;
  if(!isAdminEmail(user.email)){
    res.status(403).json({ok:false,error:"Administrator access required."});
    return null;
  }
  return user;
}
async function audit(pool,userId,eventType,metadata={}){
  if(!pool||!userId)return;
  await pool.query(
    "INSERT INTO kingbot_audit_log(user_id,event_type,metadata) VALUES($1,$2,$3::jsonb)",
    [userId,eventType,JSON.stringify(metadata)]
  ).catch(error=>console.warn("[KINGBOT GOLD SIGNALS] audit failed:",error?.message||error));
}
async function notify(pool,userId,title,body,metadata={}){
  if(!pool||!userId)return;
  await pool.query(
    "INSERT INTO kingbot_notifications(user_id,type,title,body,metadata) VALUES($1,'market_signal',$2,$3,$4::jsonb)",
    [userId,clean(title,140),clean(body,1000),JSON.stringify(metadata)]
  ).catch(error=>console.warn("[KINGBOT GOLD SIGNALS] notification failed:",error?.message||error));
}
async function notifyVerifiedMembers(pool,title,body,metadata={}){
  if(!pool)return;
  try{
    const q=await pool.query("SELECT id FROM kingbot_users WHERE email_verified=TRUE");
    await Promise.all(q.rows.map(row=>notify(pool,row.id,title,body,metadata)));
  }catch(error){
    console.warn("[KINGBOT GOLD SIGNALS] member notifications failed:",error?.message||error);
  }
}
function signalPublic(row,price){
  return {
    id:row.id,
    symbol:"XAUUSD",
    direction:row.direction,
    entry:finite(row.entry),
    entryMin:finite(row.entry_min),
    entryMax:finite(row.entry_max),
    tp1:finite(row.tp1),
    tp2:finite(row.tp2),
    tp3:finite(row.tp3),
    sl:finite(row.sl),
    timeframe:row.timeframe,
    reason:row.reason,
    waitFor:row.wait_for,
    state:row.state,
    lifecycle:row.lifecycle,
    publishedAt:row.published_at,
    updatedAt:row.updated_at,
    price:finite(price),
    ai:{
      status:row.ai_status||"PENDING",
      message:row.ai_message||"KINGBOT AI confirmation is waiting for fresh review data.",
      checkedAt:row.ai_reviewed_at||null,
      checks:Array.isArray(row.ai_checks)?row.ai_checks:[],
      model:row.ai_model||null
    }
  };
}
function signalAdmin(row){
  return {
    ...signalPublic(row,row.last_price),
    createdBy:row.created_by,
    createdAt:row.created_at,
    waitFor:row.wait_for,
    evidence:Array.isArray(row.evidence)?row.evidence:[],
    internalNotes:row.internal_notes||"",
    notificationState:row.notification_state||{},
    entryReachedAt:row.entry_reached_at||null
  };
}
async function liveGoldQuote(twelveData){
  const now=Date.now();
  if(quoteCache.data && now-quoteCache.at<1000)return quoteCache.data;
  try{
    if(twelveData?.enabled){
      const rows=await twelveData.latestQuotes(["XAUUSD"],{allowRestFallback:true,restTimeoutMs:1800});
      const q=rows.find(x=>x?.available);
      if(q){
        quoteCache.at=now;
        quoteCache.data={price:finite(q.price),bid:finite(q.bid),ask:finite(q.ask),timestamp:q.timestamp||now,source:"KINGBOT live market feed"};
        return quoteCache.data;
      }
    }
  }catch{}
  try{
    const q=await publicDerivFeed.getQuote("XAUUSD",{maxAgeMs:3000,timeoutMs:2000});
    quoteCache.at=now;
    quoteCache.data={price:finite(q.price),bid:finite(q.bid),ask:finite(q.ask),timestamp:q.epoch?Number(q.epoch)*1000:now,source:q.source||"KINGBOT public live market feed"};
    return quoteCache.data;
  }catch{}
  return {price:null,bid:null,ask:null,timestamp:now,source:"unavailable"};
}
function normalizeBody(body){
  const direction=clean(body?.direction,12).toUpperCase();
  const timeframe=clean(body?.timeframe,12).toLowerCase();
  const state=clean(body?.state,20).toUpperCase()||"DRAFT";
  const entry=finite(body?.entry);
  let entryMin=finite(body?.entryMin);
  let entryMax=finite(body?.entryMax);
  if(entryMin===null)entryMin=entry;
  if(entryMax===null)entryMax=entry;
  if(entryMin!==null&&entryMax!==null&&entryMin>entryMax)[entryMin,entryMax]=[entryMax,entryMin];
  const evidence=Array.isArray(body?.evidence)?body.evidence.slice(0,MAX_EVIDENCE_ITEMS):[];
  return {
    direction,
    timeframe,
    state,
    entry,
    entryMin,
    entryMax,
    tp1:finite(body?.tp1),
    tp2:finite(body?.tp2),
    tp3:finite(body?.tp3),
    sl:finite(body?.sl),
    reason:clean(body?.reason,1800),
    waitFor:clean(body?.waitFor,1000),
    internalNotes:clean(body?.internalNotes,1800),
    evidence
  };
}
function validateSignal(x){
  if(!DIRECTIONS.includes(x.direction))return "Direction must be BUY, SELL or WAIT.";
  if(!/^(1m|3m|5m|15m|30m|1h|2h|4h|1d|1w)$/.test(x.timeframe))return "Unsupported timeframe.";
  if(x.entry===null)return "Gold entry price is required.";
  if(x.entryMin===null||x.entryMax===null)return "Entry zone is required.";
  if(x.sl===null||x.tp1===null||x.tp2===null||x.tp3===null)return "TP1, TP2, TP3 and SL are required.";
  if(x.reason.length<8)return "A setup reason is required.";
  if(x.waitFor.length<5)return "A wait-for condition is required.";
  if(!SIGNAL_STATES.includes(x.state))return "Invalid signal state.";
  if(x.direction==="BUY" && !(x.sl<x.entryMin && x.entryMax<x.tp1 && x.tp1<x.tp2 && x.tp2<x.tp3))return "BUY levels must follow SL < entry zone < TP1 < TP2 < TP3.";
  if(x.direction==="SELL" && !(x.sl>x.entryMax && x.entryMin>x.tp1 && x.tp1>x.tp2 && x.tp2>x.tp3))return "SELL levels must follow SL > entry zone > TP1 > TP2 > TP3.";
  return null;
}
function evidenceBytes(items){
  return items.reduce((sum,item)=>sum+(String(item?.dataUrl||"").length*0.75),0);
}
function sanitizeEvidence(items){
  if(!Array.isArray(items))return [];
  const total=[];
  let bytes=0;
  for(const raw of items.slice(0,MAX_EVIDENCE_ITEMS)){
    const mime=clean(raw?.mimeType,80).toLowerCase();
    const dataUrl=String(raw?.dataUrl||"");
    const name=clean(raw?.name,120)||"evidence";
    const kind=clean(raw?.kind,30).toLowerCase()||"chart";
    if(!/^image\/(png|jpe?g|webp)$/i.test(mime))continue;
    const match=dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
    if(!match)continue;
    const dataBytes=Math.floor(match[2].replace(/\s+/g,"").length*0.75);
    if(dataBytes<=0||dataBytes>MAX_EVIDENCE_BYTES||bytes+dataBytes>MAX_TOTAL_EVIDENCE_BYTES)continue;
    bytes+=dataBytes;
    total.push({name,mimeType:mime,dataUrl,kind,uploadedAt:new Date().toISOString()});
  }
  return total;
}
function legacyEvidenceForAI(items){
  return (Array.isArray(items)?items:[]).slice(0,4).map(item=>{
    const match=String(item?.dataUrl||"").match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    return match?{mimeType:match[1],data:match[2].replace(/\s+/g,"")}:null;
  }).filter(Boolean);
}
async function runAiReview(signal,quote){
  const checks=[];
  const price=finite(quote?.price);
  const entryMin=finite(signal?.entryMin);
  const entryMax=finite(signal?.entryMax);
  const sl=finite(signal?.sl);
  const tp1=finite(signal?.tp1);
  const tp2=finite(signal?.tp2);
  const tp3=finite(signal?.tp3);
  const entry=finite(signal?.entry);
  const direction=clean(signal?.direction,12).toUpperCase();

  const valid=validateSignal({
    direction,timeframe:clean(signal?.timeframe,12).toLowerCase(),
    entry,entryMin,entryMax,sl,tp1,tp2,tp3,
    reason:clean(signal?.reason,1800),
    waitFor:clean(signal?.waitFor,1000),
    state:"PUBLISHED",
    evidence:Array.isArray(signal?.evidence)?signal.evidence:[]
  });
  if(valid){checks.push("SIGNAL_STRUCTURE_INVALID");return {status:"CONFLICT",message:"KINGBOT Cortex rejected the signal structure: "+valid,checks,model:"KINGBOT-CORTEX-1"};}

  if(price===null){
    checks.push("LIVE_QUOTE_UNAVAILABLE");
    return {status:"WAIT",message:"KINGBOT Cortex verified the signal structure but has no fresh live gold quote for external-price validation.",checks,model:"KINGBOT-CORTEX-1"};
  }

  const inside=price>=entryMin&&price<=entryMax;
  const beyondStop=direction==="BUY"?price<=sl:direction==="SELL"?price>=sl:false;
  const beyondTp3=direction==="BUY"?price>=tp3:direction==="SELL"?price<=tp3:false;

  if(beyondStop){checks.push("PRICE_AT_OR_BEYOND_SL");return {status:"CONFLICT",message:"KINGBOT Cortex detected live price at or beyond the published stop boundary.",checks,model:"KINGBOT-CORTEX-1"};}
  if(beyondTp3){checks.push("PRICE_AT_OR_BEYOND_TP3");return {status:"WAIT",message:"KINGBOT Cortex sees the published target area already reached; the original entry thesis is no longer a fresh setup.",checks,model:"KINGBOT-CORTEX-1"};}
  if(inside){
    checks.push("ENTRY_ZONE_REACHED");
    checks.push("LEVEL_ORDER_VALID");
    return {status:"CONFIRMED",message:"KINGBOT Cortex verified the published level structure and live price is inside the intended entry zone. This is not execution authorization.",checks,model:"KINGBOT-CORTEX-1"};
  }

  checks.push("ENTRY_ZONE_NOT_REACHED");
  checks.push("WAIT_CONDITION_ACTIVE");
  return {status:"WAIT",message:"KINGBOT Cortex verified the signal structure, but the live price is outside the entry zone. Preserve the wait-for condition.",checks,model:"KINGBOT-CORTEX-1"};
}
function entryReached(direction,price,min,max){
  if(price===null||min===null||max===null||direction==="WAIT")return false;
  return price>=min&&price<=max;
}
function lifecycleFor(direction,price,row){
  if(price===null||direction==="WAIT")return row.lifecycle||"WAITING";
  if(direction==="BUY"){
    if(price<=row.sl)return "SL_REACHED";
    if(price>=row.tp3)return "TP3_REACHED";
    if(price>=row.tp2)return "TP2_REACHED";
    if(price>=row.tp1)return "TP1_REACHED";
  }else{
    if(price>=row.sl)return "SL_REACHED";
    if(price<=row.tp3)return "TP3_REACHED";
    if(price<=row.tp2)return "TP2_REACHED";
    if(price<=row.tp1)return "TP1_REACHED";
  }
  return entryReached(direction,price,row.entry_min,row.entry_max)?"ENTRY_ZONE_REACHED":"WAITING";
}
async function refreshSignalLifecycle(pool,row,quote){
  if(!row||row.state!=="PUBLISHED")return row;
  const price=finite(quote?.price);
  if(price===null)return row;
  const next=lifecycleFor(row.direction,price,row);
  const flags=(row.notification_state&&typeof row.notification_state==="object")?{...row.notification_state}:{};
  const changes=[];
  if(next==="ENTRY_ZONE_REACHED"&&!flags.entry){
    flags.entry=true;
    changes.push(["entry","GOLD ENTRY ZONE REACHED","XAUUSD has reached the published entry zone. Review the setup and wait-for condition before acting."]);
  }
  if(next==="TP1_REACHED"&&!flags.tp1){
    flags.tp1=true;
    changes.push(["tp1","GOLD TP1 REACHED","XAUUSD has reached the published TP1 level for the current KINGBOT Gold signal."]);
  }
  if(next==="TP2_REACHED"&&!flags.tp2){
    flags.tp2=true;
    changes.push(["tp2","GOLD TP2 REACHED","XAUUSD has reached the published TP2 level for the current KINGBOT Gold signal."]);
  }
  if(next==="TP3_REACHED"&&!flags.tp3){
    flags.tp3=true;
    changes.push(["tp3","GOLD TP3 REACHED","XAUUSD has reached the published TP3 level for the current KINGBOT Gold signal."]);
  }
  if(next==="SL_REACHED"&&!flags.sl){
    flags.sl=true;
    changes.push(["sl","GOLD STOP LEVEL REACHED","XAUUSD has reached the published SL level for the current KINGBOT Gold signal."]);
  }
  const reachedAt=row.entry_reached_at || (next==="ENTRY_ZONE_REACHED"||/^TP[123]_REACHED$/.test(next)?new Date().toISOString():null);
  if(next!==row.lifecycle || flags!==row.notification_state || price!==finite(row.last_price)){
    const q=await pool.query(
      "UPDATE kingbot_gold_signals SET lifecycle=$2,last_price=$3,entry_reached_at=COALESCE(entry_reached_at,$4),notification_state=$5::jsonb,updated_at=NOW() WHERE id=$1 RETURNING *",
      [row.id,next,price,reachedAt,JSON.stringify(flags)]
    );
    row=q.rows[0]||row;
  }
  for(const [,title,body] of changes)await notifyVerifiedMembers(pool,title,body,{signalId:row.id,lifecycle:next,price});
  if(next==="ENTRY_ZONE_REACHED"&&row.ai_status!=="CONFIRMED"){
    void (async()=>{
      const review=await runAiReview({...row,evidence:Array.isArray(row.evidence)?row.evidence:[]},quote);
      await pool.query(
        "UPDATE kingbot_gold_signals SET ai_status=$2,ai_message=$3,ai_checks=$4::jsonb,ai_model=$5,ai_reviewed_at=NOW(),updated_at=NOW() WHERE id=$1",
        [row.id,review.status,review.message,JSON.stringify(review.checks||[]),review.model]
      );
      await notifyVerifiedMembers(
        pool,
        review.status==="CONFIRMED"?"KINGBOT GOLD AI CONFIRMATION":"KINGBOT GOLD AI UPDATE",
        review.message,
        {signalId:row.id,aiStatus:review.status}
      );
    })().catch(error=>console.error("[KINGBOT GOLD AI]",error?.message||error));
  }
  return row;
}

export async function ensureGoldSignalsSchema(pool){
  if(!pool)return;
  await pool.query(`CREATE TABLE IF NOT EXISTS kingbot_gold_signals(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol TEXT NOT NULL DEFAULT 'XAUUSD',
    direction TEXT NOT NULL,
    entry NUMERIC(18,5) NOT NULL,
    entry_min NUMERIC(18,5) NOT NULL,
    entry_max NUMERIC(18,5) NOT NULL,
    tp1 NUMERIC(18,5) NOT NULL,
    tp2 NUMERIC(18,5) NOT NULL,
    tp3 NUMERIC(18,5) NOT NULL,
    sl NUMERIC(18,5) NOT NULL,
    timeframe TEXT NOT NULL,
    reason TEXT NOT NULL,
    wait_for TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'DRAFT',
    lifecycle TEXT NOT NULL DEFAULT 'WAITING',
    evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
    internal_notes TEXT NOT NULL DEFAULT '',
    notification_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    ai_status TEXT NOT NULL DEFAULT 'PENDING',
    ai_message TEXT NOT NULL DEFAULT '',
    ai_checks JSONB NOT NULL DEFAULT '[]'::jsonb,
    ai_model TEXT,
    ai_reviewed_at TIMESTAMPTZ,
    last_price NUMERIC(18,5),
    entry_reached_at TIMESTAMPTZ,
    created_by UUID REFERENCES kingbot_users(id) ON DELETE SET NULL,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_gold_signals_public_idx ON kingbot_gold_signals(state,published_at DESC,updated_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_gold_signals_lifecycle_idx ON kingbot_gold_signals(state,lifecycle,updated_at DESC)");
}

export function registerGoldSignals(app,{pool,rateLimit,twelveData}={}){
  void ensureGoldSignalsSchema(pool).catch(error=>console.error("[KINGBOT GOLD SIGNALS SCHEMA]",error?.message||error));
  const userLimiter=rateLimit({windowMs:60*1000,limit:120,standardHeaders:"draft-8",legacyHeaders:false});
  const adminLimiter=rateLimit({windowMs:60*1000,limit:180,standardHeaders:"draft-8",legacyHeaders:false});

  app.get("/api/gold-signals/current",userLimiter,async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    try{
      const q=await pool.query("SELECT * FROM kingbot_gold_signals WHERE state='PUBLISHED' ORDER BY published_at DESC,updated_at DESC LIMIT 1");
      const quote=await liveGoldQuote(twelveData);
      if(!q.rowCount)return res.json({ok:true,signal:null,quote,generatedAt:new Date().toISOString()});
      const row=await refreshSignalLifecycle(pool,q.rows[0],quote);
      res.json({ok:true,signal:signalPublic(row,quote.price),quote,generatedAt:new Date().toISOString()});
    }catch(error){
      console.error("[KINGBOT GOLD PUBLIC]",error?.message||error);
      res.status(503).json({ok:false,error:"GOLD_SIGNAL_FEED_UNAVAILABLE"});
    }
  });

  app.get("/api/gold-signals/history",userLimiter,async(req,res)=>{
    const user=await requireUser(pool,req,res);if(!user)return;
    const limit=Math.min(50,Math.max(1,Number(req.query?.limit)||20));
    try{
      const q=await pool.query("SELECT * FROM kingbot_gold_signals WHERE state IN ('PUBLISHED','CLOSED','CANCELLED') ORDER BY published_at DESC,updated_at DESC LIMIT $1",[limit]);
      res.json({ok:true,signals:q.rows.map(row=>signalPublic(row,row.last_price))});
    }catch(error){res.status(503).json({ok:false,error:"GOLD_SIGNAL_HISTORY_UNAVAILABLE"});}
  });

  app.get("/api/admin/gold-signals",adminLimiter,async(req,res)=>{
    const admin=await requireAdmin(pool,req,res);if(!admin)return;
    try{
      const q=await pool.query("SELECT * FROM kingbot_gold_signals ORDER BY CASE state WHEN 'DRAFT' THEN 0 WHEN 'PUBLISHED' THEN 1 ELSE 2 END,updated_at DESC LIMIT 100");
      res.json({ok:true,signals:q.rows.map(signalAdmin)});
    }catch(error){res.status(503).json({ok:false,error:"GOLD_SIGNAL_ADMIN_FEED_UNAVAILABLE"});}
  });

  app.post("/api/admin/gold-signals",adminLimiter,async(req,res)=>{
    const admin=await requireAdmin(pool,req,res);if(!admin)return;
    const x=normalizeBody(req.body||{});
    const normalizedEvidence=sanitizeEvidence(x.evidence);
    x.evidence=normalizedEvidence;
    const validation=validateSignal(x);
    if(validation)return res.status(400).json({ok:false,error:validation});
    try{
      const published=x.state==="PUBLISHED";
      const q=await pool.query(
        `INSERT INTO kingbot_gold_signals(
          direction,entry,entry_min,entry_max,tp1,tp2,tp3,sl,timeframe,reason,wait_for,state,evidence,internal_notes,created_by,published_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,NOW()) RETURNING *`,
        [x.direction,x.entry,x.entryMin,x.entryMax,x.tp1,x.tp2,x.tp3,x.sl,x.timeframe,x.reason,x.waitFor,published?"PUBLISHED":"DRAFT",JSON.stringify(x.evidence),x.internalNotes,admin.id,published?new Date().toISOString():null]
      );
      let row=q.rows[0];
      await audit(pool,admin.id,"GOLD_SIGNAL_CREATED",{signalId:row.id,state:row.state,direction:row.direction});
      if(published){
        const quote=await liveGoldQuote(twelveData);
        const review=await runAiReview(row,quote);
        const rq=await pool.query("UPDATE kingbot_gold_signals SET ai_status=$2,ai_message=$3,ai_checks=$4::jsonb,ai_model=$5,ai_reviewed_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *",[row.id,review.status,review.message,JSON.stringify(review.checks||[]),review.model]);
        row=rq.rows[0];
        await notifyVerifiedMembers(pool,"NEW XAUUSD SIGNAL","A new KINGBOT Gold setup is available. Review the entry, wait-for condition and risk levels.",{signalId:row.id});
        await notifyVerifiedMembers(pool,"KINGBOT GOLD AI REVIEW",review.message,{signalId:row.id,aiStatus:review.status});
      }
      res.status(201).json({ok:true,signal:signalAdmin(row)});
    }catch(error){
      console.error("[KINGBOT GOLD CREATE]",error?.message||error);
      res.status(500).json({ok:false,error:"Gold signal creation failed."});
    }
  });

  app.patch("/api/admin/gold-signals/:id",adminLimiter,async(req,res)=>{
    const admin=await requireAdmin(pool,req,res);if(!admin)return;
    const id=String(req.params.id||"");
    if(!validUuid(id))return res.status(400).json({ok:false,error:"Invalid signal ID."});
    try{
      const existingQ=await pool.query("SELECT * FROM kingbot_gold_signals WHERE id=$1 LIMIT 1",[id]);
      if(!existingQ.rowCount)return res.status(404).json({ok:false,error:"Gold signal not found."});
      const existing=existingQ.rows[0];
      const merged={
        direction:req.body?.direction??existing.direction,
        timeframe:req.body?.timeframe??existing.timeframe,
        entry:req.body?.entry??existing.entry,
        entryMin:req.body?.entryMin??existing.entry_min,
        entryMax:req.body?.entryMax??existing.entry_max,
        tp1:req.body?.tp1??existing.tp1,
        tp2:req.body?.tp2??existing.tp2,
        tp3:req.body?.tp3??existing.tp3,
        sl:req.body?.sl??existing.sl,
        reason:req.body?.reason??existing.reason,
        waitFor:req.body?.waitFor??existing.wait_for,
        state:req.body?.state??existing.state,
        internalNotes:req.body?.internalNotes??existing.internal_notes,
        evidence:Array.isArray(req.body?.evidence)?req.body.evidence:existing.evidence
      };
      const x=normalizeBody(merged);
      x.evidence=sanitizeEvidence(x.evidence);
      const validation=validateSignal(x);
      if(validation)return res.status(400).json({ok:false,error:validation});
      const published=x.state==="PUBLISHED";
      const q=await pool.query(
        `UPDATE kingbot_gold_signals SET direction=$2,entry=$3,entry_min=$4,entry_max=$5,tp1=$6,tp2=$7,tp3=$8,sl=$9,timeframe=$10,reason=$11,wait_for=$12,state=$13,evidence=$14::jsonb,internal_notes=$15,published_at=CASE WHEN $13='PUBLISHED' THEN COALESCE(published_at,NOW()) ELSE published_at END,updated_at=NOW() WHERE id=$1 RETURNING *`,
        [id,x.direction,x.entry,x.entryMin,x.entryMax,x.tp1,x.tp2,x.tp3,x.sl,x.timeframe,x.reason,x.waitFor,x.state,JSON.stringify(x.evidence),x.internalNotes]
      );
      let row=q.rows[0];
      await audit(pool,admin.id,"GOLD_SIGNAL_UPDATED",{signalId:id,state:row.state});
      if(published && existing.state!=="PUBLISHED"){
        const quote=await liveGoldQuote(twelveData);
        const review=await runAiReview(row,quote);
        const rq=await pool.query("UPDATE kingbot_gold_signals SET ai_status=$2,ai_message=$3,ai_checks=$4::jsonb,ai_model=$5,ai_reviewed_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *",[id,review.status,review.message,JSON.stringify(review.checks||[]),review.model]);
        row=rq.rows[0];
        await notifyVerifiedMembers(pool,"NEW XAUUSD SIGNAL","A new KINGBOT Gold setup is available. Review the entry, wait-for condition and risk levels.",{signalId:id});
      }
      res.json({ok:true,signal:signalAdmin(row)});
    }catch(error){
      console.error("[KINGBOT GOLD UPDATE]",error?.message||error);
      res.status(500).json({ok:false,error:"Gold signal update failed."});
    }
  });

  app.post("/api/admin/gold-signals/:id/review",adminLimiter,async(req,res)=>{
    const admin=await requireAdmin(pool,req,res);if(!admin)return;
    const id=String(req.params.id||"");
    if(!validUuid(id))return res.status(400).json({ok:false,error:"Invalid signal ID."});
    try{
      const q=await pool.query("SELECT * FROM kingbot_gold_signals WHERE id=$1 LIMIT 1",[id]);
      if(!q.rowCount)return res.status(404).json({ok:false,error:"Gold signal not found."});
      const row=q.rows[0];
      const quote=await liveGoldQuote(twelveData);
      const review=await runAiReview(row,quote);
      const updated=await pool.query("UPDATE kingbot_gold_signals SET ai_status=$2,ai_message=$3,ai_checks=$4::jsonb,ai_model=$5,ai_reviewed_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *",[id,review.status,review.message,JSON.stringify(review.checks||[]),review.model]);
      await audit(pool,admin.id,"GOLD_SIGNAL_AI_REVIEW",{signalId:id,aiStatus:review.status});
      res.json({ok:true,signal:signalAdmin(updated.rows[0]),quote});
    }catch(error){res.status(500).json({ok:false,error:"Gold signal AI review failed."});}
  });

  app.post("/api/admin/gold-signals/:id/evidence",adminLimiter,async(req,res)=>{
    const admin=await requireAdmin(pool,req,res);if(!admin)return;
    const id=String(req.params.id||"");
    if(!validUuid(id))return res.status(400).json({ok:false,error:"Invalid signal ID."});
    try{
      const q=await pool.query("SELECT evidence FROM kingbot_gold_signals WHERE id=$1 LIMIT 1",[id]);
      if(!q.rowCount)return res.status(404).json({ok:false,error:"Gold signal not found."});
      const incoming=Array.isArray(req.body?.evidence)?req.body.evidence:[];
      const merged=[...(Array.isArray(q.rows[0].evidence)?q.rows[0].evidence:[]),...incoming];
      const evidence=sanitizeEvidence(merged);
      if(!evidence.length)return res.status(400).json({ok:false,error:"No valid chart evidence was supplied. Use compressed PNG/JPEG/WebP images."});
      const updated=await pool.query("UPDATE kingbot_gold_signals SET evidence=$2::jsonb,updated_at=NOW() WHERE id=$1 RETURNING *",[id,JSON.stringify(evidence)]);
      await audit(pool,admin.id,"GOLD_SIGNAL_EVIDENCE_ADDED",{signalId:id,count:evidence.length});
      res.json({ok:true,signal:signalAdmin(updated.rows[0])});
    }catch(error){res.status(500).json({ok:false,error:"Evidence upload failed."});}
  });
}
