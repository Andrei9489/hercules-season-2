#!/usr/bin/env python3
# Faza 12: refactor suggest() + trending() — SWR background revalidate
p = "/home/z/my-project/src/lib/neon-search.ts"
src = open(p).read()

def replace_once(s, old, new, label):
    i = s.find(old)
    if i < 0:
        raise SystemExit(f"ANCHOR NEGĂSIT: {label}")
    if s.find(old, i + 1) >= 0:
        raise SystemExit(f"ANCHOR DUPLICAT: {label}")
    return s[:i] + new + s[i + len(old):]

# ---- 1. sugGetStaleEntry după sugGetStale ----
old1 = """/** Faza 9: varianta stale — servește și intrări expirate la eșec DB. */
function sugGetStale<T>(key: string): T | null {
  const hit = sugCache.get(key);
  return hit ? (hit.data as T) : null;
}"""
new1 = """/** Faza 9: varianta stale — servește și intrări expirate la eșec DB. */
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
}"""
src = replace_once(src, old1, new1, "sugGetStaleEntry")

# ---- 2. suggest: SWR + apel sugRecompute ----
old2 = """  const key = `sug:${norm}:${limit}`;
  const cached = sugGet<string[]>(key);
  if (cached) return cached;

  // coalescing: cereri simultane identice partajează aceeași promisiune
  const pending = sugInFlight.get(key);
  if (pending) return pending as Promise<string[]>;

  const exec = (async () => {"""
new2 = """  const key = `sug:${norm}:${limit}`;
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

  const exec = sugRecompute(key, norm, limit);"""
src = replace_once(src, old2, new2, "suggest body start")

# ---- 3. scoate corpul inline al exec din suggest (de la L2 până la return titles) ----
i = src.find("  const exec = sugRecompute(key, norm, limit);")
if i < 0:
    raise SystemExit("nu am găsit apelul sugRecompute")
start_after = i + len("  const exec = sugRecompute(key, norm, limit);")
# corpul vechi continuă imediat după apel până la "  })();" inclusiv
j = src.find("  })();", start_after)
if j < 0:
    raise SystemExit("sfârșit exec negăsit")
j += len("  })();")
src = src[:start_after] + src[j:]

# ---- 4. adaugă sugRecompute + kickSugRevalidate după sugSet ----
old4 = """function sugSet(key: string, data: unknown): void {
  if (sugCache.size >= SUG_MAX) {
    const oldest = sugCache.keys().next().value;
    if (oldest) sugCache.delete(oldest);
  }
  sugCache.set(key, { exp: Date.now() + SUG_TTL_MS, data });
}"""
new4 = """function sugSet(key: string, data: unknown): void {
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
}"""
src = replace_once(src, old4, new4, "sugRecompute insert")

# ---- 5. trending: SWR + trendRecompute ----
old5 = """export async function trending(limit = 8): Promise<TrendItem[]> {
  const key = `trend:${limit}`;
  const cached = sugGet<TrendItem[]>(key);
  if (cached) return cached;
  try {
  // Faza 5: și trendingul primește L2 distribuit (TTL 120s)
  const l2 = await l2Get<TrendItem[]>(key, L2_TTL_TREND_SEC);
  if (l2 && Array.isArray(l2)) {
    sugSet(key, l2);
    return l2;
  }
  const rows = await qRead<Record<string, unknown>>(
    `SELECT norm, original, hits FROM search_stats ORDER BY hits DESC, last_at DESC LIMIT $1`,
    [limit]
  );
  const items = rows.map((r) => ({ norm: String(r.norm), original: String(r.original), hits: Number(r.hits) }));
  sugSet(key, items);
  void l2Set(key, items);
  return items;
  } catch (e) {"""
new5 = """export async function trending(limit = 8): Promise<TrendItem[]> {
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
  } catch (e) {"""
src = replace_once(src, old5, new5, "trending body")

open(p, "w").write(src)
print("Refactor suggest + trending aplicat complet")
