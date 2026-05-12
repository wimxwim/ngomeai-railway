// Integration test: consumeUsageQuota must not exceed limit under concurrency.
// Requires a running PostgreSQL.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const TEST_CLIENT_ID = "test_quota_atomic_001";
const MSG_LIMIT      = 5;
const CONCURRENT     = 12;
const today          = new Date().toISOString().slice(0, 10);

let pool, consumeUsageQuota;

before(async () => {
  try {
    ({ pool } = require("../src/db"));
    ({ consumeUsageQuota } = require("../src/repositories/logic"));

    await pool.query(
      `INSERT INTO clients (id, nama, phone_number_id, meta_token, msg_limit, aktif)
       VALUES ($1, 'Test Quota', 'test_phone_quota_001', 'tok', $2, TRUE)
       ON CONFLICT (id) DO UPDATE SET msg_limit = $2`,
      [TEST_CLIENT_ID, MSG_LIMIT]
    );
    await pool.query(
      "DELETE FROM usage_tracker WHERE klien_id = $1 AND date = $2",
      [TEST_CLIENT_ID, today]
    );
  } catch (err) {
    console.warn("SKIP: DB not available —", err.message);
    process.exit(0);
  }
});

test(`${CONCURRENT} concurrent calls allow exactly ${MSG_LIMIT} (atomic)`, async () => {
  const results = await Promise.all(
    Array.from({ length: CONCURRENT }, () =>
      consumeUsageQuota(TEST_CLIENT_ID, MSG_LIMIT)
    )
  );

  const allowed = results.filter(Boolean).length;
  const blocked = results.filter(r => !r).length;

  assert.equal(allowed, MSG_LIMIT,            `Exactly ${MSG_LIMIT} should be allowed`);
  assert.equal(blocked, CONCURRENT - MSG_LIMIT, `Remaining ${CONCURRENT - MSG_LIMIT} should be blocked`);
});

after(async () => {
  await pool.query("DELETE FROM usage_tracker WHERE klien_id = $1", [TEST_CLIENT_ID]);
  await pool.query("DELETE FROM clients WHERE id = $1",            [TEST_CLIENT_ID]);
  await pool.end();
});
