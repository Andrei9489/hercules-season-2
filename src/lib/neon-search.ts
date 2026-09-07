// ============================================================
// Motor de căutare StreamVerse — strat Neon (Faza 1)
// Arhitectură: FTS (tsvector GIN) + trigram (pg_trgm GIN) pe tabel
// partiționat HASH x16, ranking hibrid, cache LRU la cald, logging
// asincron în search_logs + search_stats.
// Țintă finală: 30 miliarde itemi • 10.000 căutări simultane.
// ============================================================
import { q, qOne } from "./pg";

/** Normalizează text RO/EN: fără diacritice, lowercase, doar [a-z0-9 spații]. */
export function normalizeRo(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type LibraryHit = {
  id: number;
  externalId: string;
  title: string;
  originalTitle: string | null;
  description: string;
  contentType: string;
  brand: string | null;
  category: string | null;
  continent: string | null;
  country: string | null;
  provider: string;
  sourceType: string;
  sourceUrl: string | null;
  embedCode: string | null;
  thumbnail: string | null;
  backdrop: string | null;
  year: number | null;
  rating: number;
  popularity: number;
  views: number;
  score: number;
};

// ---------- Cache LRU la cald (protecție Neon la vârfuri) ----------
type CacheEntry = { exp: number; data: LibraryHit[] };
const RESULT_TTL_MS = 45_000;
const CACHE_MAX = 2_000;
const searchCache = new Map<string, CacheEntry>();

function cacheGet(key: string): LibraryHit[] | null {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    searchCache.delete(key);
    return null;
  }
  // LRU: repoziționează la final
  searchCache.delete(key);
  searchCache.set(key, hit);
  return hit.data;
}

function cacheSet(key: string, data: LibraryHit[]): void {
  if (searchCache.size >= CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest) searchCache.delete(oldest);
  }
  searchCache.set(key, { exp: Date.now() + RESULT_TTL_MS, data });
}

/** Invalidare la adăugarea de conținut nou. */
export function invalidateSearchCache(prefix?: string): void {
  if (!prefix) {
    searchCache.clear();
    return;
  }
  for (const k of searchCache.keys()) {
    if (k.startsWith(prefix)) searchCache.delete(k);
  }
}

// ---------- Căutare FTS + trigram (index-driven, fără seq scan) ----------
type SearchOpts = { limit?: number; offset?: number; type?: string; brand?: string };

export async function searchLibrary(
  query: string,
  opts: SearchOpts = {}
): Promise<{ hits: LibraryHit[]; tookMs: number; cached: boolean; totalIndexed: number }> {
  const t0 = Date.now();
  const { limit = 24, offset = 0, type, brand } = opts;
  const norm = normalizeRo(query).slice(0, 120);

  if (!norm) {
    // Fără query — listează cele mai populare (index pe popularity DESC)
    let where = "TRUE";
    const params: unknown[] = [];
    if (type) {
      params.push(type);
      where += ` AND content_type = $${params.length}`;
    }
    if (brand) {
      params.push(brand);
      where += ` AND brand = $${params.length}`;
    }
    params.push(limit);
    where += ` ORDER BY popularity DESC, id DESC LIMIT $${params.length}`;
    params.push(offset);
    where += ` OFFSET $${params.length}`;
    const rows = await q<Record<string, unknown>>(`SELECT * FROM content WHERE ${where}`, params);
    return { hits: rows.map(mapHit), tookMs: Date.now() - t0, cached: false, totalIndexed: 0 };
  }

  const cacheKey = `sl:${norm}:${limit}:${offset}:${type || "*"}:${brand || "*"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { hits: cached, tookMs: Date.now() - t0, cached: true, totalIndexed: 0 };

  // to_tsquery cu prefix per termen: "marii pitici" -> marii:* & pitici:*
  const terms = norm.split(" ").filter(Boolean).slice(0, 8).map((t) => t.replace(/[^\w]/g, ""));
  const tsq = terms.map((t) => `${t}:*`).join(" & ");
  const prefix = norm.replace(/[^\w\s]/g, "");

  const conditions: string[] = [];
  const params: unknown[] = [];
  let p = 0;
  const next = (v: unknown): string => {
    params.push(v);
    p++;
    return `$${p}`;
  };

  const pNorm = next(norm);
  const pTsq = next(tsq);
  const pPrefix = next(prefix + "%");

  conditions.push(`search_tsv @@ to_tsquery('simple', ${pTsq})`);
  if (prefix.length >= 3) {
    const pSim = next(norm);
    conditions.push(`search_text % ${pSim}`);
  }
  const pLike = next(`%${prefix}%`);
  conditions.push(`search_text LIKE ${pLike}`);

  const scoreExpr = `
    (ts_rank(search_tsv, to_tsquery('simple', ${pTsq})) * 8
     ${prefix.length >= 3 ? `+ similarity(search_text, ${pNorm}) * 3` : ""}
     + CASE WHEN search_text LIKE ${pPrefix} THEN 3 ELSE 0 END
     + LEAST(popularity, 5000) / 5000.0 * 1.2)`;

  let where = `(${conditions.join(" OR ")})`;
  if (type) where += ` AND content_type = ${next(type)}`;
  if (brand) where += ` AND brand = ${next(brand)}`;

  const sql = `
    SELECT id, external_id, title, original_title, description, content_type, brand,
           category, continent, country, provider, source_type, source_url, embed_code,
           thumbnail, backdrop, year, rating, popularity, views, ${scoreExpr} AS score
    FROM content
    WHERE ${where}
    ORDER BY score DESC, popularity DESC, id DESC
    LIMIT ${next(limit)} OFFSET ${next(offset)}`;

  const rows = await q<Record<string, unknown>>(sql, params);
  const hits = rows.map(mapHit);
  cacheSet(cacheKey, hits);
  return { hits, tookMs: Date.now() - t0, cached: false, totalIndexed: 0 };
}

function mapHit(r: Record<string, unknown>): LibraryHit {
  return {
    id: Number(r.id),
    externalId: String(r.external_id),
    title: String(r.title),
    originalTitle: (r.original_title as string) || null,
    description: (r.description as string) || "",
    contentType: String(r.content_type),
    brand: (r.brand as string) || null,
    category: (r.category as string) || null,
    continent: (r.continent as string) || null,
    country: (r.country as string) || null,
    provider: String(r.provider),
    sourceType: String(r.source_type),
    sourceUrl: (r.source_url as string) || null,
    embedCode: (r.embed_code as string) || null,
    thumbnail: (r.thumbnail as string) || null,
    backdrop: (r.backdrop as string) || null,
    year: (r.year as number) || null,
    rating: (r.rating as number) || 0,
    popularity: Number(r.popularity) || 0,
    views: Number(r.views) || 0,
    score: Number(r.score) || 0,
  };
}

// ---------- Sugestii (prefix pe titluri + trending) ----------
export async function suggest(prefix: string, limit = 7): Promise<string[]> {
  const norm = normalizeRo(prefix);
  if (!norm) return [];
  const rows = await q<{ title: string }>(
    `SELECT DISTINCT title FROM content
     WHERE search_text LIKE $1 || '%'
     ORDER BY title LIMIT $2`,
    [norm, limit]
  );
  return rows.map((r) => r.title);
}

export type TrendItem = { norm: string; original: string; hits: number };

export async function trending(limit = 8): Promise<TrendItem[]> {
  const rows = await q<Record<string, unknown>>(
    `SELECT norm, original, hits FROM search_stats ORDER BY hits DESC, last_at DESC LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({ norm: String(r.norm), original: String(r.original), hits: Number(r.hits) }));
}

// ---------- Logging asincron (fire-and-forget, nu blochează răspunsul) ----------
export function logSearch(
  query: string,
  resultsCount: number,
  durationMs: number,
  mode: string,
  userId?: string | null
): void {
  const norm = normalizeRo(query);
  if (!norm) return;
  void (async () => {
    try {
      await q(
        `INSERT INTO search_logs (query, norm, results_count, duration_ms, mode, user_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [query.slice(0, 200), norm, resultsCount, durationMs, mode, userId || null]
      );
      await q(`SELECT upsert_search_stat($1,$2,$3)`, [norm, query.slice(0, 120), resultsCount]);
    } catch {
      /* logging nu poate rupe căutarea */
    }
  })();
}

// ---------- Ingestion: inserare conținut nou (URL/embed) ----------
export type NewContent = {
  externalId: string;
  title: string;
  originalTitle?: string | null;
  description?: string;
  contentType: string;
  brand?: string | null;
  category?: string | null;
  continent?: string;
  country?: string | null;
  language?: string;
  provider: string;
  sourceType: string;
  sourceUrl?: string | null;
  embedCode?: string | null;
  thumbnail?: string | null;
  year?: number | null;
  tags?: string[];
  meta?: Record<string, unknown>;
  createdBy?: string | null;
};

export async function insertContent(c: NewContent): Promise<LibraryHit | null> {
  const search_text = normalizeRo(
    [c.title, c.originalTitle || "", c.description || "", (c.tags || []).join(" "), c.brand || "", c.contentType, c.category || "", c.provider].join(" ")
  );
  // dedup pe external_id la nivel de aplicație (partiționare hash nu permite unique global)
  const dup = await qOne<{ id: number }>(`SELECT id FROM content WHERE external_id = $1 LIMIT 1`, [c.externalId]);
  if (dup) return null;
  const rows = await q<Record<string, unknown>>(
    `INSERT INTO content
       (external_id, title, original_title, description, content_type, brand, category,
        continent, country, language, provider, source_type, source_url, embed_code,
        thumbnail, year, tags, search_text, meta, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING *`,
    [
      c.externalId, c.title, c.originalTitle || null, c.description || "", c.contentType,
      c.brand || null, c.category || null, c.continent || "Global", c.country || null,
      c.language || "en", c.provider, c.sourceType, c.sourceUrl || null, c.embedCode || null,
      c.thumbnail || null, c.year || null, c.tags || [], search_text,
      JSON.stringify(c.meta || {}), c.createdBy || null,
    ]
  );
  invalidateSearchCache("sl:");
  return rows[0] ? mapHit(rows[0]) : null;
}

export async function recordPlayback(
  contentId: number,
  provider: string,
  event: string,
  seconds: number,
  userId?: string | null
): Promise<void> {
  try {
    await q(`SELECT record_playback($1,$2,$3,$4,$5)`, [contentId, provider, event, seconds, userId || null]);
  } catch {
    /* nu blochează redarea */
  }
}
