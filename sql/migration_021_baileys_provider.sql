-- Migration 021: Add 'baileys' provider support
-- Date: 2026-05-11
-- Purpose: Add baileys_session column and update provider constraint

-- 1. Add baileys_session column
ALTER TABLE clients ADD COLUMN IF NOT EXISTS baileys_session VARCHAR(64);

-- 2. Update provider constraint to include 'baileys'
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_provider_check;
ALTER TABLE clients ADD CONSTRAINT clients_provider_check
  CHECK (provider IN ('meta', 'gowa', 'waha', 'evolution', 'baileys'));

-- 3. Add comment
COMMENT ON COLUMN clients.baileys_session IS 'Baileys session name (folder name in baileys_sessions/)';

-- 4. Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_clients_baileys_session ON clients(baileys_session) WHERE baileys_session IS NOT NULL;
