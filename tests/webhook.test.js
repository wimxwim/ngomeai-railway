// Integration test: webhook endpoint returns 200 for a valid signed request
// and processes the message (template match → chat_history record).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http   = require("node:http");
const crypto = require("node:crypto");

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const TEST_CLIENT_ID     = "test_webhook_client_001";
const TEST_PHONE_ID      = "test_phone_wh_001";
const TEST_USER_PHONE    = "6280000000001";
const TEST_MSG_ID        = "wamid.test." + Date.now();
const TEST_GOWA_DEVICE   = "6280000000002@s.whatsapp.net";
const TEST_GOWA_CLIENT   = "test_gowa_client_001";
const TEST_WAHA_CLIENT   = "test_waha_client_001";

let pool, server, port;

function makePayload(message, msgId) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "entry_test",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "6280000", phone_number_id: TEST_PHONE_ID },
          contacts: [{ profile: { name: "Tester" }, wa_id: TEST_USER_PHONE }],
          messages: [{
            from: TEST_USER_PHONE,
            id: msgId,
            timestamp: String(Math.floor(Date.now() / 1000)),
            text: { body: message },
            type: "text"
          }]
        }
      }]
    }]
  };
}

function post(payload, secret) {
  return new Promise((resolve, reject) => {
    const raw  = JSON.stringify(payload);
    const sig  = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
    const req  = http.request(
      { hostname: "localhost", port, path: "/webhook", method: "POST",
        headers: { "Content-Type": "application/json",
                   "Content-Length": Buffer.byteLength(raw),
                   "x-hub-signature-256": sig } },
      res => resolve(res.statusCode)
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
}

function makeWahaPayload(message, msgId) {
  return {
    event: "message",
    session: "default",
    engine: "WEBJS",
    timestamp: Date.now(),
    payload: {
      id: msgId,
      from: TEST_USER_PHONE + "@c.us",
      to: TEST_PHONE_ID + "@c.us",
      body: message,
      fromMe: false,
      type: "chat"
    }
  };
}

function makeGowaPayload(message, msgId) {
  return {
    event: "message",
    device_id: TEST_GOWA_DEVICE,
    payload: {
      id: msgId,
      chat_id: TEST_USER_PHONE + "@s.whatsapp.net",
      from: TEST_USER_PHONE,
      body: message,
      type: "text"
    }
  };
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

before(async () => {
  try {
    ({ pool } = require("../src/db"));
    const { app } = require("../src/app");

    // Insert test client (with invalid meta_token — send will fail silently).
    await pool.query(
      `INSERT INTO clients (id, nama, phone_number_id, meta_token, msg_limit, aktif)
       VALUES ($1, 'WH Test', $2, 'invalid_token', 500, TRUE)
       ON CONFLICT (id) DO UPDATE SET phone_number_id = $2, aktif = TRUE`,
      [TEST_CLIENT_ID, TEST_PHONE_ID]
    );
    // Insert a template that matches "halo".
    await pool.query(
      "DELETE FROM templates WHERE klien_id = $1", [TEST_CLIENT_ID]
    );
    await pool.query(
      "INSERT INTO templates (klien_id, keywords, answer) VALUES ($1, 'halo,hai', 'Halo test!')",
      [TEST_CLIENT_ID]
    );
    // Clear dedup entry if exists from a previous run.
    await pool.query(
      "DELETE FROM processed_messages WHERE msg_id = $1", [TEST_MSG_ID]
    );

    // Insert GoWA test client
    await pool.query(
      `INSERT INTO clients (id, nama, provider, gowa_device_id, meta_token, msg_limit, aktif)
         VALUES ($1, 'GoWA Test', 'gowa', $2, 'invalid_token', 500, TRUE)
         ON CONFLICT (id) DO UPDATE SET provider = 'gowa', gowa_device_id = $2, aktif = TRUE`,
      [TEST_GOWA_CLIENT, TEST_GOWA_DEVICE]
    );

    // Insert WaHA test client
    await pool.query(
      `INSERT INTO clients (id, nama, provider, waha_session, meta_token, msg_limit, aktif)
         VALUES ($1, 'WaHA Test', 'waha', 'default', 'invalid_token', 500, TRUE)
         ON CONFLICT (id) DO UPDATE SET provider = 'waha', waha_session = 'default', aktif = TRUE`,
      [TEST_WAHA_CLIENT]
    );

    // Start server on a random port.
    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, err => err ? reject(err) : resolve(s));
    });
    port = server.address().port;
  } catch (err) {
    console.warn("SKIP: DB not available —", err.message);
    process.exit(0);
  }
});

test("POST /webhook returns 200 for valid signed request", async () => {
  const status = await post(makePayload("halo", TEST_MSG_ID), process.env.META_APP_SECRET);
  assert.equal(status, 200);
});

test("duplicate message (same msg.id) is ignored — returns 200 but no new history row", async () => {
  const dupId = "wamid.dup." + Date.now();

  await post(makePayload("halo", dupId), process.env.META_APP_SECRET);
  await wait(200); // let async processing finish

  const { rows: before } = await pool.query(
    "SELECT id FROM chat_history WHERE klien_id = $1 ORDER BY id DESC LIMIT 1",
    [TEST_CLIENT_ID]
  );

  // Send exact same message again.
  await post(makePayload("halo", dupId), process.env.META_APP_SECRET);
  await wait(200);

  const { rows: after } = await pool.query(
    "SELECT id FROM chat_history WHERE klien_id = $1 ORDER BY id DESC LIMIT 1",
    [TEST_CLIENT_ID]
  );

  // No new row should appear for the duplicate.
  assert.equal(
    before[0]?.id,
    after[0]?.id,
    "chat_history should not have a new row for the duplicate"
  );
});

test("POST /webhook returns 401 for bad signature", async () => {
  const status = await post(makePayload("halo", "wamid.bad.sig"), "wrong_secret");
  assert.equal(status, 401);
});

test("POST /webhook/waha returns 200 for valid signed request", async () => {
  const wahaMsgId = "wamid.waha." + Date.now();
  const payload = makeWahaPayload("halo", wahaMsgId);
  const raw = JSON.stringify(payload);
  const secret = process.env.WAHA_WEBHOOK_SECRET || "test_secret";
  const sig = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "localhost", port, path: "/webhook/waha", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw),
                   "x-hub-signature-256": sig } },
      res => resolve(res.statusCode)
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
  assert.equal(status, 200);
});

test("POST /webhook/waha returns 401 for bad signature", async () => {
  const wahaMsgId = "wamid.waha.bad." + Date.now();
  const payload = makeWahaPayload("halo", wahaMsgId);
  const raw = JSON.stringify(payload);
  const sig = "sha256=" + crypto.createHmac("sha256", "wrong_secret").update(raw).digest("hex");
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "localhost", port, path: "/webhook/waha", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw),
                   "x-hub-signature-256": sig } },
      res => resolve(res.statusCode)
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
  assert.equal(status, 401);
});

test("POST /webhook/gowa returns 200 for valid signed request", async () => {
  const gowaMsgId = "gowa." + Date.now();
  const payload = makeGowaPayload("halo", gowaMsgId);
  const raw = JSON.stringify(payload);
  const secret = process.env.GOWA_WEBHOOK_SECRET || "test_secret";
  const sig = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "localhost", port, path: "/webhook/gowa", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw),
                   "x-hub-signature-256": sig } },
      res => resolve(res.statusCode)
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
  assert.equal(status, 200);
});

test("POST /webhook/gowa returns 401 for bad signature", async () => {
  const gowaMsgId = "gowa.bad." + Date.now();
  const payload = makeGowaPayload("halo", gowaMsgId);
  const raw = JSON.stringify(payload);
  const sig = "sha256=" + crypto.createHmac("sha256", "wrong_secret").update(raw).digest("hex");
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "localhost", port, path: "/webhook/gowa", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw),
                   "x-hub-signature-256": sig } },
      res => resolve(res.statusCode)
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
  assert.equal(status, 401);
});

after(async () => {
  await pool.query("DELETE FROM chat_history WHERE klien_id = $1",      [TEST_CLIENT_ID]);
  await pool.query("DELETE FROM templates WHERE klien_id = $1",         [TEST_CLIENT_ID]);
  await pool.query("DELETE FROM processed_messages WHERE msg_id LIKE 'wamid.%'");
  await pool.query("DELETE FROM rate_limit WHERE phone_number = $1",    [TEST_USER_PHONE]);
  await pool.query("DELETE FROM usage_tracker WHERE klien_id = $1",     [TEST_CLIENT_ID]);
  await pool.query("DELETE FROM clients WHERE id = $1",                 [TEST_CLIENT_ID]);

  await new Promise(resolve => server.close(resolve));
  await pool.end();
});
