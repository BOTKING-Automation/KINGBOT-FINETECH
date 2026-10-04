import crypto from "node:crypto";
import MetaApi from "metaapi.cloud-sdk/esm-node";
import { ExnessTraderClient } from "./exness-trader-client.js";
import { OandaTraderClient } from "./oanda-trader-client.js";
import { DerivTraderClient } from "./deriv-trader-client.js";
import { getGlobalRiskState } from "./global-risk.js";

const ALGORITHM="aes-256-gcm";

function masterKey(){
  const raw=String(process.env.BROKER_CREDENTIALS_KEY||"").trim();
  if(!raw) throw new Error("BROKER_CREDENTIALS_KEY_NOT_CONFIGURED");
  if(raw.length < 32) throw new Error("BROKER_CREDENTIALS_KEY_TOO_SHORT");
  return crypto.createHash("sha256").update(raw,"utf8").digest();
}
function encryptSecret(value){
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv(ALGORITHM,masterKey(),iv);
  const ciphertext=Buffer.concat([cipher.update(String(value),"utf8"),cipher.final()]);
  return {ciphertext:ciphertext.toString("base64"),iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64")};
}
function qtyString(value){
  const n=Number(value);
  if(!Number.isFinite(n)||n<=0)throw new Error("INVALID_ORDER_VOLUME");
  return String(value);
}

function decryptSecret(row){
  const decipher=crypto.createDecipheriv(ALGORITHM,masterKey(),Buffer.from(row.credential_iv,"base64"));
  decipher.setAuthTag(Buffer.from(row.credential_tag,"base64"));
  return Buffer.concat([decipher.update(Buffer.from(row.credential_ciphertext,"base64")),decipher.final()]).toString("utf8");
}

export class UserBrokerManager {
  constructor({pool}={}) {
    this.pool=pool;
    this.connections=new Map();
    this.connectBackoff=new Map();
  }

  async ensureSchema(){
    if(!this.pool)return;
    await this.pool.query("CREATE TABLE IF NOT EXISTS kingbot_broker_accounts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,provider TEXT NOT NULL,account_id TEXT NOT NULL,credential_ciphertext TEXT NOT NULL,credential_iv TEXT NOT NULL,credential_tag TEXT NOT NULL,execution_mode TEXT NOT NULL DEFAULT 'DEMO' CHECK(execution_mode IN ('DEMO','LIVE')),live_execution_authorized BOOLEAN NOT NULL DEFAULT FALSE,live_authorized_at TIMESTAMPTZ,enabled BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(user_id,provider,account_id))");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts DROP CONSTRAINT IF EXISTS kingbot_broker_accounts_execution_mode_check");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD CONSTRAINT kingbot_broker_accounts_execution_mode_check CHECK(execution_mode IN ('DEMO','LIVE'))");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts DROP CONSTRAINT IF EXISTS kingbot_broker_accounts_execution_mode_check");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD CONSTRAINT kingbot_broker_accounts_execution_mode_check CHECK(execution_mode IN ('DEMO','LIVE'))");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS credential_ciphertext TEXT");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS credential_iv TEXT");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS credential_tag TEXT"); 
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS provider TEXT");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS account_id TEXT");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS execution_mode TEXT DEFAULT 'DEMO'");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS live_execution_authorized BOOLEAN NOT NULL DEFAULT FALSE");
    await this.pool.query("ALTER TABLE kingbot_broker_accounts ADD COLUMN IF NOT EXISTS live_authorized_at TIMESTAMPTZ");
    await this.pool.query("UPDATE kingbot_broker_accounts SET live_execution_authorized=FALSE,live_authorized_at=NULL WHERE live_execution_authorized IS NULL");
    await this.pool.query("CREATE TABLE IF NOT EXISTS kingbot_deriv_oauth_states (state TEXT PRIMARY KEY,user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,code_verifier TEXT NOT NULL,execution_mode TEXT NOT NULL DEFAULT 'DEMO',expires_at TIMESTAMPTZ NOT NULL,pending_id TEXT,token_ciphertext TEXT,token_iv TEXT,token_tag TEXT,accounts_json JSONB,status TEXT NOT NULL DEFAULT 'pending')");
    await this.pool.query("ALTER TABLE kingbot_deriv_oauth_states ADD COLUMN IF NOT EXISTS pending_id TEXT");
    await this.pool.query("ALTER TABLE kingbot_deriv_oauth_states ADD COLUMN IF NOT EXISTS token_ciphertext TEXT");
    await this.pool.query("ALTER TABLE kingbot_deriv_oauth_states ADD COLUMN IF NOT EXISTS token_iv TEXT");
    await this.pool.query("ALTER TABLE kingbot_deriv_oauth_states ADD COLUMN IF NOT EXISTS token_tag TEXT");
    await this.pool.query("ALTER TABLE kingbot_deriv_oauth_states ADD COLUMN IF NOT EXISTS accounts_json JSONB");
    await this.pool.query("ALTER TABLE kingbot_deriv_oauth_states ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'");
    // Exactly one active broker account is allowed per KINGBOT user.
    // Retire stale duplicate active mappings before enforcing the database constraint.
    await this.pool.query("WITH ranked AS (SELECT id,ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY updated_at DESC,created_at DESC,id DESC) AS rn FROM kingbot_broker_accounts WHERE enabled=TRUE) UPDATE kingbot_broker_accounts a SET enabled=FALSE,updated_at=NOW() FROM ranked r WHERE a.id=r.id AND r.rn>1");
    await this.pool.query("CREATE UNIQUE INDEX IF NOT EXISTS kingbot_broker_accounts_one_active_per_user ON kingbot_broker_accounts(user_id) WHERE enabled=TRUE");
    // Never allow one Deriv trading account to be shared across KINGBOT users.
    await this.pool.query("CREATE UNIQUE INDEX IF NOT EXISTS kingbot_deriv_account_one_user ON kingbot_broker_accounts(account_id) WHERE provider='deriv'");
    await this.pool.query("CREATE INDEX IF NOT EXISTS kingbot_deriv_oauth_states_expires_idx ON kingbot_deriv_oauth_states(expires_at)");
    await this.pool.query("CREATE UNIQUE INDEX IF NOT EXISTS kingbot_deriv_oauth_states_pending_idx ON kingbot_deriv_oauth_states(pending_id) WHERE pending_id IS NOT NULL");
  }

  async createDerivOAuthState({userId,codeVerifier,executionMode="DEMO"}={}){
    if(!this.pool||!userId)throw new Error("USER_CONTEXT_REQUIRED");
    const state=crypto.randomBytes(32).toString("base64url");
    const mode=(String(executionMode||"DEMO").toUpperCase()==="PAPER"?"DEMO":String(executionMode||"DEMO").toUpperCase());
    if(!["DEMO","LIVE"].includes(mode))throw new Error("INVALID_EXECUTION_MODE");
    await this.pool.query("DELETE FROM kingbot_deriv_oauth_states WHERE expires_at<NOW()");
    await this.pool.query("INSERT INTO kingbot_deriv_oauth_states(state,user_id,code_verifier,execution_mode,expires_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '10 minutes')",[state,userId,String(codeVerifier||""),mode]);
    return {state,executionMode:mode};
  }

  async consumeDerivOAuthState(state){
    if(!this.pool)return null;
    const q=await this.pool.query("SELECT user_id,code_verifier,execution_mode,status FROM kingbot_deriv_oauth_states WHERE state=$1 AND expires_at>NOW() AND status='pending' FOR UPDATE",[String(state||"")]);
    return q.rowCount?q.rows[0]:null;
  }

  async finalizeDerivOAuthState({state,tokenPayload,accounts}={}){
    if(!this.pool||!state)throw new Error("DERIV_OAUTH_STATE_REQUIRED");
    const token=JSON.stringify({
      accessToken:String(tokenPayload?.access_token||""),
      refreshToken:tokenPayload?.refresh_token||undefined,
      expiresAt:Date.now()+Number(tokenPayload?.expires_in||3600)*1000
    });
    if(!JSON.parse(token).accessToken)throw new Error("DERIV_ACCESS_TOKEN_REQUIRED");
    const encrypted=encryptSecret(token);
    const pendingId=crypto.randomBytes(24).toString("base64url");
    const q=await this.pool.query(
      "UPDATE kingbot_deriv_oauth_states SET code_verifier='',pending_id=$2,token_ciphertext=$3,token_iv=$4,token_tag=$5,accounts_json=$6::jsonb,status='authorized',expires_at=NOW()+INTERVAL '10 minutes' WHERE state=$1 AND status='pending' AND expires_at>NOW() RETURNING user_id,execution_mode,pending_id",
      [String(state),pendingId,encrypted.ciphertext,encrypted.iv,encrypted.tag,JSON.stringify(Array.isArray(accounts)?accounts:[])]
    );
    if(!q.rowCount)throw new Error("DERIV_OAUTH_STATE_INVALID_OR_EXPIRED");
    return q.rows[0];
  }

  async getDerivOAuthPending({userId,pendingId}={}){
    if(!this.pool||!userId||!pendingId)return null;
    const q=await this.pool.query(
      "SELECT user_id,execution_mode,pending_id,token_ciphertext,token_iv,token_tag,accounts_json,status,expires_at FROM kingbot_deriv_oauth_states WHERE user_id=$1 AND pending_id=$2 AND status='authorized' AND expires_at>NOW()",
      [userId,String(pendingId)]
    );
    if(!q.rowCount)return null;
    const row=q.rows[0];
    let token;
    try{token=JSON.parse(decryptSecret({credential_ciphertext:row.token_ciphertext,credential_iv:row.token_iv,credential_tag:row.token_tag}));}catch{throw new Error("DERIV_OAUTH_TOKEN_DECRYPTION_FAILED");}
    return {...row,token,accounts:Array.isArray(row.accounts_json)?row.accounts_json:[]};
  }

  async consumeDerivOAuthPending({userId,pendingId}={}){
    const pending=await this.getDerivOAuthPending({userId,pendingId});
    if(!pending)return null;
    await this.pool.query("DELETE FROM kingbot_deriv_oauth_states WHERE user_id=$1 AND pending_id=$2",[userId,String(pendingId)]);
    return pending;
  }

  async isConnected(userId){
    const prefix=String(userId)+":";
    for(const [key,entry] of this.connections){
      if(!key.startsWith(prefix))continue;

      // Deriv is WebSocket-backed. A stale entry can remain in the process
      // map after the broker closes the socket, so never report that entry as
      // connected unless the underlying adapter explicitly says it is alive.
      if(entry?.provider==="deriv" && entry?.api?.connected!==true){
        this.connections.delete(key);
        continue;
      }
      return true;
    }

    // Broker connection objects live in process memory, while the verified
    // account mapping is persistent. Rehydrate the connection after a
    // Render restart, idle wake-up, broker socket close, or worker/page transition.
    const mapping=await this.getMapping(userId);
    if(!mapping)return false;

    try{
      const result=await this.connect(userId,mapping.execution_mode);
      return Boolean(result?.connected);
    }catch(error){
      console.warn("[KINGBOT BROKER] Connection rehydration deferred:",error?.message||error);
      return false;
    }
  }

  async getStoredIdentity(userId){
    const mapping=await this.getMapping(userId);
    if(!mapping)return {
      configured:false,
      connected:false,
      broker:null,
      accountId:null,
      executionMode:"NOT_CONNECTED"
    };
    const executionMode=String(mapping.execution_mode||"DEMO").toUpperCase();
    return {
      configured:true,
      connected:true,
      broker:mapping.provider||null,
      accountId:mapping.account_id||null,
      executionMode,
      accountType:executionMode==="LIVE"?"REAL":"DEMO"
    };
  }

  async getStatus(userId){
    const mapping=await this.getMapping(userId);
    const connected=Boolean(mapping) ? await this.isConnected(userId) : false;
    const key=mapping ? String(userId)+":"+mapping.provider+":"+mapping.account_id : "";
    const entry=key ? this.connections.get(key) : null;
    const raw=entry?.accountInfo||null;
    const numeric=(value)=>Number.isFinite(Number(value))?Number(value):null;
    const accountSnapshot=raw ? {
      balance:numeric(raw.balance),
      equity:numeric(raw.equity ?? raw.NAV ?? raw.netAssetValue ?? raw.balance),
      currency:String(raw.currency||"").trim()||null,
      accountType:String(raw.accountType||raw.account_type||"").trim().toUpperCase()||(
        mapping?.execution_mode==="LIVE" ? "REAL" : "DEMO"
      ),
      accountStatus:String(raw.account_status||raw.status||"ACTIVE").toUpperCase(),
      tradingEnabled:raw.tradeAllowed!==false
        && raw.tradingEnabled!==false
        && String(raw.account_status||"active").toLowerCase()!=="trading_disabled"
        && String(raw.trade_mode||"enabled").toLowerCase()!=="trading_disabled",
      syncedAt:entry?.accountInfoAt ? new Date(entry.accountInfoAt).toISOString() : null
    } : null;
    return {
      configured:Boolean(mapping),
      connected,
      broker:mapping?.provider||null,
      accountId:mapping?.account_id||null,
      executionMode:mapping?.execution_mode||"NOT_CONNECTED",
      accountSnapshot
    };
  }

  async getMapping(userId){
    if(!this.pool||!userId)return null;
    const q=await this.pool.query("SELECT id,user_id,provider,account_id,execution_mode,enabled,live_execution_authorized,live_authorized_at,credential_ciphertext,credential_iv,credential_tag FROM kingbot_broker_accounts WHERE user_id=$1 AND enabled=TRUE AND credential_ciphertext IS NOT NULL AND credential_iv IS NOT NULL AND credential_tag IS NOT NULL ORDER BY updated_at DESC LIMIT 1",[userId]);
    return q.rowCount?q.rows[0]:null;
  }

  async saveMapping({userId,provider="metaapi",accountId,accountToken,executionMode="DEMO",apiKey,secretKey,baseUrl,derivAccountType}={}){
    if(!this.pool||!userId)return {ok:false,error:"USER_CONTEXT_REQUIRED"};
    const requestedMode=String(executionMode||"DEMO").toUpperCase();
    if(!["DEMO","LIVE"].includes(requestedMode))return {ok:false,error:"INVALID_EXECUTION_MODE"};
    const mode=requestedMode;
    const id=String(accountId||"").trim();
    const providerName=String(provider).toLowerCase();
    const isExness=providerName==="exness";
    let secretValue=String(accountToken||"").trim();
    if(isExness){
      const key=String(apiKey||"").trim();
      const secret=String(secretKey||"").trim();
      const host=String(baseUrl||"").trim();
      if(!key)return {ok:false,error:"EXNESS_API_KEY_REQUIRED"};
      if(!secret)return {ok:false,error:"EXNESS_PRIVATE_KEY_REQUIRED"};
      if(host && !/^https:\/\//i.test(host))return {ok:false,error:"EXNESS_BASE_URL_MUST_USE_HTTPS"};
      secretValue=JSON.stringify({apiKey:key,secretKey:secret,baseUrl:host||undefined});
    }else if(providerName==="oanda"){

      const token=String(accountToken||"").trim();
      if(!token)return {ok:false,error:"OANDA_API_TOKEN_REQUIRED"};
      const host=String(baseUrl||"").trim();
      if(host && !/^https:\/\//i.test(host))return {ok:false,error:"OANDA_BASE_URL_MUST_USE_HTTPS"};
      secretValue=JSON.stringify({apiToken:token,baseUrl:host||undefined});
    }else if(providerName==="deriv"){
      const token=String(accountToken||"").trim();
      if(!token)return {ok:false,error:"DERIV_OAUTH_TOKEN_REQUIRED"};
      let parsed={};
      try{parsed=JSON.parse(token);}catch{parsed={accessToken:token};}
      if(!parsed.accessToken)return {ok:false,error:"DERIV_ACCESS_TOKEN_REQUIRED"};
      secretValue=JSON.stringify({
        accessToken:parsed.accessToken,
        refreshToken:parsed.refreshToken||undefined,
        expiresAt:parsed.expiresAt||undefined,
        accountType:String(derivAccountType||parsed.accountType||"").toLowerCase()||undefined,
        appId:String(parsed.appId||"").trim()||undefined,
        authMethod:String(parsed.authMethod||"pat").toLowerCase()
      });
    }
    if(!id)return {ok:false,error:"BROKER_ACCOUNT_ID_REQUIRED"};
    if(!secretValue)return {ok:false,error:isExness?"EXNESS_CREDENTIALS_REQUIRED":providerName==="deriv"?"DERIV_CREDENTIALS_REQUIRED":"BROKER_ACCOUNT_TOKEN_REQUIRED"};
    if(secretValue.length>12000)return {ok:false,error:"BROKER_CREDENTIAL_TOO_LONG"};
    const existing=await this.getMapping(userId);
    if(existing && (String(existing.provider)!==providerName || String(existing.account_id)!==id)){
      return {ok:false,error:"BROKER_ALREADY_CONNECTED",message:"A broker account is already connected. Disconnect it before connecting another broker or account."};
    }
    if(providerName==="deriv"){
      const owner=await this.pool.query("SELECT user_id FROM kingbot_broker_accounts WHERE provider='deriv' AND account_id=$1 AND user_id<>$2 AND enabled=TRUE LIMIT 1",[id,userId]);
      if(owner.rowCount){
        return {ok:false,error:"DERIV_ACCOUNT_ALREADY_LINKED",message:"This Deriv account is already linked to another KINGBOT user. Each Deriv account must remain private to one KINGBOT user."};
      }
    }
    const encrypted=encryptSecret(secretValue);
    try{
      const q=await this.pool.query("INSERT INTO kingbot_broker_accounts(user_id,provider,account_id,credential_ciphertext,credential_iv,credential_tag,execution_mode,enabled,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,TRUE,NOW()) ON CONFLICT(user_id,provider,account_id) DO UPDATE SET credential_ciphertext=EXCLUDED.credential_ciphertext,credential_iv=EXCLUDED.credential_iv,credential_tag=EXCLUDED.credential_tag,execution_mode=EXCLUDED.execution_mode,live_execution_authorized=FALSE,live_authorized_at=NULL,enabled=TRUE,updated_at=NOW() RETURNING id,user_id,provider,account_id,execution_mode,live_execution_authorized,live_authorized_at,enabled",[userId,providerName,id,encrypted.ciphertext,encrypted.iv,encrypted.tag,mode]);
      await this.disconnect(userId,{disableMapping:false});
      return {ok:true,account:q.rows[0]};
    }catch(error){
      if(error?.code==="23505")return {ok:false,error:"BROKER_ALREADY_CONNECTED",message:"A broker account is already connected. Disconnect it before connecting another broker or account."};
      throw error;
    }
  }

  async getLiveAuthorization(userId){
    const mapping=await this.getMapping(userId);
    if(!mapping)return {authorized:false,reason:"BROKER_ACCOUNT_NOT_CONFIGURED"};
    return {
      authorized:Boolean(mapping.live_execution_authorized),
      executionMode:String(mapping.execution_mode||"DEMO").toUpperCase(),
      accountId:mapping.account_id||null,
      provider:mapping.provider||null,
      authorizedAt:mapping.live_authorized_at||null
    };
  }

  async setLiveAuthorization(userId,authorized){
    if(!this.pool||!userId)throw new Error("USER_CONTEXT_REQUIRED");
    const enable=Boolean(authorized);
    const mapping=await this.getMapping(userId);
    if(!mapping)throw new Error("BROKER_ACCOUNT_NOT_CONFIGURED");
    if(enable){
      if(String(mapping.execution_mode||"DEMO").toUpperCase()!=="LIVE")throw new Error("LIVE_EXECUTION_MODE_REQUIRED");
      const status=await this.getStatus(userId);
      const accountType=String(status?.accountSnapshot?.accountType||"").toUpperCase();
      if(accountType!=="REAL")throw new Error("LIVE_REQUIRES_REAL_ACCOUNT");
      if(status?.accountSnapshot?.tradingEnabled===false)throw new Error("BROKER_TRADING_DISABLED");
    }
    await this.pool.query(
      "UPDATE kingbot_broker_accounts SET live_execution_authorized=$2,live_authorized_at=CASE WHEN $2 THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$1",
      [mapping.id,enable]
    );
    return this.getLiveAuthorization(userId);
  }

  async assertExecutionAuthorized(userId){
    const globalRisk=await getGlobalRiskState(this.pool);
    if(globalRisk.globalKillSwitch)throw new Error("GLOBAL_KILL_SWITCH_ACTIVE");
    if(globalRisk.tradingPaused)throw new Error("GLOBAL_TRADING_PAUSED");

    const mapping=await this.getMapping(userId);
    if(!mapping)throw new Error("BROKER_ACCOUNT_NOT_CONFIGURED");
    const mode=String(mapping.execution_mode||"DEMO").toUpperCase();
    if(!["DEMO","LIVE"].includes(mode))throw new Error("INVALID_EXECUTION_MODE");
    if(mode==="DEMO")return {authorized:true,mode,liveAuthorized:false,provider:mapping.provider,accountId:mapping.account_id};
    if(String(process.env.KINGBOT_LIVE_AUTH_REQUIRED||"true").toLowerCase()!=="false"){
      if(!Boolean(mapping.live_execution_authorized))throw new Error("LIVE_EXECUTION_NOT_AUTHORIZED");
    }
    const status=await this.getStatus(userId);
    const accountType=String(status?.accountSnapshot?.accountType||"").toUpperCase();
    if(accountType!=="REAL")throw new Error("LIVE_REQUIRES_REAL_ACCOUNT");
    if(status?.accountSnapshot?.tradingEnabled===false)throw new Error("BROKER_TRADING_DISABLED");
    return {authorized:true,mode,liveAuthorized:Boolean(mapping.live_execution_authorized),provider:mapping.provider,accountId:mapping.account_id};
  }

  async connect(userId,executionMode="DEMO"){
    if(!userId)return {connected:false,mode:"NOT_CONNECTED",reason:"USER_CONTEXT_REQUIRED"};
    const backoffKey=String(userId);
    const blockedUntil=Number(this.connectBackoff.get(backoffKey)||0);
    if(blockedUntil>Date.now())return {connected:false,mode:"NOT_CONNECTED",reason:"BROKER_RECONNECT_BACKOFF",retryAt:new Date(blockedUntil).toISOString()};
    const mapping=await this.getMapping(userId);
    if(!mapping)return {connected:false,mode:"NOT_CONNECTED",reason:"BROKER_ACCOUNT_NOT_CONFIGURED"};
    const requestedMode=String(executionMode||mapping.execution_mode||"DEMO").toUpperCase();
    const mode=requestedMode==="PAPER"?"DEMO":requestedMode;
    if(!["DEMO","LIVE"].includes(mode))return {connected:false,mode:"NOT_CONNECTED",reason:"INVALID_EXECUTION_MODE"};
    let credential;
    try{credential=decryptSecret(mapping);}
    catch(error){return {connected:false,mode:"NOT_CONNECTED",reason:"BROKER_CREDENTIAL_DECRYPTION_FAILED"};}
    const key=userId+":"+mapping.provider+":"+mapping.account_id;
    let entry=this.connections.get(key);

    if(mapping.provider==="exness"){
      try{
        const parsed=JSON.parse(credential);
        if(!entry){
          const api=new ExnessTraderClient({
            apiKey:parsed.apiKey,
            secretKey:parsed.secretKey,
            accountId:mapping.account_id,
            baseUrl:parsed.baseUrl
          });
          await api.ensureReady();
          const accountInfo=await api.getAccountInformation();
          entry={ownerUserId:userId,api,accountInfo,accountId:mapping.account_id,executionMode:mode,provider:"exness",connectedAt:Date.now(),accountInfoAt:Date.now()};
          this.connections.set(key,entry);
        }else{
          entry.accountInfo=await entry.api.getAccountInformation();
          entry.accountInfoAt=Date.now();
        }
        const info=entry.accountInfo||{};
        if(info.trade_mode==="trading_disabled")return {connected:false,mode:"NOT_CONNECTED",reason:"EXNESS_TRADING_DISABLED"};
        if(mode==="LIVE"&&info.account_status==="close_only")return {connected:false,mode:"NOT_CONNECTED",reason:"EXNESS_ACCOUNT_CLOSE_ONLY"};
        entry.executionMode=mode;
        return {connected:true,mode,broker:"exness",accountId:mapping.account_id,account:info};
      }catch(error){
        console.error("[KINGBOT EXNESS] connect failed:",error?.message||error);
        return {connected:false,mode:"NOT_CONNECTED",reason:error?.message||"EXNESS_CONNECTION_FAILED"};
      }
    }

    if(mapping.provider==="deriv"){
      try{
        const parsed=JSON.parse(credential);
        if(!entry){
          const api=new DerivTraderClient({
            accessToken:parsed.accessToken,
            accountId:mapping.account_id,
            executionMode:mode,
            accountType:parsed.accountType,
            appId:parsed.appId
          });
          const result=await api.connect();
          entry={ownerUserId:userId,api,accountId:mapping.account_id,executionMode:mode,provider:"deriv",connectedAt:Date.now(),accountInfo:result.account,accountType:api.accountTypeFromBalance(result.account),accountInfoAt:Date.now()};
          this.connections.set(key,entry);
        }else{
          entry.executionMode=mode;
          entry.api.executionMode=mode;
          // Deriv rate-limits balance requests. Reuse the last verified account
          // snapshot instead of polling balance on every status/connection call.
          // A 30s refresh is sufficient for connection validation and keeps the
          // authenticated session stable under dashboard polling.
          if(!entry.accountInfoAt || Date.now()-entry.accountInfoAt>30000){
            try{
              const verified=(await entry.api.getAccount()).data;
              entry.accountInfo=verified;
              entry.accountType=verified.accountType||entry.accountType||"DEMO";
              entry.accountInfoAt=Date.now();
            }catch(error){
              const message=String(error?.message||"");
              if(/rate.?limit.*balance|balance.*rate.?limit/i.test(message) && entry.accountInfo){
                entry.accountInfoAt=Date.now();
              }else{
                throw error;
              }
            }
          }
        }
        this.connectBackoff.delete(backoffKey);
        entry.executionMode=mode;
        return {connected:true,mode,broker:"deriv",accountId:mapping.account_id,account:entry.accountInfo};
      }catch(error){
        const retryAt=Date.now()+5000;
        this.connectBackoff.set(backoffKey,retryAt);
        console.error("[KINGBOT DERIV] connect failed:",error?.message||error);
        return {connected:false,mode:"NOT_CONNECTED",reason:error?.message||"DERIV_CONNECTION_FAILED",retryAt:new Date(retryAt).toISOString()};
      }
    }

    if(mapping.provider==="oanda"){
      try{
        const parsed=JSON.parse(credential);
        if(!entry){
          const api=new OandaTraderClient({
            apiToken:parsed.apiToken,
            accountId:mapping.account_id,
            executionMode:mode,
            baseUrl:parsed.baseUrl
          });
          const accountInfo=await api.ensureReady();
          entry={ownerUserId:userId,api,accountId:mapping.account_id,executionMode:mode,provider:"oanda",connectedAt:Date.now(),accountInfo,accountInfoAt:Date.now()};
          this.connections.set(key,entry);
        }else{
          entry.accountInfo=await entry.api.getAccountSummary();
          entry.accountInfoAt=Date.now();
        }
        entry.executionMode=mode;
        return {connected:true,mode,broker:"oanda",accountId:mapping.account_id,account:entry.accountInfo};
      }catch(error){
        console.error("[KINGBOT OANDA] connect failed:",error?.message||error);
        return {connected:false,mode:"NOT_CONNECTED",reason:error?.message||"OANDA_CONNECTION_FAILED"};
      }
    }

    if(mapping.provider==="mt5-bridge" || mapping.provider==="deriv-mt5"){
      return {
        connected:false,
        mode:"NOT_CONNECTED",
        reason:"LEGACY_MT5_EA_ROUTE_DISABLED",
        message:"KINGBOT now uses AI Strategies with broker-native API execution. MT5 EA/bridge execution is no longer supported."
      };
    }

    const accountToken=credential;
    if(!entry){
      try{
        const api=new MetaApi(accountToken);
        const account=await api.metatraderAccountApi.getAccount(mapping.account_id);
        await account.waitConnected();
        const connection=String(mapping.provider).toLowerCase()==="deriv-mt5"
          ? account.getStreamingConnection()
          : account.getRPCConnection();
        await connection.connect();
        await connection.waitSynchronized();
        if(String(mapping.provider).toLowerCase()==="deriv-mt5"){
          try{
            const symbols=["XAUUSD","frxXAUUSD","FRXXAUUSD"];
            for(const symbol of symbols){
              try{await connection.subscribeToMarketData(symbol);}catch{}
            }
          }catch{}
        }
        entry={api,account,connection,accountId:mapping.account_id,executionMode:mode,provider:mapping.provider,accountInfo:null};
        this.connections.set(key,entry);
      }catch(error){
        return {connected:false,mode:"NOT_CONNECTED",reason:"BROKER_CONNECTION_FAILED"};
      }
    }
    try{
      const accountInfo=String(entry.provider).toLowerCase()==="deriv-mt5"
        ? entry.connection.terminalState.accountInformation
        : await entry.connection.getAccountInformation();
      entry.accountInfo=accountInfo;
      entry.accountInfoAt=Date.now();
      if(mode==="DEMO"&&accountInfo.type!=="ACCOUNT_TRADE_MODE_DEMO"){
        await entry.connection.close();
        this.connections.delete(key);
        return {connected:false,mode:"NOT_CONNECTED",reason:"DEMO_REQUIRES_DEMO_ACCOUNT"};
      }
      if(mode==="LIVE"&&accountInfo.type!=="ACCOUNT_TRADE_MODE_REAL"){
        await entry.connection.close();
        this.connections.delete(key);
        return {connected:false,mode:"NOT_CONNECTED",reason:"LIVE_REQUIRES_REAL_ACCOUNT"};
      }
    }catch(error){
      try{await entry.connection.close();}catch{}
      this.connections.delete(key);
      return {connected:false,mode:"NOT_CONNECTED",reason:"BROKER_ACCOUNT_VALIDATION_FAILED"};
    }
    entry.executionMode=mode;
    return {connected:true,mode,broker:mapping.provider,accountId:mapping.account_id};
  }

  async disconnect(userId,{disableMapping=true}={}){
    for(const [key,entry] of this.connections){
      if(key.startsWith(String(userId)+":")){
        try{
          if(entry.provider==="deriv" && entry.api?.disconnect)await entry.api.disconnect();
          else if(entry.provider!=="exness" && entry.connection?.close)await entry.connection.close();
        }finally{this.connections.delete(key);}
      }
    }
    if(disableMapping&&this.pool&&userId){
      await this.pool.query("UPDATE kingbot_broker_accounts SET enabled=FALSE,updated_at=NOW() WHERE user_id=$1 AND enabled=TRUE",[userId]);
    }
    return {connected:false,mode:"NOT_CONNECTED"};
  }

  async connectionFor(userId){
    const mapping=await this.getMapping(userId);
    if(!mapping)throw new Error("BROKER_ACCOUNT_NOT_CONFIGURED");
    const key=userId+":"+mapping.provider+":"+mapping.account_id;
    let entry=this.connections.get(key);

    // Reconnect stale in-memory broker sessions. This is especially important
    // for Deriv because its WebSocket can close while the persistent broker
    // authorization remains valid.
    if(entry?.provider==="deriv" && entry?.api?.connected!==true){
      this.connections.delete(key);
      entry=null;
    }

    if(!entry){
      const result=await this.connect(userId,mapping.execution_mode);
      if(!result?.connected)throw new Error(result?.reason||"BROKER_NOT_CONNECTED");
      entry=this.connections.get(key);
    }

    if(!entry)throw new Error("BROKER_NOT_CONNECTED");
    return entry;
  }

  async getAccount(userId){
    const entry=await this.connectionFor(userId);
    if(String(entry.ownerUserId||"")!==String(userId))throw new Error("EXECUTION_OWNER_MISMATCH");
    if(entry.provider==="deriv"){
      // Prefer the adapter's live balance stream snapshot. Deriv pushes a
      // balance message whenever the authorized account balance changes.
      // This avoids serving an older manager-level cache to the terminal.
      const streamed=entry.api?.accountBalance;
      const raw=streamed||entry.accountInfo||{};
      if(streamed){
        entry.accountInfo=streamed;
        entry.accountInfoAt=entry.api.accountBalanceAt||Date.now();
      }
      const loginid=String(raw.loginid||entry.accountId||"");
      const accountType=String(raw.accountType||entry.accountType||"").toUpperCase() || (loginid.startsWith("VR")||loginid.includes("_VRTC")?"DEMO":"REAL");
      return {connected:true,data:{
        ...raw,
        balance:Number.isFinite(Number(raw.balance))?Number(raw.balance):null,
        equity:Number.isFinite(Number(raw.equity))?Number(raw.equity):null,
        currency:raw.currency||null,
        loginid:raw.loginid||entry.accountId,
        tradeAllowed:typeof raw.tradeAllowed==="boolean"?raw.tradeAllowed:null,
        provider:"deriv",
        accountType,
        balanceUpdatedAt:entry.api?.accountBalanceAt?new Date(entry.api.accountBalanceAt).toISOString():null,
        balanceStreamActive:Boolean(entry.api?.balanceSubscriptionId)
      }};
    }
    if(String(entry.provider).toLowerCase()==="mt5-bridge"){
      const info=await entry.connection.getAccountInformation();
      return {connected:true,data:{...info,provider:"mt5-bridge",accountType:entry.executionMode==="LIVE"?"REAL":"DEMO"}};
    }
    if(entry.provider==="exness"){
      const info=await entry.api.getAccountInformation();
      let state={};
      try{
        const snapshot=await entry.api.websocketSnapshot();
        state=snapshot?.payload?.account_state||snapshot?.account_state||{};
        if(!state && snapshot?.payload?.accountState)state=snapshot.payload.accountState;
      }catch{}
      return {
        connected:true,
        data:{
          ...info,
          balance:state.balance??info.balance,
          equity:state.equity??info.equity,
          margin:state.used_margin??info.margin,
          freeMargin:state.free_margin??info.free_margin,
          marginLevel:state.margin_level??info.margin_level,
          tradeAllowed:info.trade_mode==="enabled" && info.account_status==="active",
          provider:"exness",
          accountType:entry.executionMode==="LIVE"?"REAL":"DEMO"
        }
      };
    }
    if(entry.provider==="deriv"){
      const info=await entry.api.getAccount();
      entry.accountInfo=info?.data||entry.accountInfo||null;
      entry.accountInfoAt=Date.now();
      return info;
    }
    if(entry.provider==="oanda"){
      const info=await entry.api.getAccountSummary();
      entry.accountInfo=info;
      entry.accountInfoAt=Date.now();
      return {connected:true,data:{
        ...info,
        balance:info.balance,
        equity:info.NAV,
        margin:info.marginUsed,
        freeMargin:info.marginAvailable,
        marginLevel:Number(info.marginUsed)>0 ? Number(info.NAV)/Number(info.marginUsed)*100 : null,
        tradeAllowed:true,
        provider:"oanda",
        accountType:entry.executionMode==="LIVE"?"REAL":"DEMO"
      }};
    }
    if(String(entry.provider).toLowerCase()==="deriv-mt5"){
      return {connected:true,data:{...entry.connection.terminalState.accountInformation,provider:"deriv-mt5",accountType:entry.executionMode==="LIVE"?"REAL":"DEMO"}};
    }
    return {connected:true,data:await entry.connection.getAccountInformation()};
  }

  async getPositions(userId){
    const entry=await this.connectionFor(userId);
    if(String(entry.provider).toLowerCase()==="mt5-bridge")return {connected:true,data:await entry.connection.getPositions()};
    if(entry.provider==="exness")return {connected:true,data:await entry.api.getPositions()};
    if(entry.provider==="deriv"){
      try{
        return await entry.api.getPositions();
      }catch(error){
        const message=String(error?.message||"");
        if(/DERIV_(?:WEBSOCKET_CLOSED|NOT_CONNECTED|REQUEST_TIMEOUT)/i.test(message)){
          // Delete the exact persistent mapping key; entry.accountId may not be
          // populated on older in-memory entries after a deploy/reconnect.
          const mapping=await this.getMapping(userId);
          const key=mapping
            ? String(userId)+":"+mapping.provider+":"+mapping.account_id
            : String(userId)+":"+entry.provider+":"+String(entry.accountId||"");
          this.connections.delete(key);
          const refreshed=await this.connectionFor(userId);
          return await refreshed.api.getPositions();
        }
        throw error;
      }
    }
    if(entry.provider==="oanda")return {connected:true,data:await entry.api.getPositions()};
    if(String(entry.provider).toLowerCase()==="deriv-mt5")return {connected:true,data:Array.isArray(entry.connection.terminalState.positions)?entry.connection.terminalState.positions:[]};
    return {connected:true,data:await entry.connection.getPositions()};
  }

  async getOrders(userId){
    const entry=await this.connectionFor(userId);
    if(String(entry.provider).toLowerCase()==="mt5-bridge")return {connected:true,data:await entry.connection.getOrders()};
    if(entry.provider==="exness")return {connected:true,data:await entry.api.getOrders()};
    if(entry.provider==="deriv")return await entry.api.getOrders();
    if(entry.provider==="oanda")return {connected:true,data:await entry.api.getOrders()};
    if(String(entry.provider).toLowerCase()==="deriv-mt5")return {connected:true,data:Array.isArray(entry.connection.terminalState.orders)?entry.connection.terminalState.orders:[]};
    return {connected:true,data:await entry.connection.getOrders()};
  }

  async getTrades({startTime,endTime,userId}={}){
    const entry=await this.connectionFor(userId);
    const end=endTime?new Date(endTime):new Date();
    const start=startTime?new Date(startTime):new Date(end.getTime()-24*60*60*1000);
    if(String(entry.provider).toLowerCase()==="mt5-bridge"){
      return {
        connected:true,
        data:{
          orders:await entry.connection.getHistoryOrdersByTimeRange(start,end),
          deals:await entry.connection.getDealsByTimeRange(start,end)
        }
      };
    }
    if(entry.provider==="exness"){
      return {
        connected:true,
        data:{
          orders:await entry.api.getHistoricalOrders({from:start.toISOString(),to:end.toISOString(),limit:200}),
          deals:await entry.api.getHistoricalDeals({from:start.toISOString(),to:end.toISOString(),limit:200})
        }
      };
    }
    if(entry.provider==="deriv"){
      return await entry.api.getTrades({startTime,endTime});
    }
    if(entry.provider==="oanda"){
      return {connected:true,data:await entry.api.getTrades({state:"CLOSE"})};
    }
    if(String(entry.provider).toLowerCase()==="deriv-mt5"){
      const history=entry.connection.historyStorage;
      const orders=history?.historyOrdersByTimeRange?history.historyOrdersByTimeRange(start,end):[];
      const deals=history?.dealsByTimeRange?history.dealsByTimeRange(start,end):[];
      return {connected:true,data:{orders,deals}};
    }
    const [orders,deals]=await Promise.all([entry.connection.getHistoryOrdersByTimeRange(start,end),entry.connection.getDealsByTimeRange(start,end)]);
    return {connected:true,data:{orders,deals}};
  }

  async validateMarket(userId,symbol){
    const requested=String(symbol||"").trim().toUpperCase();
    if(!requested)throw new Error("BROKER_SYMBOL_REQUIRED");
    const result=await this.getMarkets(userId);
    const markets=Array.isArray(result?.data)?result.data:[];
    const match=markets.find(item=>String(item?.symbol||"").trim().toUpperCase()===requested);
    if(!match)return {ok:false,error:"BROKER_MARKET_NOT_AVAILABLE"};
    if(match.tradeable===false)return {ok:false,error:"BROKER_MARKET_NOT_TRADEABLE"};
    return {ok:true,market:match};
  }

  async getMarkets(userId){
    let entry=await this.connectionFor(userId);
    if(String(entry.provider).toLowerCase()==="mt5-bridge"){
      const list=typeof entry.connection.getMarketCatalog==="function"
        ? await entry.connection.getMarketCatalog()
        : await entry.connection.getSymbols();
      return {connected:true,data:(Array.isArray(list)?list:[]).map(item=>typeof item==="string"
        ? {symbol:item.toUpperCase(),name:item,category:"CFD",submarket:"",tradeable:null,source:"mt5-ea-bridge"}
        : {symbol:String(item?.symbol||"").toUpperCase(),name:String(item?.name||item?.description||item?.symbol||"").trim(),
          category:String(item?.category||"CFD"),submarket:String(item?.path||item?.submarket||"").trim(),
          tradeable:typeof item?.tradeable==="boolean"?item.tradeable:null,source:item?.source||"mt5-ea-bridge",
          minVolume:Number(item?.minVolume)||null,maxVolume:Number(item?.maxVolume)||null,volumeStep:Number(item?.volumeStep)||null,
          digits:Number(item?.digits)||null,point:Number(item?.point)||null,tickSize:Number(item?.tickSize)||null,
          tickValue:Number(item?.tickValue)||null,stopsLevel:Number(item?.stopsLevel)||0,contractSize:Number(item?.contractSize)||null}).filter(x=>x.symbol)};
    }
        if(entry.provider==="exness")return {connected:true,data:await entry.api.getMarkets()};
    if(entry.provider==="deriv"){
      try{
        return {connected:true,data:await entry.api.getMarkets()};
      }catch(error){
        // A Deriv socket can close between connectionFor() and the actual
        // request. Drop the stale entry and perform one deterministic reconnect.
        const message=String(error?.message||"");
        if(message==="DERIV_NOT_CONNECTED" || message==="DERIV_WEBSOCKET_CLOSED"){
          const key=String(userId)+":deriv:"+entry.accountId;
          this.connections.delete(key);
          entry=await this.connectionFor(userId);
          return {connected:true,data:await entry.api.getMarkets()};
        }
        throw error;
      }
    }
    if(entry.provider==="oanda")return {connected:true,data:await entry.api.getMarkets()};
    if(String(entry.provider).toLowerCase()==="deriv-mt5" && entry.connection.terminalState?.specifications){
      const specs=entry.connection.terminalState.specifications;
      const list=Array.isArray(specs)?specs:Object.values(specs||{});
      return {connected:true,data:list.map(item=>({symbol:String(item?.symbol||"").toUpperCase(),name:String(item?.description||item?.symbol||"").trim(),category:"CFD",submarket:String(item?.path||"").trim(),tradeable:true,source:"deriv-mt5-stream",minVolume:Number(item?.minVolume)||null,maxVolume:Number(item?.maxVolume)||null,volumeStep:Number(item?.volumeStep)||null,digits:Number(item?.digits)||null,contractSize:Number(item?.contractSize)||null})).filter(x=>x.symbol)};
    }
    if(typeof entry.connection.getSymbols==="function"){
      const list=await entry.connection.getSymbols();
      return {connected:true,data:(Array.isArray(list)?list:[]).map(item=>typeof item==="string"?({symbol:item.toUpperCase(),name:item,category:"",submarket:"",tradeable:true,source:"broker"}):({symbol:String(item?.symbol||item?.name||"").toUpperCase(),name:String(item?.displayName||item?.name||item?.symbol||"").trim(),category:String(item?.type||item?.category||"").trim(),submarket:String(item?.group||"").trim(),tradeable:item?.tradeable!==false,source:"broker"})).filter(x=>x.symbol)};
    }
    return {connected:true,data:[]};
  }

  async getSymbolSpecification(symbol,userId){
    const entry=await this.connectionFor(userId);
    if(String(entry.provider).toLowerCase()==="mt5-bridge")return {connected:true,data:await entry.connection.getSymbolSpecification(String(symbol).trim().toUpperCase())};
    if(entry.provider==="exness")return {connected:true,data:await entry.api.getInstrumentConditions(String(symbol).trim().toUpperCase())};
    if(entry.provider==="deriv")return await entry.api.getSymbolSpecification(String(symbol).trim().toUpperCase());
    if(entry.provider==="oanda")return {connected:true,data:await entry.api.getInstrumentSpecification(String(symbol).trim().toUpperCase())};
    if(String(entry.provider).toLowerCase()==="deriv-mt5"){
      const spec=entry.connection.terminalState.specification(String(symbol).trim().toUpperCase());
      if(!spec)throw new Error("MT5_SYMBOL_NOT_AVAILABLE:"+String(symbol).trim().toUpperCase());
      return {connected:true,data:spec};
    }
    return {connected:true,data:await entry.connection.getSymbolSpecification(String(symbol).trim().toUpperCase())};
  }

  async getHistoricalCandles(symbol,timeframe,userId,limit=100){
    const entry=await this.connectionFor(userId);
    if(String(entry.provider).toLowerCase()==="mt5-bridge"){
      return {connected:true,data:await entry.connection.getHistoricalCandles(String(symbol).trim().toUpperCase(),String(timeframe),limit)};
    }
    if(entry.provider==="exness")throw new Error("EXNESS_CANDLES_ADAPTER_PENDING");
    if(entry.provider==="deriv")return await entry.api.getHistoricalCandles(String(symbol).trim().toUpperCase(),String(timeframe),limit);
    if(entry.provider==="oanda")return {connected:true,data:await entry.api.getHistoricalCandles(String(symbol).trim().toUpperCase(),String(timeframe),limit)};
    const connection=entry.connection;
    const count=Math.max(10,Math.min(1000,Number(limit)||100));
    const end=new Date();
    const minutes={"1m":1,"2m":2,"3m":3,"4m":4,"5m":5,"6m":6,"10m":10,"12m":12,"15m":15,"20m":20,"30m":30,"1h":60,"2h":120,"3h":180,"4h":240,"6h":360,"8h":480,"12h":720,"1d":1440,"1w":10080,"1mn":43200};
    const mins=minutes[String(timeframe)]||1;
    const start=new Date(end.getTime()-count*mins*60000);
    return {connected:true,data:await connection.getHistoricalCandles(String(symbol).trim().toUpperCase(),String(timeframe),start,end,count)};
  }

  async getQuote(symbol,userId){
    const requested=String(symbol).trim().toUpperCase();
    let entry=null;
    try{entry=await this.connectionFor(userId);}catch(error){
      const mapping=await this.getMapping(userId);
      if(mapping?.provider==="deriv"){
        // Deriv market data is public and must remain available even when the
        // authenticated trading socket is temporarily rate-limited.
        const publicApi=new DerivTraderClient();
        return await publicApi.getQuote(requested);
      }
      throw error;
    }
    if(String(entry.provider).toLowerCase()==="mt5-bridge"){
      return await entry.connection.getQuote(requested);
    }
    if(entry.provider==="exness"){
      const quote=await entry.api.getQuote(requested);
      return {connected:true,data:{...quote,time:quote.timestamp||quote.time||new Date().toISOString(),lossTickValue:quote.lossTickValue}};
    }
    if(entry.provider==="deriv"){
      return await entry.api.getQuote(requested);
    }
    if(entry.provider==="oanda"){
      const quote=await entry.api.getQuote(requested);
      return {connected:true,data:{...quote,lossTickValue:1}};
    }
    if(String(entry.provider).toLowerCase()==="deriv-mt5"){
      const price=entry.connection.terminalState.price(requested);
      if(!price)throw new Error("MT5_QUOTE_UNAVAILABLE:"+requested);
      return {connected:true,data:{...price,source:"deriv-mt5-stream"}};
    }
    return {connected:true,data:await entry.connection.getSymbolPrice(requested)};
  }

  async closePosition({userId,positionId}={}){
    if(!userId)throw new Error("USER_CONTEXT_REQUIRED");
    const entry=await this.connectionFor(userId);
    if(String(entry.ownerUserId||"")!==String(userId))throw new Error("EXECUTION_OWNER_MISMATCH");
    const id=String(positionId||"").trim();
    if(!id)throw new Error("BROKER_POSITION_ID_REQUIRED");
    if(String(entry.provider).toLowerCase()==="mt5-bridge")return {connected:true,data:await entry.connection.closePosition(id)};
    if(entry.provider==="exness"||entry.provider==="oanda"||entry.provider==="deriv")throw new Error("BROKER_POSITION_CLOSE_UNSUPPORTED");
    if(typeof entry.connection?.closePosition!=="function")throw new Error("BROKER_POSITION_CLOSE_UNSUPPORTED");
    return {connected:true,data:await entry.connection.closePosition(id)};
  }

  async modifyPositionStops({userId,positionId,symbol,stopLoss,takeProfit}={}){
    const entry=await this.connectionFor(userId);
    const id=String(positionId||"").trim();
    if(!id)throw new Error("BROKER_POSITION_ID_REQUIRED");
    if(entry.provider==="exness"){
      return {connected:true,data:await entry.api.modifyPositionStops({positionId:id,stopLoss,takeProfit})};
    }
    if(entry.provider==="oanda"){
      return {connected:true,data:await entry.api.modifyTradeStops(id,{stopLoss,takeProfit})};
    }
    if(entry.provider==="deriv"){
      throw new Error("DERIV_LADDER_POSITION_MODIFICATION_UNSUPPORTED");
    }
    if(typeof entry.connection.modifyPosition!=="function")throw new Error("BROKER_POSITION_MODIFICATION_UNSUPPORTED");
    return {connected:true,data:await entry.connection.modifyPosition(id,stopLoss??null,takeProfit??null)};
  }

  async placeOrder({side,symbol,volume,stopLoss,takeProfit,comment,clientId,userId,currency,multiplier,derivContractType}){
    if(!userId)throw new Error("EXECUTION_USER_CONTEXT_REQUIRED");
    if(!clientId || String(clientId).trim().length<12)throw new Error("EXECUTION_CLIENT_ID_REQUIRED");
    await this.assertExecutionAuthorized(userId);
    const entry=await this.connectionFor(userId);
    if(entry.provider==="deriv"){
      return await entry.api.placeOrder({side,symbol,volume,stopLoss,takeProfit,comment,clientId,userId,currency,multiplier,derivContractType});
    }
    if(entry.provider==="oanda"){
      return await entry.api.placeOrder({side,symbol,volume,stopLoss,takeProfit,comment,clientId});
    }
    if(entry.provider==="exness"){
      return await entry.api.openPosition({
        instrument:symbol,
        side:String(side).toLowerCase(),
        volume:qtyString(volume),
        stopLossPrice:stopLoss,
        takeProfitPrice:takeProfit,
        comment,
        clientRequestId:clientId
      });
    }
    const connection=entry.connection;
    const qty=Number(volume);
    if(!Number.isFinite(qty)||qty<=0)throw new Error("INVALID_ORDER_VOLUME");
    const s=String(symbol||"").trim().toUpperCase();
    if(!/^[A-Z0-9._-]{3,30}$/.test(s))throw new Error("INVALID_SYMBOL");
    const options={};
    if(comment)options.comment=String(comment).slice(0,100);
    if(clientId)options.clientId=String(clientId).slice(0,100);
    if(String(side).toUpperCase()==="BUY")return await connection.createMarketBuyOrder(s,qty,stopLoss,takeProfit,options);
    if(String(side).toUpperCase()==="SELL")return await connection.createMarketSellOrder(s,qty,stopLoss,takeProfit,options);
    throw new Error("INVALID_ORDER_SIDE");
  }
}
