"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { MediaItem, UserItem } from "./types";
import { api } from "./api";
import { Hero } from "./Hero";
import { Row } from "./Row";
import { MediaCard } from "./MediaCard";
import { PlayCircle } from "lucide-react";

type Props = {
  onPlay: (i: MediaItem) => void;
  onOpen: (i: MediaItem) => void;
  onNavigate: (v: string) => void;
  isSaved: (i: MediaItem, k: "watchlist" | "favorites") => boolean;
  onToggleList: (i: MediaItem, k: "watchlist" | "favorites") => void;
  authed: boolean;
};

export function HomeView({ onPlay, onOpen, onNavigate, isSaved, onToggleList, authed }: Props) {
  const [trending, setTrending] = useState<MediaItem[]>([]);
  const [movies, setMovies] = useState<MediaItem[]>([]);
  const [series, setSeries] = useState<MediaItem[]>([]);
  const [anime, setAnime] = useState<MediaItem[]>([]);
  const [blockbusters, setBlockbusters] = useState<MediaItem[]>([]);
  const [history, setHistory] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const results = await Promise.allSettled([
        api.tmdb<MediaItem[]>("mode=trending&window=week"),
        api.tmdb<MediaItem[]>("mode=list&kind=popular&type=movie"),
        api.tmdb<MediaItem[]>("mode=list&kind=airing_today&type=tv"),
        api.anime<MediaItem[]>("mode=airing"),
        api.tmdb<MediaItem[]>("mode=discover&type=movie&genre=actiune&year=2025"),
      ]);
      setTrending(results[0].status === "fulfilled" ? results[0].value.slice(0, 10) : []);
      setMovies(results[1].status === "fulfilled" ? results[1].value.slice(0, 18) : []);
      setSeries(results[2].status === "fulfilled" ? results[2].value.slice(0, 18) : []);
      setAnime(results[3].status === "fulfilled" ? results[3].value.slice(0, 18) : []);
      setBlockbusters(results[4].status === "fulfilled" ? results[4].value.slice(0, 18) : []);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!authed) return;
    api.user<{ items: UserItem[] }>("history")
      .then((r) => setHistory(r.items.slice(0, 12)))
      .catch(() => {});
  }, [authed]);

  const heroItems = trending.slice(0, 5).filter((t) => t.backdrop || t.poster);

  const toggle = (i: MediaItem, k: "watchlist" | "favorites") => onToggleList(i, k);

  if (loading) {
    return (
      <div className="space-y-6 pt-4">
        <Skeleton className="mx-4 h-[420px] rounded-2xl sm:mx-6" />
        <div className="space-y-3 px-4 sm:px-6">
          <Skeleton className="h-5 w-48" />
          <div className="flex gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-64 w-36 shrink-0 rounded-xl sm:w-40 lg:w-44" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pb-8">
      <Hero items={heroItems} onPlay={onPlay} onOpen={onOpen} />

      <div className="relative z-10 -mt-8 space-y-7 pt-2">
        {authed && history.length > 0 && (
          <Row title="▶ Continuă vizionarea" onMore={() => onNavigate("lista")}>
            {history.map((h) => (
              <div key={h.id} className="relative w-36 shrink-0 sm:w-40 lg:w-44 cursor-pointer group" onClick={() => onOpen({
                id: h.mediaId, mediaType: h.mediaType, title: h.title, poster: h.poster,
                backdrop: h.backdrop, overview: "", year: h.year || "", rating: h.rating || 0, source: h.source || "tmdb",
              })}>
                <div className="relative aspect-video rounded-xl overflow-hidden bg-zinc-800 ring-1 ring-white/10">
                  {h.backdrop || h.poster ? (
                     
                    <img src={h.backdrop || h.poster || ""} alt={h.title} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-3xl">🎬</div>
                  )}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity">
                    <PlayCircle className="h-10 w-10 text-white drop-shadow" />
                  </div>
                  {h.progress != null && h.progress > 0 && (
                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-700">
                      <div className="h-full bg-red-600" style={{ width: `${Math.min(95, (h.progress / 600) * 100)}%` }} />
                    </div>
                  )}
                </div>
                <p className="mt-1.5 truncate text-[13px] font-medium">{h.title}</p>
              </div>
            ))}
          </Row>
        )}

        <Row title="🔥 Trending acum — global" onMore={() => onNavigate("filme")}>
          {trending.map((i) => (
            <MediaCard key={`t-${i.mediaType}-${i.id}`} item={i} onOpen={onOpen} onPlay={onPlay}
              saved={isSaved(i, "watchlist")} fav={isSaved(i, "favorites")} onToggleList={(m) => toggle(m, "watchlist")} />
          ))}
        </Row>

        <Row title="🍿 Filme populare" onMore={() => onNavigate("filme")}>
          {movies.map((i) => (
            <MediaCard key={`m-${i.id}`} item={i} onOpen={onOpen} onPlay={onPlay}
              saved={isSaved(i, "watchlist")} fav={isSaved(i, "favorites")} onToggleList={(m) => toggle(m, "watchlist")} />
          ))}
        </Row>

        <Row title="📺 Seriale difuzate azi" onMore={() => onNavigate("seriale")}>
          {series.map((i) => (
            <MediaCard key={`s-${i.id}`} item={i} onOpen={onOpen} onPlay={onPlay}
              saved={isSaved(i, "watchlist")} fav={isSaved(i, "favorites")} onToggleList={(m) => toggle(m, "watchlist")} />
          ))}
        </Row>

        <Row title="🌸 Anime în emisiune" onMore={() => onNavigate("anime")}>
          {anime.map((i) => (
            <MediaCard key={`a-${i.id}`} item={i} onOpen={onOpen} onPlay={onPlay}
              saved={isSaved(i, "watchlist")} fav={isSaved(i, "favorites")} onToggleList={(m) => toggle(m, "watchlist")} />
          ))}
        </Row>

        <Row title="💥 Blockbustere de acțiune" onMore={() => onNavigate("filme")}>
          {blockbusters.map((i) => (
            <MediaCard key={`b-${i.id}`} item={i} onOpen={onOpen} onPlay={onPlay}
              saved={isSaved(i, "watchlist")} fav={isSaved(i, "favorites")} onToggleList={(m) => toggle(m, "watchlist")} />
          ))}
        </Row>
      </div>
    </div>
  );
}
