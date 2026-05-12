/**
 * webhook.js — Inbound webhook routes untuk semua provider.
 *
 * Endpoints aktif:
 *   GET  /webhook           — Meta webhook verification (hub.challenge)
 *   POST /webhook           — Meta Cloud API inbound messages
 *   POST /webhook/evolution — Evolution API inbound messages
 *
 * Baileys: tidak pakai webhook — event diterima langsung via socket in-process (src/providers/baileys.js).
 *
 * Semua POST endpoint:
 *   - Balas 200 SEGERA sebelum proses (agar provider tidak retry)
 *   - Verifikasi HMAC-SHA256 jika secret dikonfigurasi
 *   - Proses async di background
 */

"use strict";

const crypto  = require("crypto");
const express = require("express");
const config  = require("../config");
const logger  = require("../utils/logger");
const { handleInboundMessage } = require("../orchestrator/orchestrator");
const { getClientByPhoneId, isMessageProcessed } = require("../repositories/logic");
const { getClientCache, setClientCache, setNX } = require("../utils/redis");
const { pool }                 = require("../db");

const router = express.Router();

// ─── Webhook rate limiter ─────────────────────────────────────────────────────
// Max 300 requests per IP per minute (WaHA/GoWA bisa burst banyak pesan sekaligus)
const _webhookRateMap = new Map();
function webhookRateLimit(req, res, next) {
  const ip  = req.socket?.remoteAddress || req.ip || "unknown";
  const now = Date.now();
  const e   = _webhookRateMap.get(ip) || { count: 0, start: now };
  if (now - e.start > 60_000) { e.count = 0; e.start = now; }
  e.count++;
  _webhookRateMap.set(ip, e);
  if (_webhookRateMap.size > 5000) _webhookRateMap.delete(_webhookRateMap.keys().next().value);
  if (e.count > 300) return res.sendStatus(429);
  next();
}
router.use(webhookRateLimit);

// ─── Content-Type guard ───────────────────────────────────────────────────────
// Reject non-JSON POST bodies before they reach the parser — prevents
// malformed body attacks and bypasses body-parser error handling.
function requireJson(req, res, next) {
  if (req.method !== "POST") return next();
  const ct = req.headers["content-type"] || "";
  if (!ct.includes("application/json")) {
    return res.status(415).end();
  }
  next();
}
router.use(requireJson);

// ─── Shared: HMAC-SHA256 verifier factory ────────────────────────────────
// Membuat middleware verifikasi signature.
// Jika secret kosong → skip verifikasi (dev/test mode).
function makeHmacVerifier(getSecret, label) {
  return function verifyHmac(req, res, next) {
    const secret = typeof getSecret === "function" ? getSecret() : getSecret;
    if (!secret) return next(); // dev mode: skip

    const sig = req.get("x-hub-signature-256");
    if (!sig) {
      logger.warn(`${label} missing signature`);
      return res.sendStatus(401);
    }
    if (req.rawBody === undefined) {
      logger.warn(`${label} rawBody missing`);
      return res.sendStatus(401);
    }

    const expected = "sha256=" + crypto
      .createHmac("sha256", secret)
      .update(req.rawBody)
      .digest("hex");

    // Pad both to same length before timingSafeEqual to prevent throw on mismatch
    const sigBuf = Buffer.alloc(256);
    const expBuf = Buffer.alloc(256);
    Buffer.from(sig).copy(sigBuf);
    Buffer.from(expected).copy(expBuf);
    if (!crypto.timingSafeEqual(sigBuf, expBuf) || sig !== expected) {
      logger.warn(`${label} signature invalid`);
      return res.sendStatus(401);
    }
    return next();
  };
}

// ─── Meta HMAC verification — STRICT (no dev mode skip) ─────────────
// Meta webhook MUST always have valid signature — never skip verification
function verifyMeta(req, res, next) {
  const secret = config.metaAppSecret;
  if (!secret) {
    // Secret not configured — this is a server misconfiguration, but we still reject
    logger.error("[Meta] META_APP_SECRET not configured — rejecting webhook");
    return res.sendStatus(500);
  }

  const sig = req.get("x-hub-signature-256");
  if (!sig) {
    logger.warn("[Meta] missing signature");
    return res.sendStatus(401);
  }
  if (req.rawBody === undefined) {
    logger.warn("[Meta] rawBody missing");
    return res.sendStatus(401);
  }

  const expected = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("hex");

  // Pad both to same length before timingSafeEqual to prevent throw on mismatch
  const sigBuf = Buffer.alloc(256);
  const expBuf = Buffer.alloc(256);
  Buffer.from(sig).copy(sigBuf);
  Buffer.from(expected).copy(expBuf);
  if (!crypto.timingSafeEqual(sigBuf, expBuf) || sig !== expected) {
    logger.warn("[Meta] signature invalid");
    return res.sendStatus(401);
  }
  return next();
}

// ─── Client cache helper ─────────────────────────────────────────────────
// Lookup client dari DB berdasarkan Evolution instance name.
// Cache TTL 60 detik di Redis untuk kurangi DB query per pesan masuk.

/**
 * Lookup client berdasarkan Evolution instance name.
 * Menggunakan Redis cache dengan TTL 60 detik.
 *
 * @param {string} instance - Nama instance Evolution API (= evolution_instance di DB)
 * @returns {Promise<object|null>} client row atau null jika tidak ditemukan
 */
async function lookupByEvolutionInstance(instance) {
  const cacheKey = `evo:${instance}`;
  const cached = await getClientCache(cacheKey);
  if (cached) return cached;

  const { rows } = await pool.query(
    `SELECT id, phone_number_id, meta_token, msg_limit, provider,
            system_prompt, evolution_instance, evolution_url,
            baileys_session, reply_mode, listen_personal, listen_group, blocked_phones
     FROM clients WHERE evolution_instance = $1 AND aktif = TRUE LIMIT 1`,
    [instance]
  );
  const client = rows[0] || null;
  await setClientCache(cacheKey, client);
  return client;
}

// ─── META: Webhook verification (GET) ────────────────────────────────────
router.get("/", function(req, res) {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode !== "subscribe") return res.sendStatus(403);

  // Timing-safe token comparison
  const expected = config.metaVerifyToken;
  const provided = String(token || "");
  let tokenValid = false;
  try {
    const a = Buffer.alloc(256);
    const b = Buffer.alloc(256);
    Buffer.from(expected).copy(a);
    Buffer.from(provided).copy(b);
    tokenValid = crypto.timingSafeEqual(a, b) && provided === expected;
  } catch (_) {
    tokenValid = false;
  }
  if (!tokenValid) return res.sendStatus(403);

  // Sanitize challenge — cegah reflected XSS
  const safe = String(challenge || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) return res.sendStatus(400);
  return res.status(200).send(safe);
});

// ─── META: Inbound message (POST /webhook) ────────────────────────────────
router.post("/", verifyMeta, async function(req, res) {
  res.sendStatus(200); // Balas cepat — Meta retry jika tidak dapat 200 dalam 20 detik

  const rid = req.requestId;
  try {
    const change = req.body && req.body.entry && req.body.entry[0] &&
                   req.body.entry[0].changes && req.body.entry[0].changes[0] &&
                   req.body.entry[0].changes[0].value;
    const msg = change && change.messages && change.messages[0];
    if (!msg) return;

    const phoneNumberId = change.metadata && change.metadata.phone_number_id;
    let userPhone     = msg.from;
    if (!phoneNumberId || !userPhone) return;

    // Normalize phone number: strip non-digits, convert 0 to 62 (Indonesian format)
    userPhone = String(userPhone).replace(/\D/g, "");
    if (userPhone.startsWith("0")) userPhone = "62" + userPhone.slice(1);

    const client = await getClientByPhoneId(phoneNumberId);
    if (!client) {
      logger.warn("[Meta] No active client", { phoneNumberId: phoneNumberId, rid: rid });
      return;
    }

    const messageType    = msg.type || "text";
    const userMessageRaw = messageType === "text" ? String((msg.text && msg.text.body) || "").trim() : "";
    // Caption dari media (image, video, document)
    const mediaObj       = msg[messageType];
    const mediaCaption   = (mediaObj && typeof mediaObj === "object" && mediaObj.caption)
      ? String(mediaObj.caption).trim() : "";

   // Validate msg.id is valid before constructing msgId
   const rawMetaMsgId = msg.id;
   const invalidMetaMsgId = !rawMetaMsgId || typeof rawMetaMsgId !== "string" || rawMetaMsgId.trim() === "" || /^(null|undefined)$/i.test(String(rawMetaMsgId));
   if (invalidMetaMsgId) {
     logger.warn("[Meta] Invalid msg.id", { msgId: rawMetaMsgId, rid: rid });
     return;
   }
    // #17: Duplicate event check via Redis SET NX EX 300
        // EX 300
    if (!await setNX(`webhook:event:meta:${rawMetaMsgId}`, 300)) {
      logger.debug("[Meta] duplicate event skipped", { msgId: rawMetaMsgId, rid: rid });
      return;
    }
    await handleInboundMessage({
      client:         client,
      userPhone:      userPhone,
      userMessageRaw: userMessageRaw,
      msgId:          rawMetaMsgId,
      rid:            rid,
      messageType:    messageType,
      mediaCaption:   mediaCaption,
    });
  } catch (err) {
    logger.error("[Meta] Webhook error", { error: err.message, rid: rid });
  }
});

// ─── EVOLUTION API: Inbound message (POST /webhook/evolution) ───────────────
//
// Evolution API webhook payload (event: messages.upsert / MESSAGES_UPSERT):
// {
//   "event": "messages.upsert",
//   "instance": "instance_name",
//   "data": {
//     "key": { "id": "msg_id", "remoteJid": "628xxx@s.whatsapp.net", "fromMe": false },
//     "message": { "conversation": "text" },
//     "pushName": "Sender"
//   },
//   "date_time": "...", "sender": "...", "apikey": "..."
// }
//
// Client lookup: instance_name → waha_session field di tabel clients

router.post("/evolution", async function(req, res) {
  res.sendStatus(200); // Balas cepat

  const rid = req.requestId;
  try {
    const body     = req.body || {};
    const event    = body.event;
    const instance = body.instance; // Evolution instance name = waha_session di DB
    const data     = body.data || {};

    if (!instance || typeof instance !== "string") return;
    if (!data || !data.key) return;

    // Hanya proses event messages.upsert / MESSAGES_UPSERT
    if (event !== "messages.upsert" && event !== "MESSAGES_UPSERT") {
      logger.debug("[Evolution] Non-message event", { event, instance });
      return;
    }

    // Skip pesan dari diri sendiri
    if (data.key.fromMe) return;

    // Skip status broadcast
    const remoteJid = String(data.key.remoteJid || "");
    if (remoteJid.startsWith("status@")) return;

    const isGroup = remoteJid.endsWith("@g.us");

    // Extract sender: untuk grup ambil dari participant, personal dari remoteJid
    const senderJid = isGroup
      ? String(data.key.participant || data.participant || remoteJid)
      : remoteJid;
    let userPhone = senderJid.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/@c\.us$/, "");
    // Remove trailing :XX (device ID)
    userPhone = userPhone.replace(/:[\d]+$/, "");
    // Strip non-digits and normalize Indonesian
    userPhone = userPhone.replace(/\D/g, "");
    if (userPhone.startsWith("0")) userPhone = "62" + userPhone.slice(1);

    const chatPhone = isGroup
      ? remoteJid.replace(/@g\.us$/, "")
      : userPhone;

    // replyTo: gunakan JID asli
    const replyTo = isGroup ? remoteJid : (senderJid || `${userPhone}@c.us`);

    // Validate msgId
    const rawMsgId = data.key.id;
    const invalidMsgId = !rawMsgId || typeof rawMsgId !== "string" || rawMsgId.trim() === "" || /^(null|undefined)$/i.test(String(rawMsgId));
    if (invalidMsgId) {
      logger.warn("[Evolution] Invalid msgId", { instance, rawMsgId, rid });
      return;
    }
    // #17: Duplicate event check via Redis SET NX EX 300
    if (!await setNX(`webhook:event:evolution:${instance}:${rawMsgId}`, 300)) {
      logger.debug("[Evolution] duplicate event skipped", { instance, msgId: rawMsgId, rid });
      return;
    }
    const msgId = `evolution:${instance}:${rawMsgId}`;

    // Detect message type + caption
    const msgObj   = data.message || {};
    const messageType = detectEvolutionType(msgObj);
    const userMessageRaw = messageType === "text" ? String(msgObj.conversation || msgObj.extendedTextMessage?.text || "").trim() : "";
    const mediaCaption = extractEvolutionCaption(msgObj, messageType);

    if (messageType === "text" && !userMessageRaw) return;

    // Lookup client berdasarkan evolution_instance
    const client = await lookupByEvolutionInstance(instance);
    if (!client) {
      logger.warn("[Evolution] No active client", { instance, rid });
      return;
    }

    await handleInboundMessage({
      client,
      userPhone:   isGroup ? chatPhone : userPhone,
      senderPhone: userPhone,
      replyTo,
      userMessageRaw,
      msgId,
      rid:         `evo-${rid}`,
      messageType,
      mediaCaption,
      mediaUrl:    null,
      isGroup,
      senderName:  data.pushName || null,
    });
  } catch (err) {
    logger.error("[Evolution] Webhook error", { error: err.message, rid: rid });
  }
});

// Deteksi tipe pesan Evolution API
function detectEvolutionType(msgObj) {
  if (msgObj.conversation || msgObj.extendedTextMessage) return "text";
  if (msgObj.imageMessage)          return "image";
  if (msgObj.videoMessage)          return "video";
  if (msgObj.audioMessage)          return "audio";
  if (msgObj.documentMessage)       return "document";
  if (msgObj.stickerMessage)        return "sticker";
  if (msgObj.locationMessage)       return "location";
  if (msgObj.contactMessage)        return "contact";
  if (msgObj.liveLocationMessage)   return "live_location";
  return "text";
}

// Ekstrak caption dari pesan media Evolution API
function extractEvolutionCaption(msgObj, messageType) {
  if (messageType === "text") return "";
  const mediaObj = msgObj[messageType + "Message"] || msgObj;
  if (mediaObj && mediaObj.caption) return String(mediaObj.caption).trim();
  return "";
}

module.exports = router;
