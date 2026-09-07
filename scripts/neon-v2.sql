-- ============================================================
-- StreamVerse — Neon Schema v2
-- Motor de căutare + bibliotecă universală, proiectat pentru:
--   - 30 miliarde de conținuturi (partiționare HASH x16, extensibilă la x64/256)
--   - 10.000 căutări simultane (GIN + trigram + cache LRU + log asincron)
--   - 10 milioane utilizatori (pooling, citiri index-only, metrics)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- BIBLIOTECA UNIVERSALĂ (partiționată HASH pe id) ----------
CREATE TABLE IF NOT EXISTS content (
  id BIGSERIAL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  original_title TEXT,
  description TEXT DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'video',
  brand TEXT,
  category TEXT,
  continent TEXT,
  country TEXT,
  language TEXT DEFAULT 'en',
  provider TEXT NOT NULL DEFAULT 'unknown',
  source_type TEXT NOT NULL DEFAULT 'url',
  source_url TEXT,
  embed_code TEXT,
  thumbnail TEXT,
  backdrop TEXT,
  duration_seconds INTEGER,
  year INTEGER,
  rating REAL DEFAULT 0,
  popularity BIGINT DEFAULT 0,
  views BIGINT DEFAULT 0,
  tags TEXT[] DEFAULT '{}',
  meta JSONB DEFAULT '{}',
  search_text TEXT NOT NULL DEFAULT '',
  search_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
) PARTITION BY HASH (id);

CREATE TABLE IF NOT EXISTS content_p00 PARTITION OF content FOR VALUES WITH (MODULUS 16, REMAINDER 0);
CREATE TABLE IF NOT EXISTS content_p01 PARTITION OF content FOR VALUES WITH (MODULUS 16, REMAINDER 1);
CREATE TABLE IF NOT EXISTS content_p02 PARTITION OF content FOR VALUES WITH (MODULUS 16, REMAINDER 2);
CREATE TABLE IF NOT EXISTS content_p03 PARTITION OF content FOR VALUES WITH (MODULUS 16, REMAINDER 3);
CREATE TABLE IF NOT EXISTS content_p04 PARTITION OF content FOR VALUES WITH (MODULUS 16, REMAINDER 4);
CREATE TABLE IF NOT EXISTS content_p05 PARTITION OF content FOR VALUES WITH (MODULUS 16, REMAINDER 5);
CREATE TABLE IF NOT EXISTS content_p06 PARTITION OF content FOR VALUES WITH (MODULUS 16, REMAINDER 6);
CREATE TABLE IF NOT EXISTS content_p07 PARTITION OF content FOR VALUES WITH (MODULUS 16, REMAINDER 7);
CREATE TABLE IF NOT EXISTS content_p08 PARTITION OF content FOR VALUES WITH (MODULUS 16, REMAINDER 8);
CREATE TABLE IF NOT EXISTS content_p09 PARTITION OF content FOR VALUES WITH (MODULUS 16, REMAINDER 9);
CREATE TABLE IF NOT EXISTS content_p10 PARTITION OF content FOR VALUES WITH (MODULUS 16, REMAINDER 10);
CREATE TABLE IF NOT EXISTS content_p11 PARTITION OF content FOR VALUES WITH (MODULUS 16, REMAINDER 11);
CREATE TABLE IF NOT EXISTS content_p12 PARTITION OF content FOR VALUES WITH (MODULUS 16, REMAINDER 12);
CREATE TABLE IF NOT EXISTS content_p13 PARTITION OF content FOR VALUES WITH (MODULUS 16, REMAINDER 13);
CREATE TABLE IF NOT EXISTS content_p14 PARTITION OF content FOR VALUES WITH (MODULUS 16, REMAINDER 14);
CREATE TABLE IF NOT EXISTS content_p15 PARTITION OF content FOR VALUES WITH (MODULUS 16, REMAINDER 15);

CREATE INDEX IF NOT EXISTS idx_content_tsv ON content USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_content_trgm_title ON content USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_content_trgm_stext ON content USING GIN (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_content_stext_prefix ON content (search_text text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_content_external ON content (external_id);
CREATE INDEX IF NOT EXISTS idx_content_type ON content (content_type);
CREATE INDEX IF NOT EXISTS idx_content_brand ON content (brand);
CREATE INDEX IF NOT EXISTS idx_content_provider ON content (provider);
CREATE INDEX IF NOT EXISTS idx_content_pop ON content (popularity DESC);
CREATE INDEX IF NOT EXISTS idx_content_created ON content (created_at DESC);

-- ---------- JURNAL CĂUTĂRI (partiționat pe interval de timp) ----------
CREATE TABLE IF NOT EXISTS search_logs (
  id BIGSERIAL,
  query TEXT NOT NULL,
  norm TEXT NOT NULL,
  results_count INTEGER DEFAULT 0,
  library_hits INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  mode TEXT DEFAULT 'full',
  user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS search_logs_default PARTITION OF search_logs DEFAULT;
CREATE TABLE IF NOT EXISTS search_logs_2026a PARTITION OF search_logs FOR VALUES FROM ('2026-01-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS search_logs_2026b PARTITION OF search_logs FOR VALUES FROM ('2026-07-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS search_logs_2027a PARTITION OF search_logs FOR VALUES FROM ('2027-01-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS search_logs_2027b PARTITION OF search_logs FOR VALUES FROM ('2027-07-01') TO ('2028-01-01');

CREATE INDEX IF NOT EXISTS idx_search_logs_norm ON search_logs (norm);
CREATE INDEX IF NOT EXISTS idx_search_logs_created ON search_logs (created_at DESC);

-- ---------- STATISTICI CĂUTĂRI (trending rapid) ----------
CREATE TABLE IF NOT EXISTS search_stats (
  norm TEXT PRIMARY KEY,
  original TEXT NOT NULL,
  hits BIGINT DEFAULT 1,
  results_avg REAL DEFAULT 0,
  last_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_search_stats_hits ON search_stats (hits DESC);
CREATE INDEX IF NOT EXISTS idx_search_stats_norm_prefix ON search_stats (norm text_pattern_ops);

-- ---------- EVENIMENTE REDARE (partiționat HASH x4) ----------
CREATE TABLE IF NOT EXISTS playback_events (
  id BIGSERIAL,
  content_id BIGINT,
  provider TEXT,
  event TEXT NOT NULL,
  seconds INTEGER DEFAULT 0,
  user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
) PARTITION BY HASH (id);

CREATE TABLE IF NOT EXISTS playback_p00 PARTITION OF playback_events FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE IF NOT EXISTS playback_p01 PARTITION OF playback_events FOR VALUES WITH (MODULUS 4, REMAINDER 1);
CREATE TABLE IF NOT EXISTS playback_p02 PARTITION OF playback_events FOR VALUES WITH (MODULUS 4, REMAINDER 2);
CREATE TABLE IF NOT EXISTS playback_p03 PARTITION OF playback_events FOR VALUES WITH (MODULUS 4, REMAINDER 3);

CREATE INDEX IF NOT EXISTS idx_playback_content ON playback_events (content_id);
CREATE INDEX IF NOT EXISTS idx_playback_created ON playback_events (created_at DESC);

-- ---------- METRICI PLATFORMĂ ----------
CREATE TABLE IF NOT EXISTS platform_metrics (
  key TEXT PRIMARY KEY,
  value NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO platform_metrics (key, value) VALUES
  ('target_content_indexed', 30000000000),
  ('target_concurrent_searches', 10000),
  ('target_concurrent_users', 10000000),
  ('engine_phase', 1)
ON CONFLICT (key) DO NOTHING;

-- ---------- FUNCȚII SQL ----------
CREATE OR REPLACE FUNCTION upsert_search_stat(p_norm TEXT, p_orig TEXT, p_results REAL)
RETURNS void AS $$
  INSERT INTO search_stats (norm, original, hits, results_avg, last_at)
  VALUES (p_norm, p_orig, 1, p_results, now())
  ON CONFLICT (norm) DO UPDATE SET
    hits = search_stats.hits + 1,
    original = EXCLUDED.original,
    results_avg = (search_stats.results_avg * search_stats.hits + p_results) / (search_stats.hits + 1),
    last_at = now();
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION record_playback(p_content BIGINT, p_provider TEXT, p_event TEXT, p_seconds INTEGER, p_user TEXT)
RETURNS void AS $$
  INSERT INTO playback_events (content_id, provider, event, seconds, user_id)
  VALUES (p_content, p_provider, p_event, p_seconds, p_user);
  UPDATE content SET views = views + 1 WHERE id = p_content;
$$ LANGUAGE sql;
