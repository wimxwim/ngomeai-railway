-- Migration 009: approval workflow fields on chat_history
ALTER TABLE chat_history
  ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN   DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS approved          BOOLEAN   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS approved_at       TIMESTAMP DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_history_pending
  ON chat_history (klien_id, requires_approval, approved)
  WHERE requires_approval = TRUE AND approved IS NULL;
