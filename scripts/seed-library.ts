// Seed bibliotecă Neon cu conținut REAL (metadate + surse oficiale/publice)
// Rulează: bun scripts/seed-library.ts  (idempotent — re-rulare sigură)
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

async function tmdbTrailer(type: "movie" | "tv", id: number): Promise<string | null> {
  const d = await fetchJson<{ results: { site: string; type: string; key: string; official: boolean }[] }>(
    `https://api.themoviedb.org/3/${type}/${id}/videos?api_key=${TMDB}`
  );
  if (!d?.results) return null;
  const vids = d.results.filter((v) => v.site === "YouTube");
  const tr = vids.find((v) => v.type === "Trailer" && v.official) || vids.find((v) => v.type === "Trailer") || vids[0];
  return tr?.key || null;
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
    provider: "youtube", source_type: "url",
    thumbnail: r.poster_path ? `${IMG}${r.poster_path}` : undefined,
    backdrop: r.backdrop_path ? `${BIMG}${r.backdrop_path}` : undefined,
    year: date ? Number(date.slice(0, 4)) : undefined,
    rating: (r.vote_average as number) || 0,
    popularity: Math.round((r.popularity as number) || 0),
    tags: o.tags || [],
    meta: { tmdbId: id, tmdbType: o.content_type === "anime" ? "movie" : o.content_type === "series" || o.content_type === "telenovela" ? "tv" : "movie" },
  });
}

async function main() {
  // ---- 1. Filme populare (20)
  const pm = await fetchJson<{ results: Record<string, unknown>[] }>(`https://api.themoviedb.org/3/movie/popular?api_key=${TMDB}&page=1`);
  pm?.results?.slice(0, 20).forEach((r) => fromTmdb(r, { content_type: "movie", category: "film", tags: ["film"] }));

  // ---- 2. Seriale populare (12)
  const pt = await fetchJson<{ results: Record<string, unknown>[] }>(`https://api.themoviedb.org/3/tv/popular?api_key=${TMDB}&page=1`);
  pt?.results?.slice(0, 12).forEach((r) => fromTmdb(r, { content_type: "series", category: "serial", tags: ["serial"] }));

  // ---- 3. Blockbustere acțiune (10)
  const bb = await fetchJson<{ results: Record<string, unknown>[] }>(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&sort_by=popularity.desc&vote_count.gte=4000&with_genres=28`);
  bb?.results?.slice(0, 10).forEach((r) => fromTmdb(r, { content_type: "movie", category: "blockbuster", tags: ["blockbuster", "acțiune"] }));

  // ---- 4. Marvel (6) + DC (6)
  const mv = await fetchJson<{ results: Record<string, unknown>[] }>(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_companies=420&sort_by=popularity.desc`);
  mv?.results?.slice(0, 6).forEach((r) => fromTmdb(r, { content_type: "movie", brand: "marvel", category: "blockbuster", tags: ["marvel", "supereroi"] }));
  const dc = await fetchJson<{ results: Record<string, unknown>[] }>(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_companies=9993&sort_by=popularity.desc`);
  dc?.results?.slice(0, 6).forEach((r) => fromTmdb(r, { content_type: "movie", brand: "dc", category: "blockbuster", tags: ["dc", "supereroi"] }));

  // ---- 5. Disney (5) + Pixar (4) + Ghibli (5) + Cartoon Network (4)
  const dis = await fetchJson<{ results: Record<string, unknown>[] }>(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_companies=2&sort_by=popularity.desc`);
  dis?.results?.slice(0, 5).forEach((r) => fromTmdb(r, { content_type: "cartoon", brand: "disney", category: "desene", tags: ["disney", "familie"] }));
  const pix = await fetchJson<{ results: Record<string, unknown>[] }>(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_companies=3&sort_by=popularity.desc`);
  pix?.results?.slice(0, 4).forEach((r) => fromTmdb(r, { content_type: "cartoon", brand: "pixar", category: "desene", tags: ["pixar", "familie"] }));
  const gh = await fetchJson<{ results: Record<string, unknown>[] }>(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_companies=10342&sort_by=popularity.desc`);
  gh?.results?.slice(0, 5).forEach((r) => fromTmdb(r, { content_type: "anime", brand: "ghibli", category: "anime", tags: ["ghibli", "anime"] }));
  const cn = await fetchJson<{ results: Record<string, unknown>[] }>(`https://api.themoviedb.org/3/discover/tv?api_key=${TMDB}&with_companies=21792&sort_by=popularity.desc`);
  cn?.results?.slice(0, 4).forEach((r) => fromTmdb(r, { content_type: "cartoon", brand: "cartoon-network", category: "desene", tags: ["cartoon network", "desene"] }));

  // ---- 6. Documentare (8) + Telenovele (6)
  const doc = await fetchJson<{ results: Record<string, unknown>[] }>(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_genres=99&sort_by=popularity.desc`);
  doc?.results?.slice(0, 8).forEach((r) => fromTmdb(r, { content_type: "documentary", category: "documentar", tags: ["documentar"] }));
  const tel = await fetchJson<{ results: Record<string, unknown>[] }>(`https://api.themoviedb.org/3/discover/tv?api_key=${TMDB}&with_genres=10766&sort_by=popularity.desc`);
  tel?.results?.slice(0, 6).forEach((r) => fromTmdb(r, { content_type: "telenovela", category: "telenovelă", tags: ["telenovelă", "dramă"] }));

  // ---- 7. Filme românești (4) — România / Europa
  const ro = await fetchJson<{ results: Record<string, unknown>[] }>(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&with_original_language=ro&sort_by=popularity.desc`);
  ro?.results?.slice(0, 4).forEach((r) => fromTmdb(r, { content_type: "movie", category: "film", continent: "Europa", country: "România", tags: ["românesc"] }));

  // ---- 8. Anime top (12) — Jikan
  const an = await fetchJson<{ data: Record<string, unknown>[] }>(`https://api.jikan.moe/v4/top/anime?limit=12`);
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
      provider: m ? "youtube" : "unknown", source_type: m ? "url" : "none",
      source_url: m ? `https://www.youtube.com/watch?v=${m[1]}` : undefined,
      thumbnail: (a.images as { jpg?: { image_url?: string } })?.jpg?.image_url,
      year: (a.year as number) || undefined,
      rating: (a.score as number) || 0,
      popularity: (a.members as number) || 0,
      tags: ["anime", ...(((a.genres as { name: string }[]) || []).slice(0, 3).map((g) => g.name.toLowerCase()))],
      meta: { malId },
    });
  }

  // ---- 9. Muzică / Sport / Gaming / Show-biz — YouTube oficial
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
  }
  await ytSection("official music video 2025", 10, "music", "muzică", ["muzică", "videoclip"]);
  await ytSection("premier league official highlights", 6, "sport", "sport", ["fotbal", "sport"]);
  await ytSection("official game trailer 2025", 6, "gaming", "gaming", ["gaming", "jocuri"]);
  await ytSection("entertainment talk show official interview", 4, "showbiz", "show-biz", ["show-biz", "interviu"]);

  // ---- 10. Demo-uri directe (open-license / public) — MP4, HLS, Vimeo, Dailymotion
  const G = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample";
  const demos: Row[] = [
    { external_id: "demo:bigbuckbunny", title: "Big Buck Bunny", description: "Film de animație open-source Blender Foundation (CC-BY). Sursă directă MP4.", content_type: "cartoon", category: "demo", provider: "direct", source_type: "direct", source_url: `${G}/BigBuckBunny.mp4`, thumbnail: `${G}/images/BigBuckBunny.jpg`, year: 2008, rating: 8.1, popularity: 500, tags: ["demo", "mp4", "blender"], meta: {} },
    { external_id: "demo:elephantsdream", title: "Elephants Dream", description: "Primul film deschis Blender Foundation. Sursă directă MP4.", content_type: "cartoon", category: "demo", provider: "direct", source_type: "direct", source_url: `${G}/ElephantsDream.mp4`, thumbnail: `${G}/images/ElephantsDream.jpg`, year: 2006, rating: 7.4, popularity: 420, tags: ["demo", "mp4", "blender"], meta: {} },
    { external_id: "demo:sintel", title: "Sintel", description: "Scurtmetraj animat Blender (CC-BY). Sursă directă MP4.", content_type: "cartoon", category: "demo", provider: "direct", source_type: "direct", source_url: `${G}/Sintel.mp4`, thumbnail: `${G}/images/Sintel.jpg`, year: 2010, rating: 8.2, popularity: 480, tags: ["demo", "mp4", "blender"], meta: {} },
    { external_id: "demo:tearsofsteel", title: "Tears of Steel", description: "Sci-fi open movie Blender (CC-BY). Sursă directă MP4.", content_type: "movie", category: "demo", provider: "direct", source_type: "direct", source_url: `${G}/TearsOfSteel.mp4`, thumbnail: `${G}/images/TearsOfSteel.jpg`, year: 2012, rating: 7.7, popularity: 460, tags: ["demo", "mp4", "sci-fi"], meta: {} },
    { external_id: "demo:forbiggerescapes", title: "For Bigger Escapes", description: "Videoclip demo public Google (MP4 direct).", content_type: "video", category: "demo", provider: "direct", source_type: "direct", source_url: `${G}/ForBiggerEscapes.mp4`, thumbnail: `${G}/images/ForBiggerEscapes.jpg`, year: 2015, rating: 0, popularity: 300, tags: ["demo", "mp4"], meta: {} },
    { external_id: "demo:hls-mux", title: "Test Stream HLS — Mux", description: "Stream HLS (m3u8) public de test Mux. Redare adaptivă prin hls.js.", content_type: "video", category: "demo", provider: "hls", source_type: "hls", source_url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", year: 2020, rating: 0, popularity: 320, tags: ["demo", "hls", "m3u8"], meta: {} },
    { external_id: "demo:hls-apple", title: "Apple BipBop — HLS avansat", description: "Stream HLS public Apple (fMP4, subtitrări, multi-bitrate).", content_type: "video", category: "demo", provider: "hls", source_type: "hls", source_url: "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8", year: 2019, rating: 0, popularity: 310, tags: ["demo", "hls", "apple"], meta: {} },
    { external_id: "demo:vimeo-staff", title: "Vimeo — Demo player oficial", description: "Videoclip public Vimeo folosit în documentația oficială a playerului.", content_type: "video", category: "demo", provider: "vimeo", source_type: "url", source_url: "https://vimeo.com/76979871", year: 2013, rating: 0, popularity: 300, tags: ["demo", "vimeo"], meta: {} },
    { external_id: "demo:dailymotion-docs", title: "Dailymotion — Video demo docs", description: "Videoclip public Dailymotion din documentația pentru dezvoltatori.", content_type: "video", category: "demo", provider: "dailymotion", source_type: "url", source_url: "https://www.dailymotion.com/video/x7tgad0", thumbnail: "https://www.dailymotion.com/thumbnail/video/x7tgad0", year: 2019, rating: 0, popularity: 290, tags: ["demo", "dailymotion"], meta: {} },
  ];
  rows.push(...demos);

  // ---- Trailere TMDB pentru rândurile din TMDB
  let vi = 0;
  for (const r of rows) {
    if (r.external_id.startsWith("tmdb:")) {
      vi++;
      const [, type, id] = r.external_id.split(":");
      const ttype = type === "series" || type === "telenovela" || type === "cartoon" && r.meta?.tmdbType === "tv" ? (r.meta?.tmdbType as string) || "tv" : (r.meta?.tmdbType as string) || "movie";
      const key = await tmdbTrailer(ttype === "tv" ? "tv" : "movie", Number(id));
      if (key) r.source_url = `https://www.youtube.com/watch?v=${key}`;
    }
  }

  // ---- Filtru + dedup intern
  const valid = rows.filter((r) => r.title && r.title.length > 1);
  const seen = new Set<string>();
  const finalRows = valid.filter((r) => (seen.has(r.external_id) ? false : (seen.add(r.external_id), true)));

  // ---- Existente
  const existing = await pool.query(`SELECT external_id FROM content`);
  const have = new Set((existing.rows as { external_id: string }[]).map((e) => e.external_id));

  const SQL = `INSERT INTO content
    (external_id, title, original_title, description, content_type, brand, category, continent, country, language, provider, source_type, source_url, embed_code, thumbnail, backdrop, year, rating, popularity, tags, search_text, meta)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`;

  let ins = 0, sk = 0, errs = 0;
  for (const r of finalRows) {
    if (have.has(r.external_id)) { sk++; continue; }
    const st = normalizeRo([
      r.title, r.original_title || "", r.description,
      (r.tags || []).join(" "), r.brand || "", r.content_type, r.category || "", r.provider,
    ].join(" "));
    try {
      await pool.query(SQL, [
        r.external_id, r.title, r.original_title || null, r.description || "",
        r.content_type, r.brand || null, r.category || null, r.continent || "Global",
        r.country || null, r.language || "en", r.provider, r.source_type,
        r.source_url || null, r.embed_code || null, r.thumbnail || null, r.backdrop || null,
        r.year || null, r.rating || 0, r.popularity || 0, r.tags || [], st, JSON.stringify(r.meta || {}),
      ]);
      ins++;
    } catch (e) {
      errs++;
      console.error("INSERT ERR:", r.external_id, String(e instanceof Error ? e.message : e).slice(0, 100));
    }
  }

  const cnt = await pool.query(
    `SELECT count(*)::int AS total,
            count(DISTINCT content_type)::int AS types,
            count(DISTINCT provider)::int AS providers
     FROM content`
  );
  const byType = await pool.query(`SELECT content_type, count(*)::int AS n FROM content GROUP BY content_type ORDER BY n DESC`);
  console.log(`\nSeed complet: ${ins} inserate, ${sk} existente, ${errs} erori`);
  console.log(`Total bibliotecă Neon: ${cnt.rows[0].total} conținuturi • ${cnt.rows[0].types} tipuri • ${cnt.rows[0].providers} provideri`);
  console.log(byType.rows.map((r: { content_type: string; n: number }) => `${r.content_type}:${r.n}`).join(" | "));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
