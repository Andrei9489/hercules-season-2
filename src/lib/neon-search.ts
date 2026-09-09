// ============================================================
// Motor de căutare StreamVerse — strat Neon (Faza 6)
// Arhitectură: FTS (tsvector GIN) + trigram (pg_trgm GIN) pe tabel
// partiționat HASH x16, ranking hibrid, cache L2 DISTRIBUIT în Neon
// (partajat cross-instance) PENTRU REZULTATE + SUGESTII + TRENDING,
// index covering pentru autocompletare (index-only scans), ROLLUP
// pre-agregat pentru ranking pe POPULARITATE la prefixe scurte,
// router READ/WRITE (pool RO replica-ready), cache LRU la cald,
// logging asincron în search_logs + search_stats.
// Țintă finală: 30 miliarde itemi • 10.000 căutări simultane.
// ============================================================
import { q, qOne, qRead, AdmissionRejected, DbUnavailable } from "./pg";
import { qReadRegion } from "./regions";
import {
  getActiveShards,
  execOnAllShards,
  pickShardFor,
  shardQuery,
  shardMapUpsert,
  shardMapLookup,
  type Shard,
} from "./shards";

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

// ---------- Cache L2 DISTRIBUIT în Neon (Faza 4) ----------
// L1 = memorie per-instanță (implicit, sub-ms) → L2 = tabel Neon shared
// (~15-40ms, partajat între TOATE instanțele) → origin (FTS+trigram).
// La scale orizontal (N instanțe) hit-rate-ul L2 crește proporțional —
// load pe compute-ul Neon scade cu numărul de instanțe.
const L2_TTL_SEC = 90;
const L2_TTL_SUG_SEC = 300;  // Faza 5: sugestiile se schimbă rar (invalidare la ingest)
const L2_TTL_TREND_SEC = 120;

async function l2Get<T>(key: string, ttlSec: number = L2_TTL_SEC): Promise<T | null> {
  try {
    const rows = await qRead<{ payload: unknown }>(
      `SELECT payload FROM search_cache
       WHERE key = $1 AND created_at > now() - ($2 || ' seconds')::interval`,
      [key, String(ttlSec)]
    );
    if (!rows[0]) return null;
    return JSON.parse(JSON.stringify(rows[0].payload)) as T;
  } catch {
    return null; // L2 e optim — o eroare NU blochează căutarea
  }
}

async function l2Set(key: string, data: unknown): Promise<void> {
  try {
    await q(
      `INSERT INTO search_cache (key, payload) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`,
      [key, JSON.stringify(data)]
    );
  } catch { /* optim — ignoră */ }
}

// cleanup probabilistic: 2% din scrieri declanșează ștergerea intrărilor expirate
function l2CleanupMaybe(): void {
  if (Math.random() > 0.02) return;
  q(`DELETE FROM search_cache WHERE created_at < now() - interval '10 minutes'`)
    .catch(() => { /* optim */ });
}

// ---------- Cache LRU la cald L1 (protecție Neon la vârfuri) ----------
// Faza 2: TTL mai lung + cache mai mare + coalescing cereri identice.
type CacheEntry = { exp: number; data: LibraryHit[] };
const RESULT_TTL_MS = 120_000;
const CACHE_MAX = 5_000;
const searchCache = new Map<string, CacheEntry>();
// coalescing: cererile simultane identice partajează ACEEAși promisiune
// (10.000 căutări simultane pe top-query-uri → 1 singur hit în Neon)
const inFlight = new Map<string, Promise<LibraryHit[]>>();

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

/** Faza 9: STALE-WHILE-ERROR — citește și intrări EXPIRATE din L1.
 *  Când origin/DB e picat, mai bine servim rezultate puțin vechi decât o eroare. */
function cacheGetStale(key: string): LibraryHit[] | null {
  const hit = searchCache.get(key);
  return hit ? hit.data : null;
}

/** Faza 12: citește intrare expirată (cu touch LRU) — pentru
 *  STALE-WHILE-REVALIDATE: servim instant din stale, refresh-ul pleacă
 *  în fundal (single-flight). Sub vârfuri susținute pe aceleași query-uri,
 *  răspunsul rămâne sub-ms, iar origin-ul e lovit max 1x per TTL. */
function cacheGetStaleEntry(key: string): LibraryHit[] | null {
  const hit = searchCache.get(key);
  if (!hit) return null;
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

/** Invalidare la adăugarea de conținut nou (L1 + L2 distribuit).
 *  Faza 12: ridică generația cache-ului — recompute-urile de background
 *  pornite ÎNAINTE de invalidare nu mai repopulează date vechi. */
export function invalidateSearchCache(prefix?: string): void {
  cacheGeneration++;
  if (!prefix) {
    searchCache.clear();
    inFlight.clear();
    sugCache.clear();
    q(`DELETE FROM search_cache`).catch(() => { /* optim */ });
    return;
  }
  // Faza 5: invalidarea L2 acoperă și sugestiile/trending (prefixe 'sug:'/'trend:')
  for (const k of searchCache.keys()) {
    if (k.startsWith(prefix)) searchCache.delete(k);
  }
  for (const k of sugCache.keys()) {
    if (k.startsWith("sug:")) sugCache.delete(k);
  }
  if (prefix.startsWith("sl:")) {
    // L2: șterge cache-urile de căutare + sugestii + trending (PK range scan, ieftin)
    q(`DELETE FROM search_cache WHERE key LIKE 'sl:%' OR key LIKE 'sug:%' OR key LIKE 'trend:%'`)
      .catch(() => { /* optim */ });
  }
}

// ---------- Căutare FTS + trigram (index-driven, fără seq scan) ----------
type SearchOpts = { limit?: number; offset?: number; type?: string; brand?: string; region?: string };

// Faza 12: generația cache-ului — invalidările incrementează; recompute-urile
// de background captură generația la start și NU mai scrie în cache dacă s-a
// schimbat între timp (previne repopularea cu date de pre-ingest).
let cacheGeneration = 0;

/**
 * Faza 12: re-materializare completă pentru o cheie de căutare
 * (L2 distribuit → origin SQL → promovare L1 + write-behind L2).
 * Folosită ATÂT de foreground (cache miss), CÂT ȘI de background
 * revalidate (intrare expirată servită stale). Nu atinge inFlight —
 * fiecare apelant își gestionează single-flight-ul.
 */
function searchRecompute(
  cacheKey: string,
  norm: string,
  limit: number,
  offset: number,
  type?: string,
  brand?: string,
  region?: string
): Promise<LibraryHit[]> {
  const gen = cacheGeneration;
  return (async (): Promise<LibraryHit[]> => {
    // Faza 4/5: L2 distribuit în Neon (partajat cross-instance)
    const l2 = await l2Get<LibraryHit[]>(cacheKey);
    if (l2 && Array.isArray(l2)) {
      const hits = l2.map((h) => ({ ...h }));
      cacheSet(cacheKey, hits); // promovează în L1
      return hits;
    }

    const hits = await runSearchFanout(norm, limit, offset, type, brand, region);

    // Faza 12: scriem în cache DOAR dacă între timp nu a venit o invalidare
    if (gen === cacheGeneration) {
      cacheSet(cacheKey, hits);
      void l2Set(cacheKey, hits).then(() => l2CleanupMaybe()); // L2 write-behind
    }
    return hits;
  })();
}

/**
 * Faza 15 — EXECUȚIE DE CĂUTARE (multi-shard):
 * - 1 shard activ (implicit) → interogare directă pe primar (calea clasică)
 * - N shard-uri active → SCATTER-GATHER: interogarea rulează pe TOATE
 *   compute-urile în paralel (fiecare cu LIMIT limit+offset, OFFSET 0),
 *   rezultatele se combină global pe score și se taie fereastra cerută.
 *   Un shard picat NU blochează căutarea (toleranță parțială).
 */
async function runSearchFanout(
  norm: string,
  limit: number,
  offset: number,
  type?: string,
  brand?: string,
  region?: string
): Promise<LibraryHit[]> {
  const active = await getActiveShards().catch(() => [] as Shard[]);
  if (active.length > 1) {
    const scatter = await execOnAllShards((shard) =>
      runSearchOnShard(shard, norm, limit + offset, 0, type, brand)
    );
    if (scatter.errors.length) {
      console.warn(`[shards] căutare parțială (${scatter.answered}/${scatter.total}): ${scatter.errors.join(" | ")}`);
    }
    const merged = scatter.results.flat();
    merged.sort((a, b) => b.score - a.score || b.popularity - a.popularity || b.id - a.id);
    return merged.slice(offset, offset + limit);
  }
  // FAZA 16: citirea de origin merge pe REPLICĂ/regiunea cerută (qReadRegion)
  // — fallback transparent pe pool-ul RO când regiunea nu e activă.
  const rows = await qReadRegion<Record<string, unknown>>(region, ...buildSearchQuery(norm, limit, offset, type, brand));
  return rows.map(mapHit);
}

/** Rulează interogarea de căutare pe UN shard specific (local sau remote). */
async function runSearchOnShard(
  shard: Shard,
  norm: string,
  limit: number,
  offset: number,
  type?: string,
  brand?: string
): Promise<LibraryHit[]> {
  const [sql, params] = buildSearchQuery(norm, limit, offset, type, brand);
  const rows = await shardQuery<Record<string, unknown>>(shard, sql, params);
  return rows.map(mapHit);
}

/** Construiește SQL-ul de căutare FTS+trigram (identic pe toate shard-urile). */
function buildSearchQuery(
  norm: string,
  limit: number,
  offset: number,
  type?: string,
  brand?: string
): [string, unknown[]] {
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

  // FIX 42P18: parametrii se alocă DOAR dacă sunt referențiați în SQL —
  // pentru prefixuri scurte (<3) pNorm nu era folosit nicăieri și Postgres
  // respicea statementul ("could not determine data type of parameter $1").
  const pTsq = next(tsq);
  const pPrefix = next(prefix + "%");
  let pSim = "";
  if (prefix.length >= 3) {
    pSim = next(norm);
    conditions.push(`search_text % ${pSim}`);
  }
  const pLike = next(`%${prefix}%`);
  conditions.push(`search_text LIKE ${pLike}`);

  const scoreExpr = `
    (ts_rank(search_tsv, to_tsquery('simple', ${pTsq})) * 8
     ${pSim ? `+ similarity(search_text, ${pSim}) * 3` : ""}
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
  return [sql, params];
}

/** Faza 12: kick asincron de revalidare (single-flight prin inFlight). */
function kickSearchRevalidate(
  cacheKey: string,
  norm: string,
  limit: number,
  offset: number,
  type?: string,
  brand?: string,
  region?: string
): void {
  if (inFlight.has(cacheKey)) return;
  const p = searchRecompute(cacheKey, norm, limit, offset, type, brand, region).catch(
    () => { /* stale-ul rămâne servit; circuit breaker/timeout gestionate de pg.ts */ }
  );
  inFlight.set(cacheKey, p);
  void p.finally(() => {
    if (inFlight.get(cacheKey) === p) inFlight.delete(cacheKey);
  });
}

export async function searchLibrary(
  query: string,
  opts: SearchOpts = {}
): Promise<{ hits: LibraryHit[]; tookMs: number; cached: boolean; totalIndexed: number; degraded?: boolean; revalidating?: boolean }> {
  const t0 = Date.now();
  const { limit = 24, offset = 0, type, brand, region } = opts;
  const norm = normalizeRo(query).slice(0, 120);

  if (!norm) {
    // Fără query — listează cele mai populare (index pe popularity DESC)
    // Faza 6: citire pe pool-ul RO (izolare de scrieri)
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
    // FAZA 16: listare populară rutată pe regiune (replică activă → replică)
    const rows = await qReadRegion<Record<string, unknown>>(region, `SELECT * FROM content WHERE ${where}`, params);
    return { hits: rows.map(mapHit), tookMs: Date.now() - t0, cached: false, totalIndexed: 0 };
  }

  const cacheKey = `sl:${norm}:${limit}:${offset}:${type || "*"}:${brand || "*"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { hits: cached, tookMs: Date.now() - t0, cached: true, totalIndexed: 0 };

  // Faza 12: STALE-WHILE-REVALIDATE — intrare expirată în L1 → servim
  // INSTANT din stale + re-materializare asincronă single-flight în fundal.
  const staleEntry = cacheGetStaleEntry(cacheKey);
  if (staleEntry) {
    kickSearchRevalidate(cacheKey, norm, limit, offset, type, brand, region);
    return { hits: staleEntry, tookMs: Date.now() - t0, cached: true, totalIndexed: 0, revalidating: true };
  }

  // coalescing: dacă o cerere identică e deja în zbor, așteptăm-o
  const pending = inFlight.get(cacheKey);
  if (pending) {
    const hits = await pending;
    return { hits, tookMs: Date.now() - t0, cached: false, totalIndexed: 0 };
  }

  const exec = searchRecompute(cacheKey, norm, limit, offset, type, brand, region);

  inFlight.set(cacheKey, exec);
  try {
    const hits = await exec;
    return { hits, tookMs: Date.now() - t0, cached: false, totalIndexed: 0 };
  } catch (e) {
    // Faza 9: STALE-WHILE-ERROR — origin indisponibil (circuit open,
    // admission full, statement timeout, rețea)? Servim cache-ul L1
    // expirat dacă există, marcat „degraded”. Utilizatorul NU vede erori.
    const stale = cacheGetStale(cacheKey);
    if (stale) {
      return { hits: stale, tookMs: Date.now() - t0, cached: true, totalIndexed: 0, degraded: true };
    }
    throw e;
  } finally {
    inFlight.delete(cacheKey);
  }
}

export function mapHit(r: Record<string, unknown>): LibraryHit {
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
// Faza 3: cache LRU propriu pentru suggest/trending (prefixele se repetă
// masiv la autocompletare → sub-1ms la cald, zero load pe Neon)
// Faza 5: + cache L2 DISTRIBUIT în Neon (300s, partajat cross-instance)
// + index covering idx_content_suggest (index-only scans pe 16 partiții)
// Faza 6: ROLLUP PRE-AGREGAT (tabel suggest_rollup) — pentru prefixe de
// 1-3 caractere, ranking pe POPULARITATE devine un simplu lookup PK pe
// bucket (top-40 titluri ordonate pop/views/titlu, recalculat de job de
// fundal). Numărul de bucket-e e mărginit de alfabet (~48K), NU de
// numărul de conținuturi → scalează la 30 miliarde rânduri. Prefixe
// lungi (≥4) rămân pe index-only scan cu early termination.
const SUG_TTL_MS = 120_000;
const SUG_MAX = 3_000;
const sugCache = new Map<string, { exp: number; data: unknown }>();
// Faza 5: coalescing pe suggest (ca la searchLibrary) — burst-uri de
// autocompletare pe prefixe identice → O SINGURĂ interogare origin.
const sugInFlight = new Map<string, Promise<unknown>>();

function sugGet<T>(key: string): T | null {
  const hit = sugCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { sugCache.delete(key); return null; }
  sugCache.delete(key);
  sugCache.set(key, hit);
  return hit.data as T;
}

/** Faza 9: varianta stale — servește și intrări expirate la eșec DB. */
function sugGetStale<T>(key: string): T | null {
  const hit = sugCache.get(key);
  return hit ? (hit.data as T) : null;
}

/** Faza 12: intrare expirată cu touch LRU — pentru STALE-WHILE-REVALIDATE
 *  (autocompletarea servește sub-ms mereu; refresh-ul pleacă în fundal). */
function sugGetStaleEntry<T>(key: string): T | null {
  const hit = sugCache.get(key);
  if (!hit) return null;
  sugCache.delete(key);
  sugCache.set(key, hit);
  return hit.data as T;
}

function sugSet(key: string, data: unknown): void {
  if (sugCache.size >= SUG_MAX) {
    const oldest = sugCache.keys().next().value;
    if (oldest) sugCache.delete(oldest);
  }
  sugCache.set(key, { exp: Date.now() + SUG_TTL_MS, data });
}

/**
 * Faza 12: re-materializare sugestii pentru o cheie (L2 → rollup/index-only
 * → L1 + L2). Folosită de foreground (miss) și background (stale revalidate).
 * Scrierile în cache respectă generația (invalidările le anulează).
 */
function sugRecompute(key: string, norm: string, limit: number): Promise<unknown> {
  const gen = cacheGeneration;
  const write = (titles: string[]): void => {
    if (gen !== cacheGeneration) return;
    sugSet(key, titles);
    void l2Set(key, titles);
  };
  return (async () => {
    // Faza 5: L2 distribuit — hit-rate crescut cross-instance la prefixe
    // repetitive de autocompletare (acoperă ~95% din traficul sub vârf)
    const l2 = await l2Get<string[]>(key, L2_TTL_SUG_SEC);
    if (l2 && Array.isArray(l2)) {
      if (gen === cacheGeneration) sugSet(key, l2);
      return l2;
    }

    const bucketKey = norm.slice(0, 3);

    // ===== Faza 6: ROLLUP (prefixe 1-3) — ranking pe POPULARITATE =====
    if (bucketKey.length <= 3) {
      const rows = await qRead<{ titles: string[]; stale: boolean }>(
        `SELECT titles,
                (refreshed_at < now() - interval '10 minutes') AS stale
         FROM suggest_rollup WHERE prefix_key = $1`,
        [bucketKey]
      );
      const row = rows[0];
      if (row && Array.isArray(row.titles) && row.titles.length > 0) {
        // stale-while-revalidate: intoarcem datele vechi imediat,
        // refresh-ul bucketului pleacă asincron (nu blochează cererea)
        if (row.stale) void refreshSuggestBucket(bucketKey);
        const titles = row.titles.slice(0, limit);
        write(titles);
        return titles;
      }
      // bucket lipsă (prefix nou-făcut / prima cerere): calcul țintit pe
      // bucketul exact + materializare în rollup (următoarele cereri → PK hit)
      const fresh = await refreshSuggestBucket(bucketKey);
      if (fresh.length > 0) {
        const titles = fresh.slice(0, limit);
        write(titles);
        return titles;
      }
      // zero potriviri — caching negativ scurt ca să nu batem la fiecare tastă
      if (gen === cacheGeneration) sugSet(key, []);
      return [];
    }

    // ===== Prefixe lungi (≥4): index-only scan, ranking alfabetic cu
    // EARLY TERMINATION pe Merge Append (≤limit rânduri per partiție).
    // La ≥4 caractere problema popularității e mai puțin relevantă (util.
    // a deja scris aproape tot cuvântul), iar agregarea completă pe 64
    // partiții rămâne prohibitivă la miliarde de rânduri — rollup-ul pe
    // bucket-e acoperă deja primul moment de decizie (primele 3 taste).=====
    const rows = await qRead<{ title: string }>(
      `SELECT DISTINCT title FROM content
       WHERE search_text LIKE $1 || '%'
       ORDER BY title LIMIT $2`,
      [norm, limit]
    );
    const titles = rows.map((r) => r.title);
    write(titles);
    return titles;
  })();
}

/** Faza 12: kick asincron de revalidare sugestii (single-flight prin sugInFlight). */
function kickSugRevalidate(key: string, norm: string, limit: number): void {
  if (sugInFlight.has(key)) return;
  const p = sugRecompute(key, norm, limit).catch(() => { /* stale rămâne servit */ });
  sugInFlight.set(key, p);
  void p.finally(() => {
    if (sugInFlight.get(key) === p) sugInFlight.delete(key);
  });
}

/**
 * Faza 12: re-materializare trending (L2 → search_stats → L1 + L2).
 */
function trendRecompute(key: string, limit: number): Promise<TrendItem[]> {
  const gen = cacheGeneration;
  return (async (): Promise<TrendItem[]> => {
    // Faza 5: și trendingul primește L2 distribuit (TTL 120s)
    const l2 = await l2Get<TrendItem[]>(key, L2_TTL_TREND_SEC);
    if (l2 && Array.isArray(l2)) {
      if (gen === cacheGeneration) sugSet(key, l2);
      return l2;
    }
    const rows = await qRead<Record<string, unknown>>(
      `SELECT norm, original, hits FROM search_stats ORDER BY hits DESC, last_at DESC LIMIT $1`,
      [limit]
    );
    const items = rows.map((r) => ({ norm: String(r.norm), original: String(r.original), hits: Number(r.hits) }));
    if (gen === cacheGeneration) {
      sugSet(key, items);
      void l2Set(key, items);
    }
    return items;
  })();
}

/** Faza 12: kick asincron de revalidare trending (single-flight). */
function kickTrendRevalidate(key: string, limit: number): void {
  if (sugInFlight.has(key)) return;
  const p = trendRecompute(key, limit).catch(() => { /* stale rămâne servit */ });
  sugInFlight.set(key, p);
  void p.finally(() => {
    if (sugInFlight.get(key) === p) sugInFlight.delete(key);
  });
}

export async function suggest(prefix: string, limit = 7): Promise<string[]> {
  const norm = normalizeRo(prefix);
  if (!norm) return [];
  const key = `sug:${norm}:${limit}`;
  const cached = sugGet<string[]>(key);
  if (cached) return cached;

  // Faza 12: STALE-WHILE-REVALIDATE — servim instant din stale,
  // re-materializarea pleacă asincron single-flight în fundal.
  const staleEntry = sugGetStaleEntry<string[]>(key);
  if (staleEntry) {
    kickSugRevalidate(key, norm, limit);
    return staleEntry;
  }

  // coalescing: cereri simultane identice partajează aceeași promisiune
  const pending = sugInFlight.get(key);
  if (pending) return pending as Promise<string[]>;

  const exec = sugRecompute(key, norm, limit);

  sugInFlight.set(key, exec);
  try {
    return await exec;
  } catch (e) {
    // Faza 9: stale-while-error pe sugestii — autocompletarea nu afișează
    // niciodată eroare; cade pe cache-ul vechi sau pe listă goală.
    const stale = sugGetStale<string[]>(key);
    if (stale) return stale;
    if (e instanceof AdmissionRejected || e instanceof DbUnavailable) {
      return [];
    }
    throw e;
  } finally {
    sugInFlight.delete(key);
  }
}

/**
 * Faza 6: recalcularea unui SINGUR bucket rollup (țintit, ieftin) +
 * materializare upsert. Returnează top-40 titluri noi ale bucketului.
 */
export async function refreshSuggestBucket(bucketKey: string): Promise<string[]> {
  try {
    const rows = await q<{ titles: string[] }>(
      `INSERT INTO suggest_rollup (prefix_key, titles, item_count, refreshed_at)
       SELECT $1,
              COALESCE(jsonb_agg(title ORDER BY pop DESC, views DESC, title) FILTER (WHERE rn <= 40), '[]'::jsonb),
              count(*) FILTER (WHERE rn <= 40),
              now()
       FROM (
         SELECT title, popularity AS pop, views,
                row_number() OVER (ORDER BY popularity DESC, views DESC, title ASC) AS rn
         FROM content
         WHERE search_text LIKE $1 || '%'
           AND title IS NOT NULL AND title <> ''
       ) b
       ON CONFLICT (prefix_key) DO UPDATE
         SET titles = EXCLUDED.titles, item_count = EXCLUDED.item_count, refreshed_at = now()
       RETURNING titles`,
      [bucketKey]
    );
    return Array.isArray(rows[0]?.titles) ? (rows[0].titles as string[]) : [];
  } catch {
    return []; // optim — sugestia cade pe L1/L2 sau pe path-ul vechi
  }
}

export type TrendItem = { norm: string; original: string; hits: number };

export async function trending(limit = 8): Promise<TrendItem[]> {
  const key = `trend:${limit}`;
  const cached = sugGet<TrendItem[]>(key);
  if (cached) return cached;
  // Faza 12: STALE-WHILE-REVALIDATE pe trending
  const staleEntry = sugGetStaleEntry<TrendItem[]>(key);
  if (staleEntry) {
    kickTrendRevalidate(key, limit);
    return staleEntry;
  }
  try {
    const items = await trendRecompute(key, limit);
    return items;
  } catch (e) {
    // Faza 9: trending NU crapă niciodată — stale sau gol
    const stale = sugGetStale<TrendItem[]>(key);
    if (stale) return stale;
    if (e instanceof AdmissionRejected || e instanceof DbUnavailable) {
      return [];
    }
    throw e;
  }
}

// ---------- Logging asincron (fire-and-forget, nu blochează răspunsul) ----------
// Faza 3: semafor cu coadă — logging-ul NU mai poate satura pool-ul Neon
// (max 2 scrieri concurente, coadă plafonată; sub vârf extrem se renunță
// la analitică, nu la răspunsul utilizatorului).
const LOG_MAX_ACTIVE = 2;
const LOG_MAX_QUEUE = 800;
let logActive = 0;
const logQueue: Array<() => Promise<void>> = [];

function pumpLog(): void {
  while (logActive < LOG_MAX_ACTIVE && logQueue.length > 0) {
    const job = logQueue.shift();
    if (!job) break;
    logActive++;
    job()
      .catch(() => { /* analitică — nu rupe nimic */ })
      .finally(() => {
        logActive--;
        pumpLog();
      });
  }
}

export function logSearch(
  query: string,
  resultsCount: number,
  durationMs: number,
  mode: string,
  userId?: string | null
): void {
  const norm = normalizeRo(query);
  if (!norm) return;
  if (logQueue.length >= LOG_MAX_QUEUE) return; // drop sub vârf extrem
  logQueue.push(async () => {
    await q(
      `INSERT INTO search_logs (query, norm, results_count, duration_ms, mode, user_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [query.slice(0, 200), norm, resultsCount, durationMs, mode, userId || null]
    );
    await q(`SELECT upsert_search_stat($1,$2,$3)`, [norm, query.slice(0, 120), resultsCount]);
  });
  pumpLog();
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

/** SQL de inserare conținut — IDENTIC pe toate shard-urile (schema comună). */
function contentInsertValues(c: NewContent): [string, unknown[]] {
  const search_text = normalizeRo(
    [c.title, c.originalTitle || "", c.description || "", (c.tags || []).join(" "), c.brand || "", c.contentType, c.category || "", c.provider].join(" ")
  );
  return [
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
    ],
  ];
}

/**
 * FAZA 15 — INSERARE RUTATĂ PE SHARD:
 * - hash(external_id) → shard activ (determinist, ponderat);
 * - shard remote → INSERT pe compute-ul lui + înregistrare în content_shard_map
 *   (external_id → shard_id + remote_id, pentru lookup-uri cross-compute);
 * - shard picat → FALLBACK pe primar (disponibilitate > plasament);
 * - 1 shard activ → calea clasică locală (comportament identic pre-Faza 15).
 */
export async function insertContent(c: NewContent): Promise<LibraryHit | null> {
  // dedup pe external_id la nivel de aplicație (partiționare hash nu permite unique global)
  const shard = await pickShardFor(c.externalId).catch(() => null);

  if (shard && shard.kind === "remote" && shard.dsn) {
    // dedup cross-compute: hartă de rutare → primar → shard-ul țintă
    const mapped = await shardMapLookup(c.externalId).catch(() => null);
    if (mapped) return null;
    const dupLocal = await qOne<{ id: number }>(`SELECT id FROM content WHERE external_id = $1 LIMIT 1`, [c.externalId]).catch(() => null);
    if (dupLocal) return null;
    const [sql, params] = contentInsertValues(c);
    try {
      const dupRemote = await shardQuery<{ id: number }>(shard, `SELECT id FROM content WHERE external_id = $1 LIMIT 1`, [c.externalId]);
      if (dupRemote[0]) {
        await shardMapUpsert(c.externalId, shard.id, Number(dupRemote[0].id));
        return null;
      }
      const rows = await shardQuery<Record<string, unknown>>(shard, sql, params);
      const hit = rows[0] ? mapHit(rows[0]) : null;
      if (hit) await shardMapUpsert(c.externalId, shard.id, hit.id);
      invalidateSearchCache("sl:");
      return hit;
    } catch (e) {
      console.error(`[shards] insert pe ${shard.name} eșuat, fallback pe primar:`, String(e).slice(0, 120));
      // cade pe calea locală de mai jos
    }
  }

  const [sql, params] = contentInsertValues(c);
  const rows = await q<Record<string, unknown>>(sql, params);
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
