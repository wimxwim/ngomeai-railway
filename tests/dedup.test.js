// Integration test: message deduplication via processed_messages table.
// Requires a running PostgreSQL with migration_001 applied.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

let pool, isMessageProcessed;

before(async () => {
  try {
    ({ pool } = require("../src/db"));
    ({ isMessageProcessed } = require("../src/repositories/logic"));
    await pool.query("DELETE FROM processed_messages WHERE msg_id LIKE 'test_%'");
  } catch (err) {
    console.warn("SKIP: DB not available —", err.message);
    process.exit(0);
  }
});

test("new message ID is not a duplicate", async () => {
  const id = "test_new_" + Date.now();
  const result = await isMessageProcessed(id);
  assert.equal(result, false, "First occurrence should return false");
});

test("same message ID is detected as duplicate", async () => {
  const id = "test_dup_" + Date.now();
  const first  = await isMessageProcessed(id);
  const second = await isMessageProcessed(id);
  assert.equal(first,  false, "First call: not a duplicate");
  assert.equal(second, true,  "Second call: detected as duplicate");
});

test("null msgId is never treated as duplicate", async () => {
  const result = await isMessageProcessed(null);
  assert.equal(result, false);
});

after(async () => {
  await pool.query("DELETE FROM processed_messages WHERE msg_id LIKE 'test_%'");
  await pool.end();
});
