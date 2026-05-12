/**
 * Action: send_audio
 * Kirim audio via URL ke user.
 *
 * Expected payload:
 *   - url / audio_url / payload.url
 */
async function sendAudio(client, userPhone, action) {
  const url = action.url || action.audio_url || (action.payload && action.payload.url) || "";
  if (!url) {
    return false;
  }

  const { sendAudio } = require("../providers/sender");
  await sendAudio(client, userPhone, url);
  return true;
}

module.exports = sendAudio;
