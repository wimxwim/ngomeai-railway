/**
 * Action: send_text
 * Kirim pesan teks ke user via provider.
 *
 * Expected payload:
 *   - text / message / payload.text / payload.message
 *   - reply_message_id (optional)
 *   - mentions (optional, array of phone numbers)
 */
async function sendText(client, userPhone, action, sendOpts) {
  const text =
    (typeof action.text    === "string" && action.text)    ||
    (typeof action.message === "string" && action.message) ||
    (action.payload && typeof action.payload.text    === "string" && action.payload.text)    ||
    (action.payload && typeof action.payload.message === "string" && action.payload.message) ||
    "";

  if (!text.trim()) {
    return false;
  }

  const { sendMessage } = require("../providers/sender");
  await sendMessage(client, userPhone, text, {
    ...sendOpts,
    replyMessageId: action.reply_message_id || undefined,
    mentions:       Array.isArray(action.mentions) ? action.mentions : undefined,
  });
  return true;
}

module.exports = sendText;
