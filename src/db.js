const { Pool } = require("pg");
const config = require("./config");

const pool = new Pool({
  connectionString:        config.databaseUrl,
  max:                     30,
  min:                     5,
  idleTimeoutMillis:       30_000,
  connectionTimeoutMillis: 5_000,
  // statement_timeout: abort any single query that runs longer than 10 s.
  // Prevents slow/malicious queries from holding a connection indefinitely.
  statement_timeout:       10_000,
  ssl: config.dbSsl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" } : false,
});

pool.on("error", (err) => {
  const logger = require("./utils/logger");
  logger.error("Unexpected DB pool error", { error: err.message });
});

module.exports = { pool };
