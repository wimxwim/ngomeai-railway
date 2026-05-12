-- Migration 003: Add audit_log table for admin action traceability.
-- Critical for SaaS with billing: every create/update/delete action is recorded.
-- Run: psql "$DATABASE_URL" -f sql/migration_003_audit_log.sql

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT NOT NULL DEFAULT 'admin',          -- who performed the action
  action      TEXT NOT NULL,                           -- e.g. 'clients.create', 'clients.delete'
  target_type TEXT NOT NULL,                           -- 'client', 'template', 'knowledge_base'
  target_id   TEXT,                                    -- id of affected record
  payload     JSONB,                                   -- sanitised request body (no secrets)
  ip          INET,
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor      ON audit_log (actor);
CREATE INDEX IF NOT EXISTS idx_audit_log_action     ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_target     ON audit_log (target_type, target_id);
