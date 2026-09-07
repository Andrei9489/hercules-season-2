"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { MediaItem, SearchResult } from "./types";
import { api } from "./api";
import { MediaCard } from "./MediaCard";

type Props = {
  query: string;
  onPlay: (i: MediaItem) => void;
  onOpen: (i: MediaItem) => void;
  isSaved: (i: MediaItem, k: "watchlist" | "favorites") => boolean;
  onToggleList: (i: MediaItem, k: "watchlist" | "favorites") => void;
};

const SOURCE_LABEL: Record<string, string> = {
  tmdb: "Film/Serial",
  jikan: "Anime",
  tvmaze: "Serial TV",
  itunes: "Muzică",
  youtube: "Video",
};

export function SearchView({ query, onPlay, onOpen, isSaved, onToggleList }: Props) {
  const [entries, setEntries] = useState<{ q: string; results: SearchResult[] }[]>([]);

  useEffect(() => {
    if (!query.trim()) return;
    let cancelled = false;
    api.search<{ results: SearchResult[] }>(query.trim())
      .then((r) => {
        if (cancelled) return;
        setEntries((prev) => [...prev.filter((e) => e.q !== query), { q: query, results: r.results }].slice(-8));
      })
      .catch(() => {
        if (cancelled) return;
        setEntries((prev) => [...prev.filter((e) => e.q !== query), { q: query, results: [] }].slice(-8));
      });
    return () => { cancelled = true; };
  }, [query]);

  const current = query.trim() ? entries.find((e) => e.q === query) : { q: query, results: [] };
  const results = current?.results || [];
  const loading = Boolean(query.trim()) && !current;
  const done = Boolean(current);

  const toMedia = (r: SearchResult): MediaItem => ({
    id: r.id,
    mediaType: r.mediaType,
    title: r.title,
    poster: r.poster,
    backdrop: null,
    overview: r.overview,
    year: r.year,
    rating: r.rating,
    source: r.source,
  });

  return (
    <div className="px-4 sm:px-6 py-6">
      <h1 className="mb-1 text-2xl font-black tracking-tight">🔍 Rezultate pentru „{query}"</h1>
      <p className="mb-5 text-sm text-zinc-500">Căutare simultană în TMDB, MyAnimeList, TVMaze, iTunes și YouTube</p>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
          {Array.from({ length: 14 }).map((_, i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      ) : results.length === 0 ? (
        <p className="py-16 text-center text-sm text-zinc-500">
          {done ? `Niciun rezultat pentru ${query}.` : "Se caută..."}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
          {results.map((r, i) => (
            <div key={`${r.mediaType}-${r.id}-${i}`}>
              <MediaCard
                item={toMedia(r)}
                onOpen={onOpen}
                onPlay={onPlay}
                saved={isSaved(toMedia(r), "watchlist")}
                fav={isSaved(toMedia(r), "favorites")}
                onToggleList={(m) => onToggleList(m, "watchlist")}
                width="w-full"
              />
              <p className="mt-0.5 text-center text-[10px] uppercase tracking-wide text-zinc-600">
                {SOURCE_LABEL[r.source] || r.source}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
