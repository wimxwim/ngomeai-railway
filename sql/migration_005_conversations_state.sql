-- Migration 005: Add conversations table for stateful orchestrator.
-- Run: psql "$DATABASE_URL" -f sql/migration_005_conversations_state.sql

CREATE TABLE IF NOT EXISTS conversations (
  klien_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  user_phone TEXT NOT NULL,
  current_state TEXT DEFAULT NULL,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (klien_id, user_phone)
);

CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
  ON conversations(updated_at DESC);

