-- Migration: Add per-client WAHA webhook secret
-- Allows each WAHA client to have a unique webhook secret instead of global config

ALTER TABLE clients ADD COLUMN IF NOT EXISTS waha_webhook_secret TEXT DEFAULT NULL;

-- Create index for faster lookup during webhook verification
CREATE INDEX IF NOT EXISTS idx_clients_waha_webhook_secret ON clients(waha_webhook_secret);
