// FIX BUG-06: Guard against accidental production run.
if (process.env.NODE_ENV === "production") {
  console.error("ERROR: seed-demo.js must not run in production. Aborting.");
  process.exit(1);
}

const { pool } = require("../db");

async function seedDemo() {
  const clientId     = process.env.DEMO_CLIENT_ID     || "klien_demo_01";
  const clientName   = process.env.DEMO_CLIENT_NAME   || "Demo Bisnis";
  const phoneNumberId = process.env.DEMO_PHONE_NUMBER_ID || "123456789012345";
  const metaToken    = process.env.DEMO_META_TOKEN    || "CHANGE_ME_META_TOKEN";

  try {
    // FIX BUG-06: DO NOTHING instead of DO UPDATE — never overwrite meta_token.
    await pool.query(
      `INSERT INTO clients (id, nama, phone_number_id, meta_token, paket, msg_limit, aktif, provider)
       VALUES ($1, $2, $3, $4, 'core', 1000, TRUE, 'meta')
       ON CONFLICT (id) DO NOTHING`,
      [clientId, clientName, phoneNumberId, metaToken]
    );

    // FIX BUG-05: Check existence before inserting to avoid duplicates
    // (templates has no unique constraint beyond SERIAL PK).
    const { rows: existing } = await pool.query(
      "SELECT 1 FROM templates WHERE klien_id = $1 LIMIT 1",
      [clientId]
    );

    if (!existing.length) {
      await pool.query(
        `INSERT INTO templates (klien_id, keywords, answer) VALUES
           ($1, 'halo,hai,hi,selamat', 'Halo! Ada yang bisa kami bantu?'),
           ($1, 'jam,buka,tutup', 'Kami buka setiap hari jam 08.00–21.00.')`,
        [clientId]
      );
    }

    const { rows: existingKb } = await pool.query(
      "SELECT 1 FROM knowledge_base WHERE klien_id = $1 LIMIT 1",
      [clientId]
    );

    if (!existingKb.length) {
      await pool.query(
        `INSERT INTO knowledge_base (klien_id, content, keywords) VALUES
           ($1, 'Kami melayani pengiriman area kota dengan estimasi 1–2 hari.',
               'pengiriman,ongkir,kirim,ekspedisi'),
           ($1, 'Pembayaran tersedia via transfer bank, QRIS, dan COD area tertentu.',
               'bayar,pembayaran,qris,cod,transfer')`,
        [clientId]
      );
    }

    console.log("Demo data seeded successfully. Client ID:", clientId);
  } catch (error) {
    console.error("Failed to seed demo data:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

seedDemo();
