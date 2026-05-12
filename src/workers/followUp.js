/**
 * Follow-up scheduler for NgomeAI.
 * When AI sets next_state with a follow-up indicator, save it.
 * Background job checks pending follow-ups and sends them.
 */

const { pool } = require("../db");
const { getRecentHistory } = require("../repositories/logic");
const { sendMessage } = require("../providers/sender");
const logger = require("../utils/logger");

const CHECK_INTERVAL_MS = 5 * 60_000; // 5 minutes
let _intervalId = null;

// ── DB helpers ─────────────────────────────────────────────────

async function createFollowUp(clientId, userPhone, scheduledFor, message) {
  if (!clientId || !userPhone || !message) return;
  await pool.query(
    `INSERT INTO follow_ups (klien_id, user_phone, scheduled_for, message)
     VALUES ($1, $2, $3, $4)`,
    [clientId, userPhone, scheduledFor, String(message).slice(0, 4000)]
  );
}

async function getDueFollowUps() {
  const { rows } = await pool.query(
    `SELECT id, klien_id, user_phone, message
     FROM follow_ups
     WHERE sent = FALSE AND scheduled_for <= NOW()
     ORDER BY scheduled_for ASC
     LIMIT 20`
  );
  return rows;
}

async function markFollowUpSent(id) {
  await pool.query(
    `UPDATE follow_ups SET sent=TRUE, sent_at=NOW() WHERE id=$1`,
    [id]
  );
}

// ── Scheduler ─────────────────────────────────────────────────

async function processFollowUps() {
  try {
    const ups = await getDueFollowUps();
    if (!ups.length) return;

    // Kumpulkan semua klien_id unik, lalu load sekaligus — hindari N+1 query
    const clientIds = [...new Set(ups.map(u => u.klien_id))];
    const { rows: clientRows } = await pool.query(
      `SELECT * FROM clients WHERE id = ANY($1) AND aktif = TRUE`,
      [clientIds]
    );
    // Buat map id → client object untuk O(1) lookup
    const clientMap = Object.fromEntries(clientRows.map(c => [c.id, c]));

    for (const up of ups) {
      try {
        const client = clientMap[up.klien_id];
        if (!client) {
          // Klien tidak aktif atau sudah dihapus — tandai terkirim agar tidak retry
          await markFollowUpSent(up.id);
          continue;
        }

        // Kirim follow-up ke nomor user
        await sendMessage(client, up.user_phone, up.message).catch(err =>
          logger.warn("followUp send failed", { id: up.id, error: err.message })
        );

        await markFollowUpSent(up.id);
        logger.info("followUp sent", { id: up.id, clientId: up.klien_id, phone: up.user_phone });
      } catch (err) {
        logger.warn("followUp processing error", { id: up.id, error: err.message });
      }
    }
  } catch (err) {
    logger.error("followUp scheduler error", { error: err.message });
  }
}

function startFollowUpScheduler() {
  if (_intervalId) return;
  logger.info("Follow-up scheduler started");
  // Run once immediately, then every 5 minutes
  processFollowUps();
  _intervalId = setInterval(processFollowUps, CHECK_INTERVAL_MS);
  _intervalId.unref();
}

function stopFollowUpScheduler() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    logger.info("Follow-up scheduler stopped");
  }
}

module.exports = { createFollowUp, getDueFollowUps, markFollowUpSent, startFollowUpScheduler, stopFollowUpScheduler };
