-- Migration 010: add direction to chat_history
-- 'in'  = pesan masuk dari user ke bot
-- 'out' = pesan keluar dari bot/admin ke user
ALTER TABLE chat_history
  ADD COLUMN IF NOT EXISTS direction TEXT DEFAULT 'in'
  CHECK (direction IN ('in', 'out'));

-- Backfill: semua data lama = 'in'
UPDATE chat_history SET direction = 'in' WHERE direction IS NULL;
