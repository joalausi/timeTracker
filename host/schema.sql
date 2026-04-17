PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ts_ms INTEGER NOT NULL,
  end_ts_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  url TEXT NOT NULL,
  hostname TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  rule TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_segments_start_ts ON segments(start_ts_ms);
CREATE INDEX IF NOT EXISTS idx_segments_category_start ON segments(category, start_ts_ms);
