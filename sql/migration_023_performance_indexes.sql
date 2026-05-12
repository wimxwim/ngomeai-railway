-- migration_023_performance_indexes.sql
-- Tambah index performa untuk query yang sering dipakai di admin dashboard.
-- Semua CREATE INDEX menggunakan IF NOT EXISTS agar aman dijalankan ulang.

-- Index untuk filter direction (in/out) + urut waktu — dipakai di history/stats
CREATE INDEX IF NOT EXISTS idx_chat_history_direction_created
  ON chat_history(direction, created_at DESC);

-- Index untuk filter per klien berdasarkan direction — dipakai filter "hanya outgoing"
CREATE INDEX IF NOT EXISTS idx_chat_history_klien_direction
  ON chat_history(klien_id, direction, created_at DESC);

-- Index untuk stats harian: total_messages per klien per tanggal
CREATE INDEX IF NOT EXISTS idx_usage_tracker_klien_date_desc
  ON usage_tracker(klien_id, date DESC);

-- Index untuk knowledge_base: search per klien yang aktif (approved=TRUE)
CREATE INDEX IF NOT EXISTS idx_kb_klien_approved
  ON knowledge_base(klien_id, approved) WHERE approved = TRUE;

-- Index untuk follow_ups yang belum terkirim
CREATE INDEX IF NOT EXISTS idx_follow_ups_pending
  ON follow_ups(scheduled_for ASC) WHERE sent = FALSE;
