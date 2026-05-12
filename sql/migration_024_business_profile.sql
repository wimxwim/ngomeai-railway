-- migration_024_business_profile.sql
-- Tambah kolom business_profile ke tabel clients.
-- Kolom ini menyimpan profil bisnis lengkap (nama, alamat, jam buka, kontak, dll)
-- yang akan diinjeksikan ke system prompt AI saat menjawab percakapan.
-- Dipisah dari system_prompt agar profil bisa dikelola terpisah dari instruksi AI.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS
  business_profile TEXT DEFAULT NULL;

-- Index parsial untuk klien yang punya profil (mempercepat query cache client)
CREATE INDEX IF NOT EXISTS idx_clients_has_profile
  ON clients(id) WHERE business_profile IS NOT NULL;
