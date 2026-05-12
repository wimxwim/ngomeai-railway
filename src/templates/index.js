/**
 * Templates — FAQ Engine dengan Exact Match + Semantic Match.
 *
 * Flow:
 *   1. Exact match (case-insensitive, trim) — langsung return jika cocok
 *   2. Semantic match (pg_trgm similarity) — jika exact tidak cocok
 *
 * Menghindari kb_latihan seperti di Lambda (buat repo terpisah, tidak instan,
 * tapi rapih dan mudah audit).
 */

const { pool } = require("../db");
const logger = require("../utils/logger");

const SIMILARITY_THRESHOLD = 0.3; // Sama dengan yang dipakai di logic.js

/**
 * Cari FAQ template berdasarkan pesan user.
 *
 * @param {number} klienId  - ID client
 * @param {string} message  - Pesan user (sudah dinormalisasi/LC)
 * @returns {string|null} Jawaban template, atau null jika tidak ada yang cocok
 */
async function searchTemplate(klienId, message) {
  if (!klienId || !message) return null;

  try {
    // ── Step 1: Exact match ────────────────────────────────────────
    // Cek apakah message persis sama dengan salah satu keyword (case-insensitive)
    const exactResult = await pool.query(
      `SELECT answer FROM templates
        WHERE klien_id = $1
          AND EXISTS (
            SELECT 1 FROM unnest(string_to_array(keywords, ',')) AS kw
            WHERE trim(kw) != '' AND LOWER(trim(kw)) = LOWER($2)
          )
        LIMIT 1`,
      [klienId, message]
    );

    if (exactResult.rows.length > 0) {
      logger.debug("Template: exact match found", { klienId, message: message.slice(0, 50) });
      return exactResult.rows[0].answer;
    }

    // ── Step 2: Semantic match (trigram similarity) ─────────────────
    const semanticResult = await pool.query(
      `SELECT answer, keywords,
          (SELECT COALESCE(MAX(similarity(trim(kw), LOWER($2))), 0)
            FROM unnest(string_to_array(keywords, ',')) AS kw
            WHERE trim(kw) != '') AS best_sim
        FROM templates
        WHERE klien_id = $1
          AND EXISTS (
            SELECT 1 FROM unnest(string_to_array(keywords, ',')) AS kw
            WHERE trim(kw) != '' AND similarity(trim(kw), LOWER($2)) > $3
          )
        ORDER BY best_sim DESC, id DESC
        LIMIT 1`,
      [klienId, message, SIMILARITY_THRESHOLD]
    );

    if (semanticResult.rows.length > 0) {
      const row = semanticResult.rows[0];
      logger.debug("Template: semantic match found", {
        klienId,
        message: message.slice(0, 50),
        similarity: row.best_sim,
      });
      return row.answer;
    }

    return null;
  } catch (err) {
    logger.error("Template search error", { error: err.message, klienId });
    return null;
  }
}

module.exports = { searchTemplate, SIMILARITY_THRESHOLD };
