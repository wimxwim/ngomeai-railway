-- migration_014_health_status.sql
-- Add health_status column to clients table for provider health tracking

ALTER TABLE clients ADD COLUMN IF NOT EXISTS health_status TEXT DEFAULT 'unknown';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_health_check TIMESTAMP DEFAULT NULL;

-- Add index for querying unhealthy clients
CREATE INDEX IF NOT EXISTS idx_clients_health_status ON clients(health_status);
