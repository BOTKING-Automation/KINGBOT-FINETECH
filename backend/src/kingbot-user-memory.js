/**
 * KINGBOT USER MEMORY v1
 *
 * Durable, non-sensitive preference/context memory.
 * Memory is explicit-first: KINGBOT stores only clear user statements,
 * not inferred sensitive attributes.
 */

function clean(value, max = 240) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function key(value) {
  return clean(value, 80).toLowerCase().replace(/[^a-z0-9:_-]+/g, "_");
}

export async function ensureUserMemorySchema(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kingbot_user_memory (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES kingbot_users(id) ON DELETE CASCADE,
      memory_type TEXT NOT NULL,
      memory_key TEXT NOT NULL,
      memory_value JSONB NOT NULL DEFAULT '{}'::jsonb,
      source TEXT NOT NULL DEFAULT 'explicit_user_statement',
      confidence NUMERIC(4,3) NOT NULL DEFAULT 1.000,
      confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id,memory_type,memory_key)
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_kb_user_memory_user_updated ON kingbot_user_memory(user_id,updated_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_kb_user_memory_type ON kingbot_user_memory(user_id,memory_type)");
}

export async function loadUserMemory(pool, userId, { limit = 30 } = {}) {
  if (!pool || !userId) return [];
  const q = await pool.query(
    "SELECT memory_type,memory_key,memory_value,source,confidence,confirmed_at,expires_at,updated_at FROM kingbot_user_memory WHERE user_id=$1 AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY updated_at DESC LIMIT $2",
    [userId, Math.min(100, Math.max(1, Number(limit) || 30))]
  );
  return q.rows;
}

export async function rememberUserFact(pool, {
  userId,
  memoryType = "PREFERENCE",
  memoryKey,
  value,
  source = "explicit_user_statement",
  confidence = 1
} = {}) {
  if (!pool || !userId || !memoryKey) return null;
  const q = await pool.query(
    "INSERT INTO kingbot_user_memory(user_id,memory_type,memory_key,memory_value,source,confidence,confirmed_at,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,NOW(),NOW()) ON CONFLICT(user_id,memory_type,memory_key) DO UPDATE SET memory_value=EXCLUDED.memory_value,source=EXCLUDED.source,confidence=EXCLUDED.confidence,confirmed_at=NOW(),updated_at=NOW() RETURNING memory_type,memory_key,memory_value,source,confidence,confirmed_at,updated_at",
    [
      userId,
      clean(memoryType, 60).toUpperCase(),
      key(memoryKey),
      JSON.stringify({ value: clean(value) }),
      clean(source, 80),
      Math.max(0, Math.min(1, Number(confidence) || 0))
    ]
  );
  return q.rows[0] || null;
}

/**
 * Store only explicit, non-sensitive preferences/context.
 * No passwords, API secrets, financial credentials, health, political,
 * biometric or similarly sensitive inferences are extracted here.
 */
export async function learnExplicitUserMemory(pool, {
  userId,
  question = "",
  conversation = []
} = {}) {
  if (!pool || !userId) return [];
  const q = clean(question, 1200);
  const learned = [];
  const patterns = [
    { regex: /\b(?:i\s+)?prefer(?:\s+to)?\s+(?:use\s+)?(.{2,100})$/i, type: "PREFERENCE", key: "response_preference" },
    { regex: /\bi\s+(?:usually|normally)\s+trade\s+([A-Za-z0-9/_ -]{2,40})/i, type: "TRADING_PREFERENCE", key: "usual_market" },
    { regex: /\bi\s+trade\s+([A-Za-z0-9/_ -]{2,40})\s+mostly/i, type: "TRADING_PREFERENCE", key: "usual_market" },
    { regex: /\bmy\s+goal\s+is\s+(.{2,160})$/i, type: "USER_GOAL", key: "primary_goal" },
    { regex: /\bremember\s+that\s+(.{2,180})$/i, type: "USER_CONTEXT", key: "remembered_fact" },
    { regex: /\bi(?:'m| am)\s+building\s+(.{2,160})$/i, type: "PROJECT_CONTEXT", key: "current_project" }
  ];
  for (const p of patterns) {
    const match = q.match(p.regex);
    if (!match) continue;
    const fact = clean(match[1]);
    if (!fact) continue;
    const saved = await rememberUserFact(pool, {
      userId,
      memoryType: p.type,
      memoryKey: p.key,
      value: fact,
      source: "explicit_user_statement",
      confidence: 1
    });
    if (saved) learned.push(saved);
  }

  const latestTurn = Array.isArray(conversation) ? conversation.at(-1) : null;
  if (latestTurn && typeof latestTurn === "object" && latestTurn.role === "user") {
    const feedback = clean(latestTurn.content || latestTurn.text || "", 800);
    const toneMatch = feedback.match(/\b(?:too\s+(?:cold|robotic|blunt|rude)|be\s+more\s+(?:friendly|natural|direct))\b/i);
    if (toneMatch) {
      const saved = await rememberUserFact(pool, {
        userId,
        memoryType: "TONE_PREFERENCE",
        memoryKey: "assistant_tone",
        value: feedback,
        source: "explicit_tone_feedback",
        confidence: 1
      });
      if (saved) learned.push(saved);
    }
  }

  return learned;
}

export function summarizeUserMemory(memory = []) {
  return (Array.isArray(memory) ? memory : []).slice(0, 20).map(row => ({
    type: row.memory_type,
    key: row.memory_key,
    value: row.memory_value?.value ?? null,
    confidence: Number(row.confidence ?? 0),
    updatedAt: row.updated_at || null
  }));
}
