const axios    = require("axios");
const FormData = require("form-data");
const { exec } = require("child_process");
const config   = require("../config");
const logger   = require("../utils/logger");
const { askAI } = require("../ai/ai");
const { getModelChain, invalidateCache } = require("../ai/modelSelector");
const { invalidateClientCacheById }      = require("../repositories/logic");
const { runBenchmark, readLastResult }   = require("../workers/modelBenchmark");
const svc = require("../repositories/admin");

const BASE = `https://api.telegram.org/bot${config.telegramBotToken}`;
const POLL_TIMEOUT = 25;

let _offset   = 0;
let _running  = false;
let _benchmarkRunning = false;

// ── Per-chat conversation history (max 10 turns, TTL 30 min) ─────────────────
const _chatHistory = new Map();
const HISTORY_MAX_TURNS = 10;
const HISTORY_TTL_MS    = 30 * 60_000;

function historyGet(chatId) {
  const entries = _chatHistory.get(chatId) || [];
  const cutoff  = Date.now() - HISTORY_TTL_MS;
  const fresh   = entries.filter(e => e.ts > cutoff);
  if (fresh.length !== entries.length) _chatHistory.set(chatId, fresh);
  return fresh.map(e => ({ role: e.role, content: e.content }));
}

function historyPush(chatId, role, content) {
  const entries = _chatHistory.get(chatId) || [];
  entries.push({ role, content, ts: Date.now() });
  if (entries.length > HISTORY_MAX_TURNS * 2) entries.splice(0, 2);
  _chatHistory.set(chatId, entries);
}

// ── Per-chat wizard state (multi-step input) ──────────────────────────────────
const _wizard = new Map(); // chatId → { step, data }
const _wizardCooldown = new Set(); // chatId yang baru selesai wizard, skip 1 pesan berikutnya
function wizardGet(chatId) { return _wizard.get(chatId) || null; }
function wizardSet(chatId, state) { _wizard.set(chatId, state); }
function wizardClear(chatId) {
  _wizard.delete(chatId);
  // Set cooldown — skip next free-text message (prevent "udah?" going to AI)
  _wizardCooldown.add(chatId);
  setTimeout(() => _wizardCooldown.delete(chatId), 3000);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function isAdmin(chatId) {
  if (config.telegramAdminIds.length === 0) return false;
  return config.telegramAdminIds.includes(chatId);
}

// ── Telegram API helpers ──────────────────────────────────────────────────────
async function tgGet(method, params = {}) {
  const res = await axios.get(`${BASE}/${method}`, { params, timeout: 35000 });
  return res.data;
}

async function send(chatId, text, extra = {}) {
  try {
    await axios.post(`${BASE}/sendMessage`, {
      chat_id:    chatId,
      text:       String(text).slice(0, 4096),
      parse_mode: "HTML",
      ...extra,
    }, { timeout: 10000 });
  } catch (err) {
    logger.warn("telegram send failed", { chatId, error: err.message });
  }
}

async function sendPhoto(chatId, buf, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", buf, { filename: "qr.png", contentType: "image/png" });
  if (caption) {
    form.append("caption", String(caption).slice(0, 1024));
    form.append("parse_mode", "HTML");
  }
  await axios.post(`${BASE}/sendPhoto`, form, { headers: form.getHeaders(), timeout: 15_000 });
}

async function sendCode(chatId, code) {
  await send(chatId, `<pre>${escHtml(String(code).slice(0, 3800))}</pre>`);
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmt(rows, fields) {
  if (!rows.length) return "<i>Kosong</i>";
  return rows.map((r, i) =>
    `<b>${i + 1}.</b> ` + fields.map(f => `${f}: <code>${escHtml(String(r[f] ?? "—"))}</code>`).join(" | ")
  ).join("\n");
}

// ── /help ─────────────────────────────────────────────────────────────────────
async function cmdHelp(chatId) {
  // Get pending count
  let pendingCount = 0;
  try {
    const rows = await svc.listPending({ limit: 1 });
    // Count is approximate, just show if > 0
    const { pool } = require("../db");
    const { rows: cnt } = await pool.query("SELECT COUNT(*) as c FROM chat_history WHERE requires_approval=TRUE AND approved IS NULL");
    pendingCount = parseInt(cnt[0]?.c) || 0;
  } catch (_) {}

  const pendingMsg = pendingCount > 0 ? `\n📬 <b>${pendingCount} pesan pending approval!</b> Ketik /pending` : '';

  await send(chatId,
    `<b>NgomeAI Admin Bot</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +

    `<b>🤖 Test AI</b>\n` +
    `/test &lt;pesan&gt; — test AI dengan history\n` +
    `/testjson &lt;pesan&gt; — raw JSON output AI\n` +
    `/clear — reset history percakapan\n\n` +

    `<b>👥 Client</b>\n` +
    `/clients — list semua client + status\n` +
    `/client_add — wizard tambah client baru\n` +
    `/client_toggle &lt;id&gt; — aktif / nonaktif\n` +
    `/client_del &lt;id&gt; — hapus client\n` +
    `/mode &lt;id&gt; [on|off] — toggle reply/listen mode\n` +
    `/listen &lt;id&gt; [personal|group] [on|off] — mode per channel\n` +
    `/block &lt;id&gt; &lt;nomor&gt; — blokir nomor\n` +
    `/unblock &lt;id&gt; &lt;nomor&gt; — unblokir nomor\n\n` +

    `<b>📝 Template & KB</b>\n` +
    `/templates &lt;client_id&gt; — list template\n` +
    `/tpl_add &lt;client_id&gt; — tambah template\n` +
    `/tpl_del &lt;id&gt; — hapus template\n` +
    `/kb &lt;client_id&gt; — list knowledge base\n` +
    `/kb_add &lt;client_id&gt; — tambah KB\n` +
    `/kb_del &lt;id&gt; — hapus KB\n\n` +

    `<b>📊 Laporan</b>\n` +
    `/history &lt;client_id&gt; — 10 chat terakhir\n` +
    `/pending [client_id] — pesan menunggu approval\n` +
    `/approve &lt;id&gt; — setujui + kirim ke WhatsApp\n` +
    `/reject &lt;id&gt; — tolak pesan\n` +
    `/stats — statistik hari ini semua client\n` +
    `/audit — log aktivitas admin\n\n` +

    `<b>📱 WhatsApp</b>\n` +
    `/wa — cek status koneksi WhatsApp aktif\n\n` +

    `<b>🛡 Anti-Spam</b>\n` +
    `/spam_check &lt;nomor&gt; — cek apakah nomor sedang di-block\n` +
    `/spam_unblock &lt;nomor&gt; — hapus temp-block antispam\n\n` +

    `<b>⚙️ Model AI</b>\n` +
    `/status — uptime + model aktif\n` +
    `/chain — model chain + score benchmark\n` +
    `/benchmark — jalankan benchmark manual\n\n` +

    `/ping — cek koneksi bot\n` +
    `/help — tampilkan menu ini`
  );
}

// ── /ping, /status, /chain, /models, /benchmark ───────────────────────────────
async function cmdPing(chatId) { await send(chatId, "Pong ✅"); }

async function cmdStatus(chatId) {
  const chain = getModelChain();
  const last  = readLastResult();
  const upMin = Math.round(process.uptime() / 60);
  let msg = `<b>Status NgomeAI</b>\n⏱ Uptime: ${upMin} menit\n🧠 Primary: <code>${escHtml(chain[0] || "—")}</code>\n🔗 Chain: ${chain.length} model\n`;
  if (last) {
    const age = Math.round((Date.now() - new Date(last.updatedAt)) / 60000);
    msg += `📊 Benchmark: ${age} menit lalu (${last.totalTested} model)\n🏆 Top: <code>${escHtml(last.topResults?.[0]?.id || "—")}</code>`;
  }
  await send(chatId, msg);
}

async function cmdChain(chatId) {
  const chain = getModelChain();
  const last  = readLastResult();
  const scoreMap = {};
  (last?.topResults || []).forEach(r => { scoreMap[r.id] = r; });
  let msg = `<b>Model Chain (${chain.length}):</b>\n\n`;
  chain.forEach((id, i) => {
    const info  = scoreMap[id];
    const score = info ? ` | score:${info.score} ${info.latencyMs}ms` : "";
    msg += `${i === 0 ? "🥇" : `${i + 1}.`} <code>${escHtml(id)}</code>${score}\n`;
  });
  await send(chatId, msg);
}

async function cmdModels(chatId) {
  const chain = getModelChain();
  let msg = `<b>Model Chain (${chain.length}):</b>\n`;
  chain.forEach((m, i) => msg += `${i + 1}. <code>${escHtml(m)}</code>\n`);
  await send(chatId, msg);
}

async function cmdBenchmark(chatId) {
  if (_benchmarkRunning) return send(chatId, "⚠️ Benchmark sedang berjalan.");
  _benchmarkRunning = true;
  await send(chatId, "🔍 Benchmark dimulai...");
  try {
    const result = await runBenchmark();
    if (result) {
      invalidateCache();
      let msg = `✅ <b>Selesai!</b> ${result.totalTested} model, ${Math.round(result.durationMs / 1000)}s\n\n<b>Chain baru:</b>\n`;
      result.chain.forEach((id, i) => {
        const r = result.topResults.find(x => x.id === id);
        msg += `${i === 0 ? "🥇" : `${i + 1}.`} <code>${escHtml(id)}</code>${r ? ` score:${r.score}` : ""}\n`;
      });
      await send(chatId, msg);
    } else {
      await send(chatId, "⚠️ Tidak ada model yang lolos. Chain lama dipertahankan.");
    }
  } catch (err) {
    await send(chatId, `❌ Error: ${escHtml(err.message)}`);
  } finally { _benchmarkRunning = false; }
}

// ── AI Test ───────────────────────────────────────────────────────────────────
async function cmdTest(chatId, text, rawJson = false) {
  if (!text.trim()) return send(chatId, "Usage: /test &lt;pesan&gt;");
  await send(chatId, "⏳ Memanggil AI...");
  const history = historyGet(chatId);
  const t0 = Date.now();
  try {
    const decision = await askAI(text, null, history, {});
    const latency  = Date.now() - t0;
    historyPush(chatId, "user", text);
    historyPush(chatId, "assistant", decision.response);
    if (rawJson) {
      await sendCode(chatId, JSON.stringify(decision, null, 2));
      await send(chatId, `⏱ ${latency}ms | <code>${escHtml(getModelChain()[0])}</code>`);
    } else {
      let msg = `<b>🤖 AI:</b>\n${escHtml(decision.response)}\n\n`;
      msg += `<b>Intent:</b> <code>${escHtml(decision.intent)}</code> (${(decision.confidence * 100).toFixed(0)}%)\n`;
      if (decision.next_state) msg += `<b>State:</b> <code>${escHtml(decision.next_state)}</code>\n`;
      msg += `\n⏱ ${latency}ms | <code>${escHtml(getModelChain()[0])}</code>`;
      await send(chatId, msg);
    }
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

async function cmdClear(chatId) {
  _chatHistory.delete(chatId);
  await send(chatId, "🗑 History dihapus.");
}

// ── Clients ───────────────────────────────────────────────────────────────────
async function cmdClients(chatId) {
  try {
    const rows = await svc.listClients();
    if (!rows.length) return send(chatId, "<i>Belum ada client.</i>");
    let msg = `<b>Clients (${rows.length}):</b>\n\n`;
    rows.forEach(r => {
      const modeIcon = r.reply_mode === false ? "👂 Listen" : "💬 Reply";
      const blocked  = (r.blocked_phones || []).length;
      msg += `<b>${escHtml(r.id)}</b> — ${escHtml(r.nama)}\n`;
      msg += `  Provider: <code>${r.provider}</code> | ${r.aktif ? "✅" : "❌"} | ${modeIcon} | Limit: ${r.msg_limit}`;
      if (blocked) msg += ` | 🚫 ${blocked} no.`;
      msg += "\n";
      if (r.provider === "evolution" && r.evolution_instance)
        msg += `  Instance: <code>${escHtml(r.evolution_instance)}</code>\n`;
      if (r.provider === "baileys" && r.baileys_session)
        msg += `  Session: <code>${escHtml(r.baileys_session)}</code>\n`;
      msg += "\n";
    });
    await send(chatId, msg);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

async function cmdClientToggle(chatId, id) {
  if (!id) return send(chatId, "Usage: /client_toggle &lt;id&gt;");
  try {
    const rows = await svc.listClients();
    const c = rows.find(r => r.id === id);
    if (!c) return send(chatId, `❌ Client <code>${escHtml(id)}</code> tidak ditemukan.`);
    await svc.toggleClient({ id, aktif: !c.aktif });
    await send(chatId, `✅ Client <code>${escHtml(id)}</code> → ${!c.aktif ? "✅ Aktif" : "❌ Nonaktif"}`);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

// ── /listen — per-channel listen mode ────────────────────────────────────────
// Usage: /listen <client_id> personal [on|off]
//        /listen <client_id> group [on|off]
//        /listen <client_id>  → tampilkan status
async function cmdListen(chatId, args) {
  const parts   = (args || "").trim().split(/\s+/);
  const id      = parts[0];
  const channel = parts[1]?.toLowerCase(); // "personal" | "group"
  const val     = parts[2]?.toLowerCase(); // "on" | "off"

  if (!id) return send(chatId,
    `Usage:\n` +
    `/listen &lt;id&gt; — lihat status\n` +
    `/listen &lt;id&gt; personal on|off\n` +
    `/listen &lt;id&gt; group on|off\n\n` +
    `Default: personal=off (AI balas), group=on (hanya simpan)`
  );

  try {
    const rows = await svc.listClients();
    const c = rows.find(r => r.id === id);
    if (!c) return send(chatId, `❌ Client <code>${escHtml(id)}</code> tidak ditemukan.`);

    if (!channel) {
      // Tampilkan status
      const pIcon = c.listen_personal ? "👂 Listen" : "💬 Reply";
      const gIcon = c.listen_group    ? "👂 Listen" : "💬 Reply";
      return send(chatId,
        `<b>Mode Channel — ${escHtml(c.id)}</b>\n\n` +
        `Personal Chat: ${pIcon}\n` +
        `Grup: ${gIcon}\n\n` +
        `<i>/listen ${escHtml(id)} personal on|off\n/listen ${escHtml(id)} group on|off</i>`
      );
    }

    if (channel !== "personal" && channel !== "group") {
      return send(chatId, "Channel harus: <code>personal</code> atau <code>group</code>");
    }

    const newVal = val === "on" ? true : val === "off" ? false
      : channel === "personal" ? !c.listen_personal : !c.listen_group;

    await svc.setListenMode({
      id,
      listenPersonal: channel === "personal" ? newVal : undefined,
      listenGroup:    channel === "group"    ? newVal : undefined,
    });
    invalidateClientCacheById(id);

    const icon = newVal ? "👂 Listen ON" : "💬 Reply ON";
    const desc = newVal
      ? `Pesan ${channel === "personal" ? "personal" : "grup"} hanya disimpan, tidak dibalas`
      : `AI akan membalas pesan ${channel === "personal" ? "personal" : "dari grup"}`;
    await send(chatId, `${icon} (${channel})\nClient: <code>${escHtml(id)}</code>\n${desc}`);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

async function cmdMode(chatId, args) {
  // /mode <client_id> [on|off|auto]
  const [id, mode] = args.split(" ");
  if (!id) return send(chatId, "Usage: /mode &lt;client_id&gt; [on|off|auto]\nTanpa on/off = toggle\nauto = AI moderation aktif (reply_mode=true)");
  try {
    const rows = await svc.listClients();
    const c = rows.find(r => r.id === id);
    if (!c) return send(chatId, `❌ Client <code>${escHtml(id)}</code> tidak ditemukan.`);
    // "auto" = reply mode ON (AI moderation handles the rest via orchestrator)
    const newMode = mode === "on" || mode === "auto" ? true : mode === "off" ? false : !c.reply_mode;
    await svc.setReplyMode({ id, replyMode: newMode });
    invalidateClientCacheById(id);
    const icon = newMode ? "💬 Reply Mode ON" : "👂 Listen Mode ON";
    const desc = newMode
      ? (mode === "auto"
          ? "AI moderation aktif — pesan sensitif/low-confidence masuk antrian approval"
          : "AI akan membalas pesan masuk")
      : "AI hanya menyimpan pesan, tidak membalas";
    await send(chatId, `${icon}\nClient: <code>${escHtml(id)}</code>\n${desc}`);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

async function cmdBlock(chatId, args) {
  // /block <client_id> <phone>
  const parts = args.split(" ");
  const id = parts[0], phone = parts[1];
  if (!id || !phone) return send(chatId, "Usage: /block &lt;client_id&gt; &lt;nomor&gt;\nContoh: /block wa 628111222333");
  const cleanPhone = phone.replace(/\D/g, "");
  if (!cleanPhone) return send(chatId, "❌ Nomor tidak valid");
  try {
    await svc.blockPhone({ id, phone: cleanPhone });
    invalidateClientCacheById(id);
    await send(chatId, `🚫 Nomor <code>${cleanPhone}</code> diblokir dari client <code>${escHtml(id)}</code>\nPesan dari nomor ini tidak akan diproses.`);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

async function cmdUnblock(chatId, args) {
  const parts = args.split(" ");
  const id = parts[0], phone = parts[1];
  if (!id || !phone) return send(chatId, "Usage: /unblock &lt;client_id&gt; &lt;nomor&gt;");
  const cleanPhone = phone.replace(/\D/g, "");
  try {
    await svc.unblockPhone({ id, phone: cleanPhone });
    invalidateClientCacheById(id);
    await send(chatId, `✅ Nomor <code>${cleanPhone}</code> diunblokir dari client <code>${escHtml(id)}</code>`);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

async function cmdClientDel(chatId, id) {
  if (!id) return send(chatId, "Usage: /client_del &lt;id&gt;");
  try {
    await svc.deleteClient(id);
    await send(chatId, `✅ Client <code>${escHtml(id)}</code> dihapus.`);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

// ── Anti-spam commands ────────────────────────────────────────────────────────

/**
 * /spam_check <nomor> — cek apakah nomor sedang di-block antispam
 */
async function cmdSpamCheck(chatId, phone) {
  if (!phone) return send(chatId, "Usage: /spam_check &lt;nomor&gt;\nContoh: /spam_check 6281234567890");
  const clean = phone.replace(/\D/g, "");
  if (!clean) return send(chatId, "❌ Nomor tidak valid");
  try {
    const { isSpamBlocked } = require("../utils/antispam");
    const blocked = await isSpamBlocked(clean);
    await send(chatId,
      blocked
        ? `🚫 <code>${clean}</code> sedang dalam cooldown antispam (temp-block).\nGunakan /spam_unblock ${clean} untuk lepas manual.`
        : `✅ <code>${clean}</code> tidak dalam block antispam.`
    );
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

/**
 * /spam_unblock <nomor> — hapus temp-block antispam secara manual
 */
async function cmdSpamUnblock(chatId, phone) {
  if (!phone) return send(chatId, "Usage: /spam_unblock &lt;nomor&gt;");
  const clean = phone.replace(/\D/g, "");
  if (!clean) return send(chatId, "❌ Nomor tidak valid");
  try {
    const { clearSpamBlock } = require("../utils/antispam");
    await clearSpamBlock(clean);
    await send(chatId, `✅ Antispam block untuk <code>${clean}</code> dihapus.`);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

// ── Templates ─────────────────────────────────────────────────────────────────
async function cmdTemplates(chatId, clientId) {
  if (!clientId) return send(chatId, "Usage: /templates &lt;client_id&gt;");
  try {
    const rows = await svc.listTemplates(clientId);
    if (!rows.length) return send(chatId, `<i>Belum ada template untuk ${escHtml(clientId)}.</i>`);
    let msg = `<b>Templates ${escHtml(clientId)} (${rows.length}):</b>\n\n`;
    rows.slice(0, 15).forEach(r => {
      msg += `<b>#${r.id}</b> keywords: <code>${escHtml(r.keywords.slice(0, 50))}</code>\n`;
      msg += `  → ${escHtml(r.answer.slice(0, 80))}${r.answer.length > 80 ? "..." : ""}\n`;
    });
    await send(chatId, msg);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

async function cmdTplDel(chatId, id) {
  if (!id || isNaN(Number(id))) return send(chatId, "Usage: /tpl_del &lt;id&gt;");
  try {
    await svc.deleteTemplate(Number(id));
    await send(chatId, `✅ Template #${id} dihapus.`);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

// ── Knowledge Base ────────────────────────────────────────────────────────────
async function cmdKb(chatId, clientId) {
  if (!clientId) return send(chatId, "Usage: /kb &lt;client_id&gt;");
  try {
    const rows = await svc.listKb(clientId);
    if (!rows.length) return send(chatId, `<i>Belum ada KB untuk ${escHtml(clientId)}.</i>`);
    let msg = `<b>KB ${escHtml(clientId)} (${rows.length}):</b>\n\n`;
    rows.slice(0, 15).forEach(r => {
      msg += `<b>#${r.id}</b> keywords: <code>${escHtml(r.keywords.slice(0, 50))}</code>\n`;
      msg += `  → ${escHtml(r.content.slice(0, 80))}${r.content.length > 80 ? "..." : ""}\n`;
    });
    await send(chatId, msg);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

async function cmdKbDel(chatId, id) {
  if (!id || isNaN(Number(id))) return send(chatId, "Usage: /kb_del &lt;id&gt;");
  try {
    await svc.deleteKb(Number(id));
    await send(chatId, `✅ KB #${id} dihapus.`);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

// ── History & Stats ───────────────────────────────────────────────────────────
async function cmdHistory(chatId, clientId) {
  if (!clientId) return send(chatId, "Usage: /history &lt;client_id&gt;");
  try {
    const rows = await svc.listHistory({ klien_id: clientId, limit: 10 });
    if (!rows.length) return send(chatId, `<i>Belum ada history untuk ${escHtml(clientId)}.</i>`);
    let msg = `<b>History ${escHtml(clientId)} (10 terakhir):</b>\n\n`;
    rows.forEach(r => {
      msg += `👤 <code>${escHtml(r.user_phone)}</code>: ${escHtml(r.user_message.slice(0, 60))}\n`;
      msg += `🤖 ${escHtml(r.bot_answer.slice(0, 60))}${r.bot_answer.length > 60 ? "..." : ""}\n\n`;
    });
    await send(chatId, msg);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

async function cmdStats(chatId) {
  try {
    const s = await svc.statsSummary();
    await send(chatId,
      `<b>📊 Stats Hari Ini</b>\n\n` +
      `👥 Client aktif: <b>${s.total_clients}</b>\n` +
      `💬 Total pesan: <b>${s.today_messages}</b>\n` +
      `🤖 AI calls: <b>${s.today_ai_calls}</b>\n` +
      `📅 Pesan 7 hari: <b>${s.week_messages}</b>`
    );
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

async function cmdAudit(chatId) {
  try {
    const rows = await svc.listAuditLog({ limit: 10 });
    if (!rows.length) return send(chatId, "<i>Audit log kosong.</i>");
    let msg = `<b>Audit Log (10 terakhir):</b>\n\n`;
    rows.forEach(r => {
      const ts = new Date(r.created_at).toLocaleString("id-ID");
      msg += `<code>${ts}</code> <b>${escHtml(r.action)}</b> → ${escHtml(r.target_id || "—")}\n`;
    });
    await send(chatId, msg);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

// ── QR Code ───────────────────────────────────────────────────────────────────

async function cmdQr(chatId, identifier) {
  if (!identifier) return send(chatId, "Usage: /qr &lt;client_id&gt;\nContoh: /qr toko-abc");
  try {
    const rows = await svc.listClients();
    const c = rows.find(r => r.id === identifier);
    if (!c) return send(chatId, `❌ Client <code>${escHtml(identifier)}</code> tidak ditemukan.`);

    if (c.provider === "baileys") {
      const baileys = require("../providers/baileys");
      const session = c.baileys_session || c.id;
      // Start session if not already running
      await baileys.initSession(session).catch(() => {});
      // Wait up to 15 s for QR to appear
      await send(chatId, `⏳ Menghubungkan Baileys session <code>${escHtml(session)}</code>...`);
      let qr = null;
      for (let i = 0; i < 15; i++) {
        qr = baileys.getQR(session);
        if (qr) break;
        if (baileys.getStatus(session) === "connected") break;
        await new Promise(r => setTimeout(r, 1000));
      }
      if (baileys.getStatus(session) === "connected") {
        return send(chatId, `✅ <b>${escHtml(c.nama)}</b> (${escHtml(session)}) sudah terhubung ke WhatsApp.`);
      }
      if (!qr) return send(chatId, `❌ QR belum tersedia. Coba lagi dalam 10 detik.`);
      // Send QR as photo via Telegram sendPhoto
      const imgBuf = Buffer.from(qr.replace(/^data:image\/png;base64,/, ""), "base64");
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("photo", imgBuf, { filename: "qr.png", contentType: "image/png" });
      form.append("caption", `📱 Scan QR — ${c.nama}\nBuka WhatsApp → Perangkat Tertaut → Tautkan Perangkat`);
      await axios.post(`${BASE}/sendPhoto`, form, { headers: form.getHeaders(), timeout: 15000 }).catch(() => {});
      return;
    }

    if (c.provider === "evolution") {
      return send(chatId, `📱 Gunakan panel admin untuk scan QR Evolution API.\n\nAtau akses Evolution API dashboard di:\n<code>${c.evolution_url || "(evolution_url belum diset)"}</code>`);
    }

    return send(chatId, `ℹ️ Provider <code>${c.provider}</code> tidak memerlukan QR scan.`);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

async function cmdWa(chatId) {
  try {
    const rows = await svc.listClients();
    const active = rows.filter(r => r.aktif);
    if (!active.length) return send(chatId, "ℹ️ Belum ada client aktif.");
    let msg = `<b>📱 WhatsApp Clients Aktif (${active.length}):</b>\n\n`;
    active.forEach(r => {
      const prov = r.provider?.toUpperCase() || "—";
      const sess = r.provider === "baileys" ? (r.baileys_session || "—")
        : r.provider === "evolution" ? (r.evolution_instance || "—")
        : (r.phone_number_id || "—");
      const modeIcon = r.reply_mode === false ? "👂 Listen" : "💬 Reply";
      msg += `<b>${escHtml(r.id)}</b> — ${escHtml(r.nama)}\n`;
      msg += `  [${prov}] ${escHtml(sess)} | ${modeIcon}\n\n`;
    });
    await send(chatId, msg);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

// Dead placeholder to avoid reference errors from old /buildwa route
async function cmdBuildWa(chatId) {
  await send(chatId,
    `<b>📱 Tambah WhatsApp Baru</b>\n\n` +
    `Gunakan /client_add untuk mendaftarkan client baru.\n\n` +
    `Provider tersedia:\n` +
    `• <b>baileys</b> — in-process, multi-session\n` +
    `• <b>evolution</b> — Evolution API REST multi-instance\n` +
    `• <b>meta</b> — Meta Cloud API (official)`
  );
}

async function cmdBuildWaWaha(chatId) { return cmdBuildWa(chatId); }
async function cmdBuildWaGowa(chatId) { return cmdBuildWa(chatId); }
async function cmdSaveWa(chatId) {
  return send(chatId, "ℹ️ /savewa sudah tidak digunakan. Gunakan /client_add untuk mendaftarkan client baru.");
}


// ── Removed: cmdWahaStatus, cmdGowaStatus, cmdWahaStart, cmdSessionStatus, autoProvisionWaha ──

async function cmdWahaStatus(chatId) {
  return send(chatId, "ℹ️ WaHA sudah tidak digunakan. Gunakan /wa untuk lihat status koneksi.");
}

async function cmdGowaStatus(chatId) {
  return send(chatId, "ℹ️ GoWA sudah tidak digunakan. Gunakan /wa untuk lihat status koneksi.");
}

// ── /pending — list messages waiting approval ─────────────────────────────────
async function cmdPending(chatId, clientId) {
  try {
    const rows = await svc.listPending({ klien_id: clientId || null, limit: 10 });
    if (!rows.length) return send(chatId, `✅ Tidak ada pesan pending approval${clientId ? ` untuk <code>${escHtml(clientId)}</code>` : ""}.`);
    let msg = `<b>⏳ Pending Approval (${rows.length}):</b>\n\n`;
    rows.forEach(r => {
      const ts = new Date(r.created_at).toLocaleString("id-ID");
      msg += `<b>#${r.id}</b> [${escHtml(r.klien_id)}] <code>${escHtml(r.user_phone)}</code>\n`;
      msg += `👤 ${escHtml(String(r.user_message || "").slice(0, 80))}\n`;
      msg += `🤖 ${escHtml(String(r.ai_generated_reply || "—").slice(0, 80))}\n`;
      msg += `🕐 ${ts}\n`;
      msg += `/approve_${r.id} | /reject_${r.id}\n\n`;
    });
    await send(chatId, msg);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

async function cmdApprove(chatId, idStr) {
  const id = Number(idStr);
  if (!id || !Number.isInteger(id)) return send(chatId, "Usage: /approve &lt;chat_id&gt;");
  try {
    // Find which client owns this record
    const { pool } = require("../db");
    const { rows } = await pool.query(
      "SELECT id, klien_id, user_phone, ai_generated_reply FROM chat_history WHERE id=$1 AND requires_approval=TRUE AND approved IS NULL",
      [id]
    );
    if (!rows.length) return send(chatId, `❌ Record #${id} tidak ditemukan atau sudah diproses.`);
    const row = rows[0];

    // Approve via admin service (which also sends to WA)
    const clients = await svc.listClients();
    const client  = clients.find(c => c.id === row.klien_id);
    if (!client) return send(chatId, `❌ Client <code>${escHtml(row.klien_id)}</code> tidak ditemukan.`);

    await svc.approveHistory({ id, klien_id: row.klien_id });

    // Send to WhatsApp
    const { sendMessage } = require("../providers/sender");
    if (row.ai_generated_reply) {
      await sendMessage(client, row.user_phone, row.ai_generated_reply).catch(err =>
        logger.warn("telegram approve: send failed", { error: err.message })
      );
      await pool.query("UPDATE chat_history SET is_sent=TRUE WHERE id=$1", [id]);
    }

    await send(chatId, `✅ #${id} disetujui dan dikirim ke <code>${escHtml(row.user_phone)}</code>`);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

async function cmdReject(chatId, idStr) {
  const id = Number(idStr);
  if (!id || !Number.isInteger(id)) return send(chatId, "Usage: /reject &lt;chat_id&gt;");
  try {
    const { pool } = require("../db");
    const { rows } = await pool.query(
      "SELECT klien_id FROM chat_history WHERE id=$1 AND requires_approval=TRUE AND approved IS NULL",
      [id]
    );
    if (!rows.length) return send(chatId, `❌ Record #${id} tidak ditemukan atau sudah diproses.`);
    await svc.rejectHistory({ id, klien_id: rows[0].klien_id });
    await send(chatId, `🚫 #${id} ditolak.`);
  } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
}

async function cmdWahaStart(chatId) {
  return send(chatId, "ℹ️ WaHA sudah tidak digunakan. Gunakan provider Baileys atau Evolution API.");
}

async function cmdSessionStatus(chatId) {
  return send(chatId, "ℹ️ /session (WaHA) sudah tidak digunakan. Gunakan /wa untuk status koneksi.");
}

async function handleWizard(chatId, text) {
  const w = wizardGet(chatId);
  if (!w) return false;

  if (text === "/cancel") {
    wizardClear(chatId);
    await send(chatId, "❌ Dibatalkan.");
    return true;
  }

  // client_add wizard
  if (w.type === "client_add") {
    // Steps: meta  = id→nama→provider→phone_number_id→msg_limit
    //        others = id→nama→provider→msg_limit
    const prompts = {
      id:             "ID client (unik, contoh: toko-abc):",
      nama:           "Nama client:",
      provider:       "Provider:\n<b>baileys</b> — in-process multi-session\n<b>evolution</b> — Evolution API REST\n<b>meta</b> — Meta Cloud API",
      phone_number_id:"Phone Number ID (dari Meta Business):",
      msg_limit:      "Limit pesan AI per hari (contoh: 1000):",
    };

    w.data[w.step] = text.trim();
    if (w.step === "provider") w.data.provider = text.trim().toLowerCase();

    const prov = w.data.provider || "";
    function getSteps(p) {
      if (p === "meta") return ["id", "nama", "provider", "phone_number_id", "msg_limit"];
      return ["id", "nama", "provider", "msg_limit"];
    }
    const steps   = getSteps(prov);
    const nextIdx = steps.indexOf(w.step) + 1;

    if (nextIdx < steps.length) {
      w.step = steps[nextIdx];
      wizardSet(chatId, w);
      await send(chatId, prompts[w.step] + "\n<i>Ketik /cancel untuk batal</i>");
    } else {
      wizardClear(chatId);
      try {
        const phoneId = w.data.phone_number_id || w.data.id;
        await svc.createClient({
          id: w.data.id, nama: w.data.nama, provider: prov,
          phone_number_id: phoneId, meta_token: "",
          msg_limit: Number(w.data.msg_limit) || 1000,
        });
        await send(chatId, `✅ Client <code>${escHtml(w.data.id)}</code> dibuat!\nGunakan panel admin untuk konfigurasi lanjutan.`);
      } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
    }
    return true;
  }

  // tpl_add wizard
  if (w.type === "tpl_add") {
    if (w.step === "keywords") {
      w.data.keywords = text.trim();
      w.step = "answer";
      wizardSet(chatId, w);
      await send(chatId, "Isi jawaban template:\n<i>Ketik /cancel untuk batal</i>");
    } else {
      wizardClear(chatId);
      try {
        const r = await svc.createTemplate({ klien_id: w.data.clientId, keywords: w.data.keywords, answer: text.trim() });
        await send(chatId, `✅ Template #${r.id} ditambahkan ke <code>${escHtml(w.data.clientId)}</code>`);
      } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
    }
    return true;
  }

  // kb_add wizard
  if (w.type === "kb_add") {
    if (w.step === "keywords") {
      w.data.keywords = text.trim();
      w.step = "content";
      wizardSet(chatId, w);
      await send(chatId, "Isi konten KB:\n<i>Ketik /cancel untuk batal</i>");
    } else {
      wizardClear(chatId);
      try {
        const r = await svc.createKb({ klien_id: w.data.clientId, keywords: w.data.keywords, content: text.trim() });
        await send(chatId, `✅ KB #${r.id} ditambahkan ke <code>${escHtml(w.data.clientId)}</code>`);
      } catch (err) { await send(chatId, `❌ ${escHtml(err.message)}`); }
    }
    return true;
  }

  return false;
}

// ── Update dispatcher ─────────────────────────────────────────────────────────
async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text   = String(msg.text || "").trim();

  if (text === "/start" || text.startsWith("/start@")) return cmdStart(chatId);
  if (!isAdmin(chatId)) {
    return send(chatId, `⛔ Akses ditolak. Chat ID: <code>${chatId}</code>`);
  }

  // Wizard intercept
  if (await handleWizard(chatId, text)) return;

  const [cmd, ...args] = text.split(" ");
  const arg = args.join(" ").trim();
  const cmdClean = cmd.replace(/@\w+$/, "").toLowerCase();

  switch (cmdClean) {
    case "/help":           return cmdHelp(chatId);
    case "/ping":           return cmdPing(chatId);
    case "/status":         return cmdStatus(chatId);
    case "/chain":          return cmdChain(chatId);
    case "/models":         return cmdModels(chatId);
    case "/benchmark":      return cmdBenchmark(chatId);
    case "/clear":          return cmdClear(chatId);
    case "/test":           return cmdTest(chatId, arg, false);
    case "/testjson":       return cmdTest(chatId, arg, true);

    case "/clients":        return cmdClients(chatId);
    case "/client_toggle":  return cmdClientToggle(chatId, arg);
    case "/client_del":     return cmdClientDel(chatId, arg);
    case "/mode":           return cmdMode(chatId, arg);
    case "/listen":         return cmdListen(chatId, arg);
    case "/block":          return cmdBlock(chatId, arg);
    case "/unblock":        return cmdUnblock(chatId, arg);
    case "/spam_check":     return cmdSpamCheck(chatId, arg);
    case "/spam_unblock":   return cmdSpamUnblock(chatId, arg);
    case "/client_add": {
      wizardSet(chatId, { type: "client_add", step: "id", data: {} });
      return send(chatId, "➕ <b>Tambah Client</b>\n\nID client (unik, contoh: toko-abc):\n<i>Ketik /cancel untuk batal</i>");
    }

    case "/templates":      return cmdTemplates(chatId, arg);
    case "/tpl_del":        return cmdTplDel(chatId, arg);
    case "/tpl_add": {
      if (!arg) return send(chatId, "Usage: /tpl_add &lt;client_id&gt;");
      wizardSet(chatId, { type: "tpl_add", step: "keywords", data: { clientId: arg } });
      return send(chatId, `➕ <b>Tambah Template</b> → <code>${escHtml(arg)}</code>\n\nKeywords (pisah koma, contoh: harga,price):\n<i>Ketik /cancel untuk batal</i>`);
    }

    case "/kb":             return cmdKb(chatId, arg);
    case "/kb_del":         return cmdKbDel(chatId, arg);
    case "/kb_add": {
      if (!arg) return send(chatId, "Usage: /kb_add &lt;client_id&gt;");
      wizardSet(chatId, { type: "kb_add", step: "keywords", data: { clientId: arg } });
      return send(chatId, `➕ <b>Tambah KB</b> → <code>${escHtml(arg)}</code>\n\nKeywords:\n<i>Ketik /cancel untuk batal</i>`);
    }

    case "/history":        return cmdHistory(chatId, arg);
    case "/stats":          return cmdStats(chatId);
    case "/audit":          return cmdAudit(chatId);
    case "/pending":        return cmdPending(chatId, arg || null);
    case "/approve":        return cmdApprove(chatId, arg);
    case "/reject":         return cmdReject(chatId, arg);
    case "/qr":             return cmdQr(chatId, arg);
    case "/wa":             return cmdWa(chatId);
    case "/buildwa":        return cmdBuildWa(chatId);
    case "/savewa":         return cmdSaveWa(chatId);
    case "/session":        return cmdSessionStatus(chatId);
    case "/waha_start":     return cmdWahaStart(chatId);
    case "/waha_status":    return cmdWahaStatus(chatId);
    case "/gowa_status":    return cmdGowaStatus(chatId);

    default:
      // Dynamic shortcuts: /approve_123 and /reject_123
      if (cmdClean.startsWith("/approve_")) return cmdApprove(chatId, cmdClean.slice(9));
      if (cmdClean.startsWith("/reject_"))  return cmdReject(chatId, cmdClean.slice(8));

      if (!text.startsWith("/")) {
        if (_wizardCooldown.has(chatId)) return;
        return cmdTest(chatId, text, false);
      }
      await send(chatId, `Perintah tidak dikenal. Ketik /help.`);
  }
}

async function cmdStart(chatId) {
  await send(chatId,
    `<b>NgomeAI Admin Bot</b>\n\nChat ID: <code>${chatId}</code>\n\nKetik /help untuk semua perintah.`
  );
}

// ── Polling loop ──────────────────────────────────────────────────────────────
async function pollOnce() {
  try {
    const data = await tgGet("getUpdates", {
      offset: _offset, timeout: POLL_TIMEOUT,
      allowed_updates: JSON.stringify(["message"]),
    });
    if (!data.ok || !data.result?.length) return;
    for (const update of data.result) {
      _offset = update.update_id + 1;
      handleUpdate(update).catch(err =>
        logger.warn("telegram handleUpdate error", { error: err.message })
      );
    }
  } catch (err) {
    if (!err.message?.includes("ECONNRESET") && !err.message?.includes("timeout")) {
      logger.warn("telegram poll error", { error: err.message });
    }
  }
}

async function startPolling() {
  if (!config.telegramBotToken) {
    logger.info("telegram: no token configured, bot disabled");
    return;
  }
  try {
    const data = await tgGet("getUpdates", { offset: -1, timeout: 1 });
    if (data.result?.length) _offset = data.result[data.result.length - 1].update_id + 1;
  } catch (_) {}
  _running = true;
  logger.info("telegram: polling started");
  const loop = async () => {
    if (!_running) return;
    await pollOnce();
    setImmediate(loop);
  };
  loop();
}

function stopPolling() { _running = false; }

async function notifyNewClient({ id, nama, provider, msg_limit }) {
  if (!config.telegramBotToken || !config.telegramAdminIds?.length) return;
  const limit = (msg_limit >= 999999 || !msg_limit) ? "∞ (tidak terbatas)" : msg_limit;
  const msg = `🆕 <b>Klien Baru Terdaftar!</b>\n\n` +
    `Nama: <b>${escHtml(nama)}</b>\n` +
    `ID: <code>${escHtml(id)}</code>\n` +
    `Provider: <code>${escHtml(provider)}</code>\n` +
    `Limit: ${limit}\n\n` +
    `<i>Atur limit kapan saja via /mode atau admin panel.</i>`;
  for (const adminId of config.telegramAdminIds) {
    await send(adminId, msg).catch(() => {});
  }
}

module.exports = { startPolling, stopPolling, notifyNewClient };
