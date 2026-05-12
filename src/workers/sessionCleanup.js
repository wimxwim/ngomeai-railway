const redisClient = require('../utils/redis');
const logger = require('../utils/logger');

/**
 * Startup recovery — no-op after WAHA removal.
 * Baileys sessions are recovered in-process by baileys.js.
 */
async function runStartupRecovery() {
  logger.info('SessionCleanup: Startup recovery skipped (Baileys handles in-process reconnect)');
}

/**
 * Periodic cleanup: remove stale Redis wizard keys (lastActivity > 30 min).
 */
async function runCleanup() {
  logger.debug('SessionCleanup: Starting wizard key cleanup');
  try {
    const keys = await redisClient.keys('wizard:*');
    for (const key of keys) {
      try {
        const data = await redisClient.get(key);
        if (!data) continue;
        const wizard = typeof data === 'string' ? JSON.parse(data) : data;
        const lastActivity = wizard.lastActivity || 0;
        if (Date.now() - lastActivity > 30 * 60 * 1000) {
          await redisClient.del(key);
          logger.debug(`SessionCleanup: Deleted stale wizard key: ${key}`);
        }
      } catch (err) {
        logger.error(`SessionCleanup: Error processing wizard key ${key}`, { error: err.message });
      }
    }
  } catch (err) {
    logger.warn('SessionCleanup: Redis unavailable for wizard cleanup', { error: err.message });
  }
}

module.exports = { runCleanup, runStartupRecovery };
