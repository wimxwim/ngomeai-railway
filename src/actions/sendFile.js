/**
 * Action: send_file
 * Kirim file via URL ke user.
 *
 * Expected payload:
 *   - url / file_url / payload.url
 *   - caption (optional)
 */
async function sendFile(client, userPhone, action) {
  const url = action.url || action.file_url || (action.payload && action.payload.url) || "";
  if (!url) {
    return false;
  }

  const { sendFile } = require("../providers/sender");
  await sendFile(client, userPhone, url, {
    caption: action.caption || (action.payload && action.payload.caption) || undefined,
  });
  return true;
}

module.exports = sendFile;
