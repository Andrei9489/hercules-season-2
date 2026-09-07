// ============================================================
// Faza 5 — Ingest INDUSTRIAL v5: expandare bibliotecă spre 10-12K
// Job-uri NOI (pagini negestionate în v4): genuri film/serial,
// studiouri de animație, cinema internațional extins (RO/TR/IN/
// nordic), anime TV/filme TMDB, documentare, kids, muzică.
// Worker-pool paralel x6, retry, dedup intern + vs. bibliotecă,
// batch insert 50/chunk x2 worker-e, ANALYZE final + invalidare L2.
// Rulează: bun scripts/ingest-fanout-v5.ts (idempotent — dedup external_id)
// ============================================================
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";
import dns from "node:dns";

// Sandbox: routing IPv6 defect către unele hosts — forțăm IPv4-first
try { dns.setDefaultResultOrder("ipv4first"); } catch { /* noop */ }

neonConfig.webSocketConstructor = WebSocket;
const url =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const pool = new Pool({ connectionString: url });

const TMDB = process.env.TMDB_API_KEY || "3dd880e229e7b83d8e63c4b6f08f77a4";
const BASE = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w500";
const BIMG = "https://image.tmdb.org/t/p/w1280";
const t0 = Date.now();

type Row = {
  external_id: string; title: string; original_title?: string; description: string;
  content_type: string; brand?: string; category?: string; continent?: string; country?: string;
  language?: string; provider: string; source_type: string; source_url?: string; embed_code?: string;
  thumbnail?: string; backdrop?: string; year?: number; rating?: number; popularity?: number;
  tags: string[]; meta?: Record<string, unknown>;
};

type Job = {
  path: string;
  params: Record<string, string>;
  type: string;
  brand?: string;
  category?: string;
  tags?: string[];
  pages: number;
  continent?: string;
  country?: string;
};

function normalizeRo(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchJson<T>(u: string, retries = 2): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 12_000);
      const res = await fetch(u, { signal: ctl.signal, cache: "no-store" });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch {
      if (i < retries) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  return null;
}

// ---------- JOB-URI NOI (Faza 5 — dedup față de Faza 4 prin pagini/genuri) ----------
const jobs: Job[] = [];
function add(j: Omit<Job, "pages">, pages: number) { jobs.push({ ...j, pages }); }

// continuări popular/top-rated (paginile următoare față de Faza 4)
add({ path: "/discover/movie", params: { sort_by: "popularity.desc", "vote_count.gte": "100" }, type: "movie", category: "movie", tags: ["popular"] }, 25);
add({ path: "/discover/movie", params: { sort_by: "vote_average.desc", "vote_count.gte": "3000" }, type: "movie", category: "movie", tags: ["top-rated"] }, 15);
add({ path: "/discover/tv", params: { sort_by: "popularity.desc", "vote_count.gte": "50" }, type: "series", category: "series", tags: ["popular"] }, 20);
add({ path: "/discover/tv", params: { sort_by: "vote_average.desc", "vote_count.gte": "1000" }, type: "series", category: "series", tags: ["top-rated"] }, 15);

// genuri film NOI (horror, thriller, sci-fi, romantic, crime, western, război, mister, familie, fantezie, aventură, istoric, comedie, dramă, acțiune)
const MOVIE_GENRES: [string, string][] = [
  ["27", "horror"], ["53", "thriller"], ["878", "sci-fi"], ["10749", "romantic"],
  ["80", "crime"], ["37", "western"], ["10752", "razboi"], ["9648", "mister"],
  ["10751", "familie"], ["14", "fantezie"], ["12", "aventura"], ["36", "istoric"],
  ["35", "comedie"], ["18", "drama"], ["28", "actiune"],
];
for (const [g, cat] of MOVIE_GENRES) {
  add({ path: "/discover/movie", params: { with_genres: g, sort_by: "popularity.desc", "vote_count.gte": "150" }, type: "movie", category: cat, tags: [cat] }, 6);
}
// genuri serial NOI
const TV_GENRES: [string, string][] = [
  ["18", "drama"], ["35", "comedie"], ["80", "crime"], ["10765", "sci-fi"],
  ["10759", "actiune-aventura"], ["9648", "mister"],
];
for (const [g, cat] of TV_GENRES) {
  add({ path: "/discover/tv", params: { with_genres: g, sort_by: "popularity.desc", "vote_count.gte": "80" }, type: "series", category: cat, tags: [cat, "tv"] }, 5);
}

// studiouri de animație (branduri noi)
add({ path: "/discover/movie", params: { with_companies: "521", sort_by: "popularity.desc" }, type: "cartoon", brand: "dreamworks", category: "dreamworks", tags: ["dreamworks", "animatie"] }, 4);
add({ path: "/discover/movie", params: { with_companies: "6704", sort_by: "popularity.desc" }, type: "cartoon", brand: "illumination", category: "illumination", tags: ["illumination", "animatie"] }, 3);
add({ path: "/discover/movie", params: { with_companies: "2251", sort_by: "popularity.desc" }, type: "cartoon", brand: "sony-animation", category: "sony-animation", tags: ["sony", "animatie"] }, 3);
add({ path: "/discover/movie", params: { with_companies: "128274", sort_by: "popularity.desc" }, type: "cartoon", brand: "warner-animation", category: "warner-animation", tags: ["warner", "animatie"] }, 3);

// anime TMDB (TV + filme, origin JP)
add({ path: "/discover/tv", params: { with_genres: "16", with_origin_country: "JP", sort_by: "popularity.desc" }, type: "anime", category: "anime", tags: ["anime", "tv"] }, 8);
add({ path: "/discover/movie", params: { with_genres: "16", with_origin_country: "JP", sort_by: "popularity.desc", "vote_count.gte": "60" }, type: "anime", category: "anime", tags: ["anime", "film"] }, 6);

// telenovele continuare (p11-16) + dizi turcești (fenomen global)
add({ path: "/discover/tv", params: { with_genres: "10766", sort_by: "popularity.desc" }, type: "telenovela", category: "telenovela", tags: ["telenovela"] }, 6);
add({ path: "/discover/tv", params: { with_origin_country: "TR", sort_by: "popularity.desc", "vote_count.gte": "20" }, type: "series", category: "dizi", tags: ["dizi", "turcia"], continent: "Asia", country: "tr" }, 10);
// telenovele latino explicit (MX/BR/AR/CO)
for (const [cc, cont] of [["MX", "America de Nord"], ["BR", "America de Sud"], ["AR", "America de Sud"], ["CO", "America de Sud"]] as const) {
  add({ path: "/discover/tv", params: { with_genres: "10766", with_origin_country: cc, sort_by: "popularity.desc" }, type: "telenovela", category: "telenovela", tags: ["telenovela", "latino"], continent: cont, country: cc.toLowerCase() }, 3);
}

// România extins (filme + seriale)
add({ path: "/discover/movie", params: { with_origin_country: "RO", sort_by: "popularity.desc" }, type: "movie", category: "cinema-ro", tags: ["romania"], continent: "Europa", country: "ro" }, 6);
add({ path: "/discover/tv", params: { with_origin_country: "RO", sort_by: "popularity.desc" }, type: "series", category: "cinema-ro", tags: ["romania", "tv"], continent: "Europa", country: "ro" }, 4);

// Bollywood + cinema asiatic extins
add({ path: "/discover/movie", params: { with_origin_country: "IN", sort_by: "popularity.desc", "vote_count.gte": "80" }, type: "movie", category: "bollywood", tags: ["bollywood"], continent: "Asia", country: "in" }, 8);
add({ path: "/discover/tv", params: { with_origin_country: "IN", sort_by: "popularity.desc" }, type: "series", category: "bollywood", tags: ["bollywood", "tv"], continent: "Asia", country: "in" }, 4);
add({ path: "/discover/movie", params: { with_origin_country: "CN", sort_by: "popularity.desc", "vote_count.gte": "100" }, type: "movie", category: "cinema-cn", tags: ["china"], continent: "Asia", country: "cn" }, 5);

// nordic (SE/NO/DK)
for (const [cc, cname] of [["SE", "se"], ["NO", "no"], ["DK", "dk"]] as const) {
  add({ path: "/discover/movie", params: { with_origin_country: cc, sort_by: "popularity.desc", "vote_count.gte": "40" }, type: "movie", category: `cinema-${cname}`, tags: ["nordic"], continent: "Europa", country: cname }, 3);
  add({ path: "/discover/tv", params: { with_origin_country: cc, sort_by: "popularity.desc", "vote_count.gte": "20" }, type: "series", category: `cinema-${cname}`, tags: ["nordic", "tv"], continent: "Europa", country: cname }, 2);
}

// documentare / kids / muzică — continuări pagini noi
add({ path: "/discover/movie", params: { with_genres: "99", sort_by: "popularity.desc" }, type: "documentary", category: "documentar", tags: ["documentar"] }, 8);
add({ path: "/discover/tv", params: { with_genres: "99", sort_by: "popularity.desc" }, type: "documentary", category: "documentar", tags: ["documentar"] }, 6);
add({ path: "/discover/tv", params: { with_genres: "10762", sort_by: "popularity.desc" }, type: "cartoon", category: "kids", tags: ["kids"] }, 6);
add({ path: "/discover/movie", params: { with_genres: "10402", sort_by: "popularity.desc" }, type: "music", category: "muzica", tags: ["muzica"] }, 5);

// ---------- MAPARE TMDB → rând Neon ----------
const rows: Row[] = [];
let fetched = 0, fetchErrs = 0;

function mapTmdb(r: Record<string, unknown>, j: Job): void {
  const id = r.id as number;
  const title = (r.title || r.name) as string;
  if (!id || !title) return;
  const date = ((r.release_date || r.first_air_date) as string) || "";
  rows.push({
    external_id: `tmdb:${j.type}:${id}`,
    title,
    original_title: (r.original_title || r.original_name) as string,
    description: ((r.overview as string) || "").slice(0, 900),
    content_type: j.type,
    brand: j.brand,
    category: j.category || j.type,
    continent: j.continent || "Global",
    country: j.country,
    language: (r.original_language as string) || "en",
    provider: "tmdb", source_type: "none",
    thumbnail: r.poster_path ? `${IMG}${r.poster_path}` : undefined,
    backdrop: r.backdrop_path ? `${BIMG}${r.backdrop_path}` : undefined,
    year: date ? Number(date.slice(0, 4)) : undefined,
    rating: (r.vote_average as number) || 0,
    popularity: Math.round((r.popularity as number) || 0),
    tags: j.tags || [],
    meta: { tmdbId: id, tmdbType: j.path.endsWith("/tv") ? "tv" : "movie" },
  });
}

// ---------- WORKER POOL paralel (x6, Faza 5) ----------
const CONCURRENCY = 6;
type Task = { job: Job; page: number };
const tasks: Task[] = [];
for (const job of jobs) {
  for (let p = 1; p <= job.pages; p++) tasks.push({ job, page: p });
}

async function worker(id: number): Promise<void> {
  while (tasks.length > 0) {
    const t = tasks.shift();
    if (!t) break;
    const qs = new URLSearchParams({ api_key: TMDB, language: "ro-RO", page: String(t.page), ...t.job.params });
    const data = await fetchJson<{ results?: Record<string, unknown>[] }>(`${BASE}${t.job.path}?${qs}`);
    if (data?.results) {
      fetched += data.results.length;
      for (const r of data.results) mapTmdb(r, t.job);
    } else {
      fetchErrs++;
    }
  }
}

// ---------- RUN ----------
console.log(`Ingest Faza 5: ${jobs.length} job-uri • ${tasks.length} cereri paralele (x${CONCURRENCY})`);

async function main() {
  const tFetch0 = Date.now();
  const totalTasks = tasks.length;
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  const fetchMs = Date.now() - tFetch0;

  // dedup intern
  const seen = new Set<string>();
  const unique = rows.filter((r) => (seen.has(r.external_id) ? false : (seen.add(r.external_id), true)));

  // dedup față de biblioteca existentă
  const existing = await pool.query(`SELECT external_id FROM content`);
  const have = new Set((existing.rows as { external_id: string }[]).map((e) => e.external_id));
  const toInsert = unique.filter((r) => !have.has(r.external_id));

  console.log(`Fetch: ${fetched} itemi din ${totalTasks} cereri în ${(fetchMs / 1000).toFixed(1)}s (${(totalTasks / (fetchMs / 1000)).toFixed(1)} req/s) • erori: ${fetchErrs}`);
  console.log(`Colectate: ${rows.length} • unice: ${unique.length} • noi de inserat: ${toInsert.length}`);

  // ---------- Batch insert paralel (2 worker-e, chunk 50) ----------
  const COLS = 22;
  const SQLBASE = `INSERT INTO content
    (external_id, title, original_title, description, content_type, brand, category, continent, country, language, provider, source_type, source_url, embed_code, thumbnail, backdrop, year, rating, popularity, tags, search_text, meta) VALUES `;

  const chunks: Row[][] = [];
  for (let i = 0; i < toInsert.length; i += 50) chunks.push(toInsert.slice(i, i + 50));

  let ins = 0, errs = 0;
  const tIns0 = Date.now();
  async function insertWorker(): Promise<void> {
    while (chunks.length > 0) {
      const chunk = chunks.shift();
      if (!chunk) break;
      const params: unknown[] = [];
      const tuples = chunk.map((r, i) => {
        const st = normalizeRo([
          r.title, r.original_title || "", r.description,
          (r.tags || []).join(" "), r.brand || "", r.content_type, r.category || "", r.provider,
        ].join(" "));
        const vals = [
          r.external_id, r.title, r.original_title || null, r.description || "",
          r.content_type, r.brand || null, r.category || null, r.continent || "Global",
          r.country || null, r.language || "en", r.provider, r.source_type,
          r.source_url || null, r.embed_code || null, r.thumbnail || null, r.backdrop || null,
          r.year || null, r.rating || 0, r.popularity || 0, r.tags || [], st, JSON.stringify(r.meta || {}),
        ];
        vals.forEach((v) => params.push(v));
        const ph = Array.from({ length: COLS }, (_, c) => `$${i * COLS + c + 1}`).join(",");
        return `(${ph})`;
      });
      try {
        await pool.query(SQLBASE + tuples.join(","), params);
        ins += chunk.length;
      } catch {
        // fallback rând-cu-rând
        for (const r of chunk) {
          const st = normalizeRo([
            r.title, r.original_title || "", r.description,
            (r.tags || []).join(" "), r.brand || "", r.content_type, r.category || "", r.provider,
          ].join(" "));
          try {
            await pool.query(SQLBASE + "($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)", [
              r.external_id, r.title, r.original_title || null, r.description || "",
              r.content_type, r.brand || null, r.category || null, r.continent || "Global",
              r.country || null, r.language || "en", r.provider, r.source_type,
              r.source_url || null, r.embed_code || null, r.thumbnail || null, r.backdrop || null,
              r.year || null, r.rating || 0, r.popularity || 0, r.tags || [], st, JSON.stringify(r.meta || {}),
            ]);
            ins++;
          } catch { errs++; }
        }
      }
    }
  }
  await Promise.all([insertWorker(), insertWorker()]);
  const insMs = Date.now() - tIns0;

  // ---------- Post-ingest: ANALYZE + invalidare cache L2 distribuit ----------
  try {
    await pool.query(`ANALYZE content`);
    await pool.query(`DELETE FROM search_cache WHERE key LIKE 'sl:%' OR key LIKE 'sug:%' OR key LIKE 'trend:%'`);
    console.log(`ANALYZE content + invalidare L2 distribuită OK`);
  } catch (e) { console.log(`Post-ingest warn: ${String(e).slice(0, 120)}`); }

  // ---------- Raport final ----------
  const cnt = await pool.query(
    `SELECT count(*)::int AS total,
            count(DISTINCT content_type)::int AS types,
            count(DISTINCT provider)::int AS providers,
            count(DISTINCT country)::int AS countries
     FROM content`
  );
  const byType = await pool.query(`SELECT content_type, count(*)::int AS n FROM content GROUP BY content_type ORDER BY n DESC`);
  const totalSec = (Date.now() - t0) / 1000;
  console.log(`\nIngest complet în ${totalSec.toFixed(1)}s: ${ins} inserate (${(ins / (insMs / 1000)).toFixed(0)} rows/s insert) • ${errs} erori`);
  console.log(`Total bibliotecă Neon: ${cnt.rows[0].total} conținuturi • ${cnt.rows[0].types} tipuri • ${cnt.rows[0].providers} provideri • ${cnt.rows[0].countries} țări`);
  console.log(byType.rows.map((r: { content_type: string; n: number }) => `${r.content_type}:${r.n}`).join(" | "));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
