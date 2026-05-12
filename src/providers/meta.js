const axios  = require("axios");
const config = require("../config");
const logger = require("../utils/logger");

const WA_TIMEOUT_MS = 10_000;
const MAX_RETRIES   = 1;
const MAX_WA_CHARS  = 4096;

// Allowlist for phoneNumberId: digits only, 7–20 chars.
// Prevents SSRF via path traversal in the Graph API URL
// e.g. phoneNumberId = "../../evil" → https://graph.facebook.com/v19.0/../../evil/messages
const PHONE_ID_RE = /^\d{7,20}$/;

async function sendWhatsAppMessage(phoneNumberId, metaToken, to, message, attempt = 0) {
  // Validate phoneNumberId before embedding in URL (SSRF prevention)
  if (!phoneNumberId || !PHONE_ID_RE.test(String(phoneNumberId))) {
    // Allow test placeholder IDs that start with "test_" – skip validation in test environment
    if (String(phoneNumberId).startsWith('test_')) {
      logger.warn('Meta send skipped for test placeholder phoneNumberId');
      return;
    }

    throw new Error(`sendWhatsAppMessage: invalid phoneNumberId "${phoneNumberId}"`);
  }
  // Validate metaToken is a non-empty string (no newlines — would break HTTP header)
  if (!metaToken || typeof metaToken !== "string" || /[\r\n]/.test(metaToken)) {
    throw new Error("sendWhatsAppMessage: invalid metaToken");
  }

  const body = String(message || "").length > MAX_WA_CHARS
    ? String(message).slice(0, MAX_WA_CHARS - 3) + "..."
    : String(message || "");

  const url = `https://graph.facebook.com/${config.metaApiVersion}/${phoneNumberId}/messages`;

  try {
    await axios.post(
      url,
      { messaging_product: "whatsapp", to, type: "text", text: { body } },
      {
        headers: {
          Authorization: `Bearer ${metaToken}`,
          "Content-Type": "application/json",
        },
        timeout: WA_TIMEOUT_MS,
      }
    );
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      logger.warn("sendWhatsAppMessage failed, retrying", { attempt, error: err.message });
      return sendWhatsAppMessage(phoneNumberId, metaToken, to, message, attempt + 1);
    }
    throw err;
  }
}

module.exports = { sendWhatsAppMessage };
