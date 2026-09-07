-- ============================================================
-- Faza 4 — motor de căutare: L2 cache DISTRIBUIT în Neon
-- Toate instanțele aplicației partajează acest cache → hit-rate
-- crescut cross-instance, load origin redus la scale orizontal.
-- (L1 = memorie per-instanță, L2 = Neon shared, origin = FTS/trigram)
-- ============================================================

CREATE TABLE IF NOT EXISTS search_cache (
  key        TEXT PRIMARY KEY,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_search_cache_created ON search_cache (created_at);

-- comentariu
COMMENT ON TABLE search_cache IS 'L2 cache distribuit pentru rezultate de căutare (TTL aplicat la citire: created_at > now() - TTL)';
