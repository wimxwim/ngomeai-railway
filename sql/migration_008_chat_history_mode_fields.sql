-- Migration 008: add ai_generated_reply and is_sent to chat_history
-- ai_generated_reply: the AI-generated text (always saved, even in Listen mode)
-- is_sent: TRUE = reply was sent to WhatsApp (Reply mode), FALSE = not sent (Listen mode)

ALTER TABLE chat_history
  ADD COLUMN IF NOT EXISTS ai_generated_reply TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_sent            BOOLEAN DEFAULT TRUE;
