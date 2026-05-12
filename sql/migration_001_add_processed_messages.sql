-- Migration 001: Add processed_messages table for webhook deduplication.
-- Backward compatible: existing tables are untouched.
-- Run: psql "$DATABASE_URL" -f sql/migration_001_add_processed_messages.sql

CREATE TABLE IF NOT EXISTS processed_messages (
  msg_id       TEXT PRIMARY KEY,
  processed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_messages_at
  ON processed_messages (processed_at);
