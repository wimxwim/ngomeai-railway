/**
 * Redis client wrapper for high-performance caching.
 * Fallback to in-memory Map if Redis is unavailable.
 */

const redis = require("redis");
const config = require("../config");
const logger = require("./logger");

// Helper: add project prefix to all Redis keys to avoid collisions
function prefixKey(key) {
  return `${config.redisPrefix}${key}`;
}

let client = null;
let useFallback = false;

const fallbackStores = new Map(); // fallback if Redis down

function getClient() {
  if (useFallback) return null;
  if (client) return client;

  // Support REDIS_URL (Railway/cloud format) or HOST+PORT (local)
  const redisUrl = process.env.REDIS_URL;
  const clientOptions = redisUrl
    ? { url: redisUrl, socket: { tls: redisUrl.startsWith("rediss://"), rejectUnauthorized: false } }
    : { socket: { host: process.env.REDIS_HOST || "127.0.0.1", port: Number(process.env.REDIS_PORT) || 6379 } };

  client = redis.createClient(clientOptions);

  client.on("error", (err) => {
    logger.warn("Redis error, using fallback", { error: err.message });
    useFallback = true;
    client = null;
  });

  client.connect().catch(() => {
    logger.warn("Redis connect failed, using in-memory fallback");
    useFallback = true;
    client = null;
  });

  return client;
}

// ── Generic get/set with TTL ────────────────────────────────

async function get(key) {
  const c = getClient();
  if (!c) return fallbackStores.get(key) || null;
  try {
    const val = await c.get(key);
    return val ? JSON.parse(val) : null;
  } catch (e) {
    return fallbackStores.get(key) || null;
  }
}

async function set(key, val, ttlSeconds) {
  const c = getClient();
  const str = JSON.stringify(val);
  if (!c) {
    fallbackStores.set(key, val);
    return;
  }
  try {
    if (ttlSeconds) {
      await c.setEx(key, ttlSeconds, str);
    } else {
      await c.set(key, str);
    }
  } catch (e) {
    fallbackStores.set(key, val);
  }
}

async function del(key) {
  const c = getClient();
  if (!c) { fallbackStores.delete(key); return; }
  try { await c.del(key); } catch (_) {}
}

// ── Set NX (set if not exists) with TTL ──────────────────────
// Returns true if key was set (not a duplicate), false if already exists.
// Fallback: always return true (allow through if Redis down).

async function setNX(key, ttlSeconds) {
  const c = getClient();
  if (!c) return true; // fail-open: allow through
  try {
    const result = await c.set(key, "1", { NX: true, EX: ttlSeconds });
    return result === "OK";
  } catch (e) {
    return true; // fail-open
  }
}

async function incr(key, ttlSeconds) {
  const c = getClient();
  if (!c) {
    const cur = (fallbackStores.get(key) || 0) + 1;
    fallbackStores.set(key, cur);
    return cur;
  }
  try {
    const val = await c.incr(key);
    if (ttlSeconds && val === 1) await c.expire(key, ttlSeconds);
    return val;
  } catch (e) {
    return 1; // fail-open
  }
}

// ── Cache helpers ─────────────────────────────────────────────

// Client cache: TTL 3600s (1 hour)
const CLIENT_TTL = 3600;

async function getClientCache(key) {
  return get(prefixKey(`client:${key}`));
}

async function setClientCache(key, val) {
  return set(prefixKey(`client:${key}`), val, CLIENT_TTL);
}

async function delClientCache(key) {
  return del(prefixKey(`client:${key}`));
}

// AI response cache: TTL 300s (5 minutes)
const AI_CACHE_TTL = 300;

async function getAiCache(key) {
  return get(prefixKey(`ai:${key}`));
}

async function setAiCache(key, val) {
  return set(prefixKey(`ai:${key}`), val, AI_CACHE_TTL);
}

// Rate limiter: TTL 60s
const RATE_TTL = 60;

async function getRateCount(key) {
  return get(prefixKey(`rate:${key}`));
}

async function incrRateCount(key) {
  return incr(prefixKey(`rate:${key}`), RATE_TTL);
}

// Conversation state: TTL 1800s (30 minutes)
const CONV_TTL = 1800;

async function getConvState(key) {
  return get(prefixKey(`conv:${key}`));
}

async function setConvState(key, val) {
  return set(prefixKey(`conv:${key}`), val, CONV_TTL);
}

async function delConvState(key) {
  return del(prefixKey(`conv:${key}`));
}

// ── Generic key/value primitives (prefixed) ──────────────────────────
// Used by antispam.js and other internal modules that manage their own namespaces.

async function getKey(key) {
  return get(prefixKey(key));
}

async function setKey(key, val, ttlSeconds) {
  return set(prefixKey(key), val, ttlSeconds);
}

async function delKey(key) {
  return del(prefixKey(key));
}

/**
 * Atomic increment of a prefixed counter. TTL is set only on first increment.
 * Returns the new counter value. Falls back to 1 on Redis error (fail-open).
 * @param {string} key
 * @param {number} ttlSeconds - TTL applied when counter is first created
 * @returns {Promise<number>}
 */
async function incrKey(key, ttlSeconds) {
  const pk = prefixKey(key);
  const c  = getClient();
  if (!c) {
    const cur = (fallbackStores.get(pk) || 0) + 1;
    fallbackStores.set(pk, cur);
    return cur;
  }
  try {
    const val = await c.incr(pk);
    if (ttlSeconds && val === 1) await c.expire(pk, ttlSeconds);
    return val;
  } catch (e) {
    return 1;
  }
}

module.exports = {
  getClientCache, setClientCache, delClientCache,
  getAiCache, setAiCache,
  getRateCount, incrRateCount,
  getConvState, setConvState, delConvState,
  setNX,
  getKey, setKey, delKey, incrKey,
};
