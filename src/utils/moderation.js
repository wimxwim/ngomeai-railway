/**
 * moderation.js — AI content moderation (keyword-based, zero-latency)
 *
 * Returns:
 *   "HARD_BLOCK" — sexual content, private data, internal keywords → skip everything
 *   "LISTEN"     — risky/uncertain content → save only, no send, requires_approval
 *   "REPLY"      — safe → normal flow
 */

// HARD_BLOCK: explicit sexual, private data exfiltration, internal system keywords
const HARD_BLOCK_PATTERNS = [
  // Sexual / explicit
  /\b(porn|bokep|ngentot|memek|kontol|vagina|penis|sex|seks|bugil|telanjang|masturbasi|orgasm)\b/i,
  // Credential / data exfiltration attempts
  /\b(password|passwd|api.?key|secret.?key|token|bearer|private.?key|ssh.?key)\b/i,
  // Internal system probing
  /\b(database|db.?url|connection.?string|env.?file|\.env|config\.js|server.?ip|localhost|127\.0\.0\.1|192\.168)\b/i,
  // SQL injection patterns
  /('|--|;)\s*(drop|delete|truncate|insert|update|select)\s/i,
];

// LISTEN: risky but uncertain — competitor names, pricing disputes, legal threats
const LISTEN_PATTERNS = [
  /\b(kompetitor|pesaing|saingan|harga.?murah|lebih.?murah|tipu|penipuan|bohong|palsu|scam|fraud)\b/i,
  /\b(lapor|polisi|hukum|pengacara|gugat|somasi|viral|media.?sosial|screenshot)\b/i,
  /\b(refund|kembalikan.?uang|ganti.?rugi|komplain|keluhan.?keras)\b/i,
];

/**
 * @param {string} text
 * @returns {"HARD_BLOCK"|"LISTEN"|"REPLY"}
 */
function detectSensitiveContent(text) {
  const s = String(text || "").toLowerCase();
  if (!s.trim()) return "REPLY";

  for (const re of HARD_BLOCK_PATTERNS) {
    if (re.test(s)) return "HARD_BLOCK";
  }
  for (const re of LISTEN_PATTERNS) {
    if (re.test(s)) return "LISTEN";
  }
  return "REPLY";
}

module.exports = { detectSensitiveContent };
