const { pool } = require("../db");
const { normalizePhone } = require("../repositories/logic");

async function getConversationState(klienId, userPhone) {
  if (!klienId || !userPhone) return null;
  const phone = normalizePhone(userPhone);
  if (!phone) return null;

  const { rows } = await pool.query(
    `SELECT current_state
     FROM conversations
     WHERE klien_id = $1 AND user_phone = $2
     LIMIT 1`,
    [klienId, phone]
  );
  return rows[0]?.current_state ?? null;
}

async function setConversationState(klienId, userPhone, state) {
  if (!klienId || !userPhone) return;
  const phone = normalizePhone(userPhone);
  if (!phone) return;

  const safeState = state == null ? null : String(state).slice(0, 128);

  await pool.query(
    `INSERT INTO conversations (klien_id, user_phone, current_state, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (klien_id, user_phone)
     DO UPDATE SET current_state = EXCLUDED.current_state, updated_at = NOW()`,
    [klienId, phone, safeState]
  );
}

module.exports = { getConversationState, setConversationState };

