const express = require("express");
const jwt     = require("jsonwebtoken");
const bcrypt  = require("bcryptjs");
const config  = require("../config");
const logger  = require("../utils/logger");
const { adminAuth, blacklistToken }     = require("../middleware/adminAuth");
const svc                               = require("../repositories/admin");
const { invalidateClientCacheById }     = require("../repositories/logic");
const { runBenchmark, readLastResult }  = require("../workers/modelBenchmark");
const { getModelChain, invalidateCache: invalidateModelCache } = require("../ai/modelSelector");
const { getAdvancedStats } = require("../workers/statsWorker");

const router = express.Router();

// ─── Login rate limit: max 5 attempts per IP per minute ───────────────────
const loginAttempts = new Map();
const MAX_LOGIN_ENTRIES = 10_000; // cap map size
const loginSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now - entry.start > 60_000) loginAttempts.delete(ip);
  }
}, 5 * 60_000);
loginSweepTimer.unref();

function loginRateLimit(req, res, next) {
  // Use socket remoteAddress — not spoofable via headers
  const ip  = req.socket?.remoteAddress || req.ip;
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, start: now };
  if (now - entry.start > 60_000) { entry.count = 0; entry.start = now; }
  entry.count++;
  loginAttempts.set(ip, entry);
  // Evict oldest if map too large
  if (loginAttempts.size > MAX_LOGIN_ENTRIES) {
    loginAttempts.delete(loginAttempts.keys().next().value);
  }
  if (entry.count > 5) return res.status(429).json({ success: false, error: "Too many attempts" });
  next();
}

const ok   = (res, data)               => res.json({ success: true, data });
const fail = (res, error, status = 400) => res.status(status).json({ success: false, error });

// ─── Input validation helpers ──────────────────────────────────────────────
const str    = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const strOpt = (v, max) => v == null || (typeof v === "string" && v.length <= max);
const int    = (v, min = 1, max = 1_000_000) => {
  const n = Number(v); return Number.isInteger(n) && n >= min && n <= max;
};
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0; };
const DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const isDate  = (v) => typeof v === "string" && DATE_RE.test(v);

// ─── Audit helper ──────────────────────────────────────────────────────────
const audit = (req, action, targetType, targetId, payload = {}) =>
  svc.auditLog({ actor: req.admin?.username || "admin", action, targetType, targetId, payload, ip: req.ip });

// Session cookie literals
const SESSION_COOKIE = "admin_session=1; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=86400";
const CLEAR_COOKIE   = "admin_session=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0";

// ─── Auth ──────────────────────────────────────────────────────────────────

router.post("/login", loginRateLimit, async (req, res) => {
  const { username, password } = req.body || {};
  if (!str(username, 64) || !str(password, 256)) return fail(res, "Username and password required");

  if (username !== config.adminUsername) return fail(res, "Invalid credentials", 401);

  const valid = config.adminPassword.startsWith("$2")
    ? await bcrypt.compare(password, config.adminPassword)
    : password === config.adminPassword;

  if (!valid) {
    logger.warn("Admin login failed", { ip: req.ip });
    return fail(res, "Invalid credentials", 401);
  }

  const token = jwt.sign({ username }, config.adminJwtSecret, { expiresIn: "24h" });
  logger.info("Admin login", { ip: req.ip });
  // Session cookie lets the server-side admin HTML guard detect a live session
  res.setHeader("Set-Cookie", SESSION_COOKIE);
  ok(res, { token, expiresIn: 86400 });
});

router.post("/logout", adminAuth, async (req, res) => {
  // Blacklist token di Redis agar tidak bisa dipakai lagi walau belum expired
  await blacklistToken(req.adminToken).catch(() => {});
  res.setHeader("Set-Cookie", CLEAR_COOKIE);
  ok(res, null);
});

router.post("/verify", adminAuth, (req, res) => {
  ok(res, { valid: true });
});

// ─── Clients ───────────────────────────────────────────────────────────────

router.post("/clients/list", adminAuth, async (req, res) => {
  try { ok(res, await svc.listClients()); }
  catch (e) { logger.error("admin clients/list", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/clients/create", adminAuth, async (req, res) => {
  const { id, nama, phone_number_id, meta_token, msg_limit, provider, system_prompt,
          evolution_instance, evolution_url, baileys_session, business_type,
          business_profile } = req.body || {};
  if (!str(id, 64))              return fail(res, "id: required, max 64 chars");
  if (!str(nama, 128))           return fail(res, "nama: required, max 128 chars");
  if (!str(phone_number_id, 64)) return fail(res, "phone_number_id: required, max 64 chars");
  const isUnofficial = provider === "evolution" || provider === "baileys";
  if (!isUnofficial && !str(meta_token, 512)) return fail(res, "meta_token: required untuk provider meta, max 512 chars");
  if (meta_token !== undefined && meta_token !== "" && !str(meta_token, 512)) return fail(res, "meta_token: max 512 chars");
  if (msg_limit !== undefined && !int(msg_limit, 1, 1_000_000)) return fail(res, "msg_limit: must be integer 1–1000000");
  if (provider && !["meta", "evolution", "baileys"].includes(provider)) return fail(res, "provider: must be 'meta', 'evolution', or 'baileys'");
  if (!strOpt(system_prompt, 2000))    return fail(res, "system_prompt: max 2000 chars");
  if (!strOpt(business_profile, 4000)) return fail(res, "business_profile: max 4000 chars");
  if (!strOpt(evolution_instance, 128)) return fail(res, "evolution_instance: max 128 chars");
  if (!strOpt(evolution_url, 256))    return fail(res, "evolution_url: max 256 chars");
  if (!strOpt(baileys_session, 64))   return fail(res, "baileys_session: max 64 chars");
  const validBusinessTypes = ["umum", "masjid", "toko", "sekolah", "kesehatan", "properti", "kuliner", "jasa"];
  if (business_type !== undefined && !validBusinessTypes.includes(business_type)) return fail(res, `business_type: must be one of ${validBusinessTypes.join(", ")}`);
  try {
    const result = await svc.createClient({
      id: id.trim(), nama: nama.trim(),
      phone_number_id: phone_number_id.trim(),
      meta_token: meta_token ? meta_token.trim() : "",
      msg_limit, provider, system_prompt, business_profile,
      evolution_instance, evolution_url, baileys_session, business_type,
    });
    audit(req, "clients.create", "client", id, { id, nama, phone_number_id, provider, msg_limit });

    // Notif Telegram
    const tg = require("../bots/telegram");
    if (tg.notifyNewClient) {
      tg.notifyNewClient({ id: id.trim(), nama: nama.trim(), provider, msg_limit }).catch(() => {});
    }

    ok(res, result);
  } catch (e) {
    if (e.code === "23505") return fail(res, "Client ID or phone_number_id already exists");
    logger.error("admin clients/create", { error: e.message }); fail(res, "DB error", 500);
  }
});

router.post("/clients/update", adminAuth, async (req, res) => {
  const { id, nama, msg_limit, system_prompt, evolution_instance, evolution_url,
          baileys_session, business_type, business_profile } = req.body || {};
  if (!str(id, 64)) return fail(res, "id required");
  if (nama !== undefined && !str(nama, 128)) return fail(res, "nama: max 128 chars");
  if (msg_limit !== undefined && !int(msg_limit, 1, 1_000_000)) return fail(res, "msg_limit: must be integer 1–1000000");
  if (!strOpt(system_prompt, 2000))    return fail(res, "system_prompt: max 2000 chars");
  if (!strOpt(business_profile, 4000)) return fail(res, "business_profile: max 4000 chars");
  if (!strOpt(evolution_instance, 128)) return fail(res, "evolution_instance: max 128 chars");
  if (!strOpt(evolution_url, 256))    return fail(res, "evolution_url: max 256 chars");
  if (!strOpt(baileys_session, 64))   return fail(res, "baileys_session: max 64 chars");
  const validBusinessTypes = ["umum", "masjid", "toko", "sekolah", "kesehatan", "properti", "kuliner", "jasa"];
  if (business_type !== undefined && !validBusinessTypes.includes(business_type)) return fail(res, `business_type: must be one of ${validBusinessTypes.join(", ")}`);
  const hasEvolutionInst    = "evolution_instance" in (req.body || {});
  const hasEvolutionUrl     = "evolution_url"      in (req.body || {});
  const hasBaileysSession   = "baileys_session"    in (req.body || {});
  const hasBusinessType     = "business_type"      in (req.body || {});
  const hasBusinessProfile  = "business_profile"   in (req.body || {});
  try {
    await svc.updateClient({ id, nama: nama?.trim() ?? undefined, msg_limit, system_prompt,
      evolution_instance, hasEvolutionInst, evolution_url, hasEvolutionUrl,
      baileys_session, hasBaileysSession, business_type, hasBusinessType,
      business_profile, hasBusinessProfile });
    await invalidateClientCacheById(id);
    audit(req, "clients.update", "client", id, { nama, msg_limit, business_type });
    ok(res, null);
  } catch (e) { logger.error("admin clients/update", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/clients/delete", adminAuth, async (req, res) => {
  const { id } = req.body || {};
  if (!str(id, 64)) return fail(res, "id required");
  try {
    await svc.deleteClient(id);
    invalidateClientCacheById(id);
    audit(req, "clients.delete", "client", id, {});
    ok(res, null);
  } catch (e) { logger.error("admin clients/delete", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/clients/toggle", adminAuth, async (req, res) => {
  const { id, aktif } = req.body || {};
  if (!str(id, 64)) return fail(res, "id required");
  if (typeof aktif !== "boolean") return fail(res, "aktif must be a boolean");
  try {
    await svc.toggleClient({ id, aktif });
    invalidateClientCacheById(id);
    audit(req, "clients.toggle", "client", id, { aktif });
    ok(res, null);
  } catch (e) { logger.error("admin clients/toggle", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/clients/listen", adminAuth, async (req, res) => {
  const { id, listen_personal, listen_group } = req.body || {};
  if (!str(id, 64)) return fail(res, "id required");
  if (listen_personal !== undefined && typeof listen_personal !== "boolean") return fail(res, "listen_personal must be boolean");
  if (listen_group    !== undefined && typeof listen_group    !== "boolean") return fail(res, "listen_group must be boolean");
  try {
    await svc.setListenMode({ id, listenPersonal: listen_personal, listenGroup: listen_group });
    invalidateClientCacheById(id);
    audit(req, "clients.listen", "client", id, { listen_personal, listen_group });
    ok(res, null);
  } catch (e) { logger.error("admin clients/listen", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/clients/mode", adminAuth, async (req, res) => {
  const { id, reply_mode } = req.body || {};
  if (!str(id, 64)) return fail(res, "id required");
  if (typeof reply_mode !== "boolean") return fail(res, "reply_mode must be boolean");
  try {
    await svc.setReplyMode({ id, replyMode: reply_mode });
    invalidateClientCacheById(id);
    audit(req, "clients.mode", "client", id, { reply_mode });
    ok(res, null);
  } catch (e) { logger.error("admin clients/mode", { error: e.message }); fail(res, "DB error", 500); }
});

// ─── Templates ─────────────────────────────────────────────────────────────

router.post("/templates/list", adminAuth, async (req, res) => {
  const { klien_id } = req.body || {};
  if (!str(klien_id, 64)) return fail(res, "klien_id required");
  try { ok(res, await svc.listTemplates(klien_id)); }
  catch (e) { logger.error("admin templates/list", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/templates/create", adminAuth, async (req, res) => {
  const { klien_id, keywords, answer } = req.body || {};
  if (!str(klien_id, 64))  return fail(res, "klien_id: required, max 64 chars");
  if (!str(keywords, 512)) return fail(res, "keywords: required, max 512 chars");
  if (!str(answer, 4000))  return fail(res, "answer: required, max 4000 chars");
  try {
    const result = await svc.createTemplate({ klien_id, keywords: keywords.trim(), answer: answer.trim() });
    audit(req, "templates.create", "template", result.id, { klien_id, keywords });
    ok(res, result);
  } catch (e) { logger.error("admin templates/create", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/templates/update", adminAuth, async (req, res) => {
  const { id, keywords, answer } = req.body || {};
  if (!posInt(id))          return fail(res, "id must be a positive integer");
  if (!str(keywords, 512))  return fail(res, "keywords: required, max 512 chars");
  if (!str(answer, 4000))   return fail(res, "answer: required, max 4000 chars");
  try {
    await svc.updateTemplate({ id: Number(id), keywords: keywords.trim(), answer: answer.trim() });
    audit(req, "templates.update", "template", id, { keywords });
    ok(res, null);
  } catch (e) { logger.error("admin templates/update", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/templates/delete", adminAuth, async (req, res) => {
  const { id } = req.body || {};
  if (!posInt(id)) return fail(res, "id must be a positive integer");
  try {
    await svc.deleteTemplate(Number(id));
    audit(req, "templates.delete", "template", id, {});
    ok(res, null);
  } catch (e) { logger.error("admin templates/delete", { error: e.message }); fail(res, "DB error", 500); }
});

// ─── Knowledge Base ────────────────────────────────────────────────────────

router.post("/kb/list", adminAuth, async (req, res) => {
  const { klien_id } = req.body || {};
  if (!str(klien_id, 64)) return fail(res, "klien_id required");
  try { ok(res, await svc.listKb(klien_id)); }
  catch (e) { logger.error("admin kb/list", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/kb/create", adminAuth, async (req, res) => {
  const { klien_id, keywords, content } = req.body || {};
  if (!str(klien_id, 64))  return fail(res, "klien_id: required, max 64 chars");
  if (!str(keywords, 512)) return fail(res, "keywords: required, max 512 chars");
  if (!str(content, 8000)) return fail(res, "content: required, max 8000 chars");
  try {
    const result = await svc.createKb({ klien_id, keywords: keywords.trim(), content: content.trim() });
    audit(req, "kb.create", "knowledge_base", result.id, { klien_id, keywords });
    ok(res, result);
  } catch (e) { logger.error("admin kb/create", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/kb/update", adminAuth, async (req, res) => {
  const { id, keywords, content } = req.body || {};
  if (!posInt(id))          return fail(res, "id must be a positive integer");
  if (!str(keywords, 512))  return fail(res, "keywords: required, max 512 chars");
  if (!str(content, 8000))  return fail(res, "content: required, max 8000 chars");
  try {
    await svc.updateKb({ id: Number(id), keywords: keywords.trim(), content: content.trim() });
    audit(req, "kb.update", "knowledge_base", id, { keywords });
    ok(res, null);
  } catch (e) { logger.error("admin kb/update", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/kb/delete", adminAuth, async (req, res) => {
  const { id } = req.body || {};
  if (!posInt(id)) return fail(res, "id must be a positive integer");
  try {
    await svc.deleteKb(Number(id));
    audit(req, "kb.delete", "knowledge_base", id, {});
    ok(res, null);
  } catch (e) { logger.error("admin kb/delete", { error: e.message }); fail(res, "DB error", 500); }
});

// Auto KB shadow-mode: list, approve, reject
router.post("/kb/pending", adminAuth, async (req, res) => {
  const { klien_id } = req.body || {};
  try {
    ok(res, await svc.listPendingKb(klien_id || null));
  } catch (e) {
    logger.error("admin kb/pending", { error: e.message });
    fail(res, "DB error", 500);
  }
});

router.post("/kb/approve", adminAuth, async (req, res) => {
  const { id } = req.body || {};
  if (!posInt(id)) return fail(res, "id must be a positive integer");
  try {
    await svc.approveKb(Number(id));
    audit(req, "kb.approve", "knowledge_base", id, {});
    ok(res, null);
  } catch (e) {
    logger.error("admin kb/approve", { error: e.message });
    fail(res, "DB error", 500);
  }
});

router.post("/kb/reject", adminAuth, async (req, res) => {
  const { id } = req.body || {};
  if (!posInt(id)) return fail(res, "id must be a positive integer");
  try {
    await svc.rejectKb(Number(id));
    audit(req, "kb.reject", "knowledge_base", id, {});
    ok(res, null);
  } catch (e) {
    logger.error("admin kb/reject", { error: e.message });
    fail(res, "DB error", 500);
  }
});

// ─── History ───────────────────────────────────────────────────────────────

router.post("/history", adminAuth, async (req, res) => {
  const { klien_id, limit = 50, offset = 0 } = req.body || {};
  if (!str(klien_id, 64)) return fail(res, "klien_id required");
  const safeLimit  = Math.min(Math.max(1,  Number(limit)  || 50),  500);
  const safeOffset = Math.min(Math.max(0,  Number(offset) || 0),   1_000_000);
  try { ok(res, await svc.listHistory({ klien_id, limit: safeLimit, offset: safeOffset })); }
  catch (e) { logger.error("admin history", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/history/pending", adminAuth, async (req, res) => {
  const { klien_id, limit = 20 } = req.body || {};
  const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);
  try { ok(res, await svc.listPending({ klien_id: klien_id || null, limit: safeLimit })); }
  catch (e) { logger.error("admin history/pending", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/history/approve", adminAuth, async (req, res) => {
  const { id, klien_id } = req.body || {};
  if (!posInt(id))            return fail(res, "id must be a positive integer");
  if (!str(klien_id, 64))     return fail(res, "klien_id required");
  try {
    const row = await svc.approveHistory({ id: Number(id), klien_id });
    if (!row) return fail(res, "Record not found or already processed", 404);

    // Send the approved reply to WhatsApp
    const { sendMessage } = require("../providers/sender");
    const { saveChatAndSetState } = require("../repositories/logic");
    const { pool } = require("../db");
    const clients = await svc.listClients();
    const client  = clients.find(c => c.id === klien_id);
    if (client && row.ai_generated_reply) {
      try {
        await sendMessage(client, row.user_phone, row.ai_generated_reply);
        // Hanya tandai is_sent=TRUE jika sendMessage berhasil (tidak throw error)
        await pool.query("UPDATE chat_history SET is_sent=TRUE WHERE id=$1", [Number(id)]);

        // Also save the outgoing message record
        await saveChatAndSetState(klien_id, row.user_phone, "", row.ai_generated_reply, row.used_ai, row.ai_generated_reply, true, "out", null, null, row.is_group, null, null, null)
          .catch(err => logger.warn("approve: save outgoing message failed", { error: err.message, id }));
      } catch (err) {
        logger.warn("approve: send failed", { error: err.message, id });
        // Jangan tandai is_sent — message tidak terkirim
      }
    }

    audit(req, "history.approve", "chat_history", id, { klien_id });
    ok(res, { id: row.id });
  } catch (e) { logger.error("admin history/approve", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/history/reject", adminAuth, async (req, res) => {
  const { id, klien_id } = req.body || {};
  if (!posInt(id))        return fail(res, "id must be a positive integer");
  if (!str(klien_id, 64)) return fail(res, "klien_id required");
  try {
    const row = await svc.rejectHistory({ id: Number(id), klien_id });
    if (!row) return fail(res, "Record not found or already processed", 404);
    audit(req, "history.reject", "chat_history", id, { klien_id });
    ok(res, { id: row.id });
  } catch (e) { logger.error("admin history/reject", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/history/edit", adminAuth, async (req, res) => {
  const { id, klien_id, ai_generated_reply } = req.body || {};
  if (!posInt(id))                          return fail(res, "id must be a positive integer");
  if (!str(klien_id, 64))                   return fail(res, "klien_id required");
  if (!str(ai_generated_reply, 4000))       return fail(res, "ai_generated_reply required, max 4000 chars");
  try {
    const { pool } = require("../db");
    const { rows } = await pool.query(
      `UPDATE chat_history SET ai_generated_reply=$3, bot_answer=$3
       WHERE id=$1 AND klien_id=$2 AND requires_approval=TRUE AND approved IS NULL
       RETURNING id`,
      [Number(id), klien_id, ai_generated_reply.trim()]
    );
    if (!rows.length) return fail(res, "Record not found or already processed", 404);
    audit(req, "history.edit", "chat_history", id, { klien_id });
    ok(res, { id: rows[0].id });
  } catch (e) { logger.error("admin history/edit", { error: e.message }); fail(res, "DB error", 500); }
});

// ─── Audit Log ─────────────────────────────────────────────────────────────

router.post("/audit", adminAuth, async (req, res) => {
  const { limit = 50, offset = 0 } = req.body || {};
  const safeLimit  = Math.min(Math.max(1, Number(limit)  || 50), 200);
  const safeOffset = Math.min(Math.max(0, Number(offset) || 0),  1_000_000);
  try { ok(res, await svc.listAuditLog({ limit: safeLimit, offset: safeOffset })); }
  catch (e) { logger.error("admin audit", { error: e.message }); fail(res, "DB error", 500); }
});

// ─── Stats ─────────────────────────────────────────────────────────────────

router.post("/stats/summary", adminAuth, async (req, res) => {
  try { ok(res, await svc.statsSummary()); }
  catch (e) { logger.error("admin stats/summary", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/stats/daily", adminAuth, async (req, res) => {
  const { klien_id, date } = req.body || {};
  if (!str(klien_id, 64)) return fail(res, "klien_id required");
  if (!isDate(date))       return fail(res, "date must be YYYY-MM-DD");
  try { ok(res, await svc.statsDaily({ klien_id, date })); }
  catch (e) { logger.error("admin stats/daily", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/stats/range", adminAuth, async (req, res) => {
  const { klien_id, from_date, to_date } = req.body || {};
  if (!str(klien_id, 64)) return fail(res, "klien_id required");
  if (!isDate(from_date)) return fail(res, "from_date must be YYYY-MM-DD");
  if (!isDate(to_date))   return fail(res, "to_date must be YYYY-MM-DD");
  if (from_date > to_date) return fail(res, "from_date must be <= to_date");
  try { ok(res, await svc.statsRange({ klien_id, from_date, to_date })); }
  catch (e) { logger.error("admin stats/range", { error: e.message }); fail(res, "DB error", 500); }
});

router.post("/stats/advanced", adminAuth, async (req, res) => {
  const { klien_id, from_date, to_date } = req.body || {};
  if (!str(klien_id, 64)) return fail(res, "klien_id required");
  if (from_date && !isDate(from_date)) return fail(res, "from_date must be YYYY-MM-DD");
  if (to_date   && !isDate(to_date))   return fail(res, "to_date must be YYYY-MM-DD");
  if (from_date && to_date && from_date > to_date) return fail(res, "from_date must be <= to_date");
  try {
    const data = await getAdvancedStats(klien_id, from_date || null, to_date || null);
    ok(res, data);
  } catch (e) {
    logger.error("admin stats/advanced", { error: e.message });
    fail(res, "DB error", 500);
  }
});

// ─── Anti-spam management ─────────────────────────────────────────────────
const antispam = require("../utils/antispam");

// GET active temp-blocked numbers
router.post("/antispam/blocked", adminAuth, async (req, res) => {
  try {
    const { getKey } = require("../utils/redis");
    // We store individual block keys — return config info since scanning is Redis-version dependent
    ok(res, {
      info: "Temp-blocked phones are stored in Redis with TTL. Use /antispam/unblock to manually clear.",
      config: {
        floodThreshold:  antispam.FLOOD_THRESHOLD,
        floodWindowSec:  antispam.FLOOD_WINDOW_SEC,
        blockTtlSec:     antispam.BLOCK_TTL_SEC,
        dupWindowSec:    antispam.DUP_WINDOW_SEC,
      },
    });
  } catch (e) { fail(res, e.message, 500); }
});

// Check if a specific phone is spam-blocked
router.post("/antispam/check", adminAuth, async (req, res) => {
  const { phone } = req.body || {};
  const clean = String(phone || "").replace(/\D/g, "");
  if (!clean || clean.length < 7) return fail(res, "phone required (digits only)");
  try {
    const blocked = await antispam.isSpamBlocked(clean);
    ok(res, { phone: clean, blocked });
  } catch (e) { fail(res, e.message, 500); }
});

// Manually unblock a phone number
router.post("/antispam/unblock", adminAuth, async (req, res) => {
  const { phone } = req.body || {};
  const clean = String(phone || "").replace(/\D/g, "");
  if (!clean || clean.length < 7) return fail(res, "phone required (digits only)");
  try {
    await antispam.clearSpamBlock(clean);
    audit(req, "antispam.unblock", "phone", clean, { phone: clean });
    logger.info("admin: antispam unblock", { phone: clean });
    ok(res, { phone: clean, unblocked: true });
  } catch (e) { fail(res, e.message, 500); }
});

// ─── WhatsApp QR (untuk admin panel) ──────────────────────────────────────
router.post("/wa/qr", adminAuth, async (req, res) => {
  const { client_id } = req.body || {};
  if (!str(client_id, 64)) return fail(res, "client_id required");
  try {
    const clients = await svc.listClients();
    const client  = clients.find(c => c.id === client_id);
    if (!client) return fail(res, "Client not found", 404);

    const axios  = require("axios");
    const cfg    = require("../config");

    if (client.provider === "evolution") {
      const evoUrl = client.evolution_url || cfg.evolutionUrl || "http://localhost:8080";
      const apiKey = cfg.evolutionApiKey || "";
      const inst   = client.evolution_instance;
      if (!inst) return fail(res, "evolution_instance belum di-set. Update client dulu.");

      const hdr = apiKey ? { "apikey": apiKey } : {};

      // Cek status koneksi
      const stRes = await axios.get(
        `${evoUrl}/instance/connectionState/${encodeURIComponent(inst)}`,
        { headers: hdr, timeout: 5000 }
      ).catch(() => null);

      const state = stRes?.data?.instance?.state;
      if (state === "open") return ok(res, { status: "WORKING" });

      // Ambil QR code
      const qrRes = await axios.get(
        `${evoUrl}/instance/connect/${encodeURIComponent(inst)}`,
        { headers: hdr, timeout: 10_000 }
      );
      const qrCode = qrRes.data?.base64 || qrRes.data?.qrcode?.base64;
      if (!qrCode) return fail(res, "QR belum tersedia, coba lagi dalam 30 detik", 503);
      const b64 = qrCode.startsWith("data:") ? qrCode : `data:image/png;base64,${qrCode}`;
      return ok(res, { qr: b64 });
    }

    fail(res, "Provider tidak support QR via panel (baileys: lihat log server saat startup)");
  } catch (e) {
    logger.error("admin wa/qr", { error: e.message });
    fail(res, e.message, 500);
  }
});

// ─── Model Benchmark ──────────────────────────────────────────────────────────

// POST /admin/models/chain — view active chain + last benchmark result
router.post("/models/chain", adminAuth, (req, res) => {
  const chain = getModelChain();
  const last  = readLastResult();
  ok(res, {
    activeChain: chain,
    lastBenchmark: last
      ? {
          updatedAt:   last.updatedAt,
          durationMs:  last.durationMs,
          totalTested: last.totalTested,
          topResults:  last.topResults,
        }
      : null,
  });
});

// POST /admin/models/benchmark — trigger manual benchmark (runs async, returns immediately)
let _benchmarkRunning = false;
router.post("/models/benchmark", adminAuth, (req, res) => {
  if (_benchmarkRunning) {
    return res.status(409).json({ success: false, error: "Benchmark already running" });
  }
  _benchmarkRunning = true;
  audit(req, "models.benchmark.trigger", "system", "benchmark", {});
  ok(res, { message: "Benchmark started in background. Check GET /admin/models/chain for results." });

  runBenchmark()
    .then(result => {
      if (result) {
        invalidateModelCache();
        logger.info("admin manual benchmark completed", { chain: result.chain });
      }
    })
    .catch(err => logger.error("admin manual benchmark error", { error: err.message }))
    .finally(() => { _benchmarkRunning = false; });
});


// ── Atomic Onboarding ─────────────────────────────────────────
router.post("/clients/onboard", adminAuth, (req, res) => {
  return handleOnboard(req, res, ok, fail, str, strOpt, int);
});

// ─── Baileys: session management ──────────────────────────────────────────

// ─── Baileys: session management ──────────────────────────────────────────
// All endpoints require JWT admin auth

const baileys = require("../providers/baileys");

// List active Baileys sessions
router.post("/baileys/sessions", adminAuth, function(req, res) {
  ok(res, { sessions: baileys.getSessions() });
});

// Start / resume a Baileys session
router.post("/baileys/start", adminAuth, async function(req, res) {
  const { session } = req.body || {};
  if (!session || typeof session !== "string" || session.length > 64) {
    return fail(res, "session wajib diisi (max 64 karakter)");
  }
  // Sanitize session name
  const safeName = session.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  if (!safeName) return fail(res, "session harus alphanumeric/_/-");
  try {
    await baileys.initSession(safeName);
    ok(res, { session: safeName, status: baileys.getStatus(safeName) });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

// Get QR code for a session (returns base64 PNG data URI)
router.post("/baileys/qr", adminAuth, function(req, res) {
  const { session } = req.body || {};
  if (!session || typeof session !== "string") return fail(res, "session wajib");
  const qr     = baileys.getQR(session);
  const status = baileys.getStatus(session);
  if (!qr) {
    return res.json({ success: true, data: { session, status, qr: null, message: status === "connected" ? "Sudah terhubung" : "QR belum siap, coba lagi dalam 5 detik" } });
  }
  ok(res, { session, status, qr });
});

// Stop / destroy a Baileys session
router.post("/baileys/stop", adminAuth, async function(req, res) {
  const { session } = req.body || {};
  if (!session || typeof session !== "string") return fail(res, "session wajib");
  try {
    await baileys.destroySession(session);
    ok(res, { session, status: "destroyed" });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

module.exports = router;
