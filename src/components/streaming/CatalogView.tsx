"use client";

import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import type { MediaItem } from "./types";
import { api } from "./api";
import { MediaCard } from "./MediaCard";
import { TMDB_GENRES } from "@/lib/brands";

type Kind = "filme" | "seriale" | "documentare" | "telenovele";

type Props = {
  kind: Kind;
  onPlay: (i: MediaItem) => void;
  onOpen: (i: MediaItem) => void;
  isSaved: (i: MediaItem, k: "watchlist" | "favorites") => boolean;
  onToggleList: (i: MediaItem, k: "watchlist" | "favorites") => void;
};

const KIND_TABS: Record<Kind, { key: string; label: string; qs: string }[]> = {
  filme: [
    { key: "pop", label: "🔥 Populare", qs: "mode=list&kind=popular&type=movie" },
    { key: "top", label: "⭐ Top evaluate", qs: "mode=list&kind=top_rated&type=movie" },
    { key: "cinema", label: "🎬 În cinematografe", qs: "mode=list&kind=now_playing&type=movie" },
    { key: "curand", label: "📅 În curând", qs: "mode=list&kind=upcoming&type=movie" },
  ],
  seriale: [
    { key: "pop", label: "🔥 Populare", qs: "mode=list&kind=popular&type=tv" },
    { key: "top", label: "⭐ Top evaluate", qs: "mode=list&kind=top_rated&type=tv" },
    { key: "azi", label: "📡 Difuzate azi", qs: "mode=list&kind=airing_today&type=tv" },
    { key: "emisiune", label: "🔁 În emisiune", qs: "mode=list&kind=on_the_air&type=tv" },
  ],
  documentare: [
    { key: "doc-movie", label: "🎥 Documentare film", qs: "mode=discover&type=movie&genre=documentar" },
    { key: "doc-tv", label: "📡 Serii documentare", qs: "mode=discover&type=tv&genre=documentar" },
    { key: "doc-nature", label: "🌍 Natură & știință", qs: "mode=discover&type=tv&genre=documentar&sort=vote_average.desc" },
  ],
  telenovele: [
    { key: "telenovela", label: "🌹 Catalog telenovele", qs: "mode=telenovela" },
    { key: "romantic-tv", label: "💕 Romantice TV", qs: "mode=discover&type=tv&genre=romantice" },
    { key: "drama", label: "🎭 Drume internaționale", qs: "mode=discover&type=tv&genre=drama&sort=vote_average.desc" },
  ],
};

const genreKeys = Object.keys(TMDB_GENRES).filter((g) =>
  ["actiune", "comedie", "drama", "groaza", "sf", "romantice", "animatie", "familie", "mister", "thriller", "aventura", "crima", "fantasy"].includes(g)
);

export function CatalogView({ kind, onPlay, onOpen, isSaved, onToggleList }: Props) {
  const tabs = KIND_TABS[kind];
  const [tab, setTab] = useState(tabs[0].key);
  const [genre, setGenre] = useState<string | null>(null);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  useEffect(() => { setTab(tabs[0].key); setGenre(null); setPage(1);   }, [kind]);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    try {
      if (genre) {
        const type = kind === "seriale" || kind === "telenovele" ? "tv" : "movie";
        const data = await api.tmdb<MediaItem[]>(`mode=discover&type=${type}&genre=${genre}&page=1`);
        setItems(data);
      } else if (kind === "telenovele") {
        const data = await api.tmdb<MediaItem[]>("mode=telenovela");
        setItems(data);
      } else {
        const t = tabs.find((x) => x.key === tab) || tabs[0];
        const data = await api.tmdb<MediaItem[]>(`${t.qs}&page=${p}`);
        setItems((prev) => (p === 1 ? data : [...prev, ...data]));
      }
    } catch {
      if (p === 1) setItems([]);
    } finally {
      setLoading(false);
    }
  }, [genre, kind, tab, tabs]);

  useEffect(() => { setPage(1); load(1);   }, [tab, genre, kind]);

  return (
    <div className="px-4 sm:px-6 py-6">
      <h1 className="mb-4 text-2xl font-black tracking-tight">
        {kind === "filme" && "🎬 Filme"}
        {kind === "seriale" && "📺 Seriale"}
        {kind === "documentare" && "🌍 Documentare"}
        {kind === "telenovele" && "🌹 Telenovele"}
      </h1>

      {/* tabs */}
      <div className="mb-4 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setGenre(null); setPage(1); }}
            className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
              tab === t.key && !genre
                ? "bg-red-600 text-white"
                : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* genuri */}
      {kind !== "telenovele" && (
        <div className="mb-5 flex flex-wrap gap-1.5">
          <button
            onClick={() => setGenre(null)}
            className={`rounded-full px-3 py-1 text-[11px] font-semibold transition ${
              !genre ? "bg-white text-black" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:text-zinc-200"
            }`}
          >
            Toate
          </button>
          {genreKeys.map((g) => (
            <button
              key={g}
              onClick={() => setGenre(genre === g ? null : g)}
              className={`rounded-full px-3 py-1 text-[11px] font-semibold transition ${
                genre === g ? "bg-white text-black" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:text-zinc-200"
              }`}
            >
              {TMDB_GENRES[g].label}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
          {Array.from({ length: 14 }).map((_, i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      ) : items.length === 0 ? (
        <p className="py-16 text-center text-sm text-zinc-500">Niciun conținut găsit.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
            {items.map((i, idx) => (
              <MediaCard
                key={`${i.mediaType}-${i.id}-${idx}`}
                item={i} onOpen={onOpen} onPlay={onPlay}
                saved={isSaved(i, "watchlist")} fav={isSaved(i, "favorites")}
                onToggleList={(m) => onToggleList(m, "watchlist")}
                width="w-full"
              />
            ))}
          </div>
          {!genre && tab !== "telenovela" && (
            <div className="mt-6 flex justify-center">
              <Button
                variant="outline"
                onClick={() => { const np = page + 1; setPage(np); load(np); }}
                className="border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
              >
                Încarcă mai multe
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
