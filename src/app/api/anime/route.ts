import { NextRequest, NextResponse } from "next/server";
import { cachedFetch } from "@/lib/cache";

import { wrapPublicGet } from "@/lib/http-cache";
// Jikan API — MyAnimeList
export type AnimeItem = {
  id: string;
  mediaType: "anime";
  title: string;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  year: string;
  rating: number;
  source: string;
  episodes?: number | null;
  status?: string;
  genres?: string[];
  trailerKey?: string | null;
};

function mapJikan(a: Record<string, unknown>): AnimeItem {
  const trailer = a.trailer as Record<string, unknown> | null;
  const images = a.images as Record<string, Record<string, string>> | null;
  const titles = a.genres as { name: string }[] | undefined;
  return {
    id: String(a.mal_id),
    mediaType: "anime",
    title: (a.title_english as string) || (a.title as string) || (a.title_japanese as string) || "Anime",
    poster: images?.jpg?.large_image_url || images?.jpg?.image_url || null,
    backdrop: images?.jpg?.large_image_url || null,
    overview: (a.synopsis as string) || "Sinopsis indisponibil pentru acest anime.",
    year: a.year ? String(a.year) : ((a.aired as Record<string, unknown>)?.from as string)?.slice(0, 4) || "",
    rating: typeof a.score === "number" ? a.score : 0,
    source: "jikan",
    episodes: (a.episodes as number) || null,
    status: (a.status as string) || "",
    genres: titles?.map((g) => g.name) || [],
    trailerKey: (trailer?.youtube_id as string) || null,
  };
}

// Jikan permite ~3 cereri/sec — retry scurt cu backoff, apoi fallback TMDB
async function jikanFetch<T>(url: string, attempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await cachedFetch<T>(url, { ttl: 1200, timeoutMs: 6000 });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

async function getHandler(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mode = sp.get("mode") || "top";
  const page = sp.get("page") || "1";

  try {
    let url = "https://api.jikan.moe/v4";
    switch (mode) {
      case "top": url += `/top/anime?limit=24&page=${page}`; break;
      case "airing": url += `/top/anime?filter=airing&limit=24`; break;
      case "upcoming": url += `/seasons/upcoming?limit=24`; break;
      case "movies": url += `/top/anime?type=movie&limit=24`; break;
      case "search": {
        const q = sp.get("q") || "";
        if (!q.trim()) return NextResponse.json([]);
        url += `/anime?q=${encodeURIComponent(q)}&limit=24&sfw=true`;
        break;
      }
      case "details": {
        const id = sp.get("id");
        if (!id) return NextResponse.json({ error: "Lipsește id" }, { status: 400 });
        url += `/anime/${id}/full`;
        const data = await jikanFetch<{ data: Record<string, unknown> }>(url);
        return NextResponse.json(mapJikan(data.data));
      }
      case "genre": {
        const gid = sp.get("genreId") || "1"; // 1=action, 4=comedy, 8=fantasy, 22=romance, 24=sci-fi, 37=supernatural
        url += `/anime?genres=${gid}&order_by=score&sort=desc&limit=24&sfw=true`;
        break;
      }
      default:
        url += `/top/anime?limit=24&page=${page}`;
    }
    const data = await jikanFetch<{ data: Record<string, unknown>[] }>(url);
    return NextResponse.json(data.data.map(mapJikan));
  } catch (e) {
    console.error("Anime route error:", e);
    // Fallback: anime din TMDB (animație + origine Japonia) când Jikan nu răspunde
    try {
      const TMDB_KEY = process.env.TMDB_API_KEY || "3dd880e229e7b83d8e63c4b6f08f77a4";
      const fb = await cachedFetch<{ results: Record<string, unknown>[] }>(
        `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_KEY}&with_genres=16&with_origin_country=JP&sort_by=popularity.desc&page=${page}`,
        { ttl: 900, cacheKey: `anime-fallback:${page}` }
      );
      const items = fb.results.map((r) => {
        const title = (r.name as string) || "Anime";
        return {
          id: String(r.id),
          mediaType: "anime",
          title,
          poster: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
          backdrop: r.backdrop_path ? `https://image.tmdb.org/t/p/w1280${r.backdrop_path}` : null,
          overview: (r.overview as string) || "Sinopsis indisponibil pentru acest anime.",
          year: ((r.first_air_date as string) || "").slice(0, 4),
          rating: typeof r.vote_average === "number" ? Math.round(r.vote_average * 10) / 10 : 0,
          source: "tmdb",
        };
      });
      return NextResponse.json(items);
    } catch {
      return NextResponse.json({ error: "Eroare Jikan API" }, { status: 502 });
    }
  }
}

// Faza 17a — edge cache public (CDN) + metrics Prometheus pentru anime
export const GET = wrapPublicGet("anime", getHandler, { sMaxage: 300, swr: 600 });
