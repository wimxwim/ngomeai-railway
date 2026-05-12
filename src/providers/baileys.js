/**
 * baileys.js — Baileys WhatsApp provider (multi-session)
 *
 * Manages multiple Baileys sessions in-process.
 * Each session = one WhatsApp number, persisted to disk.
 *
 * Public API:
 *   initSession(sessionName)           — start/resume session
 *   destroySession(sessionName)        — disconnect + cleanup
 *   getQR(sessionName)                 — get current QR as base64 PNG
 *   getStatus(sessionName)             — 'connected'|'connecting'|'disconnected'
 *   getSessions()                      — { name, status }[]
 *   sendText(sessionName, phone, text)
 *   sendImage(sessionName, phone, imageUrl, caption)
 *   sendFile(sessionName, phone, fileUrl, fileName, caption)
 *   sendAudio(sessionName, phone, audioUrl)
 *   sendLocation(sessionName, phone, lat, lng)
 *   sendTyping(sessionName, phone, isTyping)
 *   markRead(sessionName, phone, msgId)
 */

"use strict";

const path     = require("path");
const fs       = require("fs");
const https    = require("https");
const http     = require("http");
const QRCode   = require("qrcode");
const logger   = require("../utils/logger");
const config   = require("../config");

// Baileys is ESM — load once via dynamic import
let _lib = null;
async function lib() {
  if (!_lib) {
    _lib = await import("@whiskeysockets/baileys");
  }
  return _lib;
}

// Sessions registry
// Map<sessionName, { sock, status, qr, reconnectTimer, sessionDir }>
const sessions = new Map();

// Cache pemetaan LID → nomor utama per session
// Map<sessionName, Map<lid, primaryPhone>>
// Menghindari baca file disk setiap pesan masuk
const lidCache = new Map();

const BASE_SESSIONS_DIR = path.resolve(
  process.env.BAILEYS_SESSIONS_DIR || config.baileysSessionsDir || "./baileys_sessions"
);
fs.mkdirSync(BASE_SESSIONS_DIR, { recursive: true });

// ─── Helpers ───────────────────────────────────────────────────────────────

function toJid(phone) {
  const digits = String(phone).replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

function phoneFromJid(jid) {
  let phone = String(jid || "").replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/@c\.us$/, "");
  // Remove any trailing `:XX` (session/device ID from Baileys)
  phone = phone.replace(/:[\d]+$/, "");
  // Strip non-digits
  phone = phone.replace(/\D/g, "");
  // Normalize Indonesian: 08xxx → 628xxx
  if (phone.startsWith("0")) phone = "62" + phone.slice(1);
  return phone;
}

/**
 * Resolve LID (Linked Device ID) to primary phone number.
 * Menggunakan in-memory cache (lidCache) agar tidak baca file disk setiap pesan.
 * Cache di-rebuild dari disk saat pertama kali dipanggil per session.
 *
 * @param {string} sessionName - Nama Baileys session
 * @param {string} extractedPhone - Nomor yang diekstrak dari JID (mungkin LID)
 * @returns {string} - Nomor utama (primary phone)
 */
function resolveLidToPhone(sessionName, extractedPhone) {
  try {
    // Cek apakah cache sudah ada untuk session ini
    if (!lidCache.has(sessionName)) {
      // Pertama kali → baca semua file lid-mapping dari disk dan bangun cache
      const sessionDir = path.join(BASE_SESSIONS_DIR, sessionName);
      const map = new Map();
      try {
        const files = fs.readdirSync(sessionDir).filter(f => f.startsWith("lid-mapping-"));
        for (const file of files) {
          const lid     = JSON.parse(fs.readFileSync(path.join(sessionDir, file), "utf8"));
          const primary = file.replace("lid-mapping-", "").replace(".json", "");
          // Simpan mapping LID → nomor utama ke cache
          if (typeof lid === "string") map.set(lid, primary);
        }
      } catch (_) { /* Session dir belum ada — cache kosong */ }
      lidCache.set(sessionName, map);
    }

    // Lookup O(1) dari Map — tidak perlu baca file disk lagi
    const cached = lidCache.get(sessionName).get(extractedPhone);
    if (cached) {
      logger.debug("[Baileys] LID resolved (cache)", { extracted: extractedPhone, primary: cached, session: sessionName });
      return cached;
    }
  } catch (err) {
    logger.debug("[Baileys] resolveLid error", { error: err.message, session: sessionName });
  }
  return extractedPhone;
}

/**
 * Invalidate LID cache untuk session tertentu.
 * Dipanggil saat sesi baru terhubung agar cache di-rebuild dari file terbaru.
 * @param {string} sessionName
 */
function invalidateLidCache(sessionName) {
  lidCache.delete(sessionName);
}

async function downloadToBuffer(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    proto.get(url, (res) => {
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function inferMime(url, defaultMime) {
  const ext = String(url).split("?")[0].split(".").pop().toLowerCase();
  const map = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    webp: "image/webp", gif: "image/gif",
    mp4: "video/mp4", mov: "video/quicktime",
    ogg: "audio/ogg; codecs=opus", opus: "audio/ogg; codecs=opus",
    mp3: "audio/mpeg", m4a: "audio/mp4",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return map[ext] || defaultMime || "application/octet-stream";
}

// ─── Session lifecycle ─────────────────────────────────────────────────────

async function initSession(sessionName) {
  if (!sessionName || typeof sessionName !== "string") throw new Error("sessionName required");

  // If already has a connected socket, skip
  const existing = sessions.get(sessionName);
  if (existing && existing.status === "connected") {
    logger.info("[Baileys] Session already connected", { session: sessionName });
    return;
  }

  const sessionDir = path.join(BASE_SESSIONS_DIR, sessionName);
  fs.mkdirSync(sessionDir, { recursive: true });

  const entry = existing || { sock: null, status: "connecting", qr: null, reconnectTimer: null, sessionDir };
  entry.status = "connecting";
  sessions.set(sessionName, entry);

  await _startSocket(sessionName, entry);
}

async function _startSocket(sessionName, entry) {
  const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = await lib();
  const { Boom } = await import("@hapi/boom");

  const { state, saveCreds } = await useMultiFileAuthState(entry.sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const pino = (await import("pino")).default;
  const sock = makeWASocket({
    version,
    auth:                 state,
    logger:               pino({ level: "silent" }),
    printQRInTerminal:    false,
    browser:              ["NgomeAI Bot", "Chrome", "120.0"],
    syncFullHistory:      false,
    markOnlineOnConnect:  false,
    getMessage:           async () => ({ conversation: "" }),
  });

  entry.sock = sock;
  sessions.set(sessionName, entry);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        entry.qr = await QRCode.toDataURL(qr);
        logger.info("[Baileys] QR generated", { session: sessionName });
      } catch (e) {
        entry.qr = null;
      }
    }

    if (connection === "close") {
      entry.status = "disconnected";
      entry.qr = null;
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        logger.warn("[Baileys] Logged out — session invalidated", { session: sessionName });
        // Clear auth files so next initSession triggers fresh QR
        try { fs.rmSync(entry.sessionDir, { recursive: true, force: true }); } catch (_) {}
        fs.mkdirSync(entry.sessionDir, { recursive: true });
      } else {
        const delay = reason === 515 ? 1000 : 3000;
        logger.info("[Baileys] Reconnecting", { session: sessionName, reason, delay });
        entry.reconnectTimer = setTimeout(() => _startSocket(sessionName, entry), delay);
      }
    } else if (connection === "open") {
      entry.status = "connected";
      entry.qr = null;
      // Invalidate LID cache saat koneksi berhasil agar mapping terbaru dibaca dari disk
      invalidateLidCache(sessionName);
      logger.info("[Baileys] Connected", { session: sessionName });
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const chatId   = msg.key.remoteJid || "";
      if (chatId.startsWith("status@")) continue;

      const isGroup  = chatId.endsWith("@g.us");
      const senderJid = msg.key.participant || chatId;
      let userPhone  = phoneFromJid(senderJid);

      // CRITICAL FIX: Use session's primary phone, not extracted phone
      // Extracted phone might be LID or secondary number — resolve to primary
      const primaryPhone = phoneFromJid(sock.user?.id || "");
      if (isGroup && userPhone) {
        // For groups: senderJid is correct (individual sender)
        userPhone = phoneFromJid(senderJid);
      } else if (!isGroup && primaryPhone) {
        // For personal: always use session's primary phone
        userPhone = primaryPhone;
      }

      const chatPhone  = isGroup ? chatId.replace(/@g\.us$/, "") : userPhone;
      if (!userPhone) continue;

      const msgId = `baileys:${sessionName}:${msg.key.id}`;

      // Extract text body
      const content = msg.message;
      const body    = content.conversation
        || content.extendedTextMessage?.text
        || content.imageMessage?.caption
        || content.videoMessage?.caption
        || content.documentMessage?.caption
        || "";

      const hasImage    = !!content.imageMessage;
      const hasVideo    = !!content.videoMessage;
      const hasAudio    = !!content.audioMessage || !!content.pttMessage;
      const hasDocument = !!content.documentMessage;

      let messageType    = "text";
      if (hasImage)      messageType = "image";
      else if (hasVideo) messageType = "video";
      else if (hasAudio) messageType = "audio";
      else if (hasDocument) messageType = "document";

      const userMessageRaw = messageType === "text" ? String(body).trim() : "";
      const mediaCaption   = messageType !== "text" ? String(body).trim() : "";

      if (messageType === "text" && !userMessageRaw) continue;

      // Lookup client for this Baileys session
      let client = null;
      try {
        const { pool } = require("../db");
        const { rows } = await pool.query(
          `SELECT id, phone_number_id, meta_token, msg_limit, provider,
                  system_prompt, gowa_device_id, waha_session, waha_url,
                  baileys_session, reply_mode, listen_personal, listen_group,
                  blocked_phones, business_type, business_profile
           FROM clients WHERE baileys_session = $1 AND aktif = TRUE LIMIT 1`,
          [sessionName]
        );
        client = rows[0] || null;
      } catch (err) {
        logger.error("[Baileys] DB lookup failed", { session: sessionName, error: err.message });
        continue;
      }

      if (!client) {
        logger.warn("[Baileys] No active client for session", { session: sessionName });
        continue;
      }

      // ── Pesan keluar manual (fromMe=true): simpan ke DB saja, jangan proses AI ──
      if (msg.key.fromMe) {
        // Nomor penerima = chatId (bukan senderJid yang adalah nomor kita sendiri)
        const recipientPhone = phoneFromJid(chatId.replace(/@g\.us$/, "").replace(/@s\.whatsapp\.net$/, "").replace(/@c\.us$/, ""));
        if (!recipientPhone) continue;

        const outMsgText = userMessageRaw || (mediaCaption ? `[${messageType}] ${mediaCaption}` : `[${messageType}]`);
        const { saveChatAndSetState } = require("../repositories/logic");
        saveChatAndSetState(
          client.id, recipientPhone, outMsgText, "", false, null,
          true, "out", messageType !== "text" ? messageType : null, null,
          isGroup, null, null, null
        ).catch(err => logger.warn("[Baileys] save fromMe message failed", { error: err.message }));

        logger.debug("[Baileys] fromMe message captured", { session: sessionName, to: recipientPhone, type: messageType });
        continue;
      }

      // ── Pesan masuk: proses lewat orchestrator ──
      const { handleInboundMessage } = require("../orchestrator/orchestrator");
      handleInboundMessage({
        client,
        userPhone:      isGroup ? chatPhone : userPhone,
        senderPhone:    userPhone,
        replyTo:        isGroup ? chatId : senderJid,
        userMessageRaw,
        msgId,
        rid:            `baileys-${msg.key.id}`,
        messageType,
        mediaCaption,
        mediaUrl:       null,
        isGroup,
        senderName:     msg.pushName || null,
      }).catch(err => logger.error("[Baileys] handleInboundMessage error", { error: err.message, session: sessionName }));
    }
  });
}

async function destroySession(sessionName) {
  const entry = sessions.get(sessionName);
  if (!entry) return;

  clearTimeout(entry.reconnectTimer);
  try { await entry.sock?.end?.(); } catch (_) {}
  sessions.delete(sessionName);
  logger.info("[Baileys] Session destroyed", { session: sessionName });
}

// ─── Session info ──────────────────────────────────────────────────────────

function getQR(sessionName) {
  return sessions.get(sessionName)?.qr || null;
}

function getStatus(sessionName) {
  return sessions.get(sessionName)?.status || "disconnected";
}

function getSessions() {
  const result = [];
  for (const [name, entry] of sessions) {
    result.push({ name, status: entry.status, hasQR: !!entry.qr });
  }
  return result;
}

// ─── Send functions ────────────────────────────────────────────────────────

async function _getConnectedSock(sessionName) {
  const entry = sessions.get(sessionName);
  if (!entry || entry.status !== "connected" || !entry.sock) {
    throw new Error(`Baileys session '${sessionName}' not connected`);
  }
  return entry.sock;
}

// Resolve JID from opts.chatId (original JID incl. @lid) or fall back to toJid(phone)
function resolveJid(phone, opts) {
  const chatId = opts?.chatId;
  return (chatId && String(chatId).includes("@")) ? String(chatId) : toJid(phone);
}

async function sendText(sessionName, phone, text, opts) {
  const sock = await _getConnectedSock(sessionName);
  const jid  = resolveJid(phone, opts);
  await sock.sendMessage(jid, { text: String(text) });
}

async function sendImage(sessionName, phone, imageUrl, opts) {
  const sock    = await _getConnectedSock(sessionName);
  const jid     = resolveJid(phone, opts);
  const caption = opts?.caption ? String(opts.caption) : undefined;
  const buf     = await downloadToBuffer(imageUrl);
  const mime    = inferMime(imageUrl, "image/jpeg");
  await sock.sendMessage(jid, { image: buf, mimetype: mime, caption });
}

async function sendFile(sessionName, phone, fileUrl, opts) {
  const sock     = await _getConnectedSock(sessionName);
  const jid      = resolveJid(phone, opts);
  const caption  = opts?.caption ? String(opts.caption) : undefined;
  const fileName = opts?.fileName || path.basename(String(fileUrl).split("?")[0]);
  const buf      = await downloadToBuffer(fileUrl);
  const mime     = inferMime(fileUrl, "application/octet-stream");
  await sock.sendMessage(jid, { document: buf, mimetype: mime, fileName, caption });
}

async function sendAudio(sessionName, phone, audioUrl, opts) {
  const sock = await _getConnectedSock(sessionName);
  const jid  = resolveJid(phone, opts);
  const buf  = await downloadToBuffer(audioUrl);
  const url  = String(audioUrl).split("?")[0].toLowerCase();
  const isOgg = url.endsWith(".ogg") || url.endsWith(".opus");
  await sock.sendMessage(jid, {
    audio: buf,
    mimetype: isOgg ? "audio/ogg; codecs=opus" : "audio/mpeg",
    ptt:      isOgg,
  });
}

async function sendLocation(sessionName, phone, latitude, longitude, opts) {
  const sock = await _getConnectedSock(sessionName);
  const jid  = resolveJid(phone, opts);
  await sock.sendMessage(jid, {
    location: { degreesLatitude: latitude, degreesLongitude: longitude },
  });
}

async function sendTyping(sessionName, phone, isTyping, opts) {
  try {
    const sock = await _getConnectedSock(sessionName);
    const jid  = resolveJid(phone, opts);
    await sock.sendPresenceUpdate(isTyping ? "composing" : "paused", jid);
  } catch (err) {
    logger.warn("[Baileys] sendTyping failed (non-fatal)", { error: err.message });
  }
}

async function markRead(sessionName, phone, msgId, opts) {
  try {
    const sock = await _getConnectedSock(sessionName);
    const jid  = resolveJid(phone, opts);
    // msgId format: "baileys:<session>:<wa_msg_id>" — extract wa_msg_id
    const waMsgId = String(msgId).split(":").pop();
    await sock.readMessages([{ remoteJid: jid, id: waMsgId, fromMe: false }]);
  } catch (err) {
    logger.warn("[Baileys] markRead failed (non-fatal)", { error: err.message });
  }
}

// ─── Auto-start sessions from DB on startup ────────────────────────────────

async function startAllSessions() {
  try {
    const { pool } = require("../db");
    const { rows } = await pool.query(
      `SELECT baileys_session FROM clients WHERE provider = 'baileys' AND aktif = TRUE AND baileys_session IS NOT NULL`
    );
    for (const row of rows) {
      if (row.baileys_session) {
        initSession(row.baileys_session).catch(err =>
          logger.error("[Baileys] Auto-start failed", { session: row.baileys_session, error: err.message })
        );
      }
    }
    logger.info("[Baileys] Auto-start complete", { count: rows.length });
  } catch (err) {
    logger.warn("[Baileys] startAllSessions failed (DB may not be ready)", { error: err.message });
  }
}

module.exports = {
  initSession,
  destroySession,
  getQR,
  getStatus,
  getSessions,
  startAllSessions,
  sendText,
  sendImage,
  sendFile,
  sendAudio,
  sendLocation,
  sendTyping,
  markRead,
};
