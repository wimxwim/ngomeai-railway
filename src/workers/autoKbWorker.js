"use strict";

/**
 * autoKbWorker.js — Auto-generate Knowledge Base dari history percakapan.
 *
 * Jadwal: setiap 60 menit (bisa dikonfigurasi via AUTO_KB_INTERVAL_MINUTES).
 * Sumber data:
 *   - Semua chat personal (direction=in, is_sent=TRUE/FALSE)
 *   - Semua chat grup (is_group=TRUE)
 *   - 3 hari terakhir (lebih fresh dari sebelumnya)
 *
 * Per klien:
 *   1. Ambil max 200 pasang percakapan (user → bot) dari DB
 *   2. Kirim ke AI dengan prompt ekstraksi KB
 *   3. Simpan sebagai auto_generated=TRUE, approved=FALSE (shadow mode)
 *   4. Duplikat keywords ditolak otomatis via ON CONFLICT
 *   5. Cap 20 entri baru per run per klien (frekuensi tinggi → sedikit per run)
 *
 * Privasi: setiap query di-scope ke klien_id — tidak ada cross-client leak.
 */

const axios  = require("axios");
const config = require("../config");
const logger = require("../utils/logger");
const { pool } = require("../db");
const { getModelChain, getModelConfig } = require("../ai/modelSelector");
const { createKb } = require("../repositories/admin");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Konfigurasi — override via env jika perlu
const MAX_ENTRIES_PER_RUN  = Number(process.env.AUTO_KB_MAX_ENTRIES)  || 20;
const HISTORY_DAYS         = Number(process.env.AUTO_KB_HISTORY_DAYS) || 3;
const MAX_PAIRS_PER_CLIENT = 200; // max pasang percakapan yang dikirim ke AI

// ─── System prompt ekstraksi KB ───────────────────────────────────────────

const KB_EXTRACTION_PROMPT = `Kamu adalah analis percakapan customer service yang ahli.
Dari transcript percakapan WhatsApp berikut (personal & grup), ekstrak:
- Pertanyaan/topik yang SERING muncul dari banyak orang
- Jawaban terbaik yang sudah terbukti efektif
- Informasi yang rutin ditanyakan orang ke bisnis ini

Kembalikan HANYA JSON array, tanpa teks apapun di luar array, format:
[
  {
    "keywords": "kata kunci singkat dipisah koma, max 80 karakter",
    "content": "jawaban lengkap, informatif, dan sopan, max 600 karakter"
  }
]

ATURAN KETAT:
- Maksimal 10 entri per response
- JANGAN mengarang — hanya dari data percakapan yang ada
- keywords harus spesifik: "jam sholat jumat", bukan "pertanyaan umum"
- Gabungkan topik serupa menjadi satu entri
- Jika tidak ada topik berguna, kembalikan: []
- Bahasa mengikuti mayoritas percakapan
- Prioritaskan topik yang ditanya lebih dari 1 orang`;

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Ambil transcript percakapan dari semua sumber:
 * personal + grup, terkirim + listen mode.
 * Diurutkan terbaru dulu agar topik relevan muncul di atas.
 */
async function fetchTranscript(klien_id) {
  const { rows } = await pool.query(`
    SELECT
      user_message,
      bot_answer,
      is_group,
      sender_name
    FROM chat_history
    WHERE klien_id   = $1
      AND direction  = 'in'
      AND created_at >= NOW() - ($2 || ' days')::INTERVAL
      AND length(trim(user_message)) > 5
      AND (
        -- Chat personal: ambil yang ada jawaban bot
        (is_group = FALSE AND length(trim(bot_answer)) > 5)
        OR
        -- Chat grup: ambil semua (termasuk listen mode tanpa bot_answer)
        (is_group = TRUE)
      )
    ORDER BY created_at DESC
    LIMIT $3
  `, [klien_id, HISTORY_DAYS, MAX_PAIRS_PER_CLIENT]);
  return rows;
}

/**
 * Buat teks transcript ringkas untuk dikirim ke AI.
 * Format: [Grup/Personal] Nama: pesan → Jawaban bot
 */
function buildTranscriptText(pairs) {
  return pairs.map(p => {
    const source  = p.is_group ? "[Grup]" : "[Personal]";
    const sender  = p.sender_name ? ` ${p.sender_name}` : "";
    const user    = String(p.user_message).slice(0, 250);
    const bot     = p.bot_answer ? `\nBot: ${String(p.bot_answer).slice(0, 350)}` : "";
    return `${source}${sender}: ${user}${bot}`;
  }).join("\n---\n");
}

/**
 * Panggil AI untuk ekstrak entri KB dari transcript.
 * Sertakan konteks bisnis agar hasil lebih relevan.
 * @returns {Array<{keywords, content}>}
 */
async function extractKbFromTranscript(transcript, client) {
  const chain    = getModelChain();
  const modelCfg = getModelConfig();
  const model    = chain[0];

  // Sertakan profil bisnis sebagai konteks agar KB sesuai jenis usaha
  const konteks = [
    client.system_prompt   ? `Instruksi AI: ${client.system_prompt.slice(0, 200)}`   : "",
    client.business_profile ? `Profil bisnis: ${client.business_profile.slice(0, 300)}` : "",
  ].filter(Boolean).join("\n");

  const systemContent = konteks
    ? `${KB_EXTRACTION_PROMPT}\n\n=== KONTEKS BISNIS ===\n${konteks}`
    : KB_EXTRACTION_PROMPT;

  try {
    const res = await axios.post(
      OPENROUTER_URL,
      {
        model,
        messages: [
          { role: "system", content: systemContent },
          { role: "user",   content: `Transcript percakapan:\n\n${transcript}` },
        ],
        temperature: 0.2, // rendah = lebih konsisten, kurang halusinasi
        max_tokens:  2000,
      },
      {
        headers: {
          "Authorization": `Bearer ${config.openRouterKey}`,
          "Content-Type":  "application/json",
          "HTTP-Referer":  "https://ngomeai.com",
          "X-Title":       "NgomeAI-AutoKB",
        },
        timeout: 60_000,
      }
    );

    const raw = res.data?.choices?.[0]?.message?.content
             || res.data?.choices?.[0]?.message?.reasoning
             || "";
    if (!raw) return [];

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      const m = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (m) { try { parsed = JSON.parse(m[1]); } catch (_) {} }
    }

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(e => e && typeof e.keywords === "string" && typeof e.content === "string")
      .map(e => ({
        keywords: String(e.keywords).slice(0, 200).trim(),
        content:  String(e.content).slice(0, 1000).trim(),
      }))
      .filter(e => e.keywords && e.content);

  } catch (err) {
    logger.warn("autoKbWorker: AI call failed", { error: err.message, model });
    return [];
  }
}

// ─── Per-client run ────────────────────────────────────────────────────────

async function generateKbForClient(client) {
  const { id: klien_id, nama } = client;

  const pairs = await fetchTranscript(klien_id);
  if (!pairs.length) {
    logger.debug("autoKbWorker: no history for client", { klien_id, nama });
    return { generated: 0, skipped: 0 };
  }

  const transcript = buildTranscriptText(pairs);
  const entries    = await extractKbFromTranscript(transcript, client);

  if (!entries.length) {
    logger.debug("autoKbWorker: no KB entries extracted", { klien_id, nama });
    return { generated: 0, skipped: 0 };
  }

  const toInsert = entries.slice(0, MAX_ENTRIES_PER_RUN);
  let generated  = 0;
  let skipped    = 0;

  for (const entry of toInsert) {
    try {
      await createKb({
        klien_id,
        keywords:       entry.keywords,
        content:        entry.content,
        auto_generated: true,
        approved:       false, // shadow mode — admin approve dulu sebelum aktif
      });
      generated++;
    } catch (err) {
      // Duplicate keywords → ON CONFLICT → skip (bukan error fatal)
      if (err.code === "23505") {
        skipped++;
      } else {
        logger.warn("autoKbWorker: insert failed", { klien_id, error: err.message });
        skipped++;
      }
    }
  }

  if (generated > 0) {
    logger.info("autoKbWorker: new KB entries staged", { klien_id, nama, generated, skipped });
  }
  return { generated, skipped };
}

// ─── Main: jalankan untuk semua klien aktif ────────────────────────────────

async function runAutoKbGeneration() {
  if (!config.openRouterKey) {
    logger.warn("autoKbWorker: OPENROUTER_KEY not set — skip");
    return;
  }

  const { rows: clients } = await pool.query(`
    SELECT id, nama, system_prompt, business_profile, business_type
    FROM clients
    WHERE aktif = TRUE
    ORDER BY id
  `);

  if (!clients.length) return;

  let totalGenerated = 0;
  let totalFailed    = 0;

  for (const client of clients) {
    try {
      const { generated } = await generateKbForClient(client);
      totalGenerated += generated;
    } catch (err) {
      logger.warn("autoKbWorker: client run failed", { klien_id: client.id, error: err.message });
      totalFailed++;
    }
  }

  if (totalGenerated > 0) {
    logger.info("autoKbWorker: run complete", {
      clients: clients.length, totalGenerated, totalFailed,
    });
  }
}

module.exports = { runAutoKbGeneration };
