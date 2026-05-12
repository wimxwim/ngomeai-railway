const { pool } = require("../db");
const logger   = require("../utils/logger");
const crypto   = require("crypto");

// ─── Audit log ─────────────────────────────────────────────────────────────
// Non-fatal: audit failures must never block the actual operation.

async function auditLog({ actor = "admin", action, targetType, targetId, payload = {}, ip }) {
  try {
    // Strip sensitive fields before storing
    const safe = Object.assign({}, payload);
    delete safe.meta_token;
    delete safe.password;
    await pool.query(
      `INSERT INTO audit_log (actor, action, target_type, target_id, payload, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actor, action, targetType, String(targetId != null ? targetId : ""), JSON.stringify(safe), ip || null]
    );
  } catch (err) {
    logger.warn("auditLog write failed", { error: err.message });
  }
}

async function listAuditLog({ limit = 50, offset = 0 } = {}) {
  const safeLmt = Math.min(Number(limit) || 50, 200);
  const safeOff = Math.max(0, Number(offset) || 0);
  const { rows } = await pool.query(
    `SELECT id, actor, action, target_type, target_id, payload, ip, created_at
     FROM audit_log
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [safeLmt, safeOff]
  );
  return rows;
}

// ─── Clients ───────────────────────────────────────────────────────────────

async function listClients() {
  const { rows } = await pool.query(
    `SELECT id, nama, phone_number_id, paket, msg_limit, aktif, provider,
            system_prompt, business_type, business_profile,
            evolution_instance, evolution_url, baileys_session,
            reply_mode, listen_personal, listen_group, blocked_phones, created_at
     FROM clients ORDER BY created_at DESC`
  );
  return rows;
}

async function createClient({
  id,
  nama,
  phone_number_id,
  meta_token,
  msg_limit        = 1000,
  provider         = "meta",
  system_prompt    = null,
  business_type    = "umum",
  business_profile = null,
  evolution_instance = null,
  evolution_url      = null,
  baileys_session    = null,
}) {
  const safeLimit    = Math.max(1, parseInt(msg_limit) || 1000);
  const safeProvider = ["meta", "evolution", "baileys"].includes(provider) ? provider : "meta";
  const safeBizType  = ["umum","masjid","toko","sekolah","kesehatan","properti","kuliner","jasa"].includes(business_type)
    ? business_type : "umum";
  // business_profile: max 4000 karakter agar tidak overload system prompt
  const safeProfile  = business_profile ? String(business_profile).slice(0, 4000) : null;

  await pool.query(
    `INSERT INTO clients
       (id, nama, phone_number_id, meta_token, msg_limit, aktif, provider,
        system_prompt, business_type, business_profile,
        evolution_instance, evolution_url, baileys_session)
     VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id, nama, phone_number_id, meta_token, safeLimit, safeProvider,
      system_prompt     || null,
      safeBizType,
      safeProfile,
      evolution_instance || null,
      evolution_url      || null,
      baileys_session    || null,
    ]
  );
  return { id };
}

async function updateClient({
  id,
  nama,
  msg_limit,
  system_prompt,
  business_type,
  hasBusinessType,
  business_profile,
  hasBusinessProfile,
  evolution_instance,
  hasEvolutionInst,
  evolution_url,
  hasEvolutionUrl,
  baileys_session,
  hasBaileysSession,
}) {
  const safeBizType = business_type && ["umum","masjid","toko","sekolah","kesehatan","properti","kuliner","jasa"].includes(business_type)
    ? business_type : null;
  // Truncate profil agar tidak overload DB dan system prompt
  const safeProfile = business_profile != null ? String(business_profile).slice(0, 4000) : null;

  await pool.query(
    `UPDATE clients SET
       nama               = COALESCE($2, nama),
       msg_limit          = COALESCE($3, msg_limit),
       system_prompt      = $4,
       business_type      = CASE WHEN $5::boolean  THEN $6  ELSE business_type     END,
       business_profile   = CASE WHEN $7::boolean  THEN $8  ELSE business_profile  END,
       evolution_instance = CASE WHEN $9::boolean  THEN $10 ELSE evolution_instance END,
       evolution_url      = CASE WHEN $11::boolean THEN $12 ELSE evolution_url      END,
       baileys_session    = CASE WHEN $13::boolean THEN $14 ELSE baileys_session    END
     WHERE id = $1`,
    [
      id,
      nama      != null ? nama      : null,
      msg_limit != null ? msg_limit : null,
      system_prompt != null ? system_prompt : null,
      hasBusinessType    === true,
      safeBizType,
      hasBusinessProfile === true,
      safeProfile,
      hasEvolutionInst   === true,
      evolution_instance || null,
      hasEvolutionUrl    === true,
      evolution_url      || null,
      hasBaileysSession  === true,
      baileys_session    || null,
    ]
  );
}

async function deleteClient(id) {
  await pool.query("DELETE FROM clients WHERE id = $1", [id]);
}

async function toggleClient({ id, aktif }) {
  await pool.query("UPDATE clients SET aktif = $2 WHERE id = $1", [id, aktif]);
}

async function setReplyMode({ id, replyMode }) {
  await pool.query("UPDATE clients SET reply_mode = $2 WHERE id = $1", [id, replyMode]);
}

async function setListenMode({ id, listenPersonal, listenGroup }) {
  const sets = [];
  const vals = [id];
  if (listenPersonal !== undefined) { vals.push(listenPersonal); sets.push(`listen_personal=$${vals.length}`); }
  if (listenGroup    !== undefined) { vals.push(listenGroup);    sets.push(`listen_group=$${vals.length}`); }
  if (!sets.length) return;
  await pool.query(`UPDATE clients SET ${sets.join(",")} WHERE id=$1`, vals);
}

async function blockPhone({ id, phone }) {
  await pool.query(
    "UPDATE clients SET blocked_phones = array_append(blocked_phones, $2) WHERE id = $1 AND NOT ($2 = ANY(blocked_phones))",
    [id, phone]
  );
}

async function unblockPhone({ id, phone }) {
  await pool.query(
    "UPDATE clients SET blocked_phones = array_remove(blocked_phones, $2) WHERE id = $1",
    [id, phone]
  );
}

// ─── Templates ─────────────────────────────────────────────────────────────

async function listTemplates(klien_id) {
  const { rows } = await pool.query(
    `SELECT id, klien_id, keywords, answer, created_at
     FROM templates WHERE klien_id = $1 ORDER BY id DESC`,
    [klien_id]
  );
  return rows;
}

async function createTemplate({ klien_id, keywords, answer }) {
  const { rows } = await pool.query(
    `INSERT INTO templates (klien_id, keywords, answer) VALUES ($1, $2, $3) RETURNING id`,
    [klien_id, keywords, answer]
  );
  return { id: rows[0].id };
}

async function updateTemplate({ id, keywords, answer }) {
  await pool.query(
    `UPDATE templates SET keywords = $2, answer = $3 WHERE id = $1`,
    [id, keywords, answer]
  );
}

async function deleteTemplate(id) {
  await pool.query("DELETE FROM templates WHERE id = $1", [id]);
}

// ─── Knowledge Base ────────────────────────────────────────────────────────

async function listKb(klien_id) {
  const { rows } = await pool.query(
    `SELECT id, klien_id, keywords, content, auto_generated, approved, generated_at, created_at
     FROM knowledge_base
     WHERE klien_id = $1 AND (auto_generated = FALSE OR approved = TRUE)
     ORDER BY id DESC`,
    [klien_id]
  );
  return rows;
}

async function createKb({ klien_id, keywords, content, auto_generated = false, approved = true }) {
  const { rows } = await pool.query(
    `INSERT INTO knowledge_base (klien_id, keywords, content, auto_generated, approved, generated_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 THEN NOW() ELSE NULL END)
     RETURNING id`,
    [klien_id, keywords, content, auto_generated, approved]
  );
  return { id: rows[0].id };
}

/**
 * List auto-generated KB entries that are pending admin approval.
 */
async function listPendingKb(klien_id) {
  const params = klien_id ? [klien_id] : [];
  const where  = klien_id
    ? "WHERE kb.klien_id = $1 AND kb.auto_generated = TRUE AND kb.approved = FALSE"
    : "WHERE kb.auto_generated = TRUE AND kb.approved = FALSE";
  const { rows } = await pool.query(`
    SELECT kb.id, kb.klien_id, c.nama AS client_nama, kb.keywords, kb.content,
           kb.generated_at, kb.created_at
    FROM knowledge_base kb
    JOIN clients c ON c.id = kb.klien_id
    ${where}
    ORDER BY kb.generated_at DESC NULLS LAST, kb.created_at DESC
    LIMIT 200
  `, params);
  return rows;
}

/**
 * Approve a pending auto-generated KB entry (makes it active).
 */
async function approveKb(id) {
  await pool.query(
    "UPDATE knowledge_base SET approved = TRUE WHERE id = $1 AND auto_generated = TRUE",
    [id]
  );
}

/**
 * Reject and remove a pending auto-generated KB entry.
 */
async function rejectKb(id) {
  await pool.query(
    "DELETE FROM knowledge_base WHERE id = $1 AND auto_generated = TRUE AND approved = FALSE",
    [id]
  );
}

async function updateKb({ id, keywords, content }) {
  await pool.query(
    `UPDATE knowledge_base SET keywords = $2, content = $3 WHERE id = $1`,
    [id, keywords, content]
  );
}

async function deleteKb(id) {
  await pool.query("DELETE FROM knowledge_base WHERE id = $1", [id]);
}

// ─── Chat History ──────────────────────────────────────────────────────────

async function listHistory({ klien_id, limit = 50, offset = 0 }) {
  const safeLmt = Math.min(Number(limit) || 50, 500);
  const safeOff = Math.max(0, Number(offset) || 0);
  const { rows } = await pool.query(
    `SELECT id, user_phone, user_message, ai_generated_reply, is_sent,
            direction, is_group, media_type, media_url,
            is_deleted, original_message,
            requires_approval, approved, approved_at, created_at
     FROM chat_history WHERE klien_id = $1
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [klien_id, safeLmt, safeOff]
  );
  return rows;
}

async function approveHistory({ id, klien_id }) {
  const { rows } = await pool.query(
    `UPDATE chat_history
     SET approved = TRUE, approved_at = NOW(), requires_approval = FALSE
     WHERE id = $1 AND klien_id = $2
     RETURNING id, klien_id, user_phone, ai_generated_reply`,
    [id, klien_id]
  );
  return rows[0] || null;
}

async function rejectHistory({ id, klien_id }) {
  const { rows } = await pool.query(
    `UPDATE chat_history
     SET approved = FALSE, approved_at = NOW(), requires_approval = FALSE
     WHERE id = $1 AND klien_id = $2
     RETURNING id`,
    [id, klien_id]
  );
  return rows[0] || null;
}

async function listPending({ klien_id, limit = 20 }) {
  const safeLmt = Math.min(Number(limit) || 20, 100);
  const q = klien_id
    ? pool.query(
        `SELECT id, klien_id, user_phone, user_message, ai_generated_reply, created_at
         FROM chat_history
         WHERE klien_id = $1 AND requires_approval = TRUE AND approved IS NULL
         ORDER BY created_at ASC LIMIT $2`,
        [klien_id, safeLmt]
      )
    : pool.query(
        `SELECT id, klien_id, user_phone, user_message, ai_generated_reply, created_at
         FROM chat_history
         WHERE requires_approval = TRUE AND approved IS NULL
         ORDER BY created_at ASC LIMIT $1`,
        [safeLmt]
      );
  const { rows } = await q;
  return rows;
}

// ─── Stats ─────────────────────────────────────────────────────────────────

async function statsDaily({ klien_id, date }) {
  const { rows } = await pool.query(
    `SELECT ai_calls, total_messages FROM usage_tracker
     WHERE klien_id = $1 AND date = $2`,
    [klien_id, date]
  );
  return rows[0] || { ai_calls: 0, total_messages: 0 };
}

async function statsRange({ klien_id, from_date, to_date }) {
  const { rows } = await pool.query(
    `SELECT date, ai_calls, total_messages FROM usage_tracker
     WHERE klien_id = $1 AND date BETWEEN $2 AND $3
     ORDER BY date ASC`,
    [klien_id, from_date, to_date]
  );
  return rows;
}

async function statsSummary() {
  const { rows } = await pool.query(`
    SELECT
      CAST((SELECT COUNT(*) FROM clients WHERE aktif = TRUE) AS INTEGER)                                    AS total_clients,
      CAST((SELECT COALESCE(SUM(total_messages),0) FROM usage_tracker WHERE date = CURRENT_DATE) AS INTEGER) AS today_messages,
      CAST((SELECT COALESCE(SUM(ai_calls),0)       FROM usage_tracker WHERE date = CURRENT_DATE) AS INTEGER) AS today_ai_calls,
      CAST((SELECT COALESCE(SUM(total_messages),0) FROM usage_tracker WHERE date >= CURRENT_DATE - 6) AS INTEGER) AS week_messages
  `);
  return rows[0];
}

// Indonesian stop words: pronouns, particles, greetings, connectors, polite markers
const ID_STOPWORDS = new Set([
  "yang","dan","atau","ada","apa","ini","itu","dia","ayo","sih","nih","lah","deh",
  "saya","anda","kamu","kami","kita","mereka","bisa","mau","minta","mohon","tolong",
  "halo","hai","hei","kak","pak","mas","mba","oke","baik","iya","tidak","tdk",
  "dengan","untuk","dari","juga","lagi","saat","pada","akan","oleh","oleh","sudah",
  "belum","kalau","jika","karena","namun","tetapi","tapi","setelah","sebelum",
  "bagaimana","berapa","kapan","dimana","siapa","kenapa","mengapa","apakah",
  "info","data","mohon","terima","kasih","selamat","pagi","siang","sore","malam",
]);

/**
 * Top 10 most frequent words from user messages for a client over N days.
 * Uses regexp_split_to_table to tokenize messages; applies Indonesian stop-word filter.
 */
async function statsTopKeywords(klien_id, days = 7, limit = 10) {
  const safeDays  = Math.max(1, Math.min(90, parseInt(days) || 7));
  const safeLimit = Math.max(1, Math.min(50, parseInt(limit) || 10));

  const { rows } = await pool.query(`
    SELECT word, COUNT(*)::INTEGER AS count
    FROM (
      SELECT lower(trim(regexp_replace(w, '[^a-z]', '', 'g'))) AS word
      FROM chat_history,
           regexp_split_to_table(lower(user_message), E'\\s+') AS w
      WHERE klien_id = $1
        AND direction = 'in'
        AND created_at >= NOW() - ($2 || ' days')::INTERVAL
    ) t
    WHERE length(word) > 2
    GROUP BY word
    ORDER BY count DESC
    LIMIT $3
  `, [klien_id, safeDays, safeLimit]);

  // Filter stop words in application layer for flexibility
  return rows.filter(r => r.word && !ID_STOPWORDS.has(r.word));
}

/**
 * Average bot response time in seconds within a date range.
 * Uses LEAD() window function to find next-message gap per user thread.
 * Gap is accepted only if between 0.5s and 120s to exclude outliers.
 */
async function statsAvgResponseTime(klien_id, from_date, to_date) {
  const { rows } = await pool.query(`
    SELECT
      ROUND(COALESCE(AVG(gap_secs), 0)::numeric, 1)::float AS avg_secs,
      COUNT(*)::INTEGER AS sample_count
    FROM (
      SELECT
        EXTRACT(EPOCH FROM (
          LEAD(created_at) OVER (PARTITION BY user_phone ORDER BY created_at) - created_at
        )) AS gap_secs,
        direction,
        LEAD(direction) OVER (PARTITION BY user_phone ORDER BY created_at) AS next_dir
      FROM chat_history
      WHERE klien_id = $1
        AND created_at BETWEEN $2::date AND $3::date + INTERVAL '1 day'
    ) t
    WHERE direction = 'in' AND next_dir = 'out'
      AND gap_secs BETWEEN 0.5 AND 120
  `, [klien_id, from_date, to_date]);
  return rows[0] || { avg_secs: 0, sample_count: 0 };
}

/**
 * Top N most active phone numbers by inbound message count within a date range.
 */
async function statsActiveNumbers(klien_id, from_date, to_date, limit = 10) {
  const safeLimit = Math.max(1, Math.min(50, parseInt(limit) || 10));
  const { rows } = await pool.query(`
    SELECT
      user_phone,
      MAX(sender_name)   AS sender_name,
      COUNT(*)::INTEGER  AS message_count,
      MAX(created_at)    AS last_seen
    FROM chat_history
    WHERE klien_id = $1
      AND direction = 'in'
      AND created_at BETWEEN $2::date AND $3::date + INTERVAL '1 day'
    GROUP BY user_phone
    ORDER BY message_count DESC
    LIMIT $4
  `, [klien_id, from_date, to_date, safeLimit]);
  return rows;
}

/**
 * Combined advanced stats for the stats dashboard.
 * Returns top keywords (last N days), avg response time, and most active numbers
 * all in one call to minimise round-trips.
 */
async function statsAdvanced(klien_id, from_date, to_date, keywordDays = 7) {
  const [keywords, responseTime, activeNumbers] = await Promise.all([
    statsTopKeywords(klien_id, keywordDays, 10),
    statsAvgResponseTime(klien_id, from_date, to_date),
    statsActiveNumbers(klien_id, from_date, to_date, 10),
  ]);
  return { keywords, responseTime, activeNumbers };
}

module.exports = {
  auditLog,
  listAuditLog,
  listClients,   createClient,   updateClient,   deleteClient,   toggleClient,
  setReplyMode,  setListenMode, blockPhone, unblockPhone,
  listTemplates, createTemplate, updateTemplate, deleteTemplate,
  listKb,        createKb,       updateKb,       deleteKb,
  listPendingKb, approveKb,      rejectKb,
  listHistory,   approveHistory, rejectHistory,  listPending,
  statsDaily,    statsRange,     statsSummary,
  statsTopKeywords, statsAvgResponseTime, statsActiveNumbers, statsAdvanced,
};
