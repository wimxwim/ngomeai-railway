const { pool } = require("../db");
const logger = require("../utils/logger");
const { getClientCache, setClientCache, delClientCache } = require("../utils/redis");
const { searchTemplate: templateSearch } = require("../templates/index.js");

// Redis lock for orchestrator mutex
const redisLock = require("redis");

let lockClient = null;
function getLockClient() {
  if (lockClient) return lockClient;
  const host = process.env.REDIS_HOST || "127.0.0.1";
  const port = Number(process.env.REDIS_PORT) || 6379;
  lockClient = redisLock.createClient({ socket: { host, port } });
  lockClient.on("error", () => { lockClient = null; });
  lockClient.connect().catch(() => { lockClient = null; });
  return lockClient;
}

const LOCK_TTL = 60; // 60 seconds

async function acquireProcessingLock(userPhone) {
  if (!userPhone) return false;
  const client = getLockClient();
  if (!client) {
    logger.warn("Redis down, rejecting processing", { phone: userPhone });
    return false; // fail-closed: reject if Redis is down
  }
  const key = `user:${userPhone}:processing`;
  try {
    const result = await client.set(key, "1", { NX: true, EX: LOCK_TTL });
    return result === "OK";
  } catch (e) {
    logger.warn("Redis error, rejecting processing", { error: e.message, phone: userPhone });
    return false; // fail-closed: reject on Redis error
  }
}

async function releaseProcessingLock(userPhone) {
  if (!userPhone) return;
  const client = getLockClient();
  if (!client) return;
  const key = `user:${userPhone}:processing`;
  try {
    await client.del(key);
  } catch (e) { /* ignore */ }
}

// ─── Transaction helper ───────────────────────────────────────────

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Combined saveChatHistory + setConversationState in a transaction
async function saveChatAndSetState(klienId, phone, userMessage, botAnswer, usedAi, aiGeneratedReply, isSent, direction, mediaType, mediaUrl, isGroup, groupName, newState, senderName) {
  return withTransaction(async (client) => {
    const safePhone      = normalizePhone(phone);
    const safeUser       = String(userMessage || "").slice(0, 4000);
    const safeBot        = String(botAnswer || "").slice(0, 4000);
    const safeAiReply    = aiGeneratedReply != null ? String(aiGeneratedReply).slice(0, 4000) : null;
    const safeSent       = isSent !== false;
    const safeDir        = direction === "out" ? "out" : "in";
    const safeMType      = mediaType || null;
    const safeMUrl       = mediaUrl ? String(mediaUrl).slice(0, 2000) : null;
    const safeGName      = groupName ? String(groupName).slice(0, 255) : null;
    const safeSenderName = senderName ? String(senderName).slice(0, 255) : null;

    await client.query(
      `INSERT INTO chat_history (klien_id, user_phone, user_message, bot_answer, used_ai, ai_generated_reply, is_sent, direction, media_type, media_url, is_group, group_name, sender_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [klienId, safePhone, safeUser, safeBot, Boolean(usedAi), safeAiReply, safeSent, safeDir, safeMType, safeMUrl, Boolean(isGroup), safeGName, safeSenderName]
    );

    if (newState) {
      const safeState = newState == null ? null : String(newState).slice(0, 128);
      await client.query(
        `INSERT INTO conversations (klien_id, user_phone, current_state, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (klien_id, user_phone)
         DO UPDATE SET current_state = EXCLUDED.current_state, updated_at = NOW()`,
        [klienId, safePhone, safeState]
      );
    }
  });
}

// Client cache is now handled by Redis utility (with in-memory fallback)

// ─── Client ────────────────────────────────────────────────────────────────

async function getClientByPhoneId(phoneNumberId) {
  if (!phoneNumberId || typeof phoneNumberId !== "string") return null;

  const cached = await getClientCache(phoneNumberId);
  if (cached) return cached;

  const { rows } = await pool.query(
    `SELECT id, phone_number_id, meta_token, msg_limit, provider, system_prompt,
            gowa_device_id, waha_session, waha_url, reply_mode,
            listen_personal, listen_group, blocked_phones, skip_personal,
            business_type, business_profile
     FROM clients
     WHERE phone_number_id = $1 AND aktif = TRUE
     LIMIT 1`,
    [phoneNumberId]
  );
  const value = rows[0] || null;
  await setClientCache(phoneNumberId, value);
  return value;
}

// Invalidate by phone_number_id (keyed value in cache)
function invalidateClientCache(phoneNumberId) {
  if (phoneNumberId) delClientCache(phoneNumberId).catch(() => {});
}

// Invalidate all cache keys for a given client id.
// Queries the DB to get phone_number_id and evolution_instance, then deletes both cache keys.
async function invalidateClientCacheById(clientId) {
  if (!clientId) return;
  try {
    const { rows } = await pool.query(
      "SELECT phone_number_id, evolution_instance FROM clients WHERE id = $1 LIMIT 1",
      [clientId]
    );
    if (!rows[0]) return;
    const { phone_number_id, evolution_instance } = rows[0];
    const tasks = [];
    if (phone_number_id) tasks.push(delClientCache(phone_number_id));
    if (evolution_instance) tasks.push(delClientCache(`evo:${evolution_instance}`));
    await Promise.all(tasks);
  } catch (_) {}
}

// ─── Deduplication ─────────────────────────────────────────────────────────

async function isMessageProcessed(msgId) {
  if (!msgId || typeof msgId !== "string" || msgId.length > 256) return false;
  const { rows } = await pool.query(
    `INSERT INTO processed_messages (msg_id)
     VALUES ($1)
     ON CONFLICT (msg_id) DO NOTHING
     RETURNING msg_id`,
    [msgId]
  );
  return rows.length === 0;
}

// ─── Rate limiter ──────────────────────────────────────────────────────────

// Normalize phone: strip non-digits, strip leading 0 (Indonesian local → international)
function normalizePhone(phone) {
  let digits = String(phone || "").replace(/\D/g, "").slice(0, 15);
  // Convert local Indonesian "08xxx" → "628xxx"
  if (digits.startsWith("0")) digits = "62" + digits.slice(1);
  return digits;
}

async function checkRateLimit(phoneNumber, maxPerMinute = 5) {
  if (!phoneNumber || typeof phoneNumber !== "string") return true;
  const normalized = normalizePhone(phoneNumber);
  if (!normalized) return true;
  const { rows } = await pool.query(
    `INSERT INTO rate_limit (phone_number, count, window_start)
     VALUES ($1, 1, NOW())
     ON CONFLICT (phone_number) DO UPDATE
       SET
         window_start = CASE
           WHEN EXTRACT(EPOCH FROM NOW() - rate_limit.window_start) > 60
           THEN NOW()
           ELSE rate_limit.window_start
         END,
         count = CASE
           WHEN EXTRACT(EPOCH FROM NOW() - rate_limit.window_start) > 60
           THEN 1
           ELSE rate_limit.count + 1
         END
     RETURNING count`,
    [normalized]
  );
  return rows[0].count > maxPerMinute;
}

// ─── ILIKE wildcard escape ─────────────────────────────────────────────────
// Prevent keywords containing '%' or '_' from acting as SQL wildcards,
// which would cause unintended matches against user messages.
// PostgreSQL ILIKE uses '\' as the ESCAPE character.

function escapeLikePattern(str) {
  return str.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// ─── Template search ───────────────────────────────────────────────────────

async function searchTemplate(klienId, message) {
  return templateSearch(klienId, message);
}

async function searchKnowledgeBase(klienId, message) {
  if (!klienId || !message) return null;
  // Trigram similarity search using pg_trgm
  const { rows } = await pool.query(
    `SELECT content, keywords,
       (SELECT COALESCE(MAX(similarity(trim(kw), LOWER($2))), 0)
        FROM unnest(string_to_array(keywords, ',')) AS kw
        WHERE trim(kw) != '') AS best_sim
     FROM knowledge_base
     WHERE klien_id = $1
       AND EXISTS (
         SELECT 1 FROM unnest(string_to_array(keywords, ',')) AS kw
         WHERE trim(kw) != '' AND similarity(trim(kw), LOWER($2)) > 0.3
       )
     ORDER BY best_sim DESC, id DESC
     LIMIT 1`,
    [klienId, message]
  );
  return rows[0]?.content || null;
}

// ─── Usage quota ───────────────────────────────────────────────────────────

async function consumeUsageQuota(klienId, msgLimit = 1000) {
  if (!klienId) return false;
  const today = new Date().toISOString().slice(0, 10);
  // Atomic quota check + increment dalam satu query PostgreSQL.
  // Gunakan "RETURNING" sebagai sinyal apakah increment benar-benar terjadi:
  // - INSERT berhasil → ai_calls = 1 (di bawah limit) → returning row
  // - DO UPDATE berhasil (ai_calls < limit) → returning row
  // - DO UPDATE tidak jalan (ai_calls >= limit) → tidak ada returning row → ditolak
  // Ini aman terhadap concurrent access karena DO UPDATE memakai row-level lock.
  const { rows } = await pool.query(
    `INSERT INTO usage_tracker (klien_id, date, ai_calls, total_messages)
     VALUES ($1, $2, 1, 0)
     ON CONFLICT (klien_id, date) DO UPDATE
       SET ai_calls = usage_tracker.ai_calls + 1
       WHERE usage_tracker.ai_calls < $3
     RETURNING ai_calls`,
    [klienId, today, msgLimit]
  );
  // Jika rows kosong → DO UPDATE tidak terjadi → quota sudah penuh → tolak
  return rows.length > 0;
}

// ─── Analytics ─────────────────────────────────────────────────────────────

async function incrementTotalMessages(klienId) {
  if (!klienId) return;
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO usage_tracker (klien_id, date, ai_calls, total_messages)
     VALUES ($1, $2, 0, 1)
     ON CONFLICT (klien_id, date)
     DO UPDATE SET total_messages = usage_tracker.total_messages + 1`,
    [klienId, today]
  );
}

async function saveChatHistory(klienId, phone, userMessage, botAnswer, usedAi, aiGeneratedReply, isSent, direction, mediaType, mediaUrl, isGroup, groupName = null) {
  if (!klienId || !phone) return;
  const safePhone   = normalizePhone(phone); // Normalize phone for consistency
  const safeUser    = String(userMessage       || "").slice(0, 4000);
  const safeBot     = String(botAnswer         || "").slice(0, 4000);
  const safeAiReply = aiGeneratedReply != null ? String(aiGeneratedReply).slice(0, 4000) : null;
  const safeSent    = isSent !== false;
  const safeDir     = direction === "out" ? "out" : "in";
  const safeMType   = mediaType  || null;
  const safeMUrl    = mediaUrl   ? String(mediaUrl).slice(0, 2000) : null;
  const safeGName   = groupName  ? String(groupName).slice(0, 255) : null;
  await pool.query(
    `INSERT INTO chat_history (klien_id, user_phone, user_message, bot_answer, used_ai, ai_generated_reply, is_sent, direction, media_type, media_url, is_group, group_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [klienId, safePhone, safeUser, safeBot, Boolean(usedAi), safeAiReply, safeSent, safeDir, safeMType, safeMUrl, Boolean(isGroup), safeGName]
  );
}

async function getRecentHistory(klienId, userPhone, limit = 5) {
  if (!klienId || !userPhone) return [];
  const safePhone = normalizePhone(userPhone); // Normalize for consistency with saveChatHistory
  const safeLimit = Math.min(Math.max(1, Number(limit) || 5), 20);
  const { rows } = await pool.query(
    `SELECT user_message, bot_answer
     FROM chat_history
     WHERE klien_id = $1 AND user_phone = $2
     ORDER BY id DESC
     LIMIT $3`,
    [klienId, safePhone, safeLimit]
  );
  return rows.reverse().flatMap(r => [
    { role: "user",      content: r.user_message },
    { role: "assistant", content: r.bot_answer   },
  ]);
}

module.exports = {
  getClientByPhoneId,
  invalidateClientCache,
  invalidateClientCacheById,
  isMessageProcessed,
  checkRateLimit,
  normalizePhone,
  escapeLikePattern,
  searchTemplate,
  searchKnowledgeBase,
  consumeUsageQuota,
  incrementTotalMessages,
  saveChatHistory,
  getRecentHistory,
  acquireProcessingLock,
  releaseProcessingLock,
  withTransaction,
  saveChatAndSetState,
};
