-- migration_013_enable_pgtrgm.sql
-- Enable pg_trgm extension for trigram-based similarity search

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Add GIN index on templates.keywords for trigram search
CREATE INDEX IF NOT EXISTS idx_templates_keywords_gin ON templates USING gin (keywords gin_trgm_ops);

-- Add GIN index on knowledge_base.keywords for trigram search
CREATE INDEX IF NOT EXISTS idx_knowledge_base_keywords_gin ON knowledge_base USING gin (keywords gin_trgm_ops);
