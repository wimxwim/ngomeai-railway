-- migration_012_add_waha_url.sql
-- Add waha_url column to clients table for multi-session WaHA support

ALTER TABLE clients ADD COLUMN IF NOT EXISTS waha_url TEXT DEFAULT NULL;

-- Update existing waha clients to use the default WaHA URL
UPDATE clients SET waha_url = 'http://localhost:3002' WHERE provider = 'waha' AND waha_url IS NULL;
