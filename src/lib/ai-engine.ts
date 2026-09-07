// ============================================================
// StreamVerse — Faza 7: AI ENGINE (server-only)
//  - runAnalyzer(): AI analizează TOT conținutul din platformă
//    (agregări SQL reale) și salvează snapshot în Neon (ai_insights)
//  - getRecommendations(): AI recomandări din SQL (overlap genuri +
//    popularitate + istoric personal)
//  - citiri taxonomie AI (genuri/categorii/studiouri/francize/…)
// Fără LLM aici — LLM-ul e în ai-jobs (clasificare) și rezumat.
// ============================================================
import { q, qRead, qOne } from "./pg";

export type AnalyzerSnapshot = {
  at: string;
  total: number;
  byType: { type: string; count: number }[];
  byContinent: { continent: string; count: number }[];
  byProvider: { provider: string; count: number }[];
  topCountries: { country: string; count: number }[];
  byDecade: { decade: string; count: number }[];
  topGenres: { name: string; count: number }[];
  totals: {
    views: number;
    avgRating: number;
    withYear: number;
    withoutYear: number;
    withDescription: number;
    withoutDescription: number;
    withGenres: number;
    withoutGenres: number;
    genresTotal: number;
    countries: number;
    providers: number;
    playEvents: number;
    searches24h: number;
    contentAdded24h: number;
    aiExtracted: number;
  };
  summary: string;
  summarySource: "llm" | "deterministic";
};

type Row = Record<string, unknown>;

/** Agregări reale peste biblioteca Neon — sursa adevărului AI-ului. */
export async function buildAnalyzerStats(): Promise<AnalyzerSnapshot> {
  const [byType, byContinent, byProvider, topCountries, byDecade, totalsRaw, genreTop] =
    await Promise.all([
      qRead<Row>(
        `SELECT content_type AS type, count(*)::int AS count
         FROM content GROUP BY 1 ORDER BY count DESC`
      ),
      qRead<Row>(
        `SELECT COALESCE(NULLIF(continent,''),'Global') AS continent, count(*)::int AS count
         FROM content GROUP BY 1 ORDER BY count DESC LIMIT 12`
      ),
      qRead<Row>(
        `SELECT provider, count(*)::int AS count
         FROM content GROUP BY 1 ORDER BY count DESC LIMIT 16`
      ),
      qRead<Row>(
        `SELECT COALESCE(NULLIF(country,''),'necunoscut') AS country, count(*)::int AS count
         FROM content GROUP BY 1 ORDER BY count DESC LIMIT 14`
      ),
      qRead<Row>(
        `SELECT COALESCE(('Anii ' || (FLOOR(year/10)*10)::int)::text, 'fără an') AS decade, count(*)::int AS count
         FROM content WHERE year IS NOT NULL GROUP BY 1 ORDER BY 1 DESC`
      ),
      (async () => {
        const r = await qRead<Row>(
          `SELECT
             (SELECT count(*)::int FROM content) AS total,
             (SELECT COALESCE(sum(views),0)::bigint FROM content) AS views,
             (SELECT COALESCE(round(avg(nullif(rating,0))::numeric,2),0)::float FROM content WHERE rating > 0) AS avg_rating,
             (SELECT count(*)::int FROM content WHERE year IS NOT NULL) AS with_year,
             (SELECT count(*)::int FROM content WHERE year IS NULL) AS without_year,
             (SELECT count(*)::int FROM content WHERE description IS NOT NULL AND description <> '') AS with_desc,
             (SELECT count(*)::int FROM content WHERE description IS NULL OR description = '') AS without_desc,
             (SELECT count(DISTINCT cg.content_id)::int FROM content_genres cg) AS with_genres,
             (SELECT count(*)::int FROM genres) AS genres_total,
             (SELECT count(DISTINCT country)::int FROM content WHERE country IS NOT NULL AND country <> '') AS countries,
             (SELECT count(DISTINCT provider)::int FROM content) AS providers,
             (SELECT count(*)::int FROM playback_events) AS play_events,
             (SELECT count(*)::int FROM search_logs WHERE created_at > now() - interval '24 hours') AS searches_24h,
             (SELECT count(*)::int FROM content WHERE created_at > now() - interval '24 hours') AS added_24h,
             (SELECT count(*)::int FROM content WHERE meta ? 'aiExtractedAt') AS ai_extracted
          WHERE 1=1`
        );
        const t = r[0] || {};
        return {
          views: Number(t.views || 0),
          avgRating: Number(t.avg_rating || 0),
          withYear: Number(t.with_year || 0),
          withoutYear: Number(t.without_year || 0),
          withDescription: Number(t.with_desc || 0),
          withoutDescription: Number(t.without_desc || 0),
          withGenres: Number(t.with_genres || 0),
          withoutGenres: Math.max(0, Number(t.total || 0) - Number(t.with_genres || 0)),
          genresTotal: Number(t.genres_total || 0),
          countries: Number(t.countries || 0),
          providers: Number(t.providers || 0),
          playEvents: Number(t.play_events || 0),
          searches24h: Number(t.searches_24h || 0),
          contentAdded24h: Number(t.added_24h || 0),
          aiExtracted: Number(t.ai_extracted || 0),
          total: Number(t.total || 0),
        };
      })(),
      qRead<Row>(
        `SELECT g.name, count(cg.content_id)::int AS count
         FROM content_genres cg JOIN genres g ON g.id = cg.genre_id
         GROUP BY g.name ORDER BY count DESC LIMIT 12`
      ),
    ]);

  const totals = totalsRaw;

  const snapshot: AnalyzerSnapshot = {
    at: new Date().toISOString(),
    total: totals.total,
    byType: byType.map((r) => ({ type: String(r.type), count: Number(r.count) })),
    byContinent: byContinent.map((r) => ({ continent: String(r.continent), count: Number(r.count) })),
    byProvider: byProvider.map((r) => ({ provider: String(r.provider), count: Number(r.count) })),
    topCountries: topCountries.map((r) => ({ country: String(r.country), count: Number(r.count) })),
    byDecade: byDecade.map((r) => ({ decade: String(r.decade), count: Number(r.count) })),
    topGenres: genreTop.map((r) => ({ name: String(r.name), count: Number(r.count) })),
    totals: {
      views: totals.views,
      avgRating: totals.avgRating,
      withYear: totals.withYear,
      withoutYear: totals.withoutYear,
      withDescription: totals.withDescription,
      withoutDescription: totals.withoutDescription,
      withGenres: totals.withGenres,
      withoutGenres: totals.withoutGenres,
      genresTotal: totals.genresTotal,
      countries: totals.countries,
      providers: totals.providers,
      playEvents: totals.playEvents,
      searches24h: totals.searches24h,
      contentAdded24h: totals.contentAdded24h,
      aiExtracted: totals.aiExtracted,
    },
    summary: "",
    summarySource: "deterministic",
  };

  return snapshot;
}

/** Rezumat în română — LLM cu fallback determinist (nu blochează niciodată). */
export async function aiSummary(stats: AnalyzerSnapshot): Promise<{ text: string; source: "llm" | "deterministic" }> {
  const deterministic = () => {
    const top = stats.byType.slice(0, 3).map((t) => `${t.count.toLocaleString("ro-RO")} ${t.type}`).join(", ");
    return (
      `Platforma găzduiește ${stats.total.toLocaleString("ro-RO")} de conținuturi reale în Neon — top: ${top}. ` +
      `Cuprind ${stats.totals.countries} țări și ${stats.totals.providers} surse, cu ${stats.totals.genresTotal} genuri și categorii AI. ` +
      `Metadate complete pe ${(100 * stats.totals.withYear / Math.max(1, stats.total)).toFixed(0)}% (an) și ` +
      `${(100 * stats.totals.withGenres / Math.max(1, stats.total)).toFixed(0)}% (genuri).`
    );
  };
  try {
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const facts = JSON.stringify(
      {
        total: stats.total,
        tipuri: stats.byType,
        tari: stats.totals.countries,
        surse: stats.totals.providers,
        genuri: stats.totals.genresTotal,
        faraAn: stats.totals.withoutYear,
        faraDescriere: stats.totals.withoutDescription,
        faraGenuri: stats.totals.withoutGenres,
        redari: stats.totals.playEvents,
        cautari24h: stats.totals.searches24h,
      },
      null, 0
    );
    const completion = await zai.chat.completions.create({
      messages: [
        {
          role: "assistant",
          content:
            "Ești analistul AI al platformei StreamVerse. Primești statistici reale ale bibliotecii. " +
            "Scrie MAXIM 3 propoziții în română, concrete, cu cifre, fără introducere și fără concluzii generice.",
        },
        { role: "user", content: facts },
      ],
      thinking: { type: "disabled" },
    });
    const text = (completion.choices[0]?.message?.content || "").trim();
    if (text && text.length > 30) return { text, source: "llm" };
    return { text: deterministic(), source: "deterministic" };
  } catch {
    return { text: deterministic(), source: "deterministic" };
  }
}

/** Rulează analiza completă + salvează snapshot în Neon (istoric permanent). */
export async function runAnalyzer(withLlmSummary = true): Promise<AnalyzerSnapshot> {
  const stats = await buildAnalyzerStats();
  const sum = withLlmSummary ? await aiSummary(stats) : { text: "", source: "deterministic" as const };
  stats.summary = sum.text || fallbackSummary(stats);
  stats.summarySource = sum.source;
  await q(
    `INSERT INTO ai_insights (kind, snapshot) VALUES ('analyzer', $1::jsonb)`,
    [JSON.stringify(stats)]
  );
  await q(
    `INSERT INTO platform_metrics (key, value) VALUES ('ai_total_analyzed', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [stats.total]
  );
  return stats;
}

function fallbackSummary(s: AnalyzerSnapshot): string {
  const top = s.byType.slice(0, 3).map((t) => `${t.count.toLocaleString("ro-RO")} ${t.type}`).join(", ");
  return `Bibliotecă Neon: ${s.total.toLocaleString("ro-RO")} conținuturi — top: ${top}. ` +
    `${s.totals.countries} țări, ${s.totals.providers} surse, ${s.totals.genresTotal} taxonomii AI, ` +
    `${s.totals.playEvents.toLocaleString("ro-RO")} evenimente de redare.`;
}

export async function getLatestAnalyzer(): Promise<AnalyzerSnapshot | null> {
  const rows = await qRead<Row>(
    `SELECT snapshot, created_at FROM ai_insights WHERE kind='analyzer'
     ORDER BY created_at DESC LIMIT 1`
  );
  if (!rows[0]) return null;
  const s = rows[0].snapshot as AnalyzerSnapshot;
  return { ...s, at: new Date(rows[0].created_at as string).toISOString() };
}

// ---------- RECOMANDĂRI AI (SQL real, overlap genuri) ----------

export type RecItem = {
  id: number;
  title: string;
  contentType: string;
  description: string;
  thumbnail: string | null;
  backdrop: string | null;
  year: number | null;
  rating: number;
  views: number;
  shared: number;
  reason: string;
};

const REC_COLS = `c.id, c.title, c.content_type, c.description, c.thumbnail, c.backdrop,
  c.year, c.rating, c.views`;

/** Recomandări pentru un conținut-sămânță: genuri comune + popularitate. */
export async function recommendBySeed(seedId: number, limit = 8): Promise<RecItem[]> {
  // treapta 1: genuri reale (film/muzică/franciză/colecție)
  let rows = await qRead<Row>(
    `WITH seed AS (
       SELECT cg.genre_id FROM content_genres cg
       JOIN genres g ON g.id = cg.genre_id
       WHERE cg.content_id = $1 AND g.kind IN ('genre','franchise','collection','trilogy')
     )
     SELECT ${REC_COLS}, count(DISTINCT cg.genre_id)::int AS shared,
            string_agg(DISTINCT g.name, ', ') AS genre_names
     FROM content_genres cg
     JOIN seed s ON s.genre_id = cg.genre_id
     JOIN content c ON c.id = cg.content_id AND c.id <> $1
     JOIN genres g ON g.id = cg.genre_id
     GROUP BY c.id
     ORDER BY shared DESC, c.popularity DESC, c.views DESC
     LIMIT $2`,
    [seedId, limit]
  );
  // treapta 2: orice taxonomie legată (an, categorie TV…)
  if (rows.length === 0) {
    rows = await qRead<Row>(
      `WITH seed AS (SELECT genre_id FROM content_genres WHERE content_id = $1)
       SELECT ${REC_COLS}, count(DISTINCT cg.genre_id)::int AS shared,
              string_agg(DISTINCT g.name, ', ') AS genre_names
       FROM content_genres cg
       JOIN seed s ON s.genre_id = cg.genre_id
       JOIN content c ON c.id = cg.content_id AND c.id <> $1
       JOIN genres g ON g.id = cg.genre_id
       GROUP BY c.id
       ORDER BY shared DESC, c.popularity DESC, c.views DESC
       LIMIT $2`,
      [seedId, limit]
    );
  }
  // treapta 3: mix global
  if (rows.length === 0) return recommendGlobal(limit);
  return rows.map((r) => ({
    id: Number(r.id),
    title: String(r.title),
    contentType: String(r.content_type),
    description: String(r.description || ""),
    thumbnail: (r.thumbnail as string) || null,
    backdrop: (r.backdrop as string) || null,
    year: (r.year as number) || null,
    rating: Number(r.rating || 0),
    views: Number(r.views || 0),
    shared: Number(r.shared || 0),
    reason: r.genre_names ? `genuri comune: ${r.genre_names}` : "similar AI",
  }));
}

/** Recomandări PERSONALIZATE: din istoricul utilizatorului (ultimele vizionări). */
export async function recommendForUser(userId: string, limit = 10): Promise<RecItem[]> {
  const hist = await q<Row>(
    `SELECT DISTINCT h.media_id FROM "History" h
     WHERE h.user_id = $1 AND h.media_id ~ '^[0-9]+$'
     ORDER BY h.media_id DESC LIMIT 12`,
    [userId]
  );
  const ids = hist.map((r) => Number(r.media_id)).filter((n) => n > 0);
  if (ids.length === 0) return recommendGlobal(limit);

  const rows = await qRead<Row>(
    `WITH seed AS (
       SELECT DISTINCT cg.genre_id
       FROM content_genres cg
       JOIN genres g ON g.id = cg.genre_id
       WHERE cg.content_id = ANY($1::bigint[]) AND g.kind IN ('genre','franchise','collection','trilogy')
     )
     SELECT ${REC_COLS}, count(DISTINCT cg.genre_id)::int AS shared,
            string_agg(DISTINCT g.name, ', ') AS genre_names
     FROM content_genres cg
     JOIN seed s ON s.genre_id = cg.genre_id
     JOIN content c ON c.id = cg.content_id AND NOT (c.id = ANY($1::bigint[]))
     JOIN genres g ON g.id = cg.genre_id
     GROUP BY c.id
     ORDER BY shared DESC, c.popularity DESC, c.views DESC
     LIMIT $2`,
    [ids, limit]
  );
  if (rows.length === 0) return recommendGlobal(limit);
  return rows.map((r) => ({
    id: Number(r.id),
    title: String(r.title),
    contentType: String(r.content_type),
    description: String(r.description || ""),
    thumbnail: (r.thumbnail as string) || null,
    backdrop: (r.backdrop as string) || null,
    year: (r.year as number) || null,
    rating: Number(r.rating || 0),
    views: Number(r.views || 0),
    shared: Number(r.shared || 0),
    reason: "pe baza istoricului tău",
  }));
}

/** Fallback global: top diversificat pe tipuri (film, serial, TV live, radio…). */
export async function recommendGlobal(limit = 10): Promise<RecItem[]> {
  const rows = await qRead<Row>(
    `SELECT id, title, content_type, description, thumbnail, backdrop, year, rating, views FROM (
       SELECT c.id, c.title, c.content_type, c.description, c.thumbnail, c.backdrop, c.year, c.rating, c.views, c.popularity,
              row_number() OVER (PARTITION BY c.content_type ORDER BY c.popularity DESC, c.views DESC) AS rn
       FROM content c
       WHERE c.content_type IN ('movie','series','live_tv','radio','music','anime','cartoon','documentary')
     ) t
     WHERE rn <= 2
     ORDER BY popularity DESC
     LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    title: String(r.title),
    contentType: String(r.content_type),
    description: String(r.description || ""),
    thumbnail: (r.thumbnail as string) || null,
    backdrop: (r.backdrop as string) || null,
    year: (r.year as number) || null,
    rating: Number(r.rating || 0),
    views: Number(r.views || 0),
    shared: 0,
    reason: "popular global",
  }));
}

// ---------- CITIRI TAXONOMIE AI ----------

export type TaxonomyEntry = {
  slug: string;
  name: string;
  kind: string;
  count: number;
  poster: string | null;
};

export async function getTaxonomy(perKind = 28): Promise<Record<string, TaxonomyEntry[]>> {
  const rows = await qRead<Row>(
    `SELECT slug, name, kind, content_count AS count, poster
     FROM genres WHERE content_count > 0
     ORDER BY kind, content_count DESC, name`
  );
  const out: Record<string, TaxonomyEntry[]> = {};
  for (const r of rows) {
    const kind = String(r.kind);
    (out[kind] ||= []).push({
      slug: String(r.slug),
      name: String(r.name),
      kind,
      count: Number(r.count),
      poster: (r.poster as string) || null,
    });
  }
  for (const k of Object.keys(out)) out[k] = out[k].slice(0, perKind);
  return out;
}

export async function getTaxonomyCounts(): Promise<{ kind: string; n: number; total: number }[]> {
  const rows = await qRead<Row>(
    `SELECT kind, count(*)::int AS n, COALESCE(sum(content_count),0)::int AS total
     FROM genres GROUP BY kind ORDER BY kind`
  );
  return rows.map((r) => ({ kind: String(r.kind), n: Number(r.n), total: Number(r.total) }));
}

// ---------- STATISTICI METADATE (pentru panoul AI) ----------

export async function getMetadataStats() {
  const r = await qRead<Row>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE year IS NULL)::int AS no_year,
            count(*) FILTER (WHERE description IS NULL OR description='')::int AS no_desc,
            (SELECT count(*)::int FROM content c WHERE NOT EXISTS (SELECT 1 FROM content_genres cg WHERE cg.content_id = c.id)) AS no_genres,
            (SELECT count(*)::int FROM content WHERE meta ? 'aiExtractedAt') AS ai_extracted,
            (SELECT count(*)::int FROM content WHERE external_id LIKE 'tmdb:%') AS tmdb_items
     FROM content`
  );
  const job = await qRead<Row>(
    `SELECT id, kind, status, processed, total, inserted, started_at, finished_at, error
     FROM ai_jobs ORDER BY started_at DESC LIMIT 6`
  );
  const t = r[0] || {};
  return {
    total: Number((t as Row).total || 0),
    noYear: Number((t as Row).no_year || 0),
    noDesc: Number((t as Row).no_desc || 0),
    noGenres: Number((t as Row).no_genres || 0),
    aiExtracted: Number((t as Row).ai_extracted || 0),
    tmdbItems: Number((t as Row).tmdb_items || 0),
    jobs: job.map((j) => ({
      id: Number(j.id),
      kind: String(j.kind),
      status: String(j.status),
      processed: Number(j.processed),
      total: Number(j.total),
      inserted: Number(j.inserted),
      startedAt: j.started_at as string,
      finishedAt: j.finished_at as string | null,
      error: (j.error as string) || null,
    })),
  };
}

export { qOne };
