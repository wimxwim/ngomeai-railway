-- Migration 020: Add 'evolution' provider and fields
-- Date: 2026-05-08
-- Purpose: Sync DB with code (evolution_instance, evolution_url, provider constraint)

-- 1. Add 'evolution' to provider constraint
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_provider_check;
ALTER TABLE clients ADD CONSTRAINT clients_provider_check 
  CHECK (provider IN ('meta', 'gowa', 'waha', 'evolution'));

-- 2. Add evolution fields (nullable)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS evolution_instance VARCHAR(128);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS evolution_url VARCHAR(256);

-- 3. Add comments
COMMENT ON COLUMN clients.evolution_instance IS 'Evolution API instance name for evolution provider';
COMMENT ON COLUMN clients.evolution_url IS 'Evolution API base URL for evolution provider';
