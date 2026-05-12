/**
 * Health monitoring for WhatsApp providers.
 * Runs every 60s, pings each provider, marks clients as degraded if down.
 * Notifies admin via Telegram on status changes.
 * OWNERSHIP: Terminal 2 — Webhook & Realtime Synchronization
 */

const axios  = require("axios");
const config = require("../config");
const logger = require("../utils/logger");
const { pool } = require("../db");
const { listClients } = require("../repositories/admin");
const { getClientCache, setClientCache } = require("../utils/redis");

const CHECK_INTERVAL_MS = 60_000; // 60 seconds
let _intervalId = null;
let _lastStatus = {}; // clientId → last health_status

// #7: Load _lastStatus from Redis on startup (graceful fallback if Redis down)
async function loadLastStatus() {
  try {
    const saved = await getClientCache("healthcheck:lastStatus");
    if (saved && typeof saved === "object") {
      _lastStatus = saved;
      logger.info("HealthCheck: loaded lastStatus from Redis");
    }
  } catch (err) {
    logger.warn("HealthCheck: failed to load lastStatus from Redis", { error: err.message });
  }
}

async function persistLastStatus() {
  try {
    await setClientCache("healthcheck:lastStatus", _lastStatus);
  } catch (err) {
    logger.warn("HealthCheck: failed to persist lastStatus to Redis", { error: err.message });
  }
}

// Load on module load
loadLastStatus();

async function checkWahaHealth(url, session) {
  try {
    const res = await axios.get(`${url}/api/sessions/${encodeURIComponent(session)}`, {
      headers: config.wahaApiKey ? { "X-Api-Key": config.wahaApiKey } : {},
      timeout: 5000,
    });
    const st = res.data?.status;
    return { ok: st === "WORKING", status: st || "unknown" };
  } catch (err) {
    return { ok: false, status: "down", error: err.message };
  }
}

async function checkGowaHealth(url) {
  try {
    await axios.get(`${url}/app/status`, { timeout: 5000 });
    return { ok: true, status: "WORKING" };
  } catch (err) {
    return { ok: false, status: "down", error: err.message };
  }
}

async function runHealthCheck() {
  try {
    const clients = await listClients();
    const notify = [];

    for (const c of clients) {
      if (!c.aktif) continue;

      let health;
      if (c.provider === "waha" && c.waha_url && c.waha_session) {
        health = await checkWahaHealth(c.waha_url, c.waha_session);
      } else if (c.provider === "gowa" && c.gowa_device_id) {
        health = await checkGowaHealth(config.gowaUrl || "http://localhost:3001");
      } else if (c.provider === "meta") {
        health = { ok: true, status: "WORKING" }; // Meta is managed by Meta
      } else {
        continue;
      }

      const newStatus = health.ok ? "healthy" : "degraded";
      const oldStatus = _lastStatus[c.id] || "unknown";

      // Notify on status change (webhook.js is the single source of truth for DB updates)
      if (newStatus !== oldStatus) {
        _lastStatus[c.id] = newStatus;
        await persistLastStatus(); // #7: persist to Redis

        if (!health.ok) {
          notify.push(`⚠️ *${c.nama}* (${c.id}) is *${newStatus}*\nProvider: ${c.provider}\nStatus: ${health.status}`);
        } else if (oldStatus === "degraded") {
          notify.push(`✅ *${c.nama}* (${c.id}) is back to *healthy*\nProvider: ${c.provider}`);
        }
      }
    }

    // Send Telegram notifications
    if (notify.length && config.telegramBotToken && config.telegramAdminIds?.length) {
      const msg = `🏥 *Health Update*\n\n${notify.join("\n\n")}`;
      for (const adminId of config.telegramAdminIds) {
        try {
          await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
            chat_id: adminId,
            text: msg,
            parse_mode: "Markdown",
          }, { timeout: 5000 });
        } catch (_) {}
      }
    }
  } catch (err) {
    logger.warn("healthCheck failed", { error: err.message });
  }
}

function startHealthCheck() {
  if (_intervalId) return;
  logger.info("Health monitoring started");
  // Run immediately, then every 60s
  runHealthCheck();
  _intervalId = setInterval(runHealthCheck, CHECK_INTERVAL_MS);
  _intervalId.unref(); // Don't keep process alive

  // #15: Clear interval on process termination (same line for grep)
  process.once("SIGTERM", () => { clearInterval(_intervalId); _intervalId = null; });
  process.once("SIGINT", () => { clearInterval(_intervalId); _intervalId = null; });
}

function stopHealthCheck() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    logger.info("Health monitoring stopped");
  }
}

module.exports = { startHealthCheck, stopHealthCheck, runHealthCheck };
