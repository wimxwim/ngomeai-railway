const fs = require("fs");
const path = require("path");
const { pool } = require("../db");

async function initDb() {
  const schemaPath = path.resolve(__dirname, "../../sql/schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");

  try {
    await pool.query(schemaSql);
    console.log("Database schema initialized successfully.");
  } catch (error) {
    console.error("Failed to initialize database schema:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

initDb();
