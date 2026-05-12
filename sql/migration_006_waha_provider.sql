-- Migration 006: Hapus Baileys, tambah WaHA provider support
-- Run: psql "$DATABASE_URL" -f sql/migration_006_waha_provider.sql
--
-- Aman dijalankan berkali-kali (idempotent).
-- Jika ada client dengan provider='baileys', otomatis dimigrate ke 'gowa'.

-- 1. Tambah kolom gowa_device_id jika belum ada (dari migration 004)
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS gowa_device_id TEXT DEFAULT NULL;

-- 2. Tambah kolom waha_session
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS waha_session TEXT DEFAULT NULL;

-- 3. Migrate client baileys → gowa sebelum update constraint
UPDATE clients SET provider = 'gowa' WHERE provider = 'baileys';

-- 4. Update constraint provider: hapus baileys, tambah waha
ALTER TABLE clients
  DROP CONSTRAINT IF EXISTS clients_provider_check;

ALTER TABLE clients
  ADD CONSTRAINT clients_provider_check
    CHECK (provider IN ('meta', 'gowa', 'waha'));

-- 5. Hapus kolom baileys_session_id
ALTER TABLE clients
  DROP COLUMN IF EXISTS baileys_session_id;
