-- ============================================================
-- Faza 6 — rollup pre-agregat pentru sugestii (ranking scalabil
-- pe POPULARITATE la miliarde de rânduri).
--
-- Problema (Faza 5): ranking-ul pe popularitate la sugestii
-- (GROUP BY max(pop) ORDER BY) forțează agregare completă pe
-- toate cele 16 partiții — fără early termination. Am rămas la
-- ranking alfabetic cu Merge Append.
--
-- Soluția (Faza 6): tabelă rollup cu prefix_key = primele 1-3
-- caractere din search_text; fiecare bucket conține top-40
-- titluri sortate după (popularity DESC, views DESC, title).
-- Numărul de bucket-e este MĂRGINIT de alfabet (36 + 1296 +
-- 46656 ≈ 48K rânduri), NU de numărul de conținuturi — deci
-- lookup-ul PK rămâne sub-milisecundă și la 30 miliarde rânduri.
-- Refresh-ul e job de fundal (nu e pe calea cererii).
-- ============================================================

CREATE TABLE IF NOT EXISTS suggest_rollup (
  prefix_key   TEXT PRIMARY KEY,
  titles       JSONB NOT NULL DEFAULT '[]'::jsonb,
  item_count   INTEGER NOT NULL DEFAULT 0,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suggest_rollup_refreshed
  ON suggest_rollup (refreshed_at);

-- Recompute pentru TOATE bucket-ele de o anumită lungime.
-- Rulat de job de fundal / după ingest-uri mari.
CREATE OR REPLACE FUNCTION refresh_suggest_rollup(p_len INT)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  affected INT;
BEGIN
  IF p_len < 1 OR p_len > 3 THEN
    RAISE EXCEPTION 'lungime prefix suportată: 1..3, primit %', p_len;
  END IF;

  -- șterge bucket-ele vechi de această lungime
  DELETE FROM suggest_rollup WHERE length(prefix_key) = p_len;

  INSERT INTO suggest_rollup (prefix_key, titles, item_count, refreshed_at)
  SELECT bucket.prefix,
         COALESCE(
           jsonb_agg(title ORDER BY pop DESC, views DESC, title ASC)
             FILTER (WHERE rn <= 40),
           '[]'::jsonb
         ),
         count(*) FILTER (WHERE rn <= 40),
         now()
  FROM (
    SELECT substring(search_text, 1, p_len) AS prefix,
           title,
           popularity AS pop,
           views,
           row_number() OVER (
             PARTITION BY substring(search_text, 1, p_len)
             ORDER BY popularity DESC, views DESC, title ASC
           ) AS rn
    FROM content
    WHERE length(search_text) >= p_len
      AND title IS NOT NULL
      AND title <> ''
  ) bucket
  GROUP BY bucket.prefix
  HAVING length(bucket.prefix) = p_len;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
