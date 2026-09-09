import { NextRequest, NextResponse } from "next/server";
import { cachedFetch } from "@/lib/cache";

import { wrapPublicGet } from "@/lib/http-cache";
// TVMaze — seriale internaționale (telenovele, shows TV)
export type TvItem = {
  id: string;
  mediaType: "tv";
  title: string;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  year: string;
  rating: number;
  source: string;
  network?: string;
  status?: string;
  genres?: string[];
};

function mapTvmaze(s: Record<string, unknown>): TvItem {
  const image = s.image as { medium?: string; original?: string } | null;
  const show = (s.show as Record<string, unknown>) || s;
  const network = (show.network as { name?: string }) || (show.webChannel as { name?: string });
  return {
    id: String(show.id),
    mediaType: "tv",
    title: (show.name as string) || "Serial",
    poster: image?.original || image?.medium || null,
    backdrop: image?.original || null,
    overview: ((show.summary as string) || "").replace(/<[^>]*>/g, "") || "Descriere indisponibilă.",
    year: ((show.premiered as string) || "").slice(0, 4),
    rating: (show.rating as { average?: number })?.average || 0,
    source: "tvmaze",
    network: network?.name || "",
    status: (show.status as string) || "",
    genres: (show.genres as string[]) || [],
  };
}

async function getHandler(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mode = sp.get("mode") || "popular";
  const page = sp.get("page") || "0";

  try {
    if (mode === "popular") {
      const data = await cachedFetch<Record<string, unknown>[]>(
        `https://api.tvmaze.com/shows?page=${page}`, { ttl: 1800 }
      );
      const items = data
        .filter((s) => (s.rating as { average?: number })?.average)
        .sort((a, b) =>
          ((b.rating as { average?: number })?.average || 0) -
          ((a.rating as { average?: number })?.average || 0)
        )
        .slice(0, 24)
        .map(mapTvmaze);
      return NextResponse.json(items);
    }
    if (mode === "search") {
      const q = sp.get("q") || "";
      if (!q.trim()) return NextResponse.json([]);
      const data = await cachedFetch<Record<string, unknown>[]>(
        `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`, { ttl: 900 }
      );
      return NextResponse.json(data.slice(0, 24).map(mapTvmaze));
    }
    if (mode === "details") {
      const id = sp.get("id");
      if (!id) return NextResponse.json({ error: "Lipsește id" }, { status: 400 });
      const data = await cachedFetch<Record<string, unknown>>(
        `https://api.tvmaze.com/shows/${id}?embed[]=cast&embed[]=episodes`, { ttl: 900 }
      );
      const item = mapTvmaze(data);
      const episodes = ((data._embedded as Record<string, unknown>)?.episodes as Record<string, unknown>[]) || [];
      return NextResponse.json({
        ...item,
        episodeCount: episodes.length,
        seasons: Math.max(0, ...episodes.map((e) => (e.season as number) || 0)),
      });
    }
    if (mode === "schedule") {
      const date = sp.get("date") || "";
      const data = await cachedFetch<Record<string, unknown>[]>(
        `https://api.tvmaze.com/schedule?date=${date}&country=US`, { ttl: 600 }
      );
      const seen = new Set<string>();
      const items = data
        .map((e) => {
          const show = e.show as Record<string, unknown> | undefined;
          return show ? mapTvmaze({ ...show, ...e }) : null;
        })
        .filter((x): x is TvItem => Boolean(x))
        .filter((x) => {
          if (seen.has(x.id)) return false;
          seen.add(x.id);
          return true;
        })
        .slice(0, 24);
      return NextResponse.json(items);
    }
    return NextResponse.json({ error: "Mod necunoscut" }, { status: 400 });
  } catch (e) {
    console.error("TVMaze route error:", e);
    return NextResponse.json({ error: "Eroare TVMaze" }, { status: 502 });
  }
}

// Faza 17a — edge cache public (CDN) + metrics Prometheus pentru tv
export const GET = wrapPublicGet("tv", getHandler, { sMaxage: 300, swr: 600 });
