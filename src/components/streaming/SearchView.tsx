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
  neon: "🧠 Biblioteca Neon",
  tmdb: "Film/Serial",
  jikan: "Anime",
  tvmaze: "Serial TV",
  itunes: "Muzică",
  youtube: "Video",
};

type SearchMeta = { libraryCount: number; tookMs: number };

export function SearchView({ query, onPlay, onOpen, isSaved, onToggleList }: Props) {
  const [entries, setEntries] = useState<{ q: string; results: SearchResult[]; meta?: SearchMeta }[]>([]);
  const [trend, setTrend] = useState<string[]>([]);

  // trending când nu e query
  useEffect(() => {
    if (query.trim()) return;
    api.searchMode<{ trending: { original: string }[] }>("", "trending")
      .then((r) => setTrend((r.trending || []).map((t) => t.original).filter(Boolean)))
      .catch(() => {});
  }, [query]);

  useEffect(() => {
    if (!query.trim()) return;
    let cancelled = false;
    api.search<{ results: SearchResult[]; libraryCount: number; tookMs: number }>(query.trim())
      .then((r) => {
        if (cancelled) return;
        setEntries((prev) =>
          [...prev.filter((e) => e.q !== query), { q: query, results: r.results, meta: { libraryCount: r.libraryCount, tookMs: r.tookMs } }].slice(-8)
        );
      })
      .catch(() => {
        if (cancelled) return;
        setEntries((prev) => [...prev.filter((e) => e.q !== query), { q: query, results: [] }].slice(-8));
      });
    return () => { cancelled = true; };
  }, [query]);

  const current = query.trim() ? entries.find((e) => e.q === query) : { q: query, results: [] };
  const results = current?.results || [];
  const meta = current?.meta;
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
    sourceUrl: r.sourceUrl,
    embedCode: r.embedCode,
    provider: r.provider,
    neonId: r.neonId,
  });

  const neonCount = results.filter((r) => r.source === "neon").length;

  return (
    <div className="px-4 sm:px-6 py-6">
      <h1 className="mb-1 text-2xl font-black tracking-tight">🔍 Rezultate pentru „{query}"</h1>
      <p className="mb-1 text-sm text-zinc-500">
        Motor Neon (FTS + trigram, partiționat) + TMDB, MyAnimeList, TVMaze, iTunes, YouTube
      </p>
      {meta && (
        <p className="mb-5 text-[11px] text-zinc-600">
          🧠 {meta.libraryCount} rezultate din biblioteca Neon • {results.length} total • {meta.tookMs}ms
          {neonCount > 0 && " • sursele Neon primele"}
        </p>
      )}

      {!query.trim() && trend.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-zinc-500">Tendințe Neon:</span>
          {trend.slice(0, 8).map((t) => (
            <span key={t} className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-zinc-300 ring-1 ring-zinc-800">
              {t}
            </span>
          ))}
        </div>
      )}

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
              <p className={`mt-0.5 text-center text-[10px] uppercase tracking-wide ${r.source === "neon" ? "font-bold text-emerald-400" : "text-zinc-600"}`}>
                {SOURCE_LABEL[r.source] || r.source}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
