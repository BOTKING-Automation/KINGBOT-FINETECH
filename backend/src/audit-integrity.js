import crypto from "node:crypto";

export async function ensureAuditIntegritySchema(pool){
  if(!pool)return;
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  await pool.query("ALTER TABLE kingbot_audit_log ADD COLUMN IF NOT EXISTS previous_entry_hash TEXT");
  await pool.query("ALTER TABLE kingbot_audit_log ADD COLUMN IF NOT EXISTS entry_hash TEXT");
  await pool.query("CREATE INDEX IF NOT EXISTS kingbot_audit_log_chain_idx ON kingbot_audit_log(created_at,id)");
  await pool.query(`CREATE OR REPLACE FUNCTION kingbot_audit_log_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  previous_hash TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('kingbot_audit_log_chain', 0));
  SELECT entry_hash INTO previous_hash
  FROM kingbot_audit_log
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  NEW.previous_entry_hash := previous_hash;
  NEW.entry_hash := encode(
    digest(
      coalesce(NEW.id::text,'') || '|' ||
      coalesce(NEW.user_id::text,'') || '|' ||
      coalesce(NEW.event_type,'') || '|' ||
      coalesce(NEW.metadata::text,'{}') || '|' ||
      coalesce(NEW.created_at::text,'') || '|' ||
      coalesce(previous_hash,''),
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$`);

  await pool.query(`CREATE OR REPLACE FUNCTION kingbot_audit_log_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'KINGBOT_AUDIT_LOG_IMMUTABLE';
END;
$$`);

  await pool.query("DROP TRIGGER IF EXISTS kingbot_audit_log_before_insert ON kingbot_audit_log");
  await pool.query("CREATE TRIGGER kingbot_audit_log_before_insert BEFORE INSERT ON kingbot_audit_log FOR EACH ROW EXECUTE FUNCTION kingbot_audit_log_before_insert()");
  await pool.query("DROP TRIGGER IF EXISTS kingbot_audit_log_no_update ON kingbot_audit_log");
  await pool.query("CREATE TRIGGER kingbot_audit_log_no_update BEFORE UPDATE ON kingbot_audit_log FOR EACH ROW EXECUTE FUNCTION kingbot_audit_log_immutable()");
  await pool.query("DROP TRIGGER IF EXISTS kingbot_audit_log_no_delete ON kingbot_audit_log");
  await pool.query("CREATE TRIGGER kingbot_audit_log_no_delete BEFORE DELETE ON kingbot_audit_log FOR EACH ROW EXECUTE FUNCTION kingbot_audit_log_immutable()");
}

export async function verifyAuditChain(pool,{limit=1000}={}){
  if(!pool)return {ok:false,error:"POOL_UNAVAILABLE"};
  const count=Math.max(1,Math.min(10000,Number(limit)||1000));
  const q=await pool.query(
    `SELECT id,user_id,event_type,metadata,created_at,previous_entry_hash,entry_hash,
      encode(digest(
        coalesce(id::text,'') || '|' ||
        coalesce(user_id::text,'') || '|' ||
        coalesce(event_type,'') || '|' ||
        coalesce(metadata::text,'{}') || '|' ||
        coalesce(created_at::text,'') || '|' ||
        coalesce(previous_entry_hash,''),
        'sha256'
      ),'hex') AS expected_hash
     FROM kingbot_audit_log
     ORDER BY created_at DESC,id DESC
     LIMIT $1`,
    [count]
  );
  const rows=q.rows.slice().reverse();
  for(const row of rows){
    if(row.entry_hash && row.entry_hash!==row.expected_hash){
      return {ok:false,verifiedEntries:rows.length,corruptEntryId:row.id};
    }
  }
  for(let i=1;i<rows.length;i++){
    const expectedPrevious=rows[i-1].entry_hash||null;
    if(rows[i].previous_entry_hash!==expectedPrevious){
      return {ok:false,verifiedEntries:i,brokenLinkEntryId:rows[i].id};
    }
  }
  return {ok:true,verifiedEntries:rows.length};
}
