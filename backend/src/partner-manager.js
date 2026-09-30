import crypto from "node:crypto";

const EVENT_TYPES = new Set(["CLICK","SIGNUP","KYC","FUNDED","ACTIVE","COMMISSION","PAID","REVERSED"]);
const BROKER_DEFS = {
  exness: {
    name: "Exness",
    provider: "exness",
    officialUrl: "https://www.exness.com/",
    model: "IB / affiliate",
    commissionBasis: "Volume / qualified referral",
    env: "BROKER_PARTNER_EXNESS_URL"
  },
  deriv: {
    name: "Deriv",
    provider: "deriv",
    officialUrl: "https://deriv.com/",
    model: "Partner / affiliate",
    commissionBasis: "Trading activity / revenue share",
    env: "BROKER_PARTNER_DERIV_URL"
  },
  oanda: {
    name: "OANDA",
    provider: "oanda",
    officialUrl: "https://www.oanda.com/",
    model: "IB / affiliate",
    commissionBasis: "Qualified referral / volume rebate",
    env: "BROKER_PARTNER_OANDA_URL"
  },
  ig: {
    name: "IG",
    provider: "ig",
    officialUrl: "https://www.ig.com/",
    model: "Introducing Partner / affiliate",
    commissionBasis: "Revenue share / referral",
    env: "BROKER_PARTNER_IG_URL"
  },
  fxcm: {
    name: "FXCM",
    provider: "fxcm",
    officialUrl: "https://www.fxcm.com/",
    model: "Affiliate / partner",
    commissionBasis: "Qualified referral / activity",
    env: "BROKER_PARTNER_FXCM_URL"
  },
  ibkr: {
    name: "Interactive Brokers",
    provider: "ibkr",
    officialUrl: "https://www.interactivebrokers.com/",
    model: "Referral / partner",
    commissionBasis: "Qualified referral",
    env: "BROKER_PARTNER_IBKR_URL"
  }
};

function envUrl(key){
  return String(process.env[key] || "").trim();
}

function materializeUrl(template, clickId){
  const value=envUrl(template);
  if(!value)return null;
  return value.replaceAll("{click_id}", encodeURIComponent(clickId));
}

function safeNumber(value){
  const n=Number(value);
  return Number.isFinite(n) ? n : null;
}

export class PartnerManager {
  constructor({pool}={}){
    this.pool=pool;
  }

  async ensureSchema(){
    if(!this.pool)return;
    await this.pool.query("CREATE TABLE IF NOT EXISTS kingbot_broker_partners (broker_slug TEXT PRIMARY KEY, broker_name TEXT NOT NULL, provider TEXT NOT NULL, official_url TEXT NOT NULL, partner_model TEXT NOT NULL, commission_basis TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    await this.pool.query("CREATE TABLE IF NOT EXISTS kingbot_partner_clicks (click_id UUID PRIMARY KEY, user_id UUID REFERENCES kingbot_users(id) ON DELETE SET NULL, broker_slug TEXT NOT NULL REFERENCES kingbot_broker_partners(broker_slug), landing_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), metadata JSONB NOT NULL DEFAULT '{}'::jsonb)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_kingbot_partner_clicks_broker_created ON kingbot_partner_clicks(broker_slug,created_at DESC)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_kingbot_partner_clicks_user ON kingbot_partner_clicks(user_id,created_at DESC)");
    await this.pool.query("CREATE TABLE IF NOT EXISTS kingbot_partner_events (id BIGSERIAL PRIMARY KEY, click_id UUID REFERENCES kingbot_partner_clicks(click_id) ON DELETE SET NULL, user_id UUID REFERENCES kingbot_users(id) ON DELETE SET NULL, broker_slug TEXT NOT NULL REFERENCES kingbot_broker_partners(broker_slug), event_type TEXT NOT NULL CHECK(event_type IN ('CLICK','SIGNUP','KYC','FUNDED','ACTIVE','COMMISSION','PAID','REVERSED')), external_reference TEXT, amount NUMERIC(20,8), currency TEXT NOT NULL DEFAULT 'USD', source TEXT NOT NULL DEFAULT 'partner_feed', occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_kingbot_partner_events_broker_occurred ON kingbot_partner_events(broker_slug,occurred_at DESC)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_kingbot_partner_events_type ON kingbot_partner_events(event_type,occurred_at DESC)");
    await this.pool.query("CREATE UNIQUE INDEX IF NOT EXISTS ux_kingbot_partner_events_external_ref ON kingbot_partner_events(broker_slug,event_type,external_reference) WHERE external_reference IS NOT NULL");

    for(const [slug,d] of Object.entries(BROKER_DEFS)){
      await this.pool.query(
        "INSERT INTO kingbot_broker_partners(broker_slug,broker_name,provider,official_url,partner_model,commission_basis,active,updated_at) VALUES($1,$2,$3,$4,$5,$6,TRUE,NOW()) ON CONFLICT(broker_slug) DO UPDATE SET broker_name=EXCLUDED.broker_name,provider=EXCLUDED.provider,official_url=EXCLUDED.official_url,partner_model=EXCLUDED.partner_model,commission_basis=EXCLUDED.commission_basis,updated_at=NOW()",
        [slug,d.name,d.provider,d.officialUrl,d.model,d.commissionBasis]
      );
    }
  }

  catalog(){
    return Object.entries(BROKER_DEFS).map(([slug,d])=>{
      const configured=Boolean(envUrl(d.env));
      return {
        slug,
        name:d.name,
        provider:d.provider,
        officialUrl:d.officialUrl,
        partnerModel:d.model,
        commissionBasis:d.commissionBasis,
        partnerLinkConfigured:configured,
        routeMode:configured ? "PARTNER_TRACKED" : "OFFICIAL_FALLBACK"
      };
    });
  }

  async trackClick({userId,brokerSlug,landingUrl,metadata={}}={}){
    const slug=String(brokerSlug||"").trim().toLowerCase();
    const def=BROKER_DEFS[slug];
    if(!def)throw new Error("UNKNOWN_BROKER");
    const clickId=crypto.randomUUID();
    if(this.pool){
      await this.pool.query(
        "INSERT INTO kingbot_partner_clicks(click_id,user_id,broker_slug,landing_url,metadata) VALUES($1,$2,$3,$4,$5::jsonb)",
        [clickId,userId||null,slug,String(landingUrl||"").slice(0,500),JSON.stringify(metadata||{})]
      );
      await this.pool.query(
        "INSERT INTO kingbot_partner_events(click_id,user_id,broker_slug,event_type,source,metadata) VALUES($1,$2,$3,'CLICK','kingbot_frontend',$4::jsonb)",
        [clickId,userId||null,slug,JSON.stringify({landingUrl:String(landingUrl||"").slice(0,500)})]
      );
    }
    const partnerUrl=materializeUrl(def.env,clickId);
    return {
      ok:true,
      clickId,
      broker:slug,
      tracked:Boolean(partnerUrl),
      redirectUrl:partnerUrl || def.officialUrl
    };
  }

  async dashboard({days=30}={}){
    if(!this.pool){
      return {ok:true,configured:false,days,data:null};
    }
    const windowDays=Math.max(1,Math.min(365,Number(days)||30));
    const [summary,brokers,recent]=await Promise.all([
      this.pool.query(
        "SELECT COUNT(*)::int AS clicks, COUNT(DISTINCT CASE WHEN event_type IN ('SIGNUP','KYC','FUNDED','ACTIVE') THEN COALESCE(user_id::text,click_id::text) END)::int AS qualified_referrals, COALESCE(SUM(CASE WHEN event_type='COMMISSION' THEN amount ELSE 0 END),0)::numeric AS gross_commission, COALESCE(SUM(CASE WHEN event_type='PAID' THEN amount ELSE 0 END),0)::numeric AS paid_commission, COALESCE(SUM(CASE WHEN event_type='REVERSED' THEN amount ELSE 0 END),0)::numeric AS reversed_commission FROM kingbot_partner_events WHERE occurred_at>=NOW()-($1 * INTERVAL '1 day')",
        [windowDays]
      ),
      this.pool.query(
        "SELECT p.broker_slug,p.broker_name,p.partner_model,p.commission_basis,p.active,COALESCE(c.clicks,0)::int AS clicks,COALESCE(q.qualified_referrals,0)::int AS qualified_referrals,COALESCE(m.gross_commission,0)::numeric AS gross_commission,COALESCE(m.paid_commission,0)::numeric AS paid_commission FROM kingbot_broker_partners p LEFT JOIN (SELECT broker_slug,COUNT(*)::int AS clicks FROM kingbot_partner_clicks WHERE created_at>=NOW()-($1 * INTERVAL '1 day') GROUP BY broker_slug) c ON c.broker_slug=p.broker_slug LEFT JOIN (SELECT broker_slug,COUNT(DISTINCT COALESCE(user_id::text,click_id::text))::int AS qualified_referrals FROM kingbot_partner_events WHERE occurred_at>=NOW()-($1 * INTERVAL '1 day') AND event_type IN ('SIGNUP','KYC','FUNDED','ACTIVE') GROUP BY broker_slug) q ON q.broker_slug=p.broker_slug LEFT JOIN (SELECT broker_slug,COALESCE(SUM(CASE WHEN event_type='COMMISSION' THEN amount ELSE 0 END),0)::numeric AS gross_commission,COALESCE(SUM(CASE WHEN event_type='PAID' THEN amount ELSE 0 END),0)::numeric AS paid_commission FROM kingbot_partner_events WHERE occurred_at>=NOW()-($1 * INTERVAL '1 day') GROUP BY broker_slug) m ON m.broker_slug=p.broker_slug ORDER BY gross_commission DESC,clicks DESC",
        [windowDays]
      ),
      this.pool.query(
        "SELECT e.id,e.broker_slug,p.broker_name,e.event_type,e.amount,e.currency,e.external_reference,e.source,e.occurred_at,e.click_id FROM kingbot_partner_events e JOIN kingbot_broker_partners p ON p.broker_slug=e.broker_slug ORDER BY e.occurred_at DESC LIMIT 40"
      )
    ]);
    const row=summary.rows[0]||{};
    const gross=safeNumber(row.gross_commission)||0;
    const paid=safeNumber(row.paid_commission)||0;
    const reversed=safeNumber(row.reversed_commission)||0;
    return {
      ok:true,
      configured:true,
      days:windowDays,
      config:this.catalog(),
      totals:{
        clicks:Number(row.clicks||0),
        qualifiedReferrals:Number(row.qualified_referrals||0),
        grossCommission:gross,
        paidCommission:paid,
        reversedCommission:reversed,
        outstandingCommission:Math.max(0,gross-paid-reversed)
      },
      brokers:brokers.rows.map(r=>({
        brokerSlug:r.broker_slug,
        brokerName:r.broker_name,
        partnerModel:r.partner_model,
        commissionBasis:r.commission_basis,
        active:Boolean(r.active),
        clicks:Number(r.clicks||0),
        qualifiedReferrals:Number(r.qualified_referrals||0),
        grossCommission:safeNumber(r.gross_commission)||0,
        paidCommission:safeNumber(r.paid_commission)||0
      })),
      recent:recent.rows
    };
  }

  async ingestEvents(events=[]){
    if(!this.pool)throw new Error("DATABASE_NOT_CONFIGURED");
    if(!Array.isArray(events)||!events.length)throw new Error("EVENTS_REQUIRED");
    if(events.length>250)throw new Error("EVENT_BATCH_TOO_LARGE");
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      const inserted=[];
      for(const event of events){
        const slug=String(event?.brokerSlug||"").trim().toLowerCase();
        const type=String(event?.eventType||"").trim().toUpperCase();
        if(!BROKER_DEFS[slug])throw new Error("UNKNOWN_BROKER:"+slug);
        if(!EVENT_TYPES.has(type))throw new Error("INVALID_EVENT_TYPE:"+type);
        const amount=safeNumber(event?.amount);
        const currency=String(event?.currency||"USD").trim().toUpperCase().slice(0,10)||"USD";
        const occurredAt=event?.occurredAt?new Date(event.occurredAt):new Date();
        if(Number.isNaN(occurredAt.getTime()))throw new Error("INVALID_OCCURRED_AT");
        const userId=event?.userId?String(event.userId):null;
        const clickId=event?.clickId?String(event.clickId):null;
        const meta=event?.metadata && typeof event.metadata==="object" ? event.metadata : {};
        const q=await client.query(
          "INSERT INTO kingbot_partner_events(click_id,user_id,broker_slug,event_type,external_reference,amount,currency,source,occurred_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT DO NOTHING RETURNING id,broker_slug,event_type,amount,currency,occurred_at",
          [clickId,userId,slug,type,event?.externalReference?String(event.externalReference).slice(0,150):null,amount,currency,String(event?.source||"partner_feed").slice(0,60),occurredAt.toISOString(),JSON.stringify(meta)]
        );
        inserted.push(q.rows[0]);
      }
      await client.query("COMMIT");
      return {ok:true,inserted};
    }catch(error){
      await client.query("ROLLBACK");
      throw error;
    }finally{
      client.release();
    }
  }
}

export { BROKER_DEFS };
