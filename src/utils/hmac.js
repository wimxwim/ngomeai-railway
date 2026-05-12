/**
 * HMAC-SHA256 verification utility
 * Eliminates duplication across webhook verifiers
 */

const crypto = require('crypto');

const DEFAULT_BUF_SIZE = 256;

/**
 * Create Express middleware that verifies HMAC-SHA256 signature
 * 
 * @param {Function|string} getSecret - Secret getter (sync) or static secret
 * @param {string} label - Log label (e.g., '[Meta]', '[WaHA]')
 * @param {object} [options] - Options
 * @param {number} [options.bufferSize=256] - Buffer size for timingSafeEqual
 * @param {boolean} [options.rejectOnMissingSecret=true] - Reject if secret empty (vs skip)
 * @returns {Function} Express middleware (req, res, next)
 */
function createHmacVerifier(getSecret, label, options = {}) {
  const { bufferSize = DEFAULT_BUF_SIZE, rejectOnMissingSecret = true, rejectStatus = 401 } = options;

  return function verifyHmac(req, res, next) {
    const secret = typeof getSecret === 'function' ? getSecret() : getSecret;

    // Handle missing secret
    if (!secret) {
      if (rejectOnMissingSecret) {
        logger.warn(`${label} secret not configured — rejecting webhook`);
        return res.sendStatus(rejectStatus);
      }
      return next(); // dev mode: skip
    }

    const sig = req.get('x-hub-signature-256');
    if (!sig) {
      logger.warn(`${label} missing signature`);
      return res.sendStatus(401);
    }

    if (req.rawBody === undefined) {
      logger.warn(`${label} rawBody missing`);
      return res.sendStatus(401);
    }

    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(req.rawBody)
      .digest('hex');

    // Double verification: timingSafeEqual + string compare (prevents mismatch throw)
    const sigBuf = Buffer.alloc(bufferSize);
    const expBuf = Buffer.alloc(bufferSize);
    Buffer.from(sig).copy(sigBuf);
    Buffer.from(expected).copy(expBuf);

    if (!crypto.timingSafeEqual(sigBuf, expBuf) || sig !== expected) {
      logger.warn(`${label} signature invalid`);
      return res.sendStatus(401);
    }

    return next();
  };
}

/**
 * Verify HMAC-SHA256 signature (core function)
 * 
 * @param {string} secret - HMAC secret
 * @param {string} signature - Signature from header (format: "sha256=...")
 * @param {Buffer|string} body - Raw body to verify
 * @param {string} label - Log label
 * @param {object} [options]
 * @param {number} [options.bufferSize=256]
 * @returns {boolean} true if valid
 */
function verifyHmacSignature(secret, signature, body, label, options = {}) {
  const { bufferSize = DEFAULT_BUF_SIZE } = options;
  
  if (!secret || !signature || !body) {
    logger.warn(`${label} missing secret, signature, or body`);
    return false;
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  const sigBuf = Buffer.alloc(bufferSize);
  const expBuf = Buffer.alloc(bufferSize);
  Buffer.from(signature).copy(sigBuf);
  Buffer.from(expected).copy(expBuf);

  return crypto.timingSafeEqual(sigBuf, expBuf) && signature === expected;
}

module.exports = { createHmacVerifier, verifyHmacSignature };
