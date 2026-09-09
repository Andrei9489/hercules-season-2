import { NextRequest, NextResponse } from "next/server";
import { cachedFetch } from "@/lib/cache";
import { BRANDS, TMDB_GENRES, TELENOVELA_SHOWS } from "@/lib/brands";

import { wrapPublicGet } from "@/lib/http-cache";
const TMDB_KEY = process.env.TMDB_API_KEY || "3dd880e229e7b83d8e63c4b6f08f77a4";
const BASE = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";

export type MediaItem = {
  id: string;
  mediaType: "movie" | "tv";
  title: string;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  year: string;
  rating: number;
  source: string;
  trailerHint?: string;
};

export function mapTmdbItem(r: Record<string, unknown>, mediaType: "movie" | "tv"): MediaItem {
  const title =
    (r.title as string) || (r.name as string) || (r.original_title as string) || "Necunoscut";
  const date = (r.release_date as string) || (r.first_air_date as string) || "";
  return {
    id: String(r.id),
    mediaType,
    title,
    poster: r.poster_path ? `${IMG}/w500${r.poster_path}` : null,
    backdrop: r.backdrop_path ? `${IMG}/w1280${r.backdrop_path}` : null,
    overview: (r.overview as string) || "",
    year: date ? date.slice(0, 4) : "",
    rating: typeof r.vote_average === "number" ? Math.round(r.vote_average * 10) / 10 : 0,
    source: "tmdb",
  };
}

async function tmdb<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams({ api_key: TMDB_KEY, language: "ro-RO", ...params });
  return cachedFetch<T>(`${BASE}${path}?${qs}`, { ttl: 600 });
}

async function tmdbEn<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams({ api_key: TMDB_KEY, ...params });
  return cachedFetch<T>(`${BASE}${path}?${qs}`, { ttl: 600 });
}

async function getHandler(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mode = sp.get("mode") || "trending";
  const page = sp.get("page") || "1";

  try {
    if (mode === "trending") {
      const window = sp.get("window") || "week";
      const data = await tmdb<{ results: Record<string, unknown>[] }>(
        `/trending/all/${window}`, { page }
      );
      return NextResponse.json(
        data.results
          .filter((r) => r.media_type !== "person")
          .map((r) => mapTmdbItem(r, (r.media_type as "movie" | "tv") || "movie"))
      );
    }

    if (mode === "list") {
      const kind = sp.get("kind") || "popular";
      const type = (sp.get("type") || "movie") as "movie" | "tv";
      const data = await tmdb<{ results: Record<string, unknown>[] }>(
        `/${type}/${kind}`, { page }
      );
      return NextResponse.json(data.results.map((r) => mapTmdbItem(r, type)));
    }

    if (mode === "discover") {
      const type = (sp.get("type") || "movie") as "movie" | "tv";
      const genre = sp.get("genre");
      const company = sp.get("company");
      const year = sp.get("year");
      const sortBy = sp.get("sort") || "popularity.desc";
      const params: Record<string, string> = { page, sort_by: sortBy };
      if (genre && TMDB_GENRES[genre]) {
        const g = TMDB_GENRES[genre];
        const gid = type === "movie" ? g.movie : g.tv;
        if (gid) params.with_genres = String(gid);
      }
      if (company) params.with_companies = company;
      if (year) {
        if (type === "movie") params.primary_release_year = year;
        else params.first_air_date_year = year;
      }
      const data = await tmdb<{ results: Record<string, unknown>[] }>(
        `/discover/${type}`, params
      );
      return NextResponse.json(data.results.map((r) => mapTmdbItem(r, type)));
    }

    if (mode === "search") {
      const q = sp.get("q") || "";
      if (!q.trim()) return NextResponse.json([]);
      const data = await tmdb<{ results: Record<string, unknown>[] }>(
        `/search/multi`, { query: q, page, include_adult: "false" }
      );
      return NextResponse.json(
        data.results
          .filter((r) => r.media_type === "movie" || r.media_type === "tv")
          .map((r) => mapTmdbItem(r, r.media_type as "movie" | "tv"))
      );
    }

    if (mode === "details") {
      const type = (sp.get("type") || "movie") as "movie" | "tv";
      const id = sp.get("id") || "";
      const [detailRo, detailEn, videos] = await Promise.all([
        tmdb<Record<string, unknown>>(`/${type}/${id}`),
        tmdbEn<Record<string, unknown>>(`/${type}/${id}`),
        tmdbEn<{ results: { key: string; type: string; site: string; name: string; official: boolean }[] }>(
          `/${type}/${id}/videos`
        ),
      ]);
      const yt =
        videos.results.find(
          (v) => v.site === "YouTube" && v.type === "Trailer" && v.official
        ) || videos.results.find((v) => v.site === "YouTube");
      const detail = { ...detailRo };
      if (!detail.overview && detailEn.overview) detail.overview = detailEn.overview;
      const item = mapTmdbItem(detail, type);
      return NextResponse.json({ ...item, trailerKey: yt?.key || null, raw: detail });
    }

    if (mode === "similar") {
      const type = (sp.get("type") || "movie") as "movie" | "tv";
      const id = sp.get("id") || "";
      const data = await tmdb<{ results: Record<string, unknown>[] }>(
        `/${type}/${id}/recommendations`, { page }
      );
      return NextResponse.json(data.results.map((r) => mapTmdbItem(r, type)));
    }

    if (mode === "brand") {
      const brandId = sp.get("brand") || "";
      const brand = BRANDS.find((b) => b.id === brandId);
      if (!brand) return NextResponse.json({ error: "Brand necunoscut" }, { status: 404 });

      if (brand.tmdbCompany) {
        const data = await tmdb<{ results: Record<string, unknown>[] }>(
          `/discover/${brand.type}`,
          { with_companies: String(brand.tmdbCompany), page, sort_by: "popularity.desc" }
        );
        return NextResponse.json({
          brand: { id: brand.id, name: brand.name, emoji: brand.emoji, accent: brand.accent },
          items: data.results.map((r) => mapTmdbItem(r, brand.type)),
        });
      }
      const shows = (brand.shows || []).slice(0, 18);
      const results = await Promise.allSettled(
        shows.map((s) =>
          tmdb<{ results: Record<string, unknown>[] }>(`/search/${brand.type}`, { query: s })
            .then((d) => (d.results[0] ? mapTmdbItem(d.results[0], brand.type) : null))
        )
      );
      const items = results
        .map((r) => (r.status === "fulfilled" ? r.value : null))
        .filter(Boolean) as MediaItem[];
      return NextResponse.json({
        brand: { id: brand.id, name: brand.name, emoji: brand.emoji, accent: brand.accent },
        items,
      });
    }

    if (mode === "blockbuster") {
      // Blockbustere globale: cele mai populare filme cu voturi masive
      const data = await tmdb<{ results: Record<string, unknown>[] }>(`/discover/movie`, {
        sort_by: "popularity.desc",
        "vote_count.gte": "2000",
        "primary_release_date.gte": "1980",
        page,
      });
      return NextResponse.json({
        items: data.results.map((r) => mapTmdbItem(r, "movie")),
      });
    }

    if (mode === "telenovela") {
      const tasks: Promise<MediaItem[]>[] = [
        tmdb<{ results: Record<string, unknown>[] }>(`/discover/tv`, {
          with_keywords: "207232", page, sort_by: "popularity.desc",
        }).then((d) => d.results.map((r) => mapTmdbItem(r, "tv"))),
        ...TELENOVELA_SHOWS.slice(0, 10).map((s) =>
          tmdb<{ results: Record<string, unknown>[] }>(`/search/tv`, { query: s }).then((d) =>
            d.results[0] ? [mapTmdbItem(d.results[0], "tv")] : []
          )
        ),
      ];
      const settled = await Promise.allSettled(tasks);
      const items = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
      const seen = new Set<string>();
      const unique = items.filter((i) => {
        const k = `${i.mediaType}:${i.id}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      return NextResponse.json(unique);
    }

    if (mode === "genres") {
      return NextResponse.json(TMDB_GENRES);
    }

    return NextResponse.json({ error: "Mod necunoscut" }, { status: 400 });
  } catch (e) {
    console.error("TMDB route error:", e);
    return NextResponse.json(
      { error: "Eroare la preluarea datelor", detail: String(e).slice(0, 200) },
      { status: 502 }
    );
  }
}

// Faza 17a — edge cache public (CDN) + metrics Prometheus pentru tmdb
export const GET = wrapPublicGet("tmdb", getHandler, { sMaxage: 300, swr: 600 });
