/**
 * Skill: lead_capture
 * Intent: lead_capture, interested, want_info
 *
 * Workflow:
 *   1. Simpan kontak user ke DB (atau tandai sebagai lead)
 *   2. Kirim pesan sukses
 *   3. Trigger follow-up setelah 30 menit
 */

const { saveLead } = require("../repositories/logic"); // Asumsi ada fungsi ini, atau buat stub
const { executeActions } = require("../actions/index.js");

module.exports = {
  name: "lead_capture",
  description: "Capture user kontak sebagai lead bisnis",
  intent: "lead_capture", // Optional: trigger otomatis jika AI intent cocok

  execute: async function(context) {
    const { client, userPhone, message, decision } = context;

    // ── Step 1: Simpan lead (stub — asumsi fungsi ada di logic.js) ──
    // Jika belum ada fungsi saveLead, bisa buat TODO atau log saja
    try {
      if (typeof saveLead === "function") {
        await saveLead(client.id, userPhone, message);
      } else {
        console.log(`[LeadCapture] Would save lead: client=${client.id}, phone=${userPhone}`);
      }
    } catch (err) {
      // Silent fail — lead capture tidak blokir balasan utama
    }

    // ── Step 2: Siapkan actions untuk dikirim ──
    const actions = [
      {
        type: "send_text",
        text: "Terima kasih! Kami sudah catat minat Anda. Tim kami akan segera menghubungi Anda. 😊",
      },
    ];

    // ── Step 3: Trigger follow-up (opsional) ──
    // Bisa pakai decision.next_state = "follow_up:30m" yang sudah didukung orchestrator

    return {
      success: true,
      next_state: "follow_up:30m", // Trigger follow-up 30 menit
      actions: actions,
      response: "Terima kasih! Kami sudah catat minat Anda.",
    };
  },
};
