"use strict";

/**
 * statsWorker.js — Pre-compute and cache expensive stats queries.
 *
 * Runs at 00:00:05 and 12:00:05 local time.
 * Caches results in Redis (TTL 13 h) so the admin dashboard never waits
 * for a slow query at page-load time.  Falls back to a direct DB query
 * if the cache is empty or Redis is unavailable.
 *
 * Cached payload per client:
 *   keywords      — top 10 words from user messages (last 7 days)
 *   responseTime  — avg response gap in seconds (last 30 days)
 *   activeNumbers — top 10 most active phone numbers (last 30 days)
 *   updatedAt     — ISO timestamp of last successful refresh
 */

const logger = require("../utils/logger");
const redis  = require("../utils/redis");
const { pool } = require("../db");
const {
  statsAdvanced,
} = require("../repositories/admin");

// Cache TTL: 13 hours — slightly longer than the half-day refresh interval
// so a failed refresh doesn't leave the cache cold.
const CACHE_TTL_SEC = 13 * 3600;

// Key pattern: stats:advanced:<klien_id>
function cacheKey(klien_id) {
  return `stats:advanced:${klien_id}`;
}

// ─── Date helpers ──────────────────────────────────────────────────────────

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function dateRange30Days() {
  const to   = new Date();
  const from = new Date(Date.now() - 29 * 86400000);
  return { from: toDateStr(from), to: toDateStr(to) };
}

// ─── Cache read / write ────────────────────────────────────────────────────

async function readCache(klien_id) {
  try {
    return await redis.getKey(cacheKey(klien_id));
  } catch (_) {
    return null;
  }
}

async function writeCache(klien_id, payload) {
  try {
    await redis.setKey(cacheKey(klien_id), payload, CACHE_TTL_SEC);
  } catch (_) {
    // Non-fatal; caller will fall back to live query
  }
}

// ─── Public: get advanced stats (cached or live) ───────────────────────────

/**
 * Get advanced stats for a client. Returns cached data when available.
 * Falls back to a direct DB query when cache is cold.
 *
 * @param {string} klien_id
 * @param {string} [from_date] — YYYY-MM-DD, defaults to 30 days ago
 * @param {string} [to_date]   — YYYY-MM-DD, defaults to today
 * @returns {Promise<{keywords, responseTime, activeNumbers, updatedAt, cached}>}
 */
async function getAdvancedStats(klien_id, from_date, to_date) {
  const cached = await readCache(klien_id);
  if (cached) return Object.assign({}, cached, { cached: true });

  // Cache miss: compute live
  const { from, to } = dateRange30Days();
  const fd = from_date || from;
  const td = to_date   || to;
  const data = await statsAdvanced(klien_id, fd, td, 7);
  const payload = Object.assign({}, data, { updatedAt: new Date().toISOString() });
  await writeCache(klien_id, payload);
  return Object.assign({}, payload, { cached: false });
}

// ─── Refresh: compute and cache for ALL active clients ────────────────────

/**
 * Recompute advanced stats for every active client and write to cache.
 * Called by the scheduler at 00:00:05 and 12:00:05.
 */
async function refreshAllStats() {
  let { rows: clients } = await pool.query(
    `SELECT id FROM clients WHERE aktif = TRUE ORDER BY id`
  );

  if (!clients.length) {
    logger.info("statsWorker: no active clients to refresh");
    return;
  }

  const { from, to } = dateRange30Days();
  let succeeded = 0;
  let failed    = 0;

  for (const { id } of clients) {
    try {
      const data = await statsAdvanced(id, from, to, 7);
      const payload = Object.assign({}, data, { updatedAt: new Date().toISOString() });
      await writeCache(id, payload);
      succeeded++;
    } catch (err) {
      logger.warn("statsWorker: refresh failed for client", { klien_id: id, error: err.message });
      failed++;
    }
  }

  logger.info("statsWorker: refresh complete", { succeeded, failed, total: clients.length });
}

module.exports = { getAdvancedStats, refreshAllStats };
