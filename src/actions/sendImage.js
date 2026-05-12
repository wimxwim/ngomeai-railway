/**
 * Action: send_image
 * Kirim gambar via URL ke user.
 *
 * Expected payload:
 *   - url / image_url / payload.url
 *   - caption (optional)
 *   - compress (optional, default false)
 *   - view_once (optional, default false)
 */
async function sendImage(client, userPhone, action) {
  const url = action.url || action.image_url || (action.payload && action.payload.url) || "";
  if (!url) {
    return false;
  }

  const { sendImage } = require("../providers/sender");
  await sendImage(client, userPhone, url, {
    caption:  action.caption  || (action.payload && action.payload.caption)  || undefined,
    compress: action.compress || false,
    viewOnce: action.view_once || false,
  });
  return true;
}

module.exports = sendImage;
