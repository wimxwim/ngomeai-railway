/**
 * Action: send_typing
 * Tunjukkan/hilangkan typing indicator.
 *
 * Expected payload:
 *   - typing (boolean, default true)
 */
async function sendTyping(client, userPhone, action) {
  const typing = action.typing !== false;
  const { sendTyping } = require("../providers/sender");
  await sendTyping(client, userPhone, typing);
  return true; // typing selalu dianggap berhasil (non-fatal)
}

module.exports = sendTyping;
