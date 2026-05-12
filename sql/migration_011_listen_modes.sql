-- Migration 011: per-channel listen mode + group support
-- listen_personal: TRUE = listen only (no reply) for personal chat
-- listen_group:    TRUE = listen only (no reply) for group chat (default TRUE — groups never auto-reply)
-- is_group:        whether the message came from a group chat

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS listen_personal BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS listen_group    BOOLEAN DEFAULT TRUE;

ALTER TABLE chat_history
  ADD COLUMN IF NOT EXISTS is_group BOOLEAN DEFAULT FALSE;
