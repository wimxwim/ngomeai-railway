/**
 * Action: send_location
 * Kirim lokasi (latitude, longitude) ke user.
 *
 * Expected payload:
 *   - latitude / lat / payload.latitude
 *   - longitude / lng / payload.longitude
 */
async function sendLocation(client, userPhone, action) {
  const lat = Number(action.latitude  || action.lat || (action.payload && action.payload.latitude));
  const lng = Number(action.longitude || action.lng || (action.payload && action.payload.longitude));
  
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return false;
  }

  const { sendLocation } = require("../providers/sender");
  await sendLocation(client, userPhone, lat, lng);
  return true;
}

module.exports = sendLocation;
