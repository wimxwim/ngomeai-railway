-- NgomeAI Code Engine — PostgreSQL Schema
-- Provider support: meta | gowa | waha
-- Tidak ada Baileys.

CREATE TABLE IF NOT EXISTS clients (
  id              TEXT PRIMARY KEY,
  nama            TEXT NOT NULL,
  phone_number_id TEXT NOT NULL UNIQUE,
  meta_token      TEXT NOT NULL,
  paket           TEXT DEFAULT 'core',
  msg_limit       INTEGER DEFAULT 1000,
  aktif           BOOLEAN DEFAULT TRUE,
  provider        TEXT NOT NULL DEFAULT 'meta',   -- 'meta' | 'gowa' | 'waha' | 'evolution'
  system_prompt   TEXT DEFAULT NULL,              -- custom AI persona per client
  gowa_device_id  TEXT DEFAULT NULL,              -- only used when provider = 'gowa'
  waha_session    TEXT DEFAULT NULL,              -- only used when provider = 'waha'
  waha_url       TEXT DEFAULT NULL,              -- per-client WaHA instance URL (for multi-session)
  evolution_instance TEXT DEFAULT NULL,            -- only used when provider = 'evolution'
  evolution_url     TEXT DEFAULT NULL,            -- Evolution API URL
  reply_mode      BOOLEAN DEFAULT TRUE,           -- TRUE=Reply, FALSE=Listen (save only, no send)
  blocked_phones  TEXT[]  DEFAULT '{}',           -- HardBlock: skip all processing for these numbers
  CONSTRAINT clients_provider_check CHECK (provider IN ('meta', 'gowa', 'waha', 'evolution')),
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS templates (
  id         SERIAL PRIMARY KEY,
  klien_id   TEXT REFERENCES clients(id) ON DELETE CASCADE,
  keywords   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_templates_klien_id ON templates(klien_id);

CREATE TABLE IF NOT EXISTS knowledge_base (
  id         SERIAL PRIMARY KEY,
  klien_id   TEXT REFERENCES clients(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  keywords   TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_base_klien_id ON knowledge_base(klien_id);

CREATE TABLE IF NOT EXISTS chat_history (
  id                  SERIAL PRIMARY KEY,
  klien_id            TEXT REFERENCES clients(id) ON DELETE CASCADE,
  user_phone          TEXT NOT NULL,
  user_message        TEXT NOT NULL,
  bot_answer          TEXT NOT NULL,
  used_ai             BOOLEAN DEFAULT FALSE,
  ai_generated_reply  TEXT    DEFAULT NULL,   -- AI reply text (always saved, even in Listen mode)
  is_sent             BOOLEAN DEFAULT TRUE,   -- TRUE=sent to WA (Reply), FALSE=not sent (Listen)
  created_at          TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_history_klien_id_created_at ON chat_history(klien_id, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_tracker (
  id             SERIAL PRIMARY KEY,
  klien_id       TEXT REFERENCES clients(id) ON DELETE CASCADE,
  date           DATE DEFAULT CURRENT_DATE,
  ai_calls       INTEGER DEFAULT 0,
  total_messages INTEGER DEFAULT 0,
  UNIQUE (klien_id, date)
);
CREATE INDEX IF NOT EXISTS idx_usage_tracker_klien_date ON usage_tracker(klien_id, date);

CREATE TABLE IF NOT EXISTS rate_limit (
  phone_number TEXT PRIMARY KEY,
  count        INTEGER DEFAULT 0,
  window_start TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processed_messages (
  msg_id       TEXT PRIMARY KEY,
  processed_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_processed_messages_at ON processed_messages(processed_at);

-- Admin audit log (non-blocking writes from app layer)
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT NOT NULL DEFAULT 'admin',
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT,
  payload     JSONB,
  ip          INET,
  created_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor      ON audit_log (actor);
CREATE INDEX IF NOT EXISTS idx_audit_log_action     ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_target     ON audit_log (target_type, target_id);

-- Conversation state (memory) — per (client, user)
CREATE TABLE IF NOT EXISTS conversations (
  klien_id      TEXT REFERENCES clients(id) ON DELETE CASCADE,
  user_phone    TEXT NOT NULL,
  current_state TEXT DEFAULT NULL,
  updated_at    TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (klien_id, user_phone)
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);
