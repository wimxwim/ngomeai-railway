/**
 * sender.js — Provider abstraction layer
 *
 * Routing outbound messages ke provider yang aktif:
 *   "baileys"   → Baileys (multi-session, in-process, primary)
 *   "meta"      → Meta Cloud API (official WhatsApp Business API)
 *   "evolution" → Evolution API (via REST, multi-instance)
 *
 * Semua fungsi menerima `client` object dari DB.
 * opts.chatId akan digunakan sebagai JID tujuan langsung (handles @lid, @g.us, @s.whatsapp.net).
 */

"use strict";

const { sendWhatsAppMessage } = require("./meta");
const baileys               = require("./baileys");
const logger                = require("../utils/logger");
// isSafeUrl: mencegah SSRF — pastikan URL bukan private IP atau protokol berbahaya
const { isSafeUrl }         = require("../utils/urlGuard");

const PHONE_RE  = /^\d{7,15}$/;
const MAX_CHARS = 4096;

/**
 * Normalise nomor telepon ke digits-only string.
 * @param {string|number} phone
 * @returns {string}
 */
function cleanPhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

/**
 * Guard: pastikan client object valid sebelum mencoba kirim.
 * @param {object} client
 * @param {string} fnName - nama fungsi pemanggil (untuk log)
 */
function assertClient(client, fnName) {
  if (!client || !client.id) throw new Error(`${fnName}: invalid client object`);
}

/**
 * Truncate pesan ke MAX_CHARS karakter agar tidak melebihi batas provider.
 * @param {string} msg
 * @returns {string}
 */
function truncate(msg) {
  const s = String(msg || "");
  return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS - 3) + "..." : s;
}

/**
 * Kirim pesan teks ke user.
 *
 * @param {object} client      - Row dari tabel clients (provider, baileys_session, dll)
 * @param {string} to          - Nomor tujuan (digits-only atau JID)
 * @param {string} message     - Isi pesan teks
 * @param {object} [opts]      - Opsi tambahan: { chatId, replyMessageId, mentions }
 *                               opts.chatId: JID asli (termasuk @lid/@g.us) — dipakai Baileys untuk reply benar
 * @returns {Promise<void>}
 */
async function sendMessage(client, to, message, opts) {
  assertClient(client, "sendMessage");
  if (!opts) opts = {};

  const phone = cleanPhone(to);
  if (!PHONE_RE.test(phone)) {
    logger.warn("sendMessage: invalid phone, skip", { to, clientId: client.id });
    return;
  }

  const body = truncate(message);
  if (!body.trim()) {
    logger.warn("sendMessage: empty body, skip", { clientId: client.id });
    return;
  }

  if (client.provider === "baileys") {
    if (!client.baileys_session) throw new Error("baileys_session tidak dikonfigurasi");
    return baileys.sendText(client.baileys_session, phone, body, opts);
  }

  // Meta (official) — fallback default
  return sendWhatsAppMessage(client.phone_number_id, client.meta_token, phone, body);
}

/**
 * Kirim gambar via URL.
 * Baileys: download + kirim native.
 * Meta: fallback ke teks berisi URL.
 *
 * @param {object} client
 * @param {string} to
 * @param {string} imageUrl  - URL gambar yang dapat diakses publik
 * @param {object} [opts]    - { caption, chatId }
 * @returns {Promise<void>}
 */
async function sendImage(client, to, imageUrl, opts) {
  assertClient(client, "sendImage");
  if (!opts) opts = {};

  // SSRF guard: tolak URL internal/private sebelum download dilakukan
  if (!isSafeUrl(imageUrl)) {
    logger.warn("sendImage: blocked unsafe URL (SSRF prevention)", { url: imageUrl, clientId: client.id });
    return;
  }

  const phone = cleanPhone(to);
  if (!PHONE_RE.test(phone)) return;

  if (client.provider === "baileys") {
    if (!client.baileys_session) throw new Error("baileys_session tidak dikonfigurasi");
    return baileys.sendImage(client.baileys_session, phone, imageUrl, opts);
  }

  // Meta fallback — kirim URL sebagai teks
  const text = opts.caption
    ? `[Gambar] ${opts.caption}\n${imageUrl}`
    : `[Gambar] ${imageUrl}`;
  return sendWhatsAppMessage(client.phone_number_id, client.meta_token, phone, truncate(text));
}

/**
 * Kirim file/dokumen via URL.
 * Baileys: download + kirim native document.
 * Meta: fallback ke teks berisi URL.
 *
 * @param {object} client
 * @param {string} to
 * @param {string} fileUrl   - URL file yang dapat diakses publik
 * @param {object} [opts]    - { caption, fileName, chatId }
 * @returns {Promise<void>}
 */
async function sendFile(client, to, fileUrl, opts) {
  assertClient(client, "sendFile");
  if (!opts) opts = {};

  // SSRF guard: tolak URL internal/private sebelum download dilakukan
  if (!isSafeUrl(fileUrl)) {
    logger.warn("sendFile: blocked unsafe URL (SSRF prevention)", { url: fileUrl, clientId: client.id });
    return;
  }

  const phone = cleanPhone(to);
  if (!PHONE_RE.test(phone)) return;

  if (client.provider === "baileys") {
    if (!client.baileys_session) throw new Error("baileys_session tidak dikonfigurasi");
    return baileys.sendFile(client.baileys_session, phone, fileUrl, opts);
  }

  // Meta fallback
  const text = opts.caption
    ? `[File] ${opts.caption}\n${fileUrl}`
    : `[File] ${fileUrl}`;
  return sendWhatsAppMessage(client.phone_number_id, client.meta_token, phone, truncate(text));
}

/**
 * Kirim audio/voice note via URL.
 * Baileys: download + kirim native PTT (push-to-talk) untuk .ogg, mp3 biasa untuk lainnya.
 * Meta: fallback ke teks berisi URL.
 *
 * @param {object} client
 * @param {string} to
 * @param {string} audioUrl  - URL audio yang dapat diakses publik
 * @param {object} [opts]    - { chatId }
 * @returns {Promise<void>}
 */
async function sendAudio(client, to, audioUrl, opts) {
  assertClient(client, "sendAudio");
  if (!opts) opts = {};

  // SSRF guard: tolak URL internal/private sebelum download dilakukan
  if (!isSafeUrl(audioUrl)) {
    logger.warn("sendAudio: blocked unsafe URL (SSRF prevention)", { url: audioUrl, clientId: client.id });
    return;
  }

  const phone = cleanPhone(to);
  if (!PHONE_RE.test(phone)) return;

  if (client.provider === "baileys") {
    if (!client.baileys_session) throw new Error("baileys_session tidak dikonfigurasi");
    return baileys.sendAudio(client.baileys_session, phone, audioUrl, opts);
  }

  // Meta fallback
  return sendWhatsAppMessage(
    client.phone_number_id, client.meta_token, phone, `[Audio] ${audioUrl}`
  );
}

/**
 * Kirim koordinat lokasi.
 * Baileys: native location message.
 * Meta: fallback ke link Google Maps.
 *
 * @param {object} client
 * @param {string} to
 * @param {number} latitude
 * @param {number} longitude
 * @param {object} [opts]   - { chatId }
 * @returns {Promise<void>}
 */
async function sendLocation(client, to, latitude, longitude, opts) {
  assertClient(client, "sendLocation");
  if (!opts) opts = {};

  const phone = cleanPhone(to);
  if (!PHONE_RE.test(phone)) return;

  if (client.provider === "baileys") {
    if (!client.baileys_session) throw new Error("baileys_session tidak dikonfigurasi");
    return baileys.sendLocation(client.baileys_session, phone, latitude, longitude, opts);
  }

  // Meta fallback — kirim sebagai teks Google Maps
  const text = `📍 Lokasi: https://maps.google.com/?q=${latitude},${longitude}`;
  return sendWhatsAppMessage(client.phone_number_id, client.meta_token, phone, text);
}

/**
 * Kirim typing indicator ("composing" / "paused").
 * Non-fatal — error di-swallow agar tidak ganggu pipeline utama.
 * Baileys: native sendPresenceUpdate.
 * Meta: tidak didukung (no-op).
 *
 * @param {object} client
 * @param {string} to
 * @param {boolean} [typing=true]
 * @param {object}  [opts]         - { chatId } — JID asli untuk Baileys
 * @returns {Promise<void>}
 */
async function sendTyping(client, to, typing, opts) {
  if (typing === undefined) typing = true;
  if (!opts) opts = {};
  try {
    const phone = cleanPhone(to);
    if (!PHONE_RE.test(phone)) return;

    if (client.provider === "baileys" && client.baileys_session) {
      return baileys.sendTyping(client.baileys_session, phone, typing, opts);
    }
    // Meta tidak mendukung typing indicator — no-op
  } catch (err) {
    logger.warn("sendTyping failed (non-fatal)", { error: err.message });
  }
}

/**
 * Tandai pesan sebagai sudah dibaca (read receipt).
 * Non-fatal — error di-swallow agar tidak ganggu pipeline utama.
 * Baileys: native readMessages.
 * Meta: tidak didukung (no-op).
 *
 * @param {object} client
 * @param {string} messageId  - ID pesan format "baileys:<session>:<wa_msg_id>"
 * @param {string} userPhone  - Nomor pengirim (untuk resolve JID)
 * @param {object} [opts]     - { chatId } — JID asli untuk Baileys
 * @returns {Promise<void>}
 */
async function markRead(client, messageId, userPhone, opts) {
  if (!opts) opts = {};
  try {
    if (client.provider === "baileys" && client.baileys_session) {
      const phone = cleanPhone(userPhone || "");
      return baileys.markRead(client.baileys_session, phone, messageId, opts);
    }
    // Meta tidak mendukung read receipt via API — no-op
  } catch (err) {
    logger.warn("markRead failed (non-fatal)", { error: err.message });
  }
}

module.exports = {
  sendMessage,
  sendImage,
  sendFile,
  sendAudio,
  sendLocation,
  sendTyping,
  markRead,
};
