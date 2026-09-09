-- ============================================================
-- FAZA 18b — DDL RECOMANDĂRI v2 (idempotent)
-- ai_recommend_cache: L2 distribuit în Neon pentru recomandări —
-- partajat între TOATE instanțele clusterului (același model ca
-- search_cache din Faza 11).
--   cache_key  = rec:user:<userId>:<limit> | rec:global:<limit> | rec:seed:<id>:<limit>
--   payload    = JSONB { items, mode, computedAt, signals }
--   expires_at = TTL (120s personal / 300s global+seed)
-- Curățenie: cron intern (cleanup_recommend_cache, Faza 18).
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_recommend_cache (
  cache_key   TEXT PRIMARY KEY,
  payload     JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_recommend_cache_expires_idx
  ON ai_recommend_cache (expires_at);

-- jurnal minimal de calcul (observabilitate recomandări)
CREATE TABLE IF NOT EXISTS recommend_log (
  id          BIGSERIAL PRIMARY KEY,
  cache_key   TEXT NOT NULL,
  user_key    TEXT,
  mode        TEXT NOT NULL,
  items       INT NOT NULL,
  signals     JSONB,
  took_ms     INT NOT NULL,
  cached      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recommend_log_created_idx ON recommend_log (created_at DESC);
