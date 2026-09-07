-- ============================================================
-- Neon DDL — Faza 5 (motor de căutare)
-- 1) Index COVERING pentru suggest: (search_text text_pattern_ops)
--    INCLUDE (title, popularity) → index-only scans pe TOATE cele 16
--    partiții hash, fără heap fetch la autocompletare.
-- 2) ANALYZE content — statistici proaspete pentru planner după ingest.
-- 3) VACUUM (setează visibility map → obligatoriu pentru index-only scan).
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_content_suggest
  ON content (search_text text_pattern_ops)
  INCLUDE (title, popularity);
