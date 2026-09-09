import { NextRequest, NextResponse } from "next/server";
import { cachedFetch } from "@/lib/cache";
import { searchLibrary, suggest, trending, logSearch } from "@/lib/neon-search";
import { regionFromRequest } from "@/lib/regions";
import { rateLimit, rateLimitTiered, clientIp, tooMany } from "@/lib/rate-limit";
import { withCache, wrapMetrics } from "@/lib/http-cache";

const TMDB_KEY = process.env.TMDB_API_KEY || "3dd880e229e7b83d8e63c4b6f08f77a4";

export type SearchResult = {
  id: string;
  mediaType: string;
  title: string;
  poster: string | null;
  year: string;
  overview: string;
  rating: number;
  source: string;
  sourceUrl?: string | null;
  embedCode?: string | null;
  provider?: string | null;
  neonId?: number | null;
};

type LibraryItemRow = {
  id: number; title: string; description: string; thumbnail: string | null;
  backdrop: string | null; year: number | null; rating: number; contentType: string;
  provider: string; sourceUrl: string | null; embedCode: string | null; brand: string | null;
};

function libToResult(h: LibraryItemRow): SearchResult {
  return {
    id: `neon:${h.id}`,
    mediaType: "neon",
    title: h.title,
    poster: h.thumbnail,
    year: h.year ? String(h.year) : "",
    overview: h.description.slice(0, 220),
    rating: h.rating,
    source: "neon",
    sourceUrl: h.sourceUrl,
    embedCode: h.embedCode,
    provider: h.provider,
    neonId: h.id,
  };
}

async function getHandler(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = sp.get("q")?.trim() || "";
  // Faza 2: mod implicit "library" (Neon-only, sub-100ms, gata 10.000 simultan).
  // mode=full include surse externe (TMDB/Jikan/TVMaze/iTunes/YouTube) la cerere.
  const mode = sp.get("mode") || "library";
  const limit = Math.min(48, Number(sp.get("limit")) || 24);
  const t0 = Date.now();

  // FAZA 16 — MULTI-REGION: regiunea preferată pentru citiri (header geo edge
  // cf-ipcountry / x-vercel-ip-country, parametru ?region= sau EU implicit).
  // Citirile de origin merg pe replică când regiunea e activă (qReadRegion).
  const region = regionFromRequest(
    req.headers.get("cf-ipcountry") || req.headers.get("x-vercel-ip-country"),
    sp.get("region")
  );

  // ---- Faza 3+10: rate limiting pe NIVELURI (autentificat > anonim) ----
  // Utilizatorii autentificați (cookie sesiune prezent) primesc 2.5x buget —
  // abuzatorii anonimi sunt limitați mai agresiv, utilizatorii reali nu.
  const ip = clientIp(req);
  const rl = rateLimitTiered(
    req,
    mode === "suggest" ? `sug:${ip}` : `srch:${ip}`,
    { burst: mode === "suggest" ? 120 : 40, perMinute: mode === "suggest" ? 600 : 300 },
    { burst: mode === "suggest" ? 300 : 100, perMinute: mode === "suggest" ? 1500 : 750 }
  );
  if (!rl.ok) return tooMany(rl);

  // ---- mode=suggest: autocompletare (titluri Neon + trending)
  // Faza 12: EDGE CACHE + ETag pe sugestii — prefixele se repetă masiv
  // la autocompletare (10.000 utilizatori tastează aceleași prefixe) →
  // în producție CDN-ul le servește FĂRĂ să atingă origin-ul.
  if (mode === "suggest") {
    if (!q) {
      const t = await trending(8).catch(() => []);
      return withCache(
        req,
        { suggestions: t.map((t) => t.original), trending: t.map((t) => t.original) },
        { sMaxage: 15, swr: 60 },
        { "X-RateLimit-Remaining": String(rl.remaining) }
      );
    }
    const [sug, tr] = await Promise.all([
      suggest(q, 7).catch(() => [] as string[]),
      trending(3).catch(() => []),
    ]);
    const merged = [...new Set([...sug, ...tr.map((t) => t.original).filter((o) => o.toLowerCase().includes(q.toLowerCase()))])].slice(0, 8);
    return withCache(
      req,
      { suggestions: merged },
      { sMaxage: 15, swr: 60 },
      { "X-RateLimit-Remaining": String(rl.remaining) }
    );
  }

  // ---- mode=trending: top căutări (Faza 12: edge cache 30s + SWR)
  if (mode === "trending") {
    const t = await trending(10).catch(() => []);
    return withCache(
      req,
      { trending: t },
      { sMaxage: 30, swr: 120 },
      { "X-RateLimit-Remaining": String(rl.remaining) }
    );
  }

  if (!q) return NextResponse.json({ results: [], sources: [], libraryCount: 0 });

  // ---- mode=library (implicit): doar Neon, viteză maximă
  if (mode === "library") {
    const lib = await searchLibrary(q, { limit, region });
    logSearch(q, lib.hits.length, lib.tookMs, "library");
    // Faza 3: cache HTTP la margine (CDN/edge) pentru vârfuri — top-queries
    // servite fără să atingă origin-ul (stale-while-revalidate)
    // Faza 17: withCache adaugă acum și ETag/304 pe lângă s-maxage+SWR
    return withCache(
      req,
      {
        results: lib.hits.map(libToResult),
        libraryCount: lib.hits.length,
        tookMs: lib.tookMs,
        cached: lib.cached,
      },
      { sMaxage: 30, swr: 120 },
      { "X-RateLimit-Remaining": String(rl.remaining) }
    );
  }

  // ---- mode=full: Neon FIRST + surse externe în paralel (opt-in)
  const neonResults: SearchResult[] = [];
  const extResults: SearchResult[] = [];
  const errors: string[] = [];

  const neonTask = searchLibrary(q, { limit: 24, region })
    .then((lib) => {
      lib.hits.forEach((h) => neonResults.push(libToResult(h)));
      return lib.hits.length;
    })
    .catch((e) => {
      errors.push(`neon: ${e}`);
      return 0;
    });

  const IMG = "https://image.tmdb.org/t/p/w500";

  const externalTasks = [
    // TMDB multi
    cachedFetch<{ results: Record<string, unknown>[] }>(
      `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_KEY}&query=${encodeURIComponent(q)}&include_adult=false`,
      { ttl: 600, cacheKey: `tmdb-search:${q}` }
    ).then((d) => {
      d.results
        .filter((r) => r.media_type === "movie" || r.media_type === "tv")
        .slice(0, 12)
        .forEach((r) => {
          extResults.push({
            id: String(r.id),
            mediaType: (r.media_type as string) || "movie",
            title: ((r.title || r.name) as string) || "",
            poster: r.poster_path ? `${IMG}${r.poster_path}` : null,
            year: ((r.release_date || r.first_air_date) as string)?.slice(0, 4) || "",
            overview: (r.overview as string) || "",
            rating: (r.vote_average as number) || 0,
            source: "tmdb",
          });
        });
    }).catch((e) => errors.push(`tmdb: ${e}`)),

    // Jikan anime
    cachedFetch<{ data: Record<string, unknown>[] }>(
      `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=8&sfw=true`,
      { ttl: 600, cacheKey: `jikan-search:${q}` }
    ).then((d) => {
      d.data.forEach((a) => {
        const img = (a.images as { jpg?: { image_url?: string } })?.jpg?.image_url || null;
        extResults.push({
          id: String(a.mal_id),
          mediaType: "anime",
          title: (a.title_english as string) || (a.title as string) || "",
          poster: img,
          year: a.year ? String(a.year) : "",
          overview: ((a.synopsis as string) || "").slice(0, 200),
          rating: (a.score as number) || 0,
          source: "jikan",
        });
      });
    }).catch((e) => errors.push(`jikan: ${e}`)),

    // TVMaze
    cachedFetch<Record<string, unknown>[]>(
      `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`,
      { ttl: 600, cacheKey: `tvmaze-search:${q}` }
    ).then((d) => {
      d.slice(0, 6).forEach((r) => {
        const show = r.show as Record<string, unknown>;
        const image = (show.image as { original?: string })?.original || null;
        extResults.push({
          id: String(show.id),
          mediaType: "tv-maze",
          title: (show.name as string) || "",
          poster: image,
          year: ((show.premiered as string) || "").slice(0, 4),
          overview: ((show.summary as string) || "").replace(/<[^>]*>/g, "").slice(0, 200),
          rating: (show.rating as { average?: number })?.average || 0,
          source: "tvmaze",
        });
      });
    }).catch((e) => errors.push(`tvmaze: ${e}`)),

    // iTunes music
    cachedFetch<{ results: Record<string, unknown>[] }>(
      `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&limit=8`,
      { ttl: 900, cacheKey: `itunes-search:${q}` }
    ).then((d) => {
      d.results.forEach((r) => {
        extResults.push({
          id: String(r.trackId),
          mediaType: "music",
          title: (r.trackName as string) || "",
          poster: ((r.artworkUrl100 as string) || "").replace("100x100", "400x400") || null,
          year: ((r.releaseDate as string) || "").slice(0, 4),
          overview: `${r.artistName || ""} • ${r.collectionName || ""}`,
          rating: 0,
          source: "itunes",
        });
      });
    }).catch((e) => errors.push(`itunes: ${e}`)),

    // YouTube videos
    cachedFetch<{
      items: { id: { videoId: string }; snippet: { title: string; channelTitle: string; thumbnails: { medium?: { url: string } } } }[];
    }>(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=6&q=${encodeURIComponent(q)}&key=${process.env.YOUTUBE_API_KEY || "AIzaSyAWJ0f6XdhPb3fJL6EYjB5ZamaoM1ZT1XM"}`,
      { ttl: 900, cacheKey: `yt-search:${q}` }
    ).then((d) => {
      (d.items || []).forEach((i) => {
        if (!i.id?.videoId) return;
        extResults.push({
          id: i.id.videoId,
          mediaType: "video",
          title: i.snippet.title,
          poster: i.snippet.thumbnails?.medium?.url || null,
          year: "",
          overview: i.snippet.channelTitle,
          rating: 0,
          source: "youtube",
        });
      });
    }).catch((e) => errors.push(`youtube: ${e}`)),
  ];

  const libraryHits = await neonTask;
  await Promise.allSettled(externalTasks);
  const results = [...neonResults, ...extResults];
  const tookMs = Date.now() - t0;

  // log asincron în Neon (nu blochează răspunsul)
  logSearch(q, results.length, tookMs, "full");

  const seen = new Set<string>();
  const unique = results.filter((r) => {
    const k = `${r.source}:${r.mediaType}:${r.id}`;
    if (seen.has(k) || !r.title) return false;
    seen.add(k);
    return true;
  });

  // Faza 17 — mode=full intră și el în cache edge public (date 100% publice
  // din cataloage externe; CDN-ul servește repeat-urile aceluiași query FĂRĂ
  // să mai declanșeze 5 apeluri externe + query Neon pe origin).
  return withCache(
    req,
    {
      results: unique,
      libraryCount: libraryHits,
      tookMs,
      cachedResults: unique.length > 0 && unique[0].source === "neon",
      region,
      errors: errors.length ? errors : undefined,
    },
    { sMaxage: 60, swr: 120 },
    { "X-RateLimit-Remaining": String(rl.remaining) }
  );
}

// Faza 17 — observabilitate Prometheus pentru search
export const GET = wrapMetrics("search", getHandler);
