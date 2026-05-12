"use strict";

/**
 * antispam.js — Inbound flood & duplicate message protection (virtex guard).
 *
 * Three-layer check executed in order per incoming message:
 *   1. Temp-block list  — phone is serving an active 5-min cooldown
 *   2. Duplicate text   — same text from same phone in <30 s → skip
 *   3. Flood counter    — >10 msgs from same phone in 60 s → temp-block 5 min
 *
 * All checks fail-open: if Redis is down, message is allowed through.
 */

const crypto = require("crypto");
const logger  = require("./logger");
const redis   = require("./redis");

// ─── Config (exported for testing) ─────────────────────────────────────────
const FLOOD_WINDOW_SEC = 60;   // Rolling window for flood counter
const FLOOD_THRESHOLD  = 10;   // Max messages in FLOOD_WINDOW_SEC
const BLOCK_TTL_SEC    = 300;  // Temp block after flood (5 minutes)
const DUP_WINDOW_SEC   = 30;   // Duplicate text detection window

// Redis key prefixes (no leading slash — redis.js adds the global project prefix)
const K_FLOOD = (phone) => `antispam:flood:${phone}`;
const K_BLOCK = (phone) => `antispam:block:${phone}`;
const K_DUP   = (clientId, phone, hash) => `antispam:dup:${clientId}:${phone}:${hash}`;

// ─── Core helpers ──────────────────────────────────────────────────────────

/**
 * Check whether phone is in the temporary spam-block list.
 * @param {string} phone
 * @returns {Promise<boolean>}
 */
async function isSpamBlocked(phone) {
  const val = await redis.getKey(K_BLOCK(phone));
  return val !== null;
}

/**
 * Set a temporary spam block for phone.
 * @param {string} phone
 * @param {number} [ttl] seconds — defaults to BLOCK_TTL_SEC (300 s)
 */
async function setSpamBlock(phone, ttl = BLOCK_TTL_SEC) {
  await redis.setKey(K_BLOCK(phone), 1, ttl);
}

/**
 * Remove a temporary spam block (admin / manual unblock).
 * @param {string} phone
 */
async function clearSpamBlock(phone) {
  await redis.delKey(K_BLOCK(phone));
}

/**
 * Increment the flood counter for this phone number.
 * TTL is set on the first increment, so the window resets naturally.
 * @param {string} phone
 * @returns {Promise<number>} new counter value
 */
async function incrFlood(phone) {
  return redis.incrKey(K_FLOOD(phone), FLOOD_WINDOW_SEC);
}

/**
 * Detect whether the exact same text was already sent by this phone
 * (for the same client) within DUP_WINDOW_SEC seconds.
 *
 * Uses Redis SET NX: the key is created on the first occurrence.
 * Subsequent calls within the TTL return false from setNX → duplicate.
 *
 * @param {string} clientId
 * @param {string} phone
 * @param {string} text
 * @returns {Promise<boolean>} true = duplicate, ignore this message
 */
async function isDuplicateText(clientId, phone, text) {
  if (!text || !text.trim()) return false;
  const hash   = crypto.createHash("md5").update(text.slice(0, 500)).digest("hex");
  const isNew  = await redis.setNX(K_DUP(clientId, phone, hash), DUP_WINDOW_SEC);
  return !isNew; // setNX true → first time seen → not a dup
}

// ─── Main check ────────────────────────────────────────────────────────────

/**
 * Run all anti-spam checks for an inbound message.
 * Always fail-open: any error → return null (allow through).
 *
 * @param {string} phone    - Sender phone (digits only)
 * @param {string} clientId - Client ID (isolates duplicate tracking per client)
 * @param {string} text     - Raw inbound message text (may be empty for media)
 * @returns {Promise<string|null>}
 *   null           → message is clean, allow processing
 *   "TEMP_BLOCKED" → phone is currently in the cooldown block list
 *   "DUPLICATE"    → identical text seen from this phone in the last 30 s
 *   "FLOOD"        → phone exceeded burst limit, now temp-blocked for 5 min
 */
async function checkInboundSpam(phone, clientId, text) {
  try {
    // 1. Temp block list
    if (await isSpamBlocked(phone)) {
      logger.debug("AntiSpam: temp-blocked", { phone, clientId });
      return "TEMP_BLOCKED";
    }

    // 2. Duplicate text
    if (text && text.trim() && await isDuplicateText(clientId, phone, text)) {
      logger.debug("AntiSpam: duplicate text suppressed", { phone, clientId });
      return "DUPLICATE";
    }

    // 3. Flood counter
    const count = await incrFlood(phone);
    if (count > FLOOD_THRESHOLD) {
      await setSpamBlock(phone);
      logger.warn("AntiSpam: flood detected — phone temp-blocked", {
        phone, clientId, msgCount: count, blockSec: BLOCK_TTL_SEC,
      });
      return "FLOOD";
    }

    return null; // clean
  } catch (err) {
    logger.warn("AntiSpam: check error (fail-open)", { error: err.message, phone });
    return null;
  }
}

module.exports = {
  checkInboundSpam,
  isSpamBlocked,
  setSpamBlock,
  clearSpamBlock,
  FLOOD_WINDOW_SEC,
  FLOOD_THRESHOLD,
  BLOCK_TTL_SEC,
  DUP_WINDOW_SEC,
};
