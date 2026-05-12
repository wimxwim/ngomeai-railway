-- Migration 004: Add GoWA (go-whatsapp-web-multidevice) provider support
-- Date: 2026-05-04
-- Description: Adds gowa_device_id column and extends provider constraint to include 'gowa'.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS gowa_device_id TEXT DEFAULT NULL;

-- Extend provider constraint to include 'gowa'
ALTER TABLE clients
  DROP CONSTRAINT IF EXISTS clients_provider_check;
ALTER TABLE clients
  ADD CONSTRAINT clients_provider_check
    CHECK (provider IN ('meta', 'baileys', 'gowa'));
