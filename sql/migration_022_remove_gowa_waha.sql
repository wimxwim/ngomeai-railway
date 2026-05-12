-- migration_022_remove_gowa_waha.sql
-- Hapus provider GoWA dan WaHA dari constraint.
-- Kolom gowa_device_id, waha_session, waha_url, waha_webhook_secret
-- tetap ada di skema untuk preservasi data historis, namun constraint diperketat
-- sehingga klien baru tidak bisa dibuat dengan provider tersebut.

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_provider_check;

ALTER TABLE clients ADD CONSTRAINT clients_provider_check
  CHECK (provider IN ('meta', 'evolution', 'baileys'));

-- Tambah kolom business_type untuk context per klien (Fitur 3)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS
  business_type TEXT DEFAULT 'umum'
  CHECK (business_type IN ('umum', 'masjid', 'toko', 'sekolah', 'kesehatan', 'properti', 'kuliner', 'jasa'));

-- Tambah kolom sender_name ke chat_history untuk pushName (Fitur E)
ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS sender_name TEXT DEFAULT NULL;

-- Tambah kolom auto_generated ke knowledge_base untuk Auto KB (Fitur D)
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN DEFAULT FALSE;
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT TRUE;
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS generated_at TIMESTAMP DEFAULT NULL;

-- Index untuk query auto-generated KB
CREATE INDEX IF NOT EXISTS idx_kb_auto_generated ON knowledge_base(klien_id, auto_generated) WHERE auto_generated = TRUE;
CREATE INDEX IF NOT EXISTS idx_kb_pending_approval ON knowledge_base(klien_id, approved) WHERE auto_generated = TRUE AND approved = FALSE;
