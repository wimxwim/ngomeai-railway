const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1|localhost)/i;

function isSafeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    if (PRIVATE_IP_RE.test(u.hostname)) return false;
    return true;
  } catch (_) { return false; }
}

module.exports = { isSafeUrl };
