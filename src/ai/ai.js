/**
 * AI Engine NgomeAI — OpenRouter dengan model chain fallback.
 *
 * Terima pesan + konteks klien, kembalikan JSON keputusan:
 * { intent, confidence, response, actions, next_state }
 */

const axios  = require("axios");
const config = require("../config");
const { getModelChain, getModelConfig } = require("./modelSelector");
const logger = require("../utils/logger");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Konteks nada bicara berdasarkan jenis bisnis klien
// Digunakan untuk menyesuaikan gaya bahasa AI agar sesuai konteks
const BUSINESS_TONE = {
  masjid:     "Gunakan bahasa yang santun, islami, dan hangat. Sapa dengan 'Assalamualaikum' jika sesuai. Prioritaskan nilai-nilai keagamaan dan edukasi.",
  toko:       "Gunakan bahasa yang ramah, persuasif, dan berorientasi penjualan. Bantu pelanggan menemukan produk yang tepat.",
  sekolah:    "Gunakan bahasa yang formal, akademis, dan edukatif. Dukung proses belajar-mengajar dengan informatif.",
  kesehatan:  "Gunakan bahasa yang empatis, profesional, dan mudah dipahami awam. Jangan berikan saran medis spesifik.",
  properti:   "Gunakan bahasa yang profesional dan informatif. Bantu calon pembeli/penyewa memahami detail properti.",
  kuliner:    "Gunakan bahasa yang hangat, menggugah selera, dan informatif tentang menu/bahan.",
  jasa:       "Gunakan bahasa yang profesional, jelas, dan berorientasi solusi untuk kebutuhan klien.",
  umum:       "Gunakan bahasa yang ramah, jelas, dan membantu.",
};

/**
 * Kembalikan string tanggal + waktu + hari saat ini dalam format Indonesia (WIB).
 * Dipanggil setiap request agar AI selalu tahu waktu real-time yang akurat.
 * @returns {string} contoh: "Senin, 11 Mei 2026 · 06:28 WIB"
 */
function nowJakarta() {
  const HARI  = ["Minggu","Senin","Selasa","Rabu","Kamis","Jumat","Sabtu"];
  const BULAN = ["Januari","Februari","Maret","April","Mei","Juni",
                 "Juli","Agustus","September","Oktober","November","Desember"];
  const now   = new Date(); // TZ sudah Asia/Jakarta dari config.js
  const hari  = HARI[now.getDay()];
  const tgl   = now.getDate();
  const bln   = BULAN[now.getMonth()];
  const thn   = now.getFullYear();
  const jam   = String(now.getHours()).padStart(2, "0");
  const mnt   = String(now.getMinutes()).padStart(2, "0");
  return `${hari}, ${tgl} ${bln} ${thn} · ${jam}:${mnt} WIB`;
}

/**
 * Bangun system prompt final dengan menyisipkan profil bisnis dan tone.
 * Urutan prioritas: customSystemPrompt (dari DB) → default fallback.
 * Profil bisnis selalu disisipkan sebagai blok konteks tambahan jika ada.
 *
 * @param {string|null} customSystemPrompt - system_prompt dari tabel clients
 * @param {string|null} businessProfile    - business_profile dari tabel clients
 * @param {string}      businessType       - business_type ('masjid', 'toko', dll)
 * @returns {string} system prompt final yang dikirim ke AI
 */
function buildSystemPrompt(customSystemPrompt, businessProfile, businessType) {
  // Prompt dasar: pakai custom dari DB atau fallback default
  const base = customSystemPrompt || `Kamu adalah asisten AI yang membantu pelanggan.
Balas dalam Bahasa Indonesia yang sopan dan ramah.
Jangan halusinasi atau mengarang fakta — jika tidak tahu, katakan jujur.

OUTPUT FORMAT (wajib JSON):
{
  "intent": "chat",
  "confidence": 0.9,
  "response": "tulis balasan di sini",
  "actions": [],
  "next_state": ""
}`;

  const parts = [base];

  // Waktu real-time Jakarta — AI pakai ini untuk jawab "sekarang jam berapa", "hari apa", dll
  parts.push(`\nWAKTU SEKARANG: ${nowJakarta()}`);

  // Sisipkan panduan nada bicara sesuai jenis bisnis
  const tone = BUSINESS_TONE[businessType] || BUSINESS_TONE.umum;
  parts.push(`GAYA BICARA: ${tone}`);

  // Sisipkan profil bisnis lengkap sebagai konteks referensi AI
  // AI harus menggunakan data ini untuk menjawab pertanyaan tentang bisnis
  if (businessProfile && businessProfile.trim()) {
    parts.push(
      "\n=== PROFIL BISNIS KLIEN ===",
      "Data berikut adalah informasi resmi bisnis ini.",
      "GUNAKAN data ini untuk menjawab pertanyaan pelanggan tentang nama, alamat, jam buka, kontak, website, dll.",
      "JANGAN mengarang informasi di luar data berikut:",
      businessProfile.trim(),
      "=== AKHIR PROFIL BISNIS ===",
    );
  }

  return parts.join("\n");
}

/**
 * Panggil AI via OpenRouter dengan model chain fallback.
 *
 * @param {string}      message           - Pesan masuk dari user (sudah di-truncate)
 * @param {string|null} customSystemPrompt - system_prompt dari tabel clients
 * @param {Array}       history           - Riwayat percakapan [{role, content}]
 * @param {object}      options
 * @param {string}      options.current_state    - State percakapan saat ini
 * @param {string|null} options.business_profile - Profil bisnis klien lengkap
 * @param {string}      options.business_type    - Jenis bisnis ('masjid', 'toko', dll)
 * @returns {Promise<{intent, confidence, response, actions, next_state}>}
 */
async function askAI(message, customSystemPrompt, history, options = {}) {
  if (!message) {
    return { intent: "unknown", confidence: 0, response: "Maaf, pesan kosong.", actions: [], next_state: "" };
  }

  const chain    = getModelChain();
  const modelCfg = getModelConfig();

  // Bangun system prompt final dengan injeksi profil bisnis
  const system = buildSystemPrompt(
    customSystemPrompt,
    options.business_profile || null,
    options.business_type    || "umum"
  );

  // Bangun message list: state saat ini + riwayat + pesan baru
  const messages = [];
  if (options.current_state) {
    // State percakapan membantu AI melanjutkan alur yang sudah dimulai
    messages.push({ role: "system", content: `State percakapan saat ini: ${options.current_state}` });
  }
  if (Array.isArray(history)) {
    // Ambil maksimal 10 pesan terakhir agar context window tidak terlalu besar
    history.slice(-10).forEach(h => {
      messages.push({ role: h.role === "user" ? "user" : "assistant", content: h.content });
    });
  }
  messages.push({ role: "user", content: String(message).slice(0, 2000) });

  let lastError = null;
  // Coba maksimal 3 model dari chain — jika gagal, lanjut ke berikutnya
  for (let i = 0; i < Math.min(chain.length, 3); i++) {
    const model = chain[i];
    try {
      const res = await axios.post(
        OPENROUTER_URL,
        {
          model,
          messages: [{ role: "system", content: system }, ...messages],
          temperature: modelCfg[model]?.temperature || 0.7,
          max_tokens: 1000,
        },
        {
          headers: {
            "Authorization": `Bearer ${config.openRouterKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://ngomeai.com",
            "X-Title": "NgomeAI-CodeEngine",
          },
          timeout: 30000,
        }
      );

      const raw       = res.data?.choices?.[0]?.message?.content;
      const reasoning = res.data?.choices?.[0]?.message?.reasoning;
      // Handle reasoning model: content null, jawaban ada di field reasoning
      const actualContent = raw || reasoning || "";
      if (!actualContent) throw new Error("Empty AI response");

      // Coba parse JSON dari response model
      let parsed;
      try {
        parsed = JSON.parse(actualContent);
      } catch (_) {
        // Coba ekstrak dari code block ```json ... ```
        const codeBlock = actualContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeBlock) {
          try { parsed = JSON.parse(codeBlock[1]); } catch (_) {}
        }
      }

      if (parsed && typeof parsed === "object") {
        return {
          intent:     String(parsed.intent     || "chat").slice(0, 64),
          confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.8)),
          response:   String(parsed.response   || parsed.reply || actualContent).slice(0, 4000),
          actions:    Array.isArray(parsed.actions) ? parsed.actions.slice(0, 10) : [],
          next_state: String(parsed.next_state || "").slice(0, 128),
        };
      }

      // Model mengembalikan teks biasa — bungkus sebagai response
      return {
        intent:     "chat",
        confidence: 0.8,
        response:   String(actualContent).slice(0, 4000),
        actions:    [],
        next_state: "",
      };

    } catch (err) {
      lastError = err;
      logger.warn("askAI model failed", { model, index: i, error: err.message });
      // Lanjut ke model berikutnya untuk error server (5xx), rate limit (429), atau timeout
      if (err.response?.status >= 500 || err.response?.status === 429 || err.code === "ECONNABORTED") continue;
      break;
    }
  }

  logger.error("askAI all models failed", { error: lastError?.message });
  return {
    intent:     "error",
    confidence: 0,
    response:   "Maaf, AI sedang gangguan. Silakan coba lagi nanti.",
    actions:    [],
    next_state: "",
  };
}

module.exports = { askAI };
