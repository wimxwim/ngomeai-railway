-- migration_015_follow_ups.sql
-- Follow-up scheduler table

CREATE TABLE IF NOT EXISTS follow_ups (
  id            SERIAL PRIMARY KEY,
  klien_id     TEXT REFERENCES clients(id) ON DELETE CASCADE,
  user_phone    TEXT NOT NULL,
  scheduled_for TIMESTAMP NOT NULL,
  message       TEXT NOT NULL,
  sent          BOOLEAN DEFAULT FALSE,
  sent_at       TIMESTAMP DEFAULT NULL,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_follow_ups_pending
  ON follow_ups(klien_id, scheduled_for)
  WHERE sent = FALSE;

CREATE INDEX IF NOT EXISTS idx_follow_ups_user
  ON follow_ups(user_phone, klien_id);
