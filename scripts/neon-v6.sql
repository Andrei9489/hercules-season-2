-- ============================================================
-- StreamVerse — Faza 7: AI Intelligence Suite
-- Tabele pentru cele 6 funcții AI cerute:
--   1. genres / content_genres — AI generează automat TOATE
--      genurile + categoriile din conținut (gen, an/deceniu,
--      studio, franciză, colecție, trilogie) și le leagă de conținut
--   2. ai_jobs — urmărire job-uri AI (metadate, genuri) cu progres real
--   3. ai_insights — AI analizează tot conținutul din platformă
--      și salvează snapshot-uri succesive (analiza se actualizează mereu)
-- Totul în Neon, zero local.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- TAXONOMIE AI (genuri + categorii derivate automat) ----------
CREATE TABLE IF NOT EXISTS genres (
  id            SERIAL PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'genre',
  -- genre | category | decade | studio | franchise | collection | trilogy | language
  source        TEXT NOT NULL DEFAULT 'ai',     -- ai | tmdb | m3u | itunes | radio | llm
  description   TEXT DEFAULT '',
  content_count INTEGER NOT NULL DEFAULT 0,     -- re-denumărat de AI după fiecare rulare
  poster        TEXT,                           -- poster reprezentativ (pt. meniuri)
  meta          JSONB NOT NULL DEFAULT '{}',    -- tmdb id, culoare, exemplu titluri etc.
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_genres_kind_count ON genres (kind, content_count DESC);
CREATE INDEX IF NOT EXISTS idx_genres_slug ON genres (slug);

-- ---------- LEGĂTURĂ CONȚINUT <-> TAXONOMIE (M:N) ----------
CREATE TABLE IF NOT EXISTS content_genres (
  content_id BIGINT NOT NULL,
  genre_id   INTEGER NOT NULL,
  score      REAL NOT NULL DEFAULT 1,             -- încredere AI (1 = sursă directă)
  source     TEXT NOT NULL DEFAULT 'ai',
  PRIMARY KEY (content_id, genre_id)
);

CREATE INDEX IF NOT EXISTS idx_cg_genre ON content_genres (genre_id, content_id);

-- ---------- JOB-URI AI (progres real, idempotente) ----------
CREATE TABLE IF NOT EXISTS ai_jobs (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,                      -- metadata | genres | analyzer
  status      TEXT NOT NULL DEFAULT 'running',    -- running | done | error
  processed   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  inserted    INTEGER NOT NULL DEFAULT 0,
  payload     JSONB NOT NULL DEFAULT '{}',        -- detaliie per rulare (surse, batch-uri LLM…)
  error       TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_jobs_kind ON ai_jobs (kind, started_at DESC);

-- ---------- INSIGHT-URI AI (snapshot-uri analiză, istoric) ----------
CREATE TABLE IF NOT EXISTS ai_insights (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'analyzer',
  snapshot   JSONB NOT NULL,                      -- numărători complete + rezumat AI
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_kind ON ai_insights (kind, created_at DESC);
