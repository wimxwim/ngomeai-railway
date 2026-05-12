/**
 * Actions Index — Action executor untuk AI decisions.
 *
 * Setiap action dalam decision.actions akan diproses secara berurutan.
 * Jika tidak ada action yang berhasil, fallback ke decision.response sebagai teks.
 */

const sendText     = require("./sendText");
const sendImage    = require("./sendImage");
const sendAudio    = require("./sendAudio");
const sendFile     = require("./sendFile");
const sendLocation = require("./sendLocation");
const sendTyping   = require("./sendTyping");

const logger = require("../utils/logger");

const ACTION_HANDLERS = {
  send_text:     sendText,
  send_image:    sendImage,
  send_audio:    sendAudio,
  send_file:     sendFile,
  send_location: sendLocation,
  send_typing:   sendTyping,
};

/**
 * Eksekusi semua action dari AI decision.
 *
 * @param {Object}   client    - Client object dari DB
 * @param {string}   userPhone - Nomor user (sudah dinormalisasi)
 * @param {Object}   decision  - AI decision object { intent, response, actions, ... }
 * @param {string}   rid       - Request ID untuk logging
 * @param {string}   [replyTo] - Optional chatId untuk reply context
 * @returns {boolean} true jika setidaknya satu action berhasil
 */
async function executeActions(client, userPhone, decision, rid, replyTo) {
  const actions  = Array.isArray(decision.actions) ? decision.actions : [];
  const sendOpts = replyTo ? { chatId: replyTo } : {};
  let sentAny = false;

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (!a) continue;

    const type = (typeof a.type   === "string" && a.type)   ||
                 (typeof a.action === "string" && a.action) ||
                 "";

    const handler = ACTION_HANDLERS[type];
    if (!handler) {
      logger.warn("Actions: unsupported action ignored", { rid, type });
      continue;
    }

    try {
      let result = false;
      if (type === "send_typing") {
        result = await handler(client, userPhone, a);
      } else {
        result = await handler(client, userPhone, a, sendOpts);
      }
      if (result) sentAny = true;
    } catch (actionErr) {
      logger.error("Actions: action failed", {
        rid:   rid,
        type:  type,
        error: actionErr.message,
      });
    }
  }

  // Fallback: jika tidak ada action yang berhasil, kirim response teks
  if (!sentAny) {
    try {
      const { sendMessage } = require("../providers/sender");
      await sendMessage(client, userPhone, decision.response, sendOpts);
    } catch (fallbackErr) {
      logger.error("Actions: fallback text failed", {
        rid:   rid,
        error: fallbackErr.message,
      });
    }
  }

  return sentAny;
}

module.exports = { executeActions, ACTION_HANDLERS };
