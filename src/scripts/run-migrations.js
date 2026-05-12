const fs = require("fs");
const path = require("path");
const { pool } = require("../db");

async function runMigrations() {
  const sqlDir = path.resolve(__dirname, "../../sql");
  const files = fs.readdirSync(sqlDir)
    .filter(f => f.startsWith("migration_") && f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("No migration files found.");
    return;
  }

  for (const file of files) {
    const filePath = path.join(sqlDir, file);
    const sql = fs.readFileSync(filePath, "utf8");

    try {
      await pool.query(sql);
      console.log(`✓ ${file}`);
    } catch (error) {
      console.error(`✗ ${file}: ${error.message}`);
      process.exitCode = 1;
      await pool.end();
      process.exit(1);
    }
  }

  console.log("All migrations completed successfully.");
  await pool.end();
}

runMigrations();
