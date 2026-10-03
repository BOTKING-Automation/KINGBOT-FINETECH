import { Router } from "express";
import { resolveFirebaseUser } from "./auth.js";
import { isAdminEmail } from "./admin-access.js";

export async function ensureCommercialLedgerSchema(pool){
  if(!pool)return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kingbot_commercial_ledger(
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NULL REFERENCES kingbot_users(id) ON DELETE SET NULL,
      entry_type TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('CREDIT','DEBIT')),
      currency TEXT NOT NULL DEFAULT 'KES',
      amount NUMERIC(20,8) NOT NULL CHECK(amount>=0),
      reference_type TEXT,
      reference_id TEXT,
      status TEXT NOT NULL DEFAULT 'POSTED',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kb_commercial_ledger_created
      ON kingbot_commercial_ledger(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_kb_commercial_ledger_ref
      ON kingbot_commercial_ledger(reference_type,reference_id);
    CREATE INDEX IF NOT EXISTS idx_kb_commercial_ledger_user
      ON kingbot_commercial_ledger(user_id,created_at DESC);
  `);
}

export async function appendCommercialLedger(db,{userId=null,entryType,direction="CREDIT",currency="KES",amount,referenceType=null,referenceId=null,status="POSTED",metadata={}}={}){
  if(!db)throw new Error("COMMERCIAL_LEDGER_DB_REQUIRED");
  const n=Number(amount);
  if(!entryType||!["CREDIT","DEBIT"].includes(direction)||!Number.isFinite(n)||n<0)throw new Error("COMMERCIAL_LEDGER_INVALID_ENTRY");
  const q=await db.query(
    `INSERT INTO kingbot_commercial_ledger(user_id,entry_type,direction,currency,amount,reference_type,reference_id,status,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     RETURNING id,user_id,entry_type,direction,currency,amount,reference_type,reference_id,status,metadata,created_at`,
    [userId,entryType,direction,String(currency||"KES").toUpperCase().slice(0,8),n,referenceType,referenceId,status,JSON.stringify(metadata||{})]
  );
  return q.rows[0];
}

export function registerCommercialLedgerRoutes(app,{pool}={}){
  if(!app||!pool)return;
  app.get("/api/commercial/ledger",async(req,res)=>{
    try{
      const u=await resolveFirebaseUser(pool,req);
      if(!u||!isAdminEmail(u.email))return res.status(403).json({ok:false,error:"Administrator access required."});
      const rawLimit=Number(req.query?.limit||100);
      const limit=Math.max(1,Math.min(Number.isFinite(rawLimit)?Math.floor(rawLimit):100,500));
      const q=await pool.query(
        `SELECT id,user_id,entry_type,direction,currency,amount,reference_type,reference_id,status,metadata,created_at
         FROM kingbot_commercial_ledger ORDER BY created_at DESC,id DESC LIMIT $1`,[limit]);
      res.json({ok:true,entries:q.rows});
    }catch(error){
      console.error("[KINGBOT COMMERCIAL LEDGER]",error?.message||error);
      res.status(503).json({ok:false,error:"Commercial ledger unavailable."});
    }
  });

  app.get("/api/commercial/revenue-summary",async(req,res)=>{
    try{
      const u=await resolveFirebaseUser(pool,req);
      if(!u||!isAdminEmail(u.email))return res.status(403).json({ok:false,error:"Administrator access required."});
      const days=Math.max(1,Math.min(Number(req.query?.days||30),3650));
      const q=await pool.query(
        `SELECT currency,
          COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE 0 END),0)::numeric AS credits,
          COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE 0 END),0)::numeric AS debits,
          COUNT(*)::int AS entries
         FROM kingbot_commercial_ledger
         WHERE created_at>=NOW()-($1::text||' days')::interval
         GROUP BY currency ORDER BY currency`,[days]);
      res.json({ok:true,days,summary:q.rows});
    }catch(error){
      console.error("[KINGBOT COMMERCIAL REVENUE]",error?.message||error);
      res.status(503).json({ok:false,error:"Revenue summary unavailable."});
    }
  });
}
