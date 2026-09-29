import "dotenv/config";
import pg from "pg";
import { UserBrokerManager } from "./user-broker-manager.js";

const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined }) : null;
const broker = new UserBrokerManager({pool});
let stopping = false;
let timer = null;

async function ensureWorkerSchema(){
  if(!pool) throw new Error("DATABASE_URL_REQUIRED");
  await broker.ensureSchema();
}

async function cycle(){
  if(stopping || !pool) return;
  const q=await pool.query("SELECT user_id,bot_id,state FROM kingbot_bot_runtime WHERE state='RUNNING' ORDER BY updated_at ASC LIMIT 100");
  for(const row of q.rows){
    if(stopping) break;
    try{
      const config=await pool.query("SELECT symbol,timeframe FROM kingbot_bot_runtime WHERE user_id=$1 AND bot_id=$2",[row.user_id,row.bot_id]);
      if(!config.rowCount||!config.rows[0].symbol){
        await pool.query("UPDATE kingbot_bot_runtime SET state='ERROR',last_error=$3,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[row.user_id,row.bot_id,"SYMBOL_NOT_CONFIGURED"]);
        continue;
      }
      const status=await broker.getStatus(row.user_id);
      if(!status.configured){
        await pool.query("UPDATE kingbot_bot_runtime SET state='ERROR',last_error=$3,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[row.user_id,row.bot_id,"BROKER_ACCOUNT_NOT_MAPPED"]);
        continue;
      }
      if(!status.connected){
        const connected=await broker.connect(row.user_id,status.executionMode);
        if(!connected.connected){
          await pool.query("UPDATE kingbot_bot_runtime SET state='ERROR',last_error=$3,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[row.user_id,row.bot_id,connected.reason||"BROKER_CONNECTION_FAILED"]);
          continue;
        }
      }
      await pool.query("UPDATE kingbot_bot_runtime SET updated_at=NOW(),last_error=NULL WHERE user_id=$1 AND bot_id=$2",[row.user_id,row.bot_id]);
    }catch(error){
      await pool.query("UPDATE kingbot_bot_runtime SET state='ERROR',last_error=$3,updated_at=NOW() WHERE user_id=$1 AND bot_id=$2",[row.user_id,row.bot_id,String(error?.message||"WORKER_CYCLE_FAILED").slice(0,500)]);
    }
  }
}

async function main(){
  await ensureWorkerSchema();
  console.log("[KINGBOT WORKER] started");
  const loop=async()=>{ try{ await cycle(); }catch(error){ console.error("[KINGBOT WORKER]",error?.message||error); } if(!stopping) timer=setTimeout(loop,2000); };
  await loop();
}

async function shutdown(){
  if(stopping) return;
  stopping=true;
  if(timer) clearTimeout(timer);
  try{ if(pool) await pool.end(); } finally { process.exit(0); }
}
process.on("SIGTERM",shutdown);
process.on("SIGINT",shutdown);
main().catch(error=>{ console.error("[KINGBOT WORKER] startup failed",error?.message||error); process.exit(1); });
