"use client";

import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import type { MediaItem } from "./types";
import { api } from "./api";
import { MediaCard } from "./MediaCard";

type Props = {
  onPlay: (i: MediaItem) => void;
  onOpen: (i: MediaItem) => void;
  isSaved: (i: MediaItem, k: "watchlist" | "favorites") => boolean;
  onToggleList: (i: MediaItem, k: "watchlist" | "favorites") => void;
};

const TABS = [
  { key: "top", label: "🏆 Top anime" },
  { key: "airing", label: "📡 În emisiune" },
  { key: "upcoming", label: "📅 Upcoming" },
  { key: "movies", label: "🎥 Filme anime" },
];

const GENRES = [
  { id: "1", label: "Acțiune" }, { id: "4", label: "Comedie" }, { id: "8", label: "Fantezie" },
  { id: "22", label: "Romantic" }, { id: "24", label: "Sci-Fi" }, { id: "37", label: "Supranatural" },
  { id: "10", label: "Fantasy" }, { id: "7", label: "Mister" },
];

export function AnimeView({ onPlay, onOpen, isSaved, onToggleList }: Props) {
  const [tab, setTab] = useState("top");
  const [genreId, setGenreId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAnime = useCallback(async (mode: string, query?: string, gid?: string | null) => {
    setLoading(true);
    try {
      let qs: string;
      if (query) qs = `mode=search&q=${encodeURIComponent(query)}`;
      else if (gid) qs = `mode=genre&genreId=${gid}`;
      else qs = `mode=${mode}`;
      const data = await api.anime<MediaItem[]>(qs);
      setItems(data);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAnime(tab, null, genreId); }, [tab, genreId, fetchAnime]);

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (q.trim()) fetchAnime("search", q.trim());
  };

  return (
    <div className="px-4 sm:px-6 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-black tracking-tight">🌸 Anime</h1>
        <form onSubmit={onSearch} className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-zinc-500" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Caută anime pe MyAnimeList..."
            className="pl-8 border-zinc-800 bg-zinc-900 text-sm text-zinc-200 placeholder:text-zinc-500"
          />
        </form>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setGenreId(null); setQ(""); }}
            className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
              tab === t.key && !genreId && !q
                ? "bg-red-600 text-white"
                : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mb-5 flex flex-wrap gap-1.5">
        <button
          onClick={() => setGenreId(null)}
          className={`rounded-full px-3 py-1 text-[11px] font-semibold transition ${
            !genreId ? "bg-white text-black" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:text-zinc-200"
          }`}
        >
          Toate
        </button>
        {GENRES.map((g) => (
          <button
            key={g.id}
            onClick={() => { setGenreId(genreId === g.id ? null : g.id); setQ(""); }}
            className={`rounded-full px-3 py-1 text-[11px] font-semibold transition ${
              genreId === g.id ? "bg-white text-black" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:text-zinc-200"
            }`}
          >
            {g.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
          {Array.from({ length: 14 }).map((_, i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      ) : items.length === 0 ? (
        <p className="py-16 text-center text-sm text-zinc-500">Niciun anime găsit.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
            {items.map((i) => (
              <MediaCard key={i.id} item={i} onOpen={onOpen} onPlay={onPlay}
                saved={isSaved(i, "watchlist")} fav={isSaved(i, "favorites")}
                onToggleList={(m) => onToggleList(m, "watchlist")} width="w-full" />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
