-- Migration 002: Add provider abstraction + system prompt per client
-- Date: 2026-05-04
-- Description: Adds provider selection (meta/baileys), custom system_prompt,
--              and baileys_session_id to the clients table.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS system_prompt TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS baileys_session_id TEXT DEFAULT NULL;

-- Constraint: provider must be one of the supported values
ALTER TABLE clients
  DROP CONSTRAINT IF EXISTS clients_provider_check;
ALTER TABLE clients
  ADD CONSTRAINT clients_provider_check CHECK (provider IN ('meta', 'baileys'));
