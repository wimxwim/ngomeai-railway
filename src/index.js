console.log("=== STARTUP: Loading config and app ===");
const { app }    = require("./app");
console.log("=== STARTUP: App loaded ===");
const config     = require("./config");
console.log("=== STARTUP: Config loaded ===");
const { pool }   = require("./db");
console.log("=== STARTUP: DB pool created ===");
const logger     = require("./utils/logger");
console.log("=== STARTUP: Logger initialized ===");
const { runBenchmark }             = require("./workers/modelBenchmark");
const { invalidateCache }          = require("./ai/modelSelector");
const { startPolling, stopPolling } = require("./bots/telegram");
const { startHealthCheck, stopHealthCheck } = require("./workers/healthCheck");
const { startFollowUpScheduler, stopFollowUpScheduler } = require("./workers/followUp");
const { runCleanup, runStartupRecovery } = require("./workers/sessionCleanup");
const { startAllSessions: startBaileys }  = require("./providers/baileys");
const { refreshAllStats }                 = require("./workers/statsWorker");
const { runAutoKbGeneration }             = require("./workers/autoKbWorker");

// Default/placeholder secrets that should never be used in real environments
const INSECURE_DEFAULTS = ["change_me", "secret", "insecure", ""];

// ─── Global error handlers ─────────────────────────────────────────────────
// Catch unhandled promise rejections and uncaught exceptions so the process
// does not silently die without a log entry.

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception — shutting down", { error: err.message });
  process.exit(1);
});

// ─── Startup ───────────────────────────────────────────────────────────────

async function runMigrationsIfNeeded() {
  const fs = require("fs");
  const path = require("path");

  const sqlDir = path.resolve(__dirname, "../sql");
  const files = fs.readdirSync(sqlDir)
    .filter(f => f.startsWith("migration_") && f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const filePath = path.join(sqlDir, file);
    const sql = fs.readFileSync(filePath, "utf8");
    try {
      await pool.query(sql);
    } catch (error) {
      if (!error.message.includes("already exists")) {
        logger.warn(`Migration ${file} warning: ${error.message}`);
      }
    }
  }
}

async function start() {
  if (INSECURE_DEFAULTS.includes(config.metaAppSecret)) {
    logger.error(
      "STARTUP BLOCKED: META_APP_SECRET is still the default placeholder. " +
      "Set a real secret in .env before running in any environment."
    );
    process.exit(1);
  }

  if (!config.adminPassword || config.adminPassword.length < 8) {
    logger.error("STARTUP BLOCKED: ADMIN_PASSWORD must be at least 8 characters");
    process.exit(1);
  }
  if (!config.adminJwtSecret || config.adminJwtSecret.length < 32) {
    logger.error("STARTUP BLOCKED: ADMIN_JWT_SECRET must be at least 32 characters");
    process.exit(1);
  }

  try {
    await pool.query("SELECT 1");
    logger.info("Database connection verified");

    console.log("=== STARTUP: Running migrations ===");
    await runMigrationsIfNeeded();
    console.log("=== STARTUP: Migrations complete ===");

    const server = app.listen(config.port, () => {
      logger.info("Server started", { port: config.port, env: config.nodeEnv });
    });

    // ─── Baileys: auto-start sessions for all active baileys clients ──────────
    startBaileys().catch(err => logger.warn("Baileys auto-start error", { error: err.message }));

    // ─── Telegram admin bot ───────────────────────────────────────────────────
    startPolling();

    // ─── Health monitoring ──────────────────────────────────
    startHealthCheck();

    // ─── Follow-up scheduler ──────────────────────────────────
    startFollowUpScheduler();
    runStartupRecovery();
    const cleanupInterval = setInterval(runCleanup, 30 * 60 * 1000);

    // ─── Nightly model benchmark at 00:00 ────────────────────────────────────
    function msUntilMidnight() {
      const now      = new Date();
      const midnight = new Date(now);
      midnight.setHours(24, 0, 5, 0); // 00:00:05 next day (tiny offset avoids edge cases)
      return midnight - now;
    }

    async function runNightlyBenchmark() {
      try {
        logger.info("modelBenchmark: nightly run triggered");
        const result = await runBenchmark();
        if (result) {
          invalidateCache();
          logger.info("modelBenchmark: chain updated", { chain: result.chain });
        }
      } catch (err) {
        logger.error("modelBenchmark: nightly run error", { error: err.message });
      }
      // Reschedule for next midnight
      const delay = msUntilMidnight();
      logger.info("modelBenchmark: next run scheduled", { inMinutes: Math.round(delay / 60000) });
      setTimeout(runNightlyBenchmark, delay).unref();
    }

    const firstDelay = msUntilMidnight();
    logger.info("modelBenchmark: scheduler armed", { nextRunInMinutes: Math.round(firstDelay / 60000) });
    setTimeout(runNightlyBenchmark, firstDelay).unref();

    // ─── Stats worker: refresh at 00:00:05 and 12:00:05 ─────────────────────
    function msUntilNextStatsRefresh() {
      const now  = new Date();
      const midnight = new Date(now); midnight.setHours(24, 0, 5, 0);
      const noon     = new Date(now);
      if (now.getHours() < 12) {
        noon.setHours(12, 0, 5, 0);
      } else {
        noon.setDate(noon.getDate() + 1);
        noon.setHours(12, 0, 5, 0);
      }
      return Math.min(midnight - now, noon - now);
    }

    async function runScheduledTasks() {
      try {
        logger.info("scheduledTasks: stats refresh triggered");
        await refreshAllStats();
      } catch (err) {
        logger.error("scheduledTasks: error", { error: err.message });
      }
      const delay = msUntilNextStatsRefresh();
      logger.info("scheduledTasks: next run scheduled", { inMinutes: Math.round(delay / 60000) });
      setTimeout(runScheduledTasks, delay).unref();
    }

    // Warm-up 30 s after startup so DB is fully settled first
    setTimeout(() => runScheduledTasks().catch(() => {}), 30_000).unref();

    // ─── Auto KB: generate every 60 minutes ──────────────────────────────────
    const AUTO_KB_INTERVAL_MS = Number(process.env.AUTO_KB_INTERVAL_MINUTES || 60) * 60 * 1000;
    async function runAutoKb() {
      try {
        await runAutoKbGeneration();
      } catch (err) {
        logger.warn("autoKbWorker: scheduled run error", { error: err.message });
      }
    }
    // First run 2 minutes after startup (DB + sessions settled), then every AUTO_KB_INTERVAL_MS
    setTimeout(() => {
      runAutoKb();
      setInterval(runAutoKb, AUTO_KB_INTERVAL_MS).unref();
    }, 2 * 60_000).unref();
    logger.info("autoKbWorker: scheduler armed", { intervalMinutes: AUTO_KB_INTERVAL_MS / 60000 });

    // ─── Periodic cleanup: stale rows ─────────────────────────────────────────
    const cleanup = () => {
      pool.query("DELETE FROM rate_limit WHERE window_start < NOW() - INTERVAL '1 hour'")
        .catch(err => logger.warn("rate_limit cleanup error", { error: err.message }));
      pool.query("DELETE FROM processed_messages WHERE processed_at < NOW() - INTERVAL '24 hours'")
        .catch(err => logger.warn("processed_messages cleanup error", { error: err.message }));
    };

    // Daily cleanup: old chat_history (>90 hari) dan conversation state lama (>30 hari tidak aktif)
    const dailyCleanup = () => {
      pool.query("DELETE FROM chat_history WHERE created_at < NOW() - INTERVAL '90 days'")
        .catch(err => logger.warn("chat_history cleanup error", { error: err.message }));
      pool.query("DELETE FROM conversations WHERE updated_at < NOW() - INTERVAL '30 days'")
        .catch(err => logger.warn("conversations cleanup error", { error: err.message }));
    };

    cleanup();
    setInterval(cleanup, 3_600_000);
    dailyCleanup();
    setInterval(dailyCleanup, 24 * 3_600_000);

    // ─── Graceful shutdown ─────────────────────────────────────────────────
    const SHUTDOWN_TIMEOUT_MS = 10_000;

    const shutdown = (signal) => {
      logger.info(`${signal} received, shutting down`);
      stopPolling();
      stopHealthCheck();
      stopFollowUpScheduler();
      clearInterval(cleanupInterval);

      // Force-exit if graceful shutdown takes too long
      const forceExit = setTimeout(() => {
        logger.error("Graceful shutdown timed out — forcing exit");
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      forceExit.unref();

      server.close(async () => {
        try {
          await pool.end();
          logger.info("DB pool closed");
        } catch (err) {
          logger.warn("DB pool close error", { error: err.message });
        }
        clearTimeout(forceExit);
        process.exit(0);
      });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT",  () => shutdown("SIGINT"));

  } catch (error) {
    logger.error("Failed to start server", { error: error.message });
    process.exit(1);
  }
}

start();
