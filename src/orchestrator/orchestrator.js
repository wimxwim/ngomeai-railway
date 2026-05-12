/**
 * Orchestrator — single entry point untuk semua inbound message.
 *
 * Pipeline:
 *   1. Dedup (processed_messages)
 *   2. Rate limit
 *   3. Increment stats
 *   4. Mark read (GoWA/WaHA only, non-fatal)
 *   5. Non-text → proses caption jika ada, atau kirim pesan penolakan
 *   6. Teks → Template → KB → AI
 *   7. Kirim balasan via executeActions
 *   8. Simpan history + update conversation state
 */

const logger = require("../utils/logger");
const {
  sendMessage, sendImage, sendAudio, sendFile, sendLocation, sendTyping, markRead,
} = require("../providers/sender");
const { askAI } = require("../ai/ai");
const { detectSensitiveContent } = require("../utils/moderation");
const { getConversationState, setConversationState } = require("../repositories/conversationState");
const {
  isMessageProcessed,
  checkRateLimit,
  searchTemplate,
  searchKnowledgeBase,
  consumeUsageQuota,
  incrementTotalMessages,
  getRecentHistory,
  normalizePhone,
  acquireProcessingLock,
  releaseProcessingLock,
  saveChatAndSetState,
} = require("../repositories/logic");
const { createFollowUp } = require("../workers/followUp");
const { executeActions } = require("../actions/index.js");
const { executeSkill } = require("../skills/index.js");
const { checkInboundSpam } = require("../utils/antispam");
const { pool } = require("../db");

const MAX_INBOUND_CHARS = 2000;

// ─── Helpers ───────────────────────────────────────────────────────────────

// Normalisasi teks masuk: truncate + lowercase untuk matching
function normalizeInbound(text) {
  const s        = String(text || "");
  const truncated = s.length > MAX_INBOUND_CHARS ? s.slice(0, MAX_INBOUND_CHARS) : s;
  return { truncated: truncated, normalized: truncated.toLowerCase() };
}

// Pastikan decision object selalu punya shape yang benar
function coerceDecision(raw, fallbackText) {
  const base = {
    intent:     "unknown",
    confidence: 0,
    response:   String(fallbackText || "").trim() || "Maaf, saya belum bisa jawab saat ini.",
    actions:    [],
    next_state: "",
  };
  if (!raw || typeof raw !== "object") return base;

  const intent     = typeof raw.intent     === "string" ? raw.intent.slice(0, 64)      : base.intent;
  const response   = typeof raw.response   === "string" ? raw.response.slice(0, 4096)  : base.response;
  const next_state = typeof raw.next_state === "string" ? raw.next_state.slice(0, 128) : base.next_state;

  const cn         = Number(raw.confidence);
  const confidence = Number.isFinite(cn) ? Math.max(0, Math.min(1, cn)) : base.confidence;

  let actions = [];
  if (Array.isArray(raw.actions)) actions = raw.actions;
  else if (raw.actions && typeof raw.actions === "object") actions = [raw.actions];

  return {
    intent:     intent,
    confidence: confidence,
    response:   response,
    actions:    actions,
    next_state: next_state,
  };
}

// ─── processTextMessage ────────────────────────────────────────────────────

/**
 * Proses pesan teks: Template → KB → AI.
 * Dipisah agar bisa dipanggil dari handler teks maupun caption media.
 * senderName = WhatsApp pushName (optional, saved to chat_history.sender_name).
 */
async function processTextMessage(client, userPhone, truncated, normalized, msgId, rid, isGroup, replyTo, senderName) {
  const replyOpts = replyTo ? { chatId: replyTo } : {};

  // Jangan tampilkan "typing..." kalau channel ini dalam mode Listen
  const isListenMode = isGroup
    ? (client.listen_group    === true)
    : (client.listen_personal === true);

  if (!isListenMode) {
    await sendTyping(client, userPhone, true, replyOpts).catch(function() {});
  }

  const results = await Promise.allSettled([
    getConversationState(client.id, userPhone),
    getRecentHistory(client.id, userPhone, 5),
    searchTemplate(client.id, normalized),
    searchKnowledgeBase(client.id, normalized),
    consumeUsageQuota(client.id, client.msg_limit != null ? client.msg_limit : 1000),
  ]);

  const currentState = results[0].status === "fulfilled" ? results[0].value : null;
  const history     = results[1].status === "fulfilled" ? results[1].value : [];
  const template    = results[2].status === "fulfilled" ? results[2].value : null;
  const kbAnswer    = results[3].status === "fulfilled" ? results[3].value : null;
  const canUseAI    = results[4].status === "fulfilled" ? results[4].value : false;

  let usedAi    = false;
  let replyText = "";
  let decision  = null;

  if (template) {
    replyText = template;
    decision  = coerceDecision(
      { intent: "template", confidence: 1, response: replyText, actions: [], next_state: currentState || "" },
      replyText
    );
  } else if (kbAnswer) {
    replyText = kbAnswer;
    decision  = coerceDecision(
      { intent: "knowledge_base", confidence: 1, response: replyText, actions: [], next_state: currentState || "" },
      replyText
    );
  } else if (!canUseAI) {
    replyText = "Maaf, kuota AI hari ini sudah habis. Hubungi admin ya.";
    decision  = coerceDecision(
      { intent: "quota_exceeded", confidence: 1, response: replyText, actions: [], next_state: currentState || "" },
      replyText
    );
  } else {
    usedAi = true;
    const aiDecision = await askAI(
      truncated,
      client.system_prompt,
      history,
      {
        current_state:    currentState         || "",
        // Profil bisnis dan jenis usaha — diinjeksi ke system prompt AI
        business_profile: client.business_profile || null,
        business_type:    client.business_type    || "umum",
      }
    );
    decision  = coerceDecision(aiDecision, "Maaf, asisten sedang sibuk. Silakan hubungi admin kami.");
    replyText = decision.response;
  }

  // ── Check for skill matching intent ────────────────────────────────
  if (decision && decision.intent) {
    try {
      const skillResult = await executeSkill(decision.intent, {
        client,
        userPhone,
        message: truncated,
        decision,
        rid,
      });
      if (skillResult.success) {
        // Merge skill results into decision
        if (skillResult.actions && skillResult.actions.length > 0) {
          decision.actions = skillResult.actions;
        }
        if (skillResult.next_state) {
          decision.next_state = skillResult.next_state;
        }
        if (skillResult.response) {
          decision.response = skillResult.response;
          replyText = skillResult.response;
        }
        logger.info("Orchestrator: skill executed", { rid, intent: decision.intent });
      }
    } catch (skillErr) {
      logger.error("Orchestrator: skill execution failed", { rid, intent: decision.intent, error: skillErr.message });
    }
  }

  if (!isListenMode) {
    await sendTyping(client, userPhone, false, replyOpts).catch(function() {});
  }

  // ── Per-channel reply mode ────────────────────────────────────────────────
  // listen_personal=true  → Listen mode  = AI menyimpan ke DB tapi TIDAK kirim ke WA
  // listen_personal=false → Reply mode   = AI kirim ke WA + simpan ke DB
  // listen_group=true     → Listen mode  untuk grup (sama)
  // listen_group=false    → Reply mode   untuk grup
  // reply_mode=false      → semua tidak dibalas (kill-switch legacy)
  const listenOnlyPersonal = client.listen_personal === true;
  const listenOnlyGroup    = client.listen_group    === true;
  const manualListen       = client.reply_mode === false;

  // shouldReplyChannel: true = kirim ke WA, false = simpan saja (listen only)
  const shouldReplyChannel = isGroup ? !listenOnlyGroup : !listenOnlyPersonal;
  const modResult          = detectSensitiveContent(truncated);
  const lowConfidence      = usedAi && decision.confidence < 0.7;
  const needsApproval      = !isGroup && (lowConfidence || modResult === "LISTEN");
  const shouldSend         = !manualListen && shouldReplyChannel && !needsApproval;

  logger.debug("orchestrator decision", {
    rid, clientId: client.id, phone: userPhone, isGroup,
    listenOnlyPersonal, listenOnlyGroup, shouldReplyChannel, shouldSend, needsApproval,
  });

  const newState = (usedAi && decision && decision.next_state && shouldSend) ? decision.next_state : null;

  if (shouldSend) {
    // Save incoming message first
    await saveChatAndSetState(client.id, userPhone, truncated, replyText, usedAi, usedAi ? replyText : null, true, "in", null, null, isGroup, null, newState, senderName);

    // Execute actions — track if any error thrown (not the return value, which is false for fallback text)
    let sendError = false;
    try {
      await executeActions(client, userPhone, decision, rid, replyTo);
    } catch(err) {
      sendError = true;
      logger.error("executeActions failed", { error: err.message, rid });
    }

    // Save outgoing message (bot reply) unless a hard error occurred
    logger.info("Orchestrator: saving outgoing", { rid, sendError, hasResponse: !!decision.response });
    if (!sendError && decision.response) {
      await saveChatAndSetState(client.id, userPhone, "", decision.response, usedAi, usedAi ? decision.response : null, true, "out", null, null, isGroup, null, null, null)
        .catch(err => logger.warn("save outgoing message failed", { error: err.message, rid }));
      logger.info("Orchestrator: outgoing saved", { rid, phone: userPhone });
    }
  } else {
    await saveChatAndSetState(client.id, userPhone, truncated, replyText, usedAi, usedAi ? replyText : null, false, "in", null, null, isGroup, null, null, senderName);
    if (needsApproval) {
      // Normalize phone to match format saved by saveChatHistory()
      const normalizedPhone = normalizePhone(userPhone);
      // Set requires_approval on the row we just inserted
      await pool.query(
        "UPDATE chat_history SET requires_approval=TRUE WHERE id = (SELECT id FROM chat_history WHERE klien_id=$1 AND user_phone=$2 AND is_group=$3 AND created_at > NOW() - INTERVAL '10 seconds' ORDER BY id DESC LIMIT 1)",
        [client.id, normalizedPhone, isGroup]
      ).catch(err => logger.warn("set requires_approval failed", { error: err.message }));
    }
  }

  if (usedAi && decision && decision.next_state && shouldSend) {
    // Check if next_state includes a follow-up instruction
    const nextState = decision.next_state;
    const followUpMatch = nextState.match(/follow_up:(\d+)([mh])/i);
    if (followUpMatch) {
      const amount = parseInt(followUpMatch[1]);
      const unit = followUpMatch[2].toLowerCase();
      const delayMs = unit === "h" ? amount * 60 * 60 * 1000 : amount * 60 * 1000;
      const scheduledFor = new Date(Date.now() + delayMs);
      createFollowUp(client.id, userPhone, scheduledFor, decision.response)
        .catch(function(err) {
          logger.warn("createFollowUp failed", { error: err.message, rid });
        });
    }
    // setConversationState is now handled by saveChatAndSetState in the transaction above
  }
}

// ─── handleInboundMessage ─────────────────────────────────────────────────

/**
 * Entry point utama — dipanggil dari semua webhook handler.
 *
 * @param {object} params
 * @param {object} params.client         - Row dari tabel clients
 * @param {string} params.userPhone      - Nomor pengirim (digits only)
 * @param {string} params.userMessageRaw - Isi pesan teks (kosong jika non-text)
 * @param {string} params.msgId          - ID pesan unik (untuk dedup)
 * @param {string} params.rid            - Request ID untuk logging
 * @param {string} [params.messageType]  - "text" | "image" | "audio" | "video" | dll
 * @param {string} [params.mediaCaption] - Caption dari media (jika ada)
 */
async function handleInboundMessage(params) {
  const client         = params.client;
  const userPhone      = params.userPhone;
  const senderPhone    = params.senderPhone || params.userPhone;
  const replyTo        = params.replyTo     || null; // JID asli untuk kirim balik (@c.us atau @lid)
  const userMessageRaw = params.userMessageRaw;
  const msgId          = params.msgId;
  const rid            = params.rid;
  const messageType    = params.messageType  || "text";
  const mediaCaption   = params.mediaCaption || "";
  const mediaUrl       = params.mediaUrl     || null;
  const isGroup        = Boolean(params.isGroup);
  const senderName     = params.senderName   || null;

  if (!client || !client.id || !userPhone || !msgId) return;

  // ── 0. Redis mutex lock ────────────────────────────────────────────────
  const lockAcquired = await acquireProcessingLock(userPhone);
  if (!lockAcquired) {
    logger.debug("Redis lock: already processing", { phone: userPhone, rid });
    return;
  }

  try {
    // ── 1. Dedup ───────────────────────────────────────────────────────────
    if (await isMessageProcessed(msgId)) {
      logger.debug("Duplicate message ignored", { msgId: msgId, rid: rid });
      return;
    }

    // ── 2. Rate limit ──────────────────────────────────────────────────────
    if (await checkRateLimit(userPhone)) {
      logger.warn("Rate limit hit", { phone: userPhone, rid: rid });
      return;
    }

    // ── 2a. Anti-spam: flood + duplicate detection ─────────────────────────
    const spamReason = await checkInboundSpam(
      userPhone,
      client.id,
      userMessageRaw || mediaCaption || ""
    );
    if (spamReason !== null) {
      logger.warn("AntiSpam block", { phone: userPhone, clientId: client.id, reason: spamReason, rid });
      return;
    }

    // ── 2b. HardBlock — skip ALL: no read, no save, no process ───────────────
    const blockedPhones = Array.isArray(client.blocked_phones) ? client.blocked_phones : [];
    if (blockedPhones.includes(userPhone)) {
      logger.debug("HardBlock: phone ignored", { phone: userPhone, clientId: client.id });
      return;
    }

    // ── 2c. Moderation HARD_BLOCK — skip before any processing ───────────────
    const textToCheck = userMessageRaw || mediaCaption || "";
    if (textToCheck && detectSensitiveContent(textToCheck) === "HARD_BLOCK") {
      logger.warn("Moderation HARD_BLOCK", { phone: userPhone, clientId: client.id, rid });
      return;
    }

    // ── 3. Increment stats ─────────────────────────────────────────────────
    await incrementTotalMessages(client.id);

    // ── 4. Mark read (non-fatal) ───────────────────────────────────────────
    await markRead(client, msgId, userPhone).catch(function() {});

    // ── 5. Non-text message ────────────────────────────────────────────────
    if (messageType !== "text") {
      const captionText = String(mediaCaption || "").trim();
      if (captionText) {
        const norm = normalizeInbound(captionText);
        if (norm.truncated.trim()) {
          return await processTextMessage(
            client, userPhone, norm.truncated, norm.normalized, msgId, rid, isGroup, replyTo, senderName
          );
        }
      }
      // Simpan non-text tanpa balas
      await saveChatAndSetState(client.id, userPhone, `[${messageType}]`, "", false, null, false, "in", messageType, mediaUrl, isGroup, null, null, senderName);
      return;
    }

    // ── 6. Proses teks ─────────────────────────────────────────────────────
    const norm = normalizeInbound(userMessageRaw);
    if (!norm.truncated.trim()) return;

    await processTextMessage(client, userPhone, norm.truncated, norm.normalized, msgId, rid, isGroup, replyTo, senderName);

  } catch (error) {
    logger.error("Orchestrator error", { error: error.message, rid: rid });
    try {
      await sendMessage(
        client, userPhone, "Maaf kak, lagi gangguan sebentar. Silakan coba lagi ya."
      ).catch(function() {});
    } catch (_) { /* ignore */ }
  } finally {
    // ── Release Redis lock ─────────────────────────────────────
    await releaseProcessingLock(userPhone);
  }
}

module.exports = { handleInboundMessage: handleInboundMessage };
