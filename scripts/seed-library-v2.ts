// ============================================================
// Seed v2 — expandare bibliotecă Neon cu conținut REAL
// (~500+ itemi: filme, seriale, anime, documentare, telenovele,
//  desene, cinema internațional, muzică & sport YouTube)
// Rulează: bun scripts/seed-library-v2.ts (idempotent — dedup external_id)
// ============================================================
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket;
const url =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const pool = new Pool({ connectionString: url });

const TMDB = process.env.TMDB_API_KEY || "3dd880e229e7b83d8e63c4b6f08f77a4";
const YTK = process.env.YOUTUBE_API_KEY || "AIzaSyAWJ0f6XdhPb3fJL6EYjB5ZamaoM1ZT1XM";
const IMG = "https://image.tmdb.org/t/p/w500";
const BIMG = "https://image.tmdb.org/t/p/w1280";

type Row = {
  external_id: string; title: string; original_title?: string; description: string;
  content_type: string; brand?: string; category?: string; continent?: string; country?: string;
  language?: string; provider: string; source_type: string; source_url?: string; embed_code?: string;
  thumbnail?: string; backdrop?: string; year?: number; rating?: number; popularity?: number;
  tags: string[]; meta?: Record<string, unknown>;
};

export function normalizeRo(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchJson<T>(u: string, retries = 2): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 12000);
      const res = await fetch(u, { signal: ctl.signal, cache: "no-store" });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch {
      if (i < retries) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  return null;
}

const rows: Row[] = [];

function fromTmdb(r: Record<string, unknown>, o: Partial<Row> & { content_type: string }): void {
  const id = r.id as number;
  const title = (r.title || r.name) as string;
  const date = ((r.release_date || r.first_air_date) as string) || "";
  rows.push({
    external_id: `tmdb:${o.content_type}:${id}`,
    title,
    original_title: (r.original_title || r.original_name) as string,
    description: ((r.overview as string) || "").slice(0, 900),
    content_type: o.content_type,
    brand: o.brand,
    category: o.category || o.content_type,
    continent: o.continent || "Global",
    country: o.country,
    language: (r.original_language as string) || "en",
    provider: "tmdb", source_type: "none",
    thumbnail: r.poster_path ? `${IMG}${r.poster_path}` : undefined,
    backdrop: r.backdrop_path ? `${BIMG}${r.backdrop_path}` : undefined,
    year: date ? Number(date.slice(0, 4)) : undefined,
    rating: (r.vote_average as number) || 0,
    popularity: Math.round((r.popularity as number) || 0),
    tags: o.tags || [],
    meta: { tmdbId: id, tmdbType: o.content_type === "series" || o.content_type === "telenovela" ? "tv" : "movie" },
  });
}

// cereri TMDB în serie cu pauză mică (rate-limit friendly)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tmdbPages(
  path: string,
  pages: number[],
  opt: Partial<Row> & { content_type: string },
  perPage = 20
): Promise<void> {
  for (const p of pages) {
    const d = await fetchJson<{ results: Record<string, unknown>[] }>(
      `${path}${path.includes("?") ? "&" : "?"}api_key=${TMDB}&page=${p}`
    );
    d?.results?.slice(0, perPage).forEach((r) => fromTmdb(r, opt));
    await sleep(250);
  }
}

async function main() {
  const t0 = Date.now();
  console.log("Seed v2 — expandare bibliotecă Neon…");

  // ---- 1. Filme populare, paginile 2-5 (80) ----
  await tmdbPages(`https://api.themoviedb.org/3/movie/popular`, [2, 3, 4, 5], { content_type: "movie", category: "film", tags: ["film"] });
  console.log("  filme populare p2-5:", rows.length);

  // ---- 2. Seriale populare, paginile 2-5 (80) ----
  await tmdbPages(`https://api.themoviedb.org/3/tv/popular`, [2, 3, 4, 5], { content_type: "series", category: "serial", tags: ["serial"] });
  console.log("  + seriale:", rows.length);

  // ---- 3. Filme top-rated, paginile 1-2 (40) ----
  await tmdbPages(`https://api.themoviedb.org/3/movie/top_rated`, [1, 2], { content_type: "movie", category: "film", tags: ["top", "clasice"] });
  console.log("  + top-rated:", rows.length);

  // ---- 4. Documentare, paginile 2-4 (60) ----
  await tmdbPages(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_genres=99&sort_by=popularity.desc`, [2, 3, 4], { content_type: "documentary", category: "documentar", tags: ["documentar"] });
  console.log("  + documentare:", rows.length);

  // ---- 5. Telenovele, paginile 2-3 (40) ----
  await tmdbPages(`https://api.themoviedb.org/3/discover/tv?api_key=${TMDB}&with_genres=10766&sort_by=popularity.desc`, [2, 3], { content_type: "telenovela", category: "telenovelă", tags: ["telenovelă", "dramă"] });
  console.log("  + telenovele:", rows.length);

  // ---- 6. Animație de familie, paginile 1-3 (60) ----
  await tmdbPages(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_genres=16&sort_by=popularity.desc`, [1, 2, 3], { content_type: "cartoon", category: "desene", tags: ["animație", "familie"] });
  console.log("  + animație:", rows.length);

  // ---- 7. Universuri: Marvel TV (10) + DC TV (10) ----
  await tmdbPages(`https://api.themoviedb.org/3/discover/tv?api_key=${TMDB}&with_companies=420&sort_by=popularity.desc`, [1], { content_type: "series", brand: "marvel", category: "serial", tags: ["marvel", "supereroi"] }, 10);
  await tmdbPages(`https://api.themoviedb.org/3/discover/tv?api_key=${TMDB}&with_companies=9993&sort_by=popularity.desc`, [1], { content_type: "series", brand: "dc", category: "serial", tags: ["dc", "supereroi"] }, 10);
  console.log("  + Marvel/DC TV:", rows.length);

  // ---- 8. Canale kids: Nickelodeon (10) + Disney TV (10) ----
  await tmdbPages(`https://api.themoviedb.org/3/discover/tv?api_key=${TMDB}&with_companies=2359&sort_by=popularity.desc`, [1], { content_type: "cartoon", brand: "nickelodeon", category: "desene", tags: ["nickelodeon", "desene"] }, 10);
  await tmdbPages(`https://api.themoviedb.org/3/discover/tv?api_key=${TMDB}&with_companies=2&sort_by=popularity.desc`, [1], { content_type: "cartoon", brand: "disney", category: "desene", tags: ["disney", "familie"] }, 10);
  console.log("  + kids Nickelodeon/Disney:", rows.length);

  // ---- 9. Cinema internațional: Coreea (20), India (15), Europa FR/DE/ES/IT (20) ----
  await tmdbPages(`https://api.themoviedb.org/3/discover/tv?api_key=${TMDB}&with_origin_country=KR&sort_by=popularity.desc`, [1], { content_type: "series", category: "k-drama", continent: "Asia", country: "Coreea de Sud", tags: ["coreean", "k-drama"] }, 20);
  await tmdbPages(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_original_language=hi&sort_by=popularity.desc`, [1], { content_type: "movie", category: "bollywood", continent: "Asia", country: "India", tags: ["bollywood", "indian"] }, 15);
  await tmdbPages(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_original_language=fr&sort_by=popularity.desc`, [1], { content_type: "movie", category: "film", continent: "Europa", country: "Franța", tags: ["francez"] }, 5);
  await tmdbPages(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_original_language=de&sort_by=popularity.desc`, [1], { content_type: "movie", category: "film", continent: "Europa", country: "Germania", tags: ["german"] }, 5);
  await tmdbPages(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_original_language=es&sort_by=popularity.desc`, [1], { content_type: "movie", category: "film", continent: "Europa", country: "Spania", tags: ["spaniol"] }, 5);
  await tmdbPages(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_original_language=it&sort_by=popularity.desc`, [1], { content_type: "movie", category: "film", continent: "Europa", country: "Italia", tags: ["italian"] }, 5);
  console.log("  + cinema internațional:", rows.length);

  // ---- 10. România: filme (p1-2, 40) + seriale RO (10) ----
  await tmdbPages(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_original_language=ro&sort_by=popularity.desc`, [1, 2], { content_type: "movie", category: "film", continent: "Europa", country: "România", tags: ["românesc"] });
  await tmdbPages(`https://api.themoviedb.org/3/discover/tv?api_key=${TMDB}&with_origin_country=RO&sort_by=popularity.desc`, [1], { content_type: "series", category: "serial", continent: "Europa", country: "România", tags: ["românesc"] }, 10);
  console.log("  + România:", rows.length);

  // ---- 11. Genuri blockbuster: horror/comedie/sci-fi (30) ----
  await tmdbPages(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_genres=27&sort_by=popularity.desc`, [1], { content_type: "movie", category: "horror", tags: ["horror"] }, 10);
  await tmdbPages(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_genres=35&sort_by=popularity.desc`, [1], { content_type: "movie", category: "comedie", tags: ["comedie"] }, 10);
  await tmdbPages(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_genres=878&sort_by=popularity.desc`, [1], { content_type: "movie", category: "sci-fi", tags: ["sci-fi"] }, 10);
  console.log("  + genuri:", rows.length);

  // ---- 12. Anime — Jikan top, paginile 2-4 (75) ----
  for (const page of [2, 3, 4]) {
    const an = await fetchJson<{ data: Record<string, unknown>[] }>(
      `https://api.jikan.moe/v4/top/anime?limit=25&page=${page}`
    );
    for (const a of an?.data || []) {
      const embed = (a.trailer as { embed_url?: string })?.embed_url || "";
      const m = /(?:embed\/|watch\?v=)([\w-]{6,})/.exec(embed || "");
      const malId = a.mal_id as number;
      rows.push({
        external_id: `jikan:${malId}`,
        title: ((a.title_english || a.title) as string) || "",
        original_title: (a.title as string) || "",
        description: ((a.synopsis as string) || "").slice(0, 900),
        content_type: "anime", category: "anime",
        provider: m ? "youtube" : "tmdb", source_type: m ? "url" : "none",
        source_url: m ? `https://www.youtube.com/watch?v=${m[1]}` : undefined,
        thumbnail: (a.images as { jpg?: { image_url?: string } })?.jpg?.image_url,
        year: (a.year as number) || undefined,
        rating: (a.score as number) || 0,
        popularity: (a.members as number) || 0,
        tags: ["anime", ...(((a.genres as { name: string }[]) || []).slice(0, 3).map((g) => g.name.toLowerCase()))],
        meta: { malId },
      });
    }
    await sleep(400);
  }
  console.log("  + anime:", rows.length);

  // ---- 13. Muzică & Sport — YouTube oficial (≈36) ----
  async function ytSection(query: string, n: number, type: string, cat: string, tags: string[]): Promise<void> {
    const d = await fetchJson<{ items?: { id: { videoId: string }; snippet: { title: string; channelTitle: string; description: string; thumbnails?: { high?: { url: string }; medium?: { url: string } }; publishedAt: string } }[] }>(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${n}&q=${encodeURIComponent(query)}&key=${YTK}`
    );
    (d?.items || []).forEach((i) => {
      if (!i.id?.videoId) return;
      rows.push({
        external_id: `yt:${i.id.videoId}`,
        title: i.snippet.title.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
        description: (i.snippet.description || "").slice(0, 600),
        content_type: type, category: cat,
        provider: "youtube", source_type: "url",
        source_url: `https://www.youtube.com/watch?v=${i.id.videoId}`,
        thumbnail: i.snippet.thumbnails?.high?.url || i.snippet.thumbnails?.medium?.url,
        year: Number(i.snippet.publishedAt.slice(0, 4)) || undefined,
        rating: 0, popularity: 0,
        tags: [...tags, i.snippet.channelTitle.toLowerCase()],
        meta: { channel: i.snippet.channelTitle, videoId: i.id.videoId },
      });
    });
    await sleep(250);
  }
  await ytSection("official music video 2025", 10, "music", "muzică", ["muzică", "videoclip"]);
  await ytSection("k-pop official mv", 8, "music", "muzică", ["k-pop", "muzică"]);
  await ytSection("live concert full 2025", 8, "music", "muzică", ["concert", "live"]);
  await ytSection("f1 race highlights official", 6, "sport", "sport", ["f1", "sport"]);
  await ytSection("nba highlights official", 6, "sport", "sport", ["nba", "sport"]);
  console.log("  + muzică/sport:", rows.length);

  // ---- Trailere TMDB doar pentru top 40 după popularitate (economie de apeluri) ----
  const tmdbRows = rows.filter((r) => r.external_id.startsWith("tmdb:"));
  tmdbRows.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  for (const r of tmdbRows.slice(0, 40)) {
    const [, type, id] = r.external_id.split(":");
    const ttype = r.meta?.tmdbType === "tv" ? "tv" : "movie";
    const key = await fetchJson<{ results: { site: string; type: string; key: string }[] }>(
      `https://api.themoviedb.org/3/${ttype}/${id}/videos?api_key=${TMDB}`
    ).then((d) => {
      if (!d?.results) return null;
      const vids = d.results.filter((v) => v.site === "YouTube");
      return (vids.find((v) => v.type === "Trailer") || vids[0])?.key || null;
    });
    if (key) {
      r.source_url = `https://www.youtube.com/watch?v=${key}`;
      r.provider = "youtube";
      r.source_type = "url";
    }
    await sleep(120);
  }
  console.log("  + trailere top 40");

  // ---- Dedup intern + existente ----
  const valid = rows.filter((r) => r.title && r.title.length > 1);
  const seen = new Set<string>();
  const finalRows = valid.filter((r) => (seen.has(r.external_id) ? false : (seen.add(r.external_id), true)));

  const existing = await pool.query(`SELECT external_id FROM content`);
  const have = new Set((existing.rows as { external_id: string }[]).map((e) => e.external_id));
  const toInsert = finalRows.filter((r) => !have.has(r.external_id));
  console.log(`Total colectate: ${finalRows.length} • noi de inserat: ${toInsert.length}`);

  // ---- Inserare batch (50 rânduri / query) ----
  const COLS = 22;
  const SQLBASE = `INSERT INTO content
    (external_id, title, original_title, description, content_type, brand, category, continent, country, language, provider, source_type, source_url, embed_code, thumbnail, backdrop, year, rating, popularity, tags, search_text, meta) VALUES `;

  let ins = 0, errs = 0;
  for (let start = 0; start < toInsert.length; start += 50) {
    const chunk = toInsert.slice(start, start + 50);
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
    } catch (e) {
      // fallback rând-cu-rând pentru batch-ul problematic
      console.error("Batch err:", String(e instanceof Error ? e.message : e).slice(0, 120));
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
        } catch {
          errs++;
        }
      }
    }
  }

  const cnt = await pool.query(
    `SELECT count(*)::int AS total,
            count(DISTINCT content_type)::int AS types,
            count(DISTINCT provider)::int AS providers,
            count(DISTINCT country)::int AS countries
     FROM content`
  );
  const byType = await pool.query(`SELECT content_type, count(*)::int AS n FROM content GROUP BY content_type ORDER BY n DESC`);
  console.log(`\nSeed v2 complet în ${Math.round((Date.now() - t0) / 1000)}s: ${ins} inserate, ${errs} erori`);
  console.log(`Total bibliotecă Neon: ${cnt.rows[0].total} conținuturi • ${cnt.rows[0].types} tipuri • ${cnt.rows[0].providers} provideri • ${cnt.rows[0].countries} țări`);
  console.log(byType.rows.map((r: { content_type: string; n: number }) => `${r.content_type}:${r.n}`).join(" | "));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
