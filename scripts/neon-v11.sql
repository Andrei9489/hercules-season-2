-- ============================================================
-- FAZA 11 — COLECȚII PERSONALE + MENTENANȚĂ AUTOMATĂ
-- Rulare: bun run scripts/init-neon-v11.ts
-- 1) collections + collection_items (playlists utilizator)
-- 2) partiții search_logs pentru anii viitori (2028b–2031)
--    — platforma „nu picore niciodată” și când logs crește peste 2028
-- 3) indecși de acoperire pentru liste rapide
-- Toate statementele sunt idempotente (IF NOT EXISTS).
-- NU conține funcții plpgsql (split pe ';' e sigur).
-- ============================================================

-- ---------- 1) COLECȚII PERSONALE (playlists) ----------
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  poster_url TEXT,
  is_public BOOLEAN NOT NULL DEFAULT false,
  items_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- un utilizator nu poate avea 2 colecții cu același nume (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS collections_user_name_uniq
  ON collections (user_id, lower(name));

CREATE INDEX IF NOT EXISTS collections_user_updated_idx
  ON collections (user_id, updated_at DESC);

-- itemi colecție — legătură logică la content (tabel partiționat HASH):
-- fără FK fizic, integritatea se asigură în aplicație + LEFT JOIN la citire
CREATE TABLE IF NOT EXISTS collection_items (
  collection_id TEXT NOT NULL,
  content_id BIGINT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, content_id)
);

CREATE INDEX IF NOT EXISTS collection_items_content_idx
  ON collection_items (content_id);

CREATE INDEX IF NOT EXISTS collection_items_added_idx
  ON collection_items (collection_id, added_at DESC);

-- ---------- 2) PARTIȚII SEARCH_LOGS VIITOARE (2028b–2031) ----------
CREATE TABLE IF NOT EXISTS search_logs_2028b PARTITION OF search_logs FOR VALUES FROM ('2028-07-01') TO ('2029-01-01');
CREATE TABLE IF NOT EXISTS search_logs_2029a PARTITION OF search_logs FOR VALUES FROM ('2029-01-01') TO ('2029-07-01');
CREATE TABLE IF NOT EXISTS search_logs_2029b PARTITION OF search_logs FOR VALUES FROM ('2029-07-01') TO ('2030-01-01');
CREATE TABLE IF NOT EXISTS search_logs_2030a PARTITION OF search_logs FOR VALUES FROM ('2030-01-01') TO ('2030-07-01');
CREATE TABLE IF NOT EXISTS search_logs_2030b PARTITION OF search_logs FOR VALUES FROM ('2030-07-01') TO ('2031-01-01');
CREATE TABLE IF NOT EXISTS search_logs_2031a PARTITION OF search_logs FOR VALUES FROM ('2031-01-01') TO ('2031-07-01');
CREATE TABLE IF NOT EXISTS search_logs_2031b PARTITION OF search_logs FOR VALUES FROM ('2031-07-01') TO ('2032-01-01');

-- ---------- 3) HINTURI PERFORMANȚĂ ----------
-- istoricul „Continuă vizionarea” — acoperire pentru sortare pe updatedAt
CREATE INDEX IF NOT EXISTS "History_userId_progress_idx" ON "History" ("userId", "updatedAt" DESC) WHERE "progress" > 0;
