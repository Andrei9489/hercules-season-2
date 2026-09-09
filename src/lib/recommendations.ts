// ============================================================
// FAZA 18b — RECOMANDĂRI v2 (era multi-shard + multi-region)
// Înlocuiește calea de recomandări din ai-engine.ts (Faza 7) care avea
// 3 lacune REALE constatate în producție:
//   1. BUG: interoga "History" cu coloane snake_case (h.user_id/h.media_id),
//      dar Neon are "userId"/"mediaId" → recomandările personalizate
//      eșuau (500) — confirmat live pe Neon (information_schema).
//   2. GAP: ruta primea EMAIL și filtra după el, deși "History"."userId"
//      stochează User.id (nu emailul) → zero potriviri.
//   3. GAP: vedea DOAR compute-ul primar — conținutul de pe shard-urile
//      remote (Faza 15) era invizibil pentru recomandări.
// v2 adaugă:
//   • rezolvare corectă userId (email → User.id) — în rută
//   • semnale profunde: History + Watchlist + Favorite (afinitate tip,
//     cuvinte-cheie din titluri, excludere TOT ce a interacționat)
//   • co-watch: „utilizatori cu gusturi asemănătoare" (self-join History)
//   • candidați CROSS-SHARD prin infrastructura de căutare (tsv pe toate
//     compute-urile active) + rezolvare ID-uri pe toate shard-urile
//   • L2 distribuit în Neon (ai_recommend_cache) — partajat între
//     instanțe, TTL 120s personal / 300s global, invalidare la scrieri
//   • jurnal recommend_log (observabilitate: mod, itemi, semnale, ms)
// Fără LLM — 100% SQL real pe Neon, scalează pe partiționarea existentă.
// ============================================================
import { q, qRead } from "@/lib/pg";
import { execOnAllShards, getActiveShards, shardQuery, type Shard } from "@/lib/shards";

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

type Row = Record<string, unknown>;

const REC_COLS = `c.id, c.title, c.content_type, c.description, c.thumbnail, c.backdrop, c.year, c.rating, c.views, c.popularity`;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "del", "las", "los", "una", "uno",
  "si", "de", "la", "le", "les", "un", "o", "pe", "in", "cu", "din", "da", "do", "of",
  "a", "an", "to", "is", "on", "it", "el", "en", "con", "por", "que", "se", "sua", "sau",
]);

function toRecItem(r: Row, shared: number, reason: string): RecItem {
  return {
    id: Number(r.id),
    title: String(r.title),
    contentType: String(r.content_type),
    description: String(r.description || "").slice(0, 220),
    thumbnail: (r.thumbnail as string) || null,
    backdrop: (r.backdrop as string) || null,
    year: (r.year as number) || null,
    rating: Number(r.rating || 0),
    views: Number(r.views || 0),
    shared,
    reason,
  };
}

/** cuvinte semnificative din titluri (pentru căutarea cross-shard) */
export function keywordsFromTitles(titles: string[], max = 6): string[] {
  const freq = new Map<string, number>();
  for (const t of titles) {
    for (const raw of String(t).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      const w = raw.trim();
      if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, max)
    .map(([w]) => w);
}

// ---------- L2 cache distribuit (Neon) ----------

type CachedRec = { items: RecItem[]; mode: string; computedAt: string; signals?: Row };

async function cacheRead(key: string): Promise<CachedRec | null> {
  try {
    const rows = await qRead<Row>(
      `SELECT payload FROM ai_recommend_cache WHERE cache_key = $1 AND expires_at > now()`,
      [key]
    );
    if (!rows.length) return null;
    return rows[0].payload as CachedRec;
  } catch {
    return null; // cache-ul nu blochează niciodată răspunsul
  }
}

async function cacheWrite(key: string, payload: CachedRec, ttlSec: number): Promise<void> {
  try {
    await q(
      `INSERT INTO ai_recommend_cache (cache_key, payload, expires_at)
       VALUES ($1, $2::jsonb, now() + ($3 || ' seconds')::interval)
       ON CONFLICT (cache_key) DO UPDATE
         SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at, created_at = now()`,
      [key, JSON.stringify(payload), String(ttlSec)]
    );
  } catch { /* best-effort */ }
}

async function logRec(key: string, userKey: string | null, mode: string, items: number, signals: Row, tookMs: number, cached: boolean): Promise<void> {
  try {
    await q(
      `INSERT INTO recommend_log (cache_key, user_key, mode, items, signals, took_ms, cached)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [key, userKey, mode, items, JSON.stringify(signals), tookMs, cached]
    );
  } catch { /* jurnalul nu blochează */ }
}

/** invalidare la scrieri user (istoric/watchlist/favorite/sync) */
export async function invalidateRecommendations(userId?: string): Promise<void> {
  try {
    if (userId) {
      await q(`DELETE FROM ai_recommend_cache WHERE cache_key LIKE $1`, [`rec:user:${userId}:%`]);
    } else {
      await q(`DELETE FROM ai_recommend_cache WHERE cache_key LIKE 'rec:%'`);
    }
  } catch { /* best-effort */ }
}

/**
 * FAZA 18 — invalidare GLOBALĂ la schimbări de bibliotecă (insertContent /
 * deleteContentByIds): fără ea, rec:global:* și rec:seed:* serveau 300s
 * conținut învechit după ingest (bug găsit în E2E). Recomandările per-user
 * rămân pe TTL scurt + invalidare la scrierile acelui user.
 */
export async function invalidateGlobalRecommendations(): Promise<void> {
  try {
    await q(`DELETE FROM ai_recommend_cache WHERE cache_key LIKE 'rec:global:%' OR cache_key LIKE 'rec:seed:%'`);
  } catch { /* best-effort */ }
}

// ---------- Semnale utilizator (Neon, coloane camelCase reale) ----------

export type UserSignals = {
  seedIds: number[];        // id-uri numerice de conținut (biblioteca)
  interactedIds: number[];  // TOT ce a interacționat userul — de exclus
  types: string[];          // afinitate tip (mediaType din History)
  keywords: string[];       // cuvinte din titlurile urmărite
  seedTitles: string[];     // titluri recente (pt. reason)
  hasSignals: boolean;
};

export async function getUserSignals(userId: string): Promise<UserSignals> {
  const [hist, wl, fav] = await Promise.all([
    qRead<Row>(
      `SELECT "mediaId", "mediaType", "title", "updatedAt" FROM "History"
       WHERE "userId" = $1 ORDER BY "updatedAt" DESC LIMIT 120`,
      [userId]
    ),
    qRead<Row>(`SELECT "mediaId" FROM "Watchlist" WHERE "userId" = $1 LIMIT 120`, [userId]),
    qRead<Row>(`SELECT "mediaId" FROM "Favorite" WHERE "userId" = $1 LIMIT 120`, [userId]),
  ]);

  const seedIds: number[] = [];
  const interacted = new Set<number>();
  const typesCount = new Map<string, number>();
  const titles: string[] = [];

  for (const h of hist) {
    const mid = String(h.mediaId || "");
    if (/^\d+$/.test(mid)) {
      const n = Number(mid);
      seedIds.push(n);
      interacted.add(n);
    }
    if (h.mediaType) typesCount.set(String(h.mediaType), (typesCount.get(String(h.mediaType)) || 0) + 1);
    if (h.title && titles.length < 12) titles.push(String(h.title));
  }
  for (const w of wl) if (/^\d+$/.test(String(w.mediaId))) interacted.add(Number(w.mediaId));
  for (const f of fav) if (/^\d+$/.test(String(f.mediaId))) interacted.add(Number(f.mediaId));

  const types = [...typesCount.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  return {
    seedIds: [...new Set(seedIds)].slice(0, 60),
    interactedIds: [...interacted],
    types,
    keywords: keywordsFromTitles(titles),
    seedTitles: titles.slice(0, 5),
    hasSignals: hist.length + wl.length + fav.length > 0,
  };
}

// ---------- Candidați CROSS-SHARD ----------

/** interogare identică pe TOATE compute-urile active + merge global */
export async function scatterCandidates(sql: string, params: unknown[]): Promise<Row[]> {
  const res = await execOnAllShards<Row[]>((shard: Shard) => shardQuery<Row>(shard, sql, params), 9_000);
  // executăm și pe primar ca cale standard (execOnAllShards include primarul
  // doar dacă e în registry activ — pe sandbox întotdeauna este)
  return res.results.flat();
}

/** candidați după cuvinte-cheie din titluri (tsv pe fiecare compute) */
export async function candidatesByKeywords(
  keywords: string[],
  types: string[],
  limit: number
): Promise<Row[]> {
  if (keywords.length === 0) return [];
  const typeFilter = types.length ? types : ["movie", "series", "live_tv", "radio", "music", "anime", "cartoon", "documentary"];
  // tsquery OR pe cuvinte: match parțial pe orice cuvânt semnificativ
  const tsquery = keywords.map((k) => `${k}:*`).join(" | ");
  const rows = await scatterCandidates(
    `SELECT ${REC_COLS}
     FROM content c
     WHERE c.content_type = ANY($1::text[])
       AND c.search_text @@ to_tsquery('simple', $2)
     ORDER BY c.popularity DESC, c.views DESC
     LIMIT $3`,
    [typeFilter, tsquery, limit]
  );
  return rows;
}

/** rezolvare ID-uri numerice pe TOATE compute-urile (fost bug: doar primar) */
export async function resolveIdsAcrossShards(ids: number[]): Promise<Row[]> {
  if (ids.length === 0) return [];
  const rows = await scatterCandidates(
    `SELECT ${REC_COLS} FROM content c WHERE c.id = ANY($1::bigint[])`,
    [ids]
  );
  return rows;
}

/** co-watch REAL (filtru colaborativ): media consumat de utilizatori care au
 *  suprapunere cu userul, EXCLUSD media pe care userul l-a văzut deja. */
export async function coWatchIds(userId: string, limit = 40): Promise<{ id: number; n: number }[]> {
  const rows = await qRead<Row>(
    `WITH my AS (
       SELECT DISTINCT "mediaId" FROM "History" WHERE "userId" = $1
     ),
     peers AS (
       SELECT DISTINCT h2."userId" AS pid
       FROM "History" h1
       JOIN "History" h2
         ON h1."mediaId" = h2."mediaId" AND h1."mediaType" = h2."mediaType"
       WHERE h1."userId" = $1 AND h2."userId" <> $1
     )
     SELECT h."mediaId" AS mid, count(DISTINCT h."userId")::int AS n
     FROM "History" h
     JOIN peers p ON h."userId" = p.pid
     WHERE h."mediaId" ~ '^[0-9]+$'
       AND NOT EXISTS (SELECT 1 FROM my m WHERE m."mediaId" = h."mediaId")
     GROUP BY h."mediaId"
     ORDER BY n DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows.map((r) => ({ id: Number(r.mid), n: Number(r.n) }));
}

// ---------- Dedup, scor, diversitate ----------

function dedupe(rows: Row[]): Map<string, Row> {
  const m = new Map<string, Row>();
  for (const r of rows) {
    const k = `${String(r.content_type)}:${String(r.title).toLowerCase().trim()}`;
    const cur = m.get(k);
    if (!cur || Number(r.popularity || 0) > Number(cur.popularity || 0)) m.set(k, r);
  }
  return m;
}

function diversify(items: RecItem[], limit: number): RecItem[] {
  const byType = new Map<string, RecItem[]>();
  for (const it of items) {
    (byType.get(it.contentType) || byType.set(it.contentType, []).get(it.contentType)!).push(it);
  }
  const out: RecItem[] = [];
  let added = true;
  while (out.length < limit && added) {
    added = false;
    for (const arr of byType.values()) {
      if (arr.length) {
        out.push(arr.shift()!);
        added = true;
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

// ---------- API PUBLIC v2 ----------

/** GLOBAL: top diversificat pe tipuri, colectat de pe TOATE compute-urile active. */
export async function recommendGlobalV2(limit = 10): Promise<CachedRec> {
  const key = `rec:global:${limit}`;
  const hit = await cacheRead(key);
  if (hit) return { ...hit, mode: "global" };

  const t0 = Date.now();
  const rows = await scatterCandidates(
    `SELECT * FROM (
       SELECT ${REC_COLS},
              row_number() OVER (PARTITION BY c.content_type ORDER BY c.popularity DESC, c.views DESC) AS rn
       FROM content c
       WHERE c.content_type IN ('movie','series','live_tv','radio','music','anime','cartoon','documentary')
     ) t WHERE t.rn <= 2
     ORDER BY popularity DESC LIMIT $1`,
    [Math.min(60, limit * 4)]
  );
  const merged = [...dedupe(rows).values()];
  const items = diversify(
    merged.map((r) => toRecItem(r, 0, "popular acum pe platformă")),
    limit
  );
  const payload: CachedRec = { items, mode: "global", computedAt: new Date().toISOString() };
  await cacheWrite(key, payload, 300);
  await logRec(key, null, "global", items.length, { shards: true }, Date.now() - t0, false);
  return payload;
}

/** PERSONALIZAT: semnale reale + genuri (primar) + co-watch + cross-shard. */
export async function recommendForUserV2(userId: string, limit = 10): Promise<CachedRec> {
  const key = `rec:user:${userId}:${limit}`;
  const hit = await cacheRead(key);
  if (hit) return { ...hit, mode: hit.mode || "personal" };

  const t0 = Date.now();
  const sig = await getUserSignals(userId);
  if (!sig.hasSignals) {
    const g = await recommendGlobalV2(limit);
    return { ...g, mode: "global" };
  }

  // 1) candidați din genuri (taxonomia e pe primar; SQL-ul vechi REPARAT camelCase nu e cazul aici — content_genres e pe primar, intact)
  let genreRows: Row[] = [];
  if (sig.seedIds.length > 0) {
    try {
      genreRows = await qRead<Row>(
        `WITH seed AS (
           SELECT DISTINCT cg.genre_id
           FROM content_genres cg
           JOIN genres g ON g.id = cg.genre_id
           WHERE cg.content_id = ANY($1::bigint[]) AND g.kind IN ('genre','franchise','collection','trilogy')
         )
         SELECT ${REC_COLS}, count(DISTINCT cg.genre_id)::int AS shared
         FROM content_genres cg
         JOIN seed s ON s.genre_id = cg.genre_id
         JOIN content c ON c.id = cg.content_id
         GROUP BY c.id
         ORDER BY shared DESC, c.popularity DESC, c.views DESC
         LIMIT $2`,
        [sig.seedIds, limit * 3]
      );
    } catch { /* taxonomia poate lipsi — continuăm cu restul semnalelor */ }
  }

  // 2) co-watch (utilizatori cu gusturi asemănătoare)
  const cw = await coWatchIds(userId, 40);
  const cwIds = cw.filter((x) => !sig.interactedIds.includes(x.id)).map((x) => x.id);
  const cwRows = await resolveIdsAcrossShards(cwIds.slice(0, 20));
  const cwBoost = new Map(cw.map((x) => [x.id, x.n]));

  // 3) candidați cross-shard după cuvinte-cheie din titluri + afinitate tip
  const kwRows = await candidatesByKeywords(sig.keywords, sig.types, limit * 3);

  // 4) scor compus + excludere tot ce a interacționat userul
  const poolMap = dedupe([...genreRows, ...kwRows, ...cwRows]);
  const typeAff = new Map(sig.types.map((t, i) => [t, sig.types.length - i]));
  const scored: { item: RecItem; score: number }[] = [];
  for (const [k, r] of poolMap) {
    if (sig.interactedIds.includes(Number(r.id))) continue;
    const id = Number(r.id);
    const shared = Number(r.shared || 0);
    const cwN = cwBoost.get(id) || 0;
    const typeA = typeAff.get(String(r.content_type)) || 0;
    const kwShare = sig.keywords.length
      ? sig.keywords.filter((w) => String(r.title).toLowerCase().includes(w)).length
      : 0;
    const score = shared * 3 + cwN * 4 + typeA * 2 + kwShare * 2 + Number(r.popularity || 0) / 100;
    let reason = "selectat de AI pentru tine";
    if (cwN > 0) reason = "utilizatori cu gusturi asemănătoare au urmărit";
    else if (shared > 0) reason = "din genurile tale preferate";
    else if (kwShare > 0) reason = `similar cu „${sig.seedTitles[0] || "istoricul tău"}"`;
    else if (typeA > 0) reason = `te uiți des: ${String(r.content_type)}`;
    void k;
    scored.push({ item: toRecItem(r, shared || cwN, reason), score });
  }

  // sortare după scor compus → diversificare pe tipuri
  scored.sort((a, b) => b.score - a.score);
  const items = diversify(scored.map((s) => s.item), limit);

  const mode = "personal";
  const payload: CachedRec = {
    items,
    mode,
    computedAt: new Date().toISOString(),
    signals: {
      seeds: sig.seedIds.length,
      interacted: sig.interactedIds.length,
      types: sig.types.slice(0, 4),
      keywords: sig.keywords.slice(0, 6),
      coWatch: cwIds.length,
      genreCandidates: genreRows.length,
      keywordCandidates: kwRows.length,
    },
  };
  await cacheWrite(key, payload, 120);
  await logRec(key, userId, mode, items.length, payload.signals as Row, Date.now() - t0, false);
  return payload;
}

/** SEED: similar cu un conținut (genuri pe primar + cuvinte-titlu cross-shard). */
export async function recommendBySeedV2(seedId: number, limit = 8): Promise<CachedRec> {
  const key = `rec:seed:${seedId}:${limit}`;
  const hit = await cacheRead(key);
  if (hit) return { ...hit, mode: "seed" };

  const t0 = Date.now();
  const seedRows = await resolveIdsAcrossShards([seedId]);
  const seed = seedRows[0];

  let rows: Row[] = [];
  let reason = "similar cu";
  try {
    rows = await qRead<Row>(
      `WITH seed AS (
         SELECT cg.genre_id FROM content_genres cg
         JOIN genres g ON g.id = cg.genre_id
         WHERE cg.content_id = $1 AND g.kind IN ('genre','franchise','collection','trilogy')
       )
       SELECT ${REC_COLS}, count(DISTINCT cg.genre_id)::int AS shared
       FROM content_genres cg
       JOIN seed s ON s.genre_id = cg.genre_id
       JOIN content c ON c.id = cg.content_id AND c.id <> $1
       JOIN genres g ON g.id = cg.genre_id
       GROUP BY c.id
       ORDER BY shared DESC, c.popularity DESC, c.views DESC
       LIMIT $2`,
      [seedId, limit]
    );
  } catch { /* fără taxonomie → treapta keyword */ }

  if (rows.length === 0 && seed) {
    const kws = keywordsFromTitles([String(seed.title)]);
    rows = await candidatesByKeywords(kws, [String(seed.content_type)], limit + 2);
    rows = rows.filter((r) => Number(r.id) !== seedId);
    reason = "asemănător titlului";
  }

  const items = rows.length
    ? diversify(rows.map((r) => toRecItem(r, Number(r.shared || 0), `${reason} „${seed?.title || "selectat"}"`)), limit)
    : (await recommendGlobalV2(limit)).items;

  const payload: CachedRec = { items, mode: "seed", computedAt: new Date().toISOString() };
  await cacheWrite(key, payload, 300);
  await logRec(key, null, "seed", items.length, { seedId }, Date.now() - t0, false);
  return payload;
}

/** stare pentru /api/status (procente recomandări) */
export async function recommendStats(): Promise<{ cached: number; lastRuns: Row[] }> {
  try {
    const [c, l] = await Promise.all([
      qRead<Row>(`SELECT count(*)::int AS n FROM ai_recommend_cache WHERE expires_at > now()`),
      qRead<Row>(`SELECT mode, items, took_ms, cached, created_at FROM recommend_log ORDER BY id DESC LIMIT 5`),
    ]);
    return { cached: Number(c[0].n || 0), lastRuns: l };
  } catch {
    return { cached: 0, lastRuns: [] };
  }
}
